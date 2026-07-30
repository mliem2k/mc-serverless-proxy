#!/usr/bin/env bun
// Tails the actual Minecraft server log for real "joined the game" events (unambiguous,
// unlike raw TCP connection counting, this can't false-positive on a status/server-list
// ping). For each new join, checks whether the relay is reachable right now; if not,
// starts the waiting lobby (XferHelper's /xferlobby start) and polls for up to ~2
// minutes (it may still be booting, the catcher-side wake watcher is what actually
// triggers that boot, independently, on the raw connection). As soon as it's reachable,
// transfers that specific player via XferHelper so their gameplay bypasses the catcher.
// If a player joins after the relay is already warm, this transfers them immediately
// with no polling or lobby needed.
//
// "Reachable" is checked with a real Minecraft handshake + status request
// (mc_slp_check.ts), not a bare TCP connect. A bare TCP connect can succeed before the
// tunnel behind it is actually forwarding traffic (frps's exposed port can accept a
// connection while frpc on this box is still reconnecting/re-registering after the
// relay's ephemeral IP changes), which sends players to a dead end that times out
// client-side after ~30s. A real SLP status response can only come back once the whole
// path (frps on the relay, the frpc tunnel, and the actual Minecraft server here) is
// genuinely answering.
//
// IMPORTANT: a successful transfer itself causes the client to reconnect, which the
// server logs as another "joined the game" line for the same player. Without dedup this
// causes an infinite transfer loop (this will trigger Minecraft's own reconnect
// throttle if it happens). lastTransferred tracks each player's last-transferred
// timestamp in-process; joins within COOLDOWN seconds of a transfer are assumed to be
// that same transfer's own reconnect and are skipped. This is a plain in-memory Map, not
// a file with flock like the old bash version: everything here runs as async tasks in
// one process rather than separate background subshells, so there's no cross-process
// state to coordinate. The one tradeoff is the cooldown resets if this watcher itself
// restarts, an acceptable, rare edge case.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = "/path/to/your/server/logs/latest.log";
const PORT = 25565;
const COOLDOWN_MS = 120_000;
const BACKEND_HOST = "mc-backend.YOURDOMAIN.com";
// Catcher's static IP (see catcher/setup-load-balancer.ts). mc-backend resolves to
// THIS whenever the relay hasn't been woken yet (or has idled back down), and catcher
// always answers a real handshake too, since its own permanent tunnel to this box
// never goes down. Without excluding it, a fast-joining player could get "transferred"
// to mc-backend within a few seconds of joining, well under the wake watcher's own
// ~9s minimum detection window, meaning no relay wake had even been triggered yet: the
// "transfer" was a same-catcher loopback, and the player saw "you're now on the fast
// route" while still actually being served through catcher (confirmed live 2026-07-18).
const CATCHER_IP = "YOUR_CATCHER_STATIC_IP";
const FRPC_CONFIG = "/etc/frp/frpc.toml";

// PufferPanel console access for /xferlobby start|cancel, the same login-then-POST
// pattern transfer_one.ts uses for /xfer. Kept in-process here (rather than shelling
// out to a separate script per call) since these calls don't need the dedup/cooldown
// bookkeeping transfer_one.ts's caller already provides.
const CREDS_PATH = "/root/pufferpanel-admin-pass.txt";
const PANEL_EMAIL = process.env.PUFFERPANEL_EMAIL;
const PANEL_SERVER_ID = "YOUR_PUFFERPANEL_SERVER_ID";

const lastTransferred = new Map<string, number>();

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

async function resolveBackend(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${BACKEND_HOST}&type=A`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
    );
    const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    const answer = json.Answer?.find((a) => a.type === 1);
    return answer?.data ?? null;
  } catch {
    return null;
  }
}

// frpc.toml's serverAddr is maintained by relay_ip_push_listener.ts, which learns the
// relay's current IP over catcher's direct push channel rather than via DNS. That path is
// both faster and independent of Cloudflare: on 2026-07-30 it had the address 2s after the
// relay's start was requested and the tunnel up 30s in, while the DNS record stayed on
// catcher for the entire session. Reading it here is purely diagnostic; it is deliberately
// NOT used as a transfer target, because the transfer goes out by hostname (see doTransfer).
function localRelayAddr(): string | null {
  try {
    const toml = readFileSync(FRPC_CONFIG, "utf8");
    return toml.match(/^\s*serverAddr\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isReachable(ip: string): boolean {
  try {
    execFileSync("bun", ["run", `${import.meta.dir}/mc_slp_check.ts`, ip, String(PORT), "3"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function recentlyTransferred(player: string): boolean {
  const last = lastTransferred.get(player);
  return last !== undefined && Date.now() - last < COOLDOWN_MS;
}

// Same login-then-POST-console pattern transfer_one.ts uses, for XferHelper's
// /xferlobby start|cancel. A fresh login per call (no cookie caching) matches how
// transfer_one.ts already re-logs-in on every separate invocation, so this doesn't
// regress anything, just moves the same flow in-process.
async function sendConsoleCommand(command: string): Promise<void> {
  if (!PANEL_EMAIL) throw new Error("set PUFFERPANEL_EMAIL in the environment");
  const password = (await Bun.file(CREDS_PATH).text()).trim();
  const loginRes = await fetch("http://localhost:8080/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PANEL_EMAIL, password }),
  });
  if (loginRes.status !== 200) throw new Error(`login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("login succeeded but no session cookie was returned");
  await fetch(`http://localhost:8080/api/servers/${PANEL_SERVER_ID}/console`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: command,
  });
}

