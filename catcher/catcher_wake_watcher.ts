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
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

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

async function gcpTokenFromMetadata(): Promise<string | null> {
  try {
    // metadata.google.internal doesn't resolve off-GCP (e.g. on the Oracle Cloud host
    // this is migrating to), which makes fetch() throw rather than return a bad status,
    // so this needs its own try/catch to fall through to the service-account path below.
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch {
    return null;
  }
}

function base64url(data: string | Buffer): string {
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64url");
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// Re-signing a JWT and round-tripping to Google on every ~1s poll would be wasteful;
// cached in memory and refreshed 60s before the token's own stated expiry.
let cachedSaToken: { token: string; expiresAtMs: number } | null = null;

async function gcpTokenFromServiceAccount(): Promise<string | null> {
  if (cachedSaToken && cachedSaToken.expiresAtMs > Date.now()) return cachedSaToken.token;

  const keyPath = process.env.GCP_SA_KEY_PATH;
  if (!keyPath) {
    logger("catcher_wake_watcher: GCP_SA_KEY_PATH not set, no fallback auth available");
    return null;
  }

  let key: ServiceAccountKey;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    logger(`catcher_wake_watcher: failed to read/parse GCP_SA_KEY_PATH=${keyPath}`);
    return null;
  }

  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const nowSec = Math.floor(Date.now() / 1000);
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      exp: nowSec + 3600,
      iat: nowSec,
    }),
  )}`;
  const jwt = `${signingInput}.${base64url(createSign("RSA-SHA256").update(signingInput).sign(key.private_key))}`;

  let res: Response;
  try {
    res = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
  } catch {
    logger("catcher_wake_watcher: service-account token exchange request failed");
    return null;
  }
  if (!res.ok) {
    logger(`catcher_wake_watcher: service-account token exchange failed, status=${res.status}`);
    return null;
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;

  cachedSaToken = { token: json.access_token, expiresAtMs: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
  return cachedSaToken.token;
}

async function gcpToken(): Promise<string | null> {
  const metadataToken = await gcpTokenFromMetadata();
  return metadataToken ?? gcpTokenFromServiceAccount();
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
}

export interface Connection {
  conn: string; // Peer Address:Port
  totalBytes: number; // bytes_acked (sent) + bytes_received, from ss -ti's per-connection info line
}

// Pure parse of `ss -tin`'s two-line-per-connection output (a summary line, then an
// indented info line carrying byte counters), split out so it's testable without
// shelling out (see catcher_wake_watcher.test.ts). `lines.slice(1)` drops `ss`'s own
// header line ("Recv-Q Send-Q Local Address:Port Peer Address:Port ..." -- `ss`
// suppresses the State column entirely when filtering to a single state via
// `state established`, confirmed live in relay/idle_shutdown.ts's own investigation,
// so there's no leading "State"/"ESTAB" text here), which starts with a non-space
// character just like a real connection's summary line and would otherwise be
// misread as one.
export function parseConnections(ssOutput: string): Connection[] {
  const lines = ssOutput.split("\n");
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
  return parseConnections(out);
}

function isLoopback(conn: string): boolean {
  return conn.startsWith("127.0.0.1:") || conn.startsWith("[::1]:") || conn.startsWith("[::ffff:127.0.0.1]:");
}

// Pure "is this persistence + byte growth enough to call it a real player" decision,
// split out so it's testable without driving fake `ss` polls through the whole tick
// loop (see catcher_wake_watcher.test.ts).
export function shouldTriggerWake(streak: number, grownBytes: number, confirmCount: number, minActivityBytes: number): boolean {
  return streak >= confirmCount && grownBytes >= minActivityBytes;
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
      if (shouldTriggerWake(existing.streak, grown, CONFIRM_COUNT, MIN_ACTIVITY_BYTES)) {
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

// Guarded so importing this module (see catcher_wake_watcher.test.ts) doesn't kick off
// the live poll loop itself: import.meta.main is only true when this file is bun's
// actual entry point (the live watcher), not when another module imports it for its
// exported functions. Without this guard, a top-level `await` inside the loop would
// never resolve, hanging the test file's own module import indefinitely. Same pattern
// already established in relay/idle_shutdown.ts for the same reason.
if (import.meta.main) {
  while (true) {
    await tick();
    await Bun.sleep(POLL_MS);
  }
}
