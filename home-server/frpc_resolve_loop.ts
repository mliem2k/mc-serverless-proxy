#!/usr/bin/env bun
// Continuously (every 5s) resolves mc-backend.YOURDOMAIN.com via Cloudflare DoH using a
// hardcoded IP literal, bypassing the local resolver (useful if it's unreliable or you
// don't want to depend on it for this). Updates frpc.toml's serverAddr and restarts frpc
// only when a NEW resolved IP is confirmed stable across CONFIRM_COUNT consecutive
// polls, to avoid reacting to a single stale/inconsistent read from an edge DNS network.
//
// This exists because the relay's IP is intentionally ephemeral (see
// relay/relay_boot_ddns.ts): it changes on every boot, and frpc's serverAddr is a raw IP,
// not a hostname it re-resolves itself, so something has to notice the change and
// restart frpc pointed at the new address.
//
// catcher/catcher_wake_watcher.ts's pushRelayIp() is the fast path for this now
// (confirmed live 2026-07-18 not to depend on DNS at all); this loop is a deliberately
// slow, conservative backstop for whenever that push is ever missed. Don't tighten its
// poll interval to compete with the push on speed: 1s polling was tried the same day
// and found fast enough to catch Cloudflare's own edge network briefly disagreeing with
// itself right after a record update, each disagreement misread as "the IP changed
// again" and re-triggering a restart, a real confirmed-live frpc flap loop, not a
// hypothetical risk.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";

const CONFIRM_COUNT = 2;
const FRPC_CONFIG = "/etc/frp/frpc.toml";
const BACKEND_HOST = "mc-backend.YOURDOMAIN.com";
// See the "don't downgrade to catcher" comment below for why this needs to be
// known here specifically, not just used as a readiness-check target like any
// other IP.
const CATCHER_IP = "YOUR_CATCHER_STATIC_IP";

let pendingIp = "";
let pendingStreak = 0;

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

function currentServerAddr(): string {
  const toml = readFileSync(FRPC_CONFIG, "utf8");
  const match = toml.match(/serverAddr = "([^"]+)"/);
  if (!match) throw new Error(`could not find serverAddr in ${FRPC_CONFIG}`);
  return match[1]!;
}

function setServerAddr(ip: string) {
  const toml = readFileSync(FRPC_CONFIG, "utf8");
  writeFileSync(FRPC_CONFIG, toml.replace(/serverAddr = "[^"]*"/, `serverAddr = "${ip}"`));
}

async function targetIsReady(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port: 7000, timeout: 2000 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

while (true) {
  const newIp = await resolveBackend();

  if (newIp) {
    const curIp = currentServerAddr();
    if (newIp !== curIp) {
      if (newIp === pendingIp) {
        pendingStreak += 1;
      } else {
        pendingIp = newIp;
        pendingStreak = 1;
      }

      // Don't downgrade FROM a working non-catcher target back TO catcher just
      // because a DNS read says so, unless the current target has actually
      // stopped working. Confirmed live 2026-07-19: catcher_wake_watcher.ts's
      // pushRelayIp() applies the relay's real IP fast (no DNS involved at all),
      // but mc-backend's DNS record for that same boot can still take a while to
      // propagate through Cloudflare's edge, so this loop's own independent poll
      // can read a briefly-stale "still catcher" answer AFTER the correct value
      // was already pushed and applied, "correcting" it right back to catcher and
      // undoing the push. catcher never actually needs to be reached via THIS
      // tunnel anyway (frpc-catcher.service maintains its own permanent
      // connection there independently), so there's nothing to protect by
      // following DNS toward catcher specifically while the current target is
      // still fine.
      if (newIp === CATCHER_IP && curIp !== CATCHER_IP && (await targetIsReady(curIp))) {
        logger(`frpc_resolve_loop: resolved ${newIp} (catcher) differs from current ${curIp}, but ${curIp} is still reachable, not downgrading`);
        pendingIp = "";
        pendingStreak = 0;
      } else if (pendingStreak >= CONFIRM_COUNT) {
        // Wait for the new target's frps control port to actually accept a
        // connection before restarting frpc at it (2026-07-18: DNS can update
        // before the relay's frps has actually started, since its DNS-update
        // step runs early in boot while frps starts later; restarting frpc
        // against a not-yet-ready target produced a real, confirmed-live
        // "i/o timeout" / brief reconnect flap instead of a clean single
        // reconnect). Same pattern as catcher_wake_watcher.ts's
        // pushRelayIp(). pendingStreak deliberately isn't reset here, so this
        // just keeps retrying the readiness check each poll without needing
        // to re-confirm the DNS answer.
        if (await targetIsReady(newIp)) {
          logger(`frpc_resolve_loop: serverAddr changed ${curIp} -> ${newIp} (confirmed after ${pendingStreak} consecutive reads, target's frps is accepting connections), updating and restarting frpc`);
          setServerAddr(newIp);
          execFileSync("systemctl", ["restart", "frpc"]);
          pendingIp = "";
          pendingStreak = 0;
        } else {
          logger(`frpc_resolve_loop: ${newIp} confirmed but its frps isn't accepting connections yet, waiting before restarting`);
        }
      } else {
        logger(`frpc_resolve_loop: resolved ${newIp} differs from current ${curIp}, awaiting confirmation (${pendingStreak}/${CONFIRM_COUNT})`);
      }
    } else {
      pendingIp = "";
      pendingStreak = 0;
    }
  }

  await Bun.sleep(5000);
}
