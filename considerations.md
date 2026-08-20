# Hosting considerations

## 2026-08-20: Bedrock UDP head-of-line-blocking tradeoff fixed (WireGuard replaces udp_relay_*)

The old Bedrock path wrapped UDP inside frp's TCP tunnel (`catcher/udp_relay_catcher.ts`
+ `home-server/udp_relay_home.ts`, a small userspace UDP-over-TCP bridge, both now
deleted along with their systemd units). That worked but carried a structural cost:
RakNet/Bedrock is loss-tolerant and doesn't want retransmission, but TCP forces
in-order delivery, so one dropped packet anywhere on the path stalled every packet
behind it (head-of-line blocking) until TCP retransmitted it. Flagged during the
2026-08-19 performance audit, fixed the next day once asked to.

Replaced with a real WireGuard tunnel between catcher and home (`10.99.0.1` catcher,
`10.99.0.2` home) plus a kernel DNAT rule on catcher forwarding public UDP 19132
straight to `10.99.0.2:19132`. This is genuine UDP end to end, no TCP anywhere in the
Bedrock path, so a dropped packet is just dropped, no HOL stall. Verified live with a
real RakNet unconnected-ping/pong before AND after removing the old services (only
cut over once the new path proved MOTD came back through DNAT correctly), then
re-verified Java + Bedrock end to end through `mc.mliem.com` after cutover.

Setup was manual (two boxes, one tunnel, not worth a script): `wg genkey`/`wg pubkey`
on each side, `/etc/wireguard/wg0.conf` on each with the peer's public key and
`AllowedIPs`, `wg-quick@wg0` enabled via systemd for boot persistence. Three gotchas:

1. **MTU**: catcher's `wg0` came up at MTU 8920, inherited from Oracle's internal
   jumbo-frame VCN interface (`ens3` at MTU 9000). Fine on Oracle's own internal
   network, wrong for a tunnel actually crossing the public internet, causes silent
   fragmentation/drops. Fixed with `ip link set mtu 1420 dev wg0` and `MTU = 1420` in
   `wg0.conf`'s `[Interface]` so it survives a restart. Home's came up correctly at
   1420 on its own, only catcher needed this.
2. **iptables FORWARD chain**: Oracle's default FORWARD chain has policy ACCEPT but a
   catch-all REJECT rule sitting at position 1 anyway, so nothing forwarded through
   `wg0` regardless of the ACCEPT policy. Needed explicit ACCEPT rules for `wg0`
   in/out and established connections inserted ahead of that REJECT.
