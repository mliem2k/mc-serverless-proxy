#!/usr/bin/env bun
// Watches for new established connections on :25565 (the always-on catcher tunnel's
// public port) that PERSIST for CONFIRM_COUNT consecutive 3s polls (~9s) AND have
// exchanged more than MIN_ACTIVITY_BYTES of actual traffic, before treating them as a
// real player and checking whether to wake the relay VM via the GCE
// metadata-server-authenticated API (no static credentials used, the VM's own service
// account token is fetched from the metadata server at request time).
//
// Why both checks: persistence alone isn't enough. A bare TCP connect or a Minecraft
// status ping (handshake + status request + response) completes and closes in well
// under a second, so persistence rules those out. But an unusually persistent internet
// port scanner (this happens; it's normal background noise on any exposed game server
// port) can hold a connection open for 9+ seconds after doing nothing more than a
// single status exchange, which persistence alone can't distinguish from a real player.
// The byte-growth check closes that gap: a real client that actually logs in receives
// the post-handshake config-phase payload (registry/tag data sent before a player ever
// spawns into the world), which on modern Minecraft (1.20.5+, the version this whole
// setup already targets for the Transfer packet) reliably runs into the tens of KB,
// dwarfing even a generously-sized status response with a favicon. A connection that's
// been open 9+ seconds but has moved comparatively little data is treated as noise, not
// a player, no matter how long it stays open.
//
// This is still a heuristic, not a full protocol parse (this watcher only observes `ss`
// output, it doesn't sit in the connection's data path), so a deliberately crafted
// client that opens a connection and pushes junk bytes to clear the threshold without
// actually being Minecraft could still trigger a false wake. That's an accepted,
// low-cost residual risk (one relay boot cycle, a few cents) given how much more
// specific a fake has to be to pass both checks now, versus just holding a socket open.
import { execFileSync } from "node:child_process";

const PROJECT = "YOUR_GCP_PROJECT_ID";
const ZONE = "YOUR_RELAY_ZONE"; // e.g. asia-southeast1-b
const INSTANCE = "YOUR_RELAY_VM_NAME"; // e.g. mc-relay-vm
// 3s/3 polls (~9s worst case) tightened to 1s/2 polls (~2s) on 2026-07-18: the
// byte-growth check below is what actually does the anti-false-positive work, not the
// poll interval, so polling faster just samples the same threshold sooner without
// weakening it. Confirmed live: no false positives at this interval, since it's purely
// local `ss` output on this VM, not subject to the kind of external-network flakiness
// that made tightening frpc_resolve_loop.ts's DNS-based poll a bad idea (see that
// file's own comment).
const CONFIRM_COUNT = 2;
const POLL_MS = 1000;
// Comfortably above a single SLP status response even with a favicon (typically well
// under 8KB), comfortably below what real login + config-phase traffic produces within
// a couple of seconds of a genuine connection.
const MIN_ACTIVITY_BYTES = 16384;
// Shared secret with home-server/relay_ip_push_listener.ts, reachable via frpc.toml's
// "relay-ip-push" proxy (127.0.0.1:19134 here forwards straight to the same port
// there). See pushRelayIp() below for why this exists.
const PUSH_TOKEN = process.env.RELAY_IP_PUSH_TOKEN || "REPLACE_ME";

interface ConnState {
  streak: number;
  firstSeenBytes: number;
}

const state = new Map<string, ConnState>();
const triggered = new Set<string>();

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

async function gcpToken(): Promise<string | null> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

async function relayStatus(token: string): Promise<string> {
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/${INSTANCE}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return "UNKNOWN";
  const json = (await res.json()) as { status?: string };
  return json.status ?? "UNKNOWN";
}

