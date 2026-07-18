#!/usr/bin/env bun
// Companion to catcher/catcher_wake_watcher.ts's push_relay_ip(). Listens on
// 127.0.0.1:19134, reachable from catcher via frpc.toml's "relay-ip-push" proxy.
//
// Why this exists: frpc_resolve_loop.ts discovers the relay's new IP by polling DNS,
// which measured live at 31.5s-63.4s of real added latency (Cloudflare's own edge
// propagation lag, not the polling loop's own overhead, which was independently
// confirmed and tightened separately). Catcher already knows the relay's IP the
// moment it asks the GCE API directly (no DNS involved at all), so pushing it
// straight to the home server removes DNS propagation from this critical path
// entirely.
//
// frpc_resolve_loop.ts keeps running unmodified as a slower backstop: if this push
// is ever missed (network blip, catcher's push subshell dying, etc.), DNS-based
// detection still eventually catches up and corrects serverAddr on its own, just
// slower. Both write the same file with the same "already matches, no-op" early
// exit, so there's no meaningful race between them, worst case a redundant restart.
//
// Waits for the relay's frps control port (7000) to actually accept a connection
// before touching frpc.toml, so frpc's reconnect only ever gets attempted once the
// relay is genuinely ready, succeeding cleanly on the first try instead of racing
// its boot. This check used to live on catcher instead (testing port 7000 directly
// from there before ever pushing), but catcher turned out to be the wrong vantage
// point for it: confirmed live 2026-07-19, catcher cannot reach the relay's IP
// cross-region on that port at all (a real, persistent network topology fact), so
// that version of the check just hung forever. The home server CAN reach it
// (that's the same reachability frpc itself needs), so the check belongs here.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";

const LISTEN_PORT = 19134;
const FRPC_CONFIG = "/etc/frp/frpc.toml";
const AUTH_TOKEN = process.env.RELAY_IP_PUSH_TOKEN || "REPLACE_ME";

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

function targetIsReady(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port: 7000, timeout: 2000 });
    // A failed connect fires both 'error' and 'close', but .once() plus an
    // already-settled Promise makes any second resolve() call a safe no-op, unlike
    // the exponential-reconnect-storm bug this exact pattern caused elsewhere when
    // it scheduled a NEW action (another connectTunnel() call) on every firing
    // instead of just resolving a single already-pending Promise.
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

async function waitUntilReadyThenApply(ip: string, curIp: string) {
  logger(`relay_ip_push_listener: waiting for ${ip}'s frps to actually accept connections before applying`);
  for (let i = 0; i < 90; i++) {
    if (await targetIsReady(ip)) {
      logger(`relay_ip_push_listener: serverAddr changed ${curIp} -> ${ip} (frps confirmed ready), updating and restarting frpc`);
      setServerAddr(ip);
      execFileSync("systemctl", ["restart", "frpc"]);
      return;
    }
    await Bun.sleep(1000);
  }
  logger(`relay_ip_push_listener: ${ip}'s frps never became reachable within 90s, DNS-based detection will still catch up`);
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

Bun.serve({
  hostname: "127.0.0.1",
  port: LISTEN_PORT,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    let body: { token?: string; ip?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    if (body.token !== AUTH_TOKEN) {
      logger("relay_ip_push_listener: rejected push, bad token");
      return new Response(null, { status: 403 });
    }
    if (!body.ip) return new Response(null, { status: 400 });

    const curIp = currentServerAddr();
    if (body.ip === curIp) {
      logger(`relay_ip_push_listener: pushed IP ${body.ip} already current, no-op`);
    } else {
      void waitUntilReadyThenApply(body.ip, curIp);
    }
    return new Response(null, { status: 200 });
  },
});
