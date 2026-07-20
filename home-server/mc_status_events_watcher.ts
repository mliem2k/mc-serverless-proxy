#!/usr/bin/env bun
// Tails the actual Minecraft server log for real "joined the game" / "left the game"
// events and pushes each one, in real time, to the mc-status webhook endpoint. This is
// a separate, independent process from join_transfer_watcher.ts (which shares the same
// log-tailing pattern but exists to decide when to fire a relay transfer): a bug here
// must never risk that transfer logic, and vice versa.
//
// Exists because polling a status endpoint (the previous approach) can only see a
// player if a poll happens to land while they're online, missing anything shorter than
// the poll gap. Confirmed live 2026-07-19: a failed-login connection attempt (~6-10s
// long) woke the relay but never appeared in the player event log, since no poll landed
// during either window. Tailing the log has no such gap, Bukkit logs the join/leave the
// instant it happens, and includes connections that never complete AuthMe login.
//
// See docs/superpowers/specs/2026-07-20-mc-status-realtime-player-events-design.md in
// mliem-landing for the full design.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const LOG = "/path/to/your/server/logs/latest.log";
const WEBHOOK_URL = process.env.MC_STATUS_WEBHOOK_URL ?? "";
const WEBHOOK_TOKEN = process.env.MC_STATUS_WEBHOOK_TOKEN ?? "";
const RETRY_DELAY_MS = 1000;

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

async function postEvent(type: "join" | "leave", name: string, attempt = 1): Promise<void> {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
      },
      body: JSON.stringify({ type, name }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  } catch (err) {
    if (attempt === 1) {
      await Bun.sleep(RETRY_DELAY_MS);
      return postEvent(type, name, attempt + 1);
    }
    logger(`mc_status_events_watcher: failed to push ${type} for ${name} after retry: ${err}`);
  }
}

const JOIN_PATTERN = /]: ([A-Za-z0-9_]{3,16}) joined the game/;
const LEAVE_PATTERN = /]: ([A-Za-z0-9_]{3,16}) left the game/;

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
  logger("mc_status_events_watcher: MC_STATUS_WEBHOOK_URL/MC_STATUS_WEBHOOK_TOKEN not set, exiting");
  process.exit(1);
}

const tail = spawn("tail", ["-F", "-n0", LOG], { stdio: ["ignore", "pipe", "ignore"] });
const rl = createInterface({ input: tail.stdout });

for await (const line of rl) {
  const joinMatch = line.match(JOIN_PATTERN);
  if (joinMatch) {
    void postEvent("join", joinMatch[1]!);
    continue;
  }
  const leaveMatch = line.match(LEAVE_PATTERN);
  if (leaveMatch) {
    void postEvent("leave", leaveMatch[1]!);
  }
}
