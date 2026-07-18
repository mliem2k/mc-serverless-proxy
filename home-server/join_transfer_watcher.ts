#!/usr/bin/env bun
// Tails the actual Minecraft server log for real "joined the game" events (unambiguous,
// unlike raw TCP connection counting, this can't false-positive on a status/server-list
// ping). For each new join, checks whether the relay is reachable right now; if not,
// polls for up to ~2 minutes (it may still be booting, the catcher-side wake watcher is
// what actually triggers that boot, independently, on the raw connection). As soon as
// it's reachable, transfers that specific player via XferHelper so their gameplay
// bypasses the catcher. If a player joins after the relay is already warm, this
// transfers them immediately with no polling needed.
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

async function handleJoin(player: string) {
  if (recentlyTransferred(player)) {
    logger(`join_transfer_watcher: ${player} rejoined within cooldown of its own transfer, skipping (not a new session)`);
    return;
  }
  logger(`join_transfer_watcher: ${player} joined, checking relay readiness`);

  // 24 attempts x 5s tightened to 120 x 1s on 2026-07-18 (same ~2min total budget,
  // just finer-grained). Unlike frpc_resolve_loop.ts's DNS poll (which restarts frpc
  // on every "IP differs from current" reading, so a flapping DNS answer compounds
  // into repeated restarts), this loop only ever takes its one consequential action
  // (the transfer) after isReachable() succeeds with a real handshake, and returns
  // immediately once it does. A flaky intermediate DNS answer here just means one more
  // failed isReachable() and another 1s wait, not a bad transfer, so there's no
  // equivalent flapping risk to tightening it.
  for (let i = 0; i < 120; i++) {
    const ip = await resolveBackend();
    if (ip && ip === CATCHER_IP) {
      logger(`join_transfer_watcher: mc-backend still resolves to catcher (${ip}), relay not woken/ready yet, waiting`);
    } else if (ip && isReachable(ip)) {
      // The readiness check above resolves and dials the IP directly (it needs a
      // real socket to test), but the transfer target passed to XferHelper is the
      // hostname, not that resolved IP. TransferTool's transfer-mappings (see the
      // README's "Bedrock/mobile cross-play" section) key on the Java Transfer
      // packet's destination host:port, and that mapping is static config, it can't
      // track the relay's IP changing on every boot. Transferring by hostname keeps
      // the mapping valid regardless of which IP mc-backend currently resolves to.
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
      return;
    }
    await Bun.sleep(5000);
  }
  logger(`join_transfer_watcher: relay never became reachable within 2min for ${player}, leaving on catcher path`);
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