async function triggerWake() {
  const token = await gcpToken();
  if (!token) {
    logger("catcher_wake_watcher: failed to fetch metadata token, skipping wake");
    return;
  }
  const status = await relayStatus(token);
  logger(`catcher_wake_watcher: relay status=${status}`);
  if (status === "RUNNING" || status === "STAGING" || status === "PROVISIONING") {
    logger(`catcher_wake_watcher: relay already ${status}, skipping wake`);
    return;
  }
  logger(`catcher_wake_watcher: triggering wake (relay was ${status})`);
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/${INSTANCE}/start`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  logger(`catcher_wake_watcher: ${await res.text()}`);
  void pushRelayIp();
}

// Polls the GCE API directly for the relay's assigned external IP and pushes it to
// relay_ip_push_listener.ts on the home server as soon as it's known, bypassing DNS
// entirely for the home server's frpc reconnect (relay/relay_boot_ddns.ts still
// updates DNS separately, for new players resolving mc.YOURDOMAIN.com fresh, that
// path is unaffected). Runs without blocking the main connection-watching loop.
// home-server/frpc_resolve_loop.ts keeps running unmodified as a slower DNS-based
// backstop in case this push is ever missed.
//
// Deliberately does NOT wait for the relay's frps to actually accept a connection
// before pushing, even though GCE assigns the external IP well before the guest OS
// finishes booting (confirmed ~3.5s after triggering wake, versus frps not starting
// until ~30s+ in). A first attempt at that readiness gate tested TCP connectivity
// to the relay's port 7000 directly FROM CATCHER, which turned out to be the wrong
// place to test it from: confirmed live 2026-07-19, catcher genuinely cannot reach
// the relay's IP cross-region on that port at all (a real, persistent network
// topology fact, not a bug or transient flakiness), while the home server can,
// every time. That readiness check silently hung forever on catcher, and this
// script has no visibility into the home server's own network reachability anyway.
// The right fix is to gate readiness on the side that can actually observe it: see
// home-server/relay_ip_push_listener.ts, which now does the same "wait for frps to
// accept a connection" check itself, from the home server, before touching
// frpc.toml or restarting frpc.
async function pushRelayIp() {
  const token = await gcpToken();
  if (!token) return;

  let ip: string | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/${INSTANCE}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = (await res.json()) as {
      networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>;
    };
    ip = json.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? null;
    if (ip) break;
    await Bun.sleep(1000);
  }
  if (!ip) {
    logger("catcher_wake_watcher: relay's external IP never became available within 60s, DNS-based detection will still catch up");
    return;
  }

  logger(`catcher_wake_watcher: relay's external IP is ${ip}, pushing to home server`);
  await fetch("http://127.0.0.1:19134", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: PUSH_TOKEN, ip }),
  }).catch((err) => logger(`catcher_wake_watcher: push failed: ${err}`));
}

interface Connection {
  conn: string; // Peer Address:Port
  totalBytes: number; // bytes_acked (sent) + bytes_received, from ss -ti's per-connection info line
}

function currentConnections(): Connection[] {
  let out: string;
  try {
    // -i adds a second, indented "info" line per connection with byte counters
    // (bytes_acked, bytes_received among others), which state/established alone
    // doesn't expose.
    out = execFileSync("ss", ["-tin", "state", "established", "( sport = :25565 )"], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const lines = out.split("\n");
  const connections: Connection[] = [];
  let pendingConn: string | null = null;

  for (const rawLine of lines.slice(1)) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      // a new connection's summary line: ... Local Address:Port  Peer Address:Port
      const fields = rawLine.trim().split(/\s+/);
      pendingConn = fields[3] ?? null;
      continue;
    }
    // the indented info line belonging to the connection just seen
    if (!pendingConn) continue;
    const acked = Number(rawLine.match(/bytes_acked:(\d+)/)?.[1] ?? 0);
    const received = Number(rawLine.match(/bytes_received:(\d+)/)?.[1] ?? 0);
    connections.push({ conn: pendingConn, totalBytes: acked + received });
    pendingConn = null;
  }

  return connections;
}

function isLoopback(conn: string): boolean {
  return conn.startsWith("127.0.0.1:") || conn.startsWith("[::1]:") || conn.startsWith("[::ffff:127.0.0.1]:");
}

async function tick() {
  const current = currentConnections().filter((c) => !isLoopback(c.conn));
  const currentSet = new Set(current.map((c) => c.conn));

  for (const { conn, totalBytes } of current) {
    const existing = state.get(conn);
    if (!existing) {
      state.set(conn, { streak: 1, firstSeenBytes: totalBytes });
      continue;
    }
    existing.streak += 1;

    if (existing.streak >= CONFIRM_COUNT && !triggered.has(conn)) {
      const grown = totalBytes - existing.firstSeenBytes;
      if (grown >= MIN_ACTIVITY_BYTES) {
        triggered.add(conn);
        logger(
          `catcher_wake_watcher: ${conn} persisted ${existing.streak} polls (~${existing.streak * (POLL_MS / 1000)}s) and exchanged ${grown} bytes, checking relay`,
        );
        await triggerWake();
      } else {
        logger(
          `catcher_wake_watcher: ${conn} persisted ${existing.streak} polls but only ${grown} bytes exchanged (need ${MIN_ACTIVITY_BYTES}), treating as noise so far`,
        );
      }
    }
  }

  // drop stale entries no longer present, so a reconnect from the same addr:port re-triggers
  for (const k of state.keys()) {
    if (!currentSet.has(k)) {
      state.delete(k);
      triggered.delete(k);
    }
  }
}

while (true) {
  await tick();
  await Bun.sleep(POLL_MS);
}
