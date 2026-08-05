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
// connection while frpc on this box is still reconnecting/re-registering), which sends
// players to a dead end that times out client-side after ~30s. A real SLP status
// response can only come back once the whole path (frps on the relay, the frpc tunnel,
// and the actual Minecraft server here) is genuinely answering.
//
// That SLP check is dialled at RELAY_IP, a fixed address, and DNS is not consulted at
// all. It used to be: this watcher resolved mc-backend over DoH every poll and refused
// to transfer while the answer still read catcher, because the relay's IP was ephemeral
// and changed on every boot. That gate could not open until a public DNS record
// propagated to this box's resolver, and cloudflare-dns.com being anycast (each node
// caching independently) made that duration unpredictable: 30s on one measured cold
// start, 75s on another the same day, and on 2026-07-30 it never opened at all inside
// the 2 minute budget, dumping a real player onto the slow path 84s after the tunnel
// had gone live. The relay now sits behind a permanent static IP on a passthrough NLB
// forwarding rule, so there is no propagating record left to wait for and the whole
// phase is gone.
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
import { resolve4 } from "node:dns/promises";
import { createInterface } from "node:readline";

const LOG = "/path/to/your/server/logs/latest.log";
const PORT = 25565;
const COOLDOWN_MS = 120_000;
// The relay's permanent static IP (see the README's "Giving the relay the same free
// static IP" section, which is catcher/setup-load-balancer.ts applied to the relay).
// Readiness is
// dialled here directly rather than through BACKEND_HOST, so a slow or stale resolver
// cannot delay a transfer that is otherwise ready to go.
const RELAY_IP = "YOUR_RELAY_STATIC_IP";
// The transfer target handed to XferHelper stays a HOSTNAME even though the address
// above is fixed, because TransferTool's Bedrock transfer-mappings key on the Java
// Transfer packet's destination host:port and that mapping is static config. This must
// resolve to RELAY_IP; assertTransferTargetMatches() below checks that at startup
// rather than leaving it as a comment nobody re-verifies.
const BACKEND_HOST = "mc-backend.YOURDOMAIN.com";

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

// Readiness dials RELAY_IP but the transfer goes out by BACKEND_HOST, so those two
// silently disagreeing would mean sending players somewhere this watcher never checked.
// That is exactly the shape of the 2026-07-18 same-catcher-loopback bug (health-check
// one endpoint, hand the player another), so it gets an actual check rather than a
// comment. Log-only and non-fatal: a resolver hiccup during boot must not take the
// watcher down, and the fixed-IP readiness path works regardless of what DNS says.
async function assertTransferTargetMatches(): Promise<void> {
  try {
    const addrs = await resolve4(BACKEND_HOST);
    if (!addrs.includes(RELAY_IP)) {
      logger(
        `join_transfer_watcher: WARNING ${BACKEND_HOST} resolves to ${addrs.join(",")} but readiness ` +
          `is checked at ${RELAY_IP}. Players would be transferred somewhere this watcher never tested. ` +
          `Fix the A record or RELAY_IP so they agree.`,
      );
      return;
    }
    logger(`join_transfer_watcher: transfer target ${BACKEND_HOST} confirmed at ${RELAY_IP}`);
  } catch (err) {
    logger(`join_transfer_watcher: could not verify ${BACKEND_HOST} against ${RELAY_IP}: ${err}`);
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

// True only when the whole path answers a real handshake right now: frps up on the relay,
// this box's frpc registered against it, and the Minecraft server behind it responding.
//
// This used to return a two-field RelayCheck, because "the tunnel is live" and "we may
// transfer" were genuinely different moments: the tunnel came up as soon as frpc
// reconnected, but transferring had to wait for the hostname to propagate to this box's
// resolver, roughly 30s later. The lobby progress bar had a dedicated "ready" signal
// (/xferlobby <player> ready) to fill that gap with something honest. With a fixed relay
// address there is no gap left to report: the tunnel coming up and the transfer becoming
// safe are now the same event, observed by the same SLP check, so the second signal and
// the state it described are both gone.
function checkRelayReady(): boolean {
  return isReachable(RELAY_IP);
}

// The readiness check dials the IP (it needs a real socket to test), but the transfer
// target passed to XferHelper is the hostname. TransferTool's transfer-mappings (see the
// README's "Bedrock/mobile cross-play" section) key on the Java Transfer packet's
// destination host:port, and that mapping is static config, so the transfer has to go out
// by name. assertTransferTargetMatches() at startup is what keeps the two in agreement.
async function doTransfer(player: string): Promise<void> {
  logger(`join_transfer_watcher: relay answered a real status request at ${RELAY_IP}, transferring ${player} via ${BACKEND_HOST}`);
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

  if (checkRelayReady()) {
    await doTransfer(player);
    return;
  }

  try {
    await sendConsoleCommand(`xferlobby ${player} start`);
  } catch (err) {
    logger(`join_transfer_watcher: failed to start lobby for ${player}: ${err}`);
  }

  // 23 attempts x 5s ~= 2min total budget, matching the log messages below. Kept at 2min
  // even though a cold start should now finish in roughly 39s rather than 68-108s: the
  // budget exists for the worst case (GCE slow to provision), not the expected one, and
  // shrinking it only converts a slow success into a failure.
  for (let i = 0; i < 23; i++) {
    await Bun.sleep(5000);
    if (checkRelayReady()) {
      await doTransfer(player);
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

// Fire and forget: this is a startup sanity log, and blocking the tail on a DNS lookup
// would mean a resolver timeout costs us the first join's transfer.
void assertTransferTargetMatches();

const tail = spawn("tail", ["-F", "-n0", LOG], { stdio: ["ignore", "pipe", "ignore"] });
const rl = createInterface({ input: tail.stdout });

for await (const line of rl) {
  const match = line.match(JOIN_PATTERN);
  if (match) {
    void handleJoin(match[1]!);
  }
}
