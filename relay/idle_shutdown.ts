#!/usr/bin/env bun
// Shuts this GCE VM down within IDLE_LIMIT_SECONDS of the last established connection
// on the Minecraft port disappearing. Tracks the actual last-seen-connected wall-clock
// timestamp (not a poll count), so "5 minutes" means 300 real seconds, not N poll
// intervals worth of quantization error. Runs every 20s via mc-relay-idle-check.timer
// (systemd, not cron, cron can't go sub-minute).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const IDLE_LIMIT_SECONDS = 300;
const STATE_FILE = "/var/run/mc-relay-last-connected";
const CATCHER_IP = "YOUR_CATCHER_STATIC_IP";
const MC_PORT = 25565;
// Written by udp_relay_relay.ts whenever a real (not just a status ping) Bedrock
// session is active. Without this, this check only ever looked at TCP port 25565,
// so a Bedrock-only player connected via the relay-side UDP relay was invisible to
// it entirely, this VM could power off out from under an actively playing Bedrock
// player (confirmed live 2026-07-19, fixed the same day relay's Bedrock relay was
// added).
const BEDROCK_ACTIVITY_FILE = "/var/run/udp-relay-relay-last-activity";
const BEDROCK_ACTIVITY_MAX_AGE_SECONDS = 60;

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

// Real root cause, found 2026-07-22 while writing this function's own unit test
// against a captured live sample: `ss -tn state established (...)` suppresses the
// State column entirely (confirmed live on mc-home, both with and without the removed
// `or dport` clause below), so the data rows never contain the literal string
// "ESTAB" anywhere. The original `.includes("ESTAB")` check was therefore always
// false and this function had always returned 0, unconditionally, whether or not any
// real connection existed, the exact reason the relay powered off out from under an
// actively-connected, actively-chatting player. Fixed by counting rows the same way
// catcher_wake_watcher.ts's `parseConnections` already does: drop `ss`'s header line
// (`slice(1)`), then every remaining non-blank line IS one connection, already
// filtered to `state established` by the query itself, no text match needed. Also
// dropped the untested `or dport = :PORT` clause (unverified live, unlike catcher's
// simpler `sport = :PORT`-only filter) since it was never actually the problem and
// only adds an unproven variable. Returns null (not 0) when the check itself throws,
// so a broken `ss` invocation can't be silently misread as "confirmed no players": a
// failed check now counts as "assume active" rather than "assume idle", since the
// destructive action (poweroff) should never fire on a check we couldn't actually
// run. Every tick's raw result is logged too, so a future occurrence is diagnosable
// from the journal alone instead of requiring live GCE forensics like this one did.
export function parseEstablishedCount(ssOutput: string): number {
  return ssOutput
    .split("\n")
    .slice(1)
    .filter((line) => line.trim().length > 0).length;
}

function establishedCount(): number | null {
  try {
    const out = execFileSync(
      "ss",
      ["-tn", "state", "established", `( sport = :${MC_PORT} )`],
      { encoding: "utf8" },
    );
    return parseEstablishedCount(out);
  } catch (err) {
    logger(`relay: idle check's \`ss\` invocation failed (${err}), treating as active this tick`);
    return null;
  }
}

// Pure Bedrock-activity check, split out so it's testable without touching the
// filesystem (see idle_shutdown.test.ts).
export function isBedrockActive(now: number, lastActivity: number, maxAgeSeconds: number): boolean {
  return now - lastActivity <= maxAgeSeconds;
}

function readBedrockActive(now: number): boolean {
  if (!existsSync(BEDROCK_ACTIVITY_FILE)) return false;
  const lastActivity = Number(readFileSync(BEDROCK_ACTIVITY_FILE, "utf8").trim() || "0");
  return isBedrockActive(now, lastActivity, BEDROCK_ACTIVITY_MAX_AGE_SECONDS);
}

// The exact fix confirmed live 2026-07-22: a failed check (tcpCount === null) counts
// as active, not idle, since the destructive action (poweroff) should never fire on a
// check that didn't actually run.
export function shouldStayAwake(tcpCount: number | null, bedrockActive: boolean): boolean {
  return tcpCount === null || tcpCount > 0 || bedrockActive;
}

export function shouldPowerOff(elapsedSeconds: number, idleLimitSeconds: number): boolean {
  return elapsedSeconds >= idleLimitSeconds;
}

if (import.meta.main) {
  const now = Math.floor(Date.now() / 1000);
  const tcpCount = establishedCount();
  const bedrock = readBedrockActive(now);
  logger(`relay: idle check tick, tcpCount=${tcpCount === null ? "check-failed" : tcpCount}, bedrockActive=${bedrock}`);

  if (shouldStayAwake(tcpCount, bedrock)) {
    writeFileSync(STATE_FILE, String(now));
    process.exit(0);
  }

  // No state file yet (fresh boot): start the clock now instead of treating a missing
  // file as "idle since epoch 0", which would trigger an immediate false shutdown.
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, String(now));
  }

  const lastSeen = Number(readFileSync(STATE_FILE, "utf8").trim());
  const elapsed = now - lastSeen;

  if (shouldPowerOff(elapsed, IDLE_LIMIT_SECONDS)) {
    logger(`relay: idle for ${elapsed}s (limit ${IDLE_LIMIT_SECONDS}s), flipping DNS back to catcher and shutting down`);
    // Both records need resetting, not just the public-facing "mc" one. "mc-backend" is
    // what the home server's DNS-change watcher uses to decide where to point its
    // tunnel, and what the join watcher checks for relay reachability. Leaving it
    // pointed at this now-dead relay IP after shutdown means the tunnel keeps dialing a
    // dead address indefinitely once it eventually re-resolves (confirmed live: this
    // broke the home server's tunnel entirely after a relay wake/sleep cycle, until
    // fixed by hand).
    execFileSync("bun", ["run", `${import.meta.dir}/cf_dns_update.ts`, "mc", CATCHER_IP], { stdio: "inherit" });
    execFileSync("bun", ["run", `${import.meta.dir}/cf_dns_update.ts`, "mc-backend", CATCHER_IP], { stdio: "inherit" });
    execFileSync("/sbin/poweroff");
  }
}