// A relay IP equal to CATCHER_IP means mc-backend hasn't actually moved off catcher yet
// (relay not woken/ready), not a real "reachable relay" reading. Without this exclusion
// a fast-joining player could get "transferred" to mc-backend while it still points at
// catcher, a same-catcher loopback that tells them they're on the fast route while they
// aren't (real bug, fixed 2026-07-18, preserved here as its own helper so restructuring
// handleJoin can't accidentally drop it again).
async function checkRelayReady(): Promise<string | null> {
  const ip = await resolveBackend();
  if (!ip) return null;
  if (ip === CATCHER_IP) {
    // Distinguish "relay genuinely isn't up yet" from "relay IS up and the tunnel is live,
    // but this box's resolver is still handing back the stale answer". Those look identical
    // through DNS alone, and conflating them cost a long investigation on 2026-07-30.
    //
    // The second case is the known killer, and it is a caching problem, NOT a failed DDNS:
    // on 2026-07-30 the relay's update provably succeeded at 06:54:11Z, yet all 24 of this
    // loop's polls (14:53:34 to 14:55:30 CST) still got catcher's IP, so the gate never
    // opened and the player was dumped to the slow path 84s after the tunnel went live.
    // Reproduced 2026-07-30: after patching the record, DoH answers from here FLAP between
    // old and new for over a minute even though only one authoritative record exists,
    // because cloudflare-dns.com is anycast and each node caches independently, and polling
    // every 5s spreads the query across many of them. A freshly created name converged in
    // 5.2s; this heavily-polled one did not. Hence: never conclude "DDNS failed" from this.
    const local = localRelayAddr();
    if (local && local !== CATCHER_IP) {
      logger(
        `join_transfer_watcher: mc-backend still resolves to catcher (${ip}) BUT frpc is already ` +
          `pointed at the relay (${local}), so the relay is UP and the tunnel is live; this is our ` +
          `resolver serving a stale cached answer, not a DDNS failure. Cannot transfer by hostname ` +
          `until the record propagates here (see the static-IP note in the README).`,
      );
    } else {
      logger(`join_transfer_watcher: mc-backend still resolves to catcher (${ip}), relay not woken/ready yet, waiting`);
    }
    return null;
  }
  return isReachable(ip) ? ip : null;
}

// The readiness check resolves and dials the IP directly (it needs a real socket to
// test), but the transfer target passed to XferHelper is the hostname, not that
// resolved IP. TransferTool's transfer-mappings (see the README's "Bedrock/mobile
// cross-play" section) key on the Java Transfer packet's destination host:port, and
// that mapping is static config, it can't track the relay's IP changing on every boot.
// Transferring by hostname keeps the mapping valid regardless of which IP mc-backend
// currently resolves to.
async function doTransfer(player: string, ip: string): Promise<void> {
  logger(`join_transfer_watcher: relay answered a real status request at ${ip}, transferring ${player} via ${BACKEND_HOST}`);
  lastTransferred.set(player, Date.now());
  try {
    const out = execFileSync(
      "bun",
      ["run", `${import.meta.dir}/transfer_one.ts`, player, BACKEND_HOST, String(PORT)],
      { encoding: "utf8" },
    );
    logger(`transfer_one: ${out.trim()}`);
  } catch (err) {
    logger(`transfer_one: failed: ${err}`);
  }
}

async function handleJoin(player: string) {
  if (recentlyTransferred(player)) {
    logger(`join_transfer_watcher: ${player} rejoined within cooldown of its own transfer, skipping (not a new session)`);
    return;
  }
  logger(`join_transfer_watcher: ${player} joined, checking relay readiness`);

  const firstIp = await checkRelayReady();
  if (firstIp) {
    await doTransfer(player, firstIp);
    return;
  }

  try {
    await sendConsoleCommand(`xferlobby ${player} start`);
  } catch (err) {
    logger(`join_transfer_watcher: failed to start lobby for ${player}: ${err}`);
  }

  // 23 attempts x 5s ~= 2min total budget, matching the log messages below.
  for (let i = 0; i < 23; i++) {
    await Bun.sleep(5000);
    const ip = await checkRelayReady();
    if (ip) {
      await doTransfer(player, ip);
      return;
    }
  }

  logger(`join_transfer_watcher: relay never became reachable within 2min for ${player}, releasing from lobby`);
  try {
    await sendConsoleCommand(`xferlobby ${player} cancel`);
  } catch (err) {
    logger(`join_transfer_watcher: failed to cancel lobby for ${player}: ${err}`);
  }
}

const JOIN_PATTERN = /]: ([A-Za-z0-9_]{3,16}) joined the game/;

const tail = spawn("tail", ["-F", "-n0", LOG], { stdio: ["ignore", "pipe", "ignore"] });
const rl = createInterface({ input: tail.stdout });

for await (const line of rl) {
  const match = line.match(JOIN_PATTERN);
  if (match) {
    void handleJoin(match[1]!);
  }
}
