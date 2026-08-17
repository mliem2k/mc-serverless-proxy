# Hosting considerations

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

**Conclusion: $3.65/month is the real floor for keeping what this setup actually has.**
Every cheaper option costs that by giving up the custom domain, the chosen relay
region, Bedrock support, or enough reliability to trust an always-on entry point to it.
Revisit this table if any of the following changes: Oracle's free tier stabilizes
instead of continuing to shrink, Fly or another provider starts including a free
IPv4 that carries UDP, or the custom-domain/specific-region requirements themselves
change (for example, if Bedrock support were ever dropped from catcher specifically,
playit.gg's free tier would be worth a second look).

## Current state (as of 2026-08-17, until reactivated)

Everything is stopped to keep cost at genuinely $0 while this sits unused: both VMs
(`mc-catcher-vm`, `mc-relay-vm`) are stopped, catcher's static IP is released, and
relay's whole load balancer chain (forwarding rules, backend services, health check,
instance group, reserved IP) is deleted. The only remaining cost is relay's 10GB boot
disk in `asia-southeast1` (not a free-tier region), roughly $0.40/month; catcher's disk
sits in a free-tier region and costs nothing. Both disks were kept rather than deleted,
since they hold the actual configured, working setup (frp, the wake watcher, the UDP
relay, all systemd units already correct), so reactivating this is "recreate the IP and
start the VM," not "reprovision from scratch."

To bring it back up:

```
gcloud compute addresses create mc-catcher-ip --region=us-west1
gcloud compute instances add-access-config mc-catcher-vm --zone=us-west1-a \
  --access-config-name=external-nat --address=<the new address> --network-tier=PREMIUM
gcloud compute instances start mc-catcher-vm --zone=us-west1-a

bun run relay/setup-load-balancer.ts   # after filling in the YOUR_* constants
gcloud compute instances start mc-relay-vm --zone=asia-southeast1-b
```

Then point `mc.mliem.com` at catcher's new address and `mc-backend.mliem.com` at
relay's (both will likely be different addresses than before, GCP does not guarantee
returning the same one). Verify both a real TCP handshake and, if Bedrock matters, a
real RakNet ping/pong before trusting either is actually live, not just that the gcloud
commands succeeded.