3. Same "Oracle's own local iptables gates ports on top of the VCN security list"
   gotcha as before (see gotcha #2 further down this file), applied again for UDP
   51820 (WireGuard's port) on both the security list and catcher's local iptables.

`home-server/udp-relay-home.service` also had a latent bug found during this work,
unrelated to the tunnel swap itself: it depended on `frpc.service` (relay's old
tunnel, long gone) instead of `frpc-catcher.service` (catcher's, what it actually
needs). Fixed on the live box and in the repo template before the WireGuard cutover.

## 2026-08-19: relay fully decommissioned

Relay is no longer a cold spare, it's gone. `mc-relay-vm` and its disk are deleted
(not just stopped), and its GCP service accounts and the custom `catcherRelayWaker`
IAM role are deleted too. Catcher's move to Oracle Cloud's Always Free tier in
`ap-singapore-1` (see "Current state" below) already puts catcher itself in the
low-latency region relay used to wake into on demand, so relay's entire reason for
existing, shortening the distance between catcher's original `us-west1` location
and SEA/Indonesia players, no longer applies. All relay-related code (the
`relay/` directory, `catcher_wake_watcher.ts`, the Transfer-packet handoff,
the XferHelper-driven join watcher) has been removed from this repo, not just
the VM. The "bring relay back" instructions further down this file describe a
GCP load-balancer-fronted relay that no longer has anything to talk to, since
the wake mechanism that would have triggered it is gone; treat them as historical
only, not a runnable recovery path, unless the wake/transfer code is rebuilt first.

Notes from a 2026-08-17 cost investigation, kept so the same alternatives don't get
re-researched from scratch next time the bill looks high. Two separate things happened
that day, worth keeping distinct:

## What was actually broken (fixed, not a hosting-provider question)

The bill spiked to a forecasted ~$47/month from an orphaned load balancer left over
from an abandoned experiment (forwarding rules, backend services, a health check, an
instance group, a reserved IP, none of it referenced anywhere in code or docs) plus a
billing account that had gone into suspension after a card decline, which force-stopped
catcher for about a day and a half. Both fixed same day. Separately, catcher's own
load balancer (the "cheat #2" trick this README used to recommend) turned out to cost
more than the per-VM-IP charge it was avoiding, so catcher moved back to a plain
static IP. None of that is a "which provider" question, it was leftover resources and
a stale cost assumption on the provider already in use.

## What was actually researched: is GCP the cheapest way to run catcher

After the fixes above, catcher's real floor cost is ~$3.65/month (the static IP,
unavoidable for anything that has to be reachable 24/7 on GCP, compute and disk are
both covered by the Always Free tier in a free-tier region). The question asked: is
there a genuinely cheaper way to get the same thing (a stable branded address, a
chosen low-latency region for the relay handoff, full Java and Bedrock support)?
Checked four real alternatives against current pricing and docs, not memory:

| Option | Cost | Why it's not actually better |
|---|---|---|
| Fly.io | ~$4.02/month | Shared IPv4 is TCP only. UDP (Bedrock) needs a dedicated IPv4 at $2/month on top of the ~$2/month machine cost, more expensive than GCP once Bedrock is kept |
| Hetzner Cloud | ~$4.70/month (EUR 4.35) | Static IP is genuinely included, but the cheapest instance (CX22) is a much bigger VM than catcher needs and still costs more all in than GCP's IP-only floor |
| Oracle Cloud Always Free | $0, if it works | Real IP-cost exemption, but a real and current reliability risk: Oracle quietly halved the Always Free Ampere A1 allowance on 2026-06-15 with no announcement, and free-tier ARM capacity is documented as scarce in popular regions. Also blocked on manual account creation, identity verification and a card, nobody could do that step but the account owner |
| playit.gg | Free | Purpose built for exactly this problem (self-hosted server behind CGNAT), but the free tier has no custom domain (only a playit-assigned one, `mc.mliem.com` would not work) and no region selection, both are Premium-only, and it adds its own 10 to 50ms on top of whatever the direct path already has. Breaks two of the three things this setup was actually built for |

**Superseded 2026-08-19: the Oracle row above turned out to be beatable.** The original
verdict was researched against the Ampere A1 (ARM) shape specifically, the one that
actually got cut on 2026-06-15. The older, smaller x86 shape, `VM.Standard.E2.1.Micro`
(1 OCPU burstable, 1GB RAM, still Always Free), was never part of that cut, it's never
been the popular/scarce one Ampere is. It still hit real capacity limits in
`ap-singapore-1` (confirmed live: "Out of host capacity" on the first several launch
attempts), but that turned out to be a queue to wait out, not a wall: scripted retries
every 20 minutes succeeded after 20 attempts (~6.5 hours). See "Current state" below,
catcher now runs there. playit.gg Premium ($3/month, solves the custom-domain and
region gaps the free tier had) remains a real fallback if Oracle capacity ever dries up
again for good, not pursued since Oracle worked out.

**Conclusion, updated: catcher's real floor is $0/month, not $3.65.** That required
Oracle's Always Free x86 shape to actually have capacity, which is not guaranteed on
demand (it took a multi-hour retry loop to get in). If Oracle capacity becomes
unworkable again, $3.65-4.70/month (GCP, Fly, or Hetzner) is the fallback floor, in
that case revisit playit.gg Premium too, now that its blockers are solved by the paid
tier. Revisit this table if Oracle's Always Free terms change again, a provider starts
including a free IPv4 that carries UDP, or the custom-domain/region requirements
themselves change.

## Current state (as of 2026-08-19)

**Catcher moved from GCP to Oracle Cloud Always Free.** `mc-catcher-oracle`
(`VM.Standard.E2.1.Micro`, Ubuntu 22.04, `ap-singapore-1`, public IP
`129.150.56.135`) runs the same three systemd services the GCP box did (`frps`,
`catcher-wake-watcher`, `udp-relay-catcher`), same auth tokens, same ports.
`mc.mliem.com` points at it, home server's `frpc-catcher.toml` points at it. Verified
live end to end, both directly by IP and again through the domain after cutover: a
real Minecraft Java status handshake and a real Bedrock RakNet unconnected ping/pong.
Still US-only-equivalent (Singapore instead), no relay, same tradeoff as before,
everyone connects, SEA/Indonesia players just don't get the low-latency handoff until
relay comes back (unrelated to this migration, see below).

**Update, 2026-08-19 (later the same day): the GCP catcher cold spare is gone too.**
`mc-catcher-vm` and its disk are deleted (not just stopped), along with the
Minecraft-specific firewall rules (`allow-catcher-minecraft`, `allow-frp-control`,
`allow-minecraft`, `allow-minecraft-bedrock`), decided once relay's removal made it
clear catcher+relay on GCP has no future here, catcher lives on Oracle permanently
now. GCP's own generic default firewall rules (SSH, ICMP, internal, RDP) were left
alone, not part of this project's specific infra. The `mc-relay-mliem` GCP project
itself is untouched (not deleted), but as of this note it holds no catcher/relay
compute, disks, or custom firewall rules at all, only the account's own default
service account and default network. If any of this ever needs rebuilding from
scratch, the old reactivation/provisioning steps in this file's earlier revisions are
a starting reference, not a live recovery path.

**Steady-state cost now: genuinely close to $0/month.** Oracle's Always Free covers
the E2.1.Micro compute, its boot disk, and (unlike GCP/AWS) does not appear to charge
separately for the public IP, no invoice has posted yet to fully confirm this, worth
checking back on that specifically. The only remaining known charge is relay's idle
10GB boot disk in `asia-southeast1`, ~$0.40/month. Down from ~$4.05/month.

**Three real gotchas hit during this migration, worth remembering for next time:**

1. `home-server/frpc-catcher.toml`'s `serverAddr` is catcher's IP hardcoded, not the
   `mc.mliem.com` domain (unlike relay, which pushes its own IP). Any time catcher's
   IP changes, for any reason, on any provider, this file goes stale and the permanent
   tunnel silently fails to reconnect (frps looks fine, the port just isn't publicly
   listening) until `serverAddr` is hand-updated and `frpc-catcher.service` restarted.
2. Oracle's official Ubuntu images ship local `iptables` rules that allow only SSH
   (22) by default and REJECT everything else, on top of whatever the VCN security
   list says. Opening the security list (done during VM creation, ports 22/25565/
   7000/19132) was not sufficient on its own, `no route to host` on every other port
   until the box's own iptables also got explicit ACCEPT rules for 25565 (tcp), 7000
   (tcp), 19132 (udp), inserted before the trailing REJECT, then persisted with
   `netfilter-persistent save` so they survive a reboot. GCP does not have this
   second gate, only the cloud firewall; do not assume Oracle behaves the same way.
3. Oracle's Ubuntu image is missing `unzip`, which bun's own installer silently needs
   (`curl -fsSL https://bun.sh/install | bash` fails with "unzip is required to
   install bun"). `apt-get install -y unzip` first. Relatedly, a fresh Oracle instance
   runs its own post-boot `apt`/`dpkg` update in the background for several minutes;
   any `apt-get` run too soon after boot hits "Could not get lock" twice in a row
   (first the apt lists lock, then a separate dpkg frontend lock a bit later), wait
   it out rather than fighting it, it clears on its own.

**Cross-cloud wake-watcher auth, superseded later the same day (2026-08-19): this
entire mechanism was deleted when relay was fully decommissioned, see the top of this
file.** Kept below as historical record of what was built and verified at the time,
not a description of anything currently live. Needed because relay stayed on GCP
while catcher no longer did: `catcher_wake_watcher.ts`'s `gcpToken()` used to only call
GCP's internal metadata server, which doesn't exist off-GCP. It tried that first
(unchanged, fast path if catcher was ever on GCP again) and fell back to a real GCP
service-account JSON key (RS256-signed JWT, `node:crypto`, no new dependency), read
from `GCP_SA_KEY_PATH` (`/etc/frp/gcp-sa-key.json` on the Oracle box, `chmod 600`,
never committed). The service account
(`catcher-wake-relay@mc-relay-mliem.iam.gserviceaccount.com`) held a custom role,
`catcherRelayWaker`, scoped to exactly `compute.instances.get`, `.list`, `.start`,
nothing else, no delete/stop/create on anything. Verified live at the time: the full
chain (sign JWT, exchange for an access token, call the real Compute API, correctly
read `mc-relay-vm`'s actual status) worked from the Oracle box. Both the service
account and the custom role are now deleted; `catcher_wake_watcher.ts` is deleted;
`catcher/udp_relay_catcher.ts` had its own independent copy of this same mechanism for
the Bedrock/UDP path (found during the relay decommission, since Bedrock traffic never
touched the TCP-only watcher above) and that's been stripped out too.

**Reproducing this migration, or reverting it:** `scripts/provision_oracle_catcher.sh`
does the actual systemd/frps/token setup (idempotent, checks for the frps binary and
the one `.ts` script already being in place rather than fetching it itself, the
wake-watcher script it used to also check for no longer exists) and
`scripts/try_create_oracle_catcher.sh` is the capacity-retry launcher, kept for the
next time Always Free capacity needs waiting out (works via the `oci` CLI once
`~/.oci/config` and an API key are set up on whatever machine runs it, see the Oracle
Cloud console's user profile > API keys to generate one).

To bring relay back up when wanted (no rush, catcher works fine without it):

```
bun run relay/setup-load-balancer.ts   # after filling in the YOUR_* constants
gcloud compute instances start mc-relay-vm --zone=asia-southeast1-b
```

Then point `mc-backend.mliem.com` at relay's new address (will likely differ from
before, GCP does not guarantee returning the same one). Verify a real TCP handshake
and RakNet ping/pong before trusting it's actually live, same as was done for catcher
this time, not just that the gcloud commands succeeded.
