#!/usr/bin/env bun
// Custom replacement for frp's UDP proxy type. frp's UDP proxying relays replies from
// a dynamically allocated port instead of the port the request arrived on, which
// breaks NAT traversal for clients behind a typical (symmetric) NAT/firewall, most
// home and mobile routers only accept a reply from the exact address:port they sent
// their request to, and silently drop anything else (confirmed live 2026-07-18: the
// reply genuinely left this VM with the correct payload, just from the wrong source
// port, and real clients never received it).
//
// Listens on the real public UDP port (Bedrock's 19132) for real client packets, and
// connects out (as a TCP client) to CONTROL_PORT, exposed via a plain frp TCP proxy
// (frp's TCP proxying isn't broken, only its UDP proxy type is) tunneling straight to
// udp_relay_home.ts on the home server. Every reply sent back to a client goes out
// through the SAME bound UDP socket that received their request, so the source port a
// client sees is always the real public port, matching normal NAT expectations.
//
// Also does its own relay-wake detection, mirroring catcher_wake_watcher.ts's
// persistence + byte-volume heuristic for the Java TCP port: a client active for
// CONFIRM_SECONDS and past MIN_ACTIVITY_BYTES is treated as a real connection attempt,
// not a status ping (confirmed live: a ping totals ~172 bytes, a real RakNet
// handshake's first packet alone is 1464 bytes). Without this, catcher_wake_watcher.ts
// (which only ever sees TCP flows) would never notice a Bedrock-only player at all.
//
// Wire protocol over the TCP tunnel, both directions identical:
//   4 bytes  total length of everything after this field (big-endian uint32)
//   1 byte   client IP string length (N)
//   N bytes  client IP as UTF-8 (dotted decimal)
//   2 bytes  client port (big-endian uint16)
//   rest     raw UDP payload
import dgram from "node:dgram";
import net from "node:net";

const PUBLIC_UDP_PORT = Number(process.env.PUBLIC_UDP_PORT || 19132);
// Bind directly to the load balancer's own IP, not 0.0.0.0. GCP's passthrough NLB
// programs this address as a valid local route on the VM (confirmed: a plain bind()
// to it succeeds), and replies sent from a socket natively bound here go out through
// the normal kernel socket path GCP's SDN already expects, rather than an
// iptables-SNAT'd packet after the fact, which never made it back to real clients
// despite leaving the VM's own NIC correctly (confirmed live 2026-07-18: netfilter
// processed and counted the SNAT, tcpdump inconsistently showed it on the wire, and it
// never reached a real external client, pointing at GCP's own SDN not treating a
// rewritten packet as part of the load balancer's expected return path).
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const CONTROL_HOST = process.env.CONTROL_HOST || "127.0.0.1"; // loops back through frp's own TCP tunnel to home
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 19133);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || "REPLACE_ME";

const GCP_PROJECT = process.env.GCP_PROJECT || "YOUR_GCP_PROJECT_ID";
const GCP_ZONE = process.env.GCP_RELAY_ZONE || "YOUR_RELAY_ZONE";
const GCP_INSTANCE = process.env.GCP_RELAY_INSTANCE || "YOUR_RELAY_VM_NAME";
const CONFIRM_SECONDS = Number(process.env.WAKE_CONFIRM_SECONDS || 9);
const MIN_ACTIVITY_BYTES = Number(process.env.WAKE_MIN_ACTIVITY_BYTES || 2048);

function encodeFrame(clientIp: string, clientPort: number, payload: Buffer): Buffer {
  const ipBytes = Buffer.from(clientIp, "utf8");
  const body = Buffer.concat([
    Buffer.from([ipBytes.length]),
    ipBytes,
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(clientPort);
      return b;
    })(),
    payload,
  ]);
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(body.length);
  return Buffer.concat([lenPrefix, body]);
}

async function gcpToken(): Promise<string | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch {
    return null;
  }
}

async function relayStatus(token: string): Promise<string> {
  try {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${GCP_PROJECT}/zones/${GCP_ZONE}/instances/${GCP_INSTANCE}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = (await res.json()) as { status?: string };
    return json.status ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function triggerWake() {
  const token = await gcpToken();
  if (!token) {
    console.warn("failed to fetch metadata token, skipping wake");
    return;
  }
  const status = await relayStatus(token);
  console.log(`relay status=${status}`);
  if (status === "RUNNING" || status === "STAGING" || status === "PROVISIONING") {
    console.log(`relay already ${status}, skipping wake`);
    return;
  }
  console.log(`triggering wake (relay was ${status})`);
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${GCP_PROJECT}/zones/${GCP_ZONE}/instances/${GCP_INSTANCE}/start`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  console.log(`wake response: ${await res.text()}`);
}

interface ActivityEntry {
  firstSeen: number;
  lastSeen: number;
  bytes: number;
  triggered: boolean;
}

const activity = new Map<string, ActivityEntry>();

function trackActivity(clientIp: string, clientPort: number, nbytes: number) {
  const key = `${clientIp}:${clientPort}`;
  const now = Date.now();
  let entry = activity.get(key);
  if (!entry) {
    entry = { firstSeen: now, lastSeen: now, bytes: nbytes, triggered: false };
    activity.set(key, entry);
    return;
  }
  entry.bytes += nbytes;
  entry.lastSeen = now;
  if (entry.triggered) return;
  const elapsedSeconds = (now - entry.firstSeen) / 1000;
  if (elapsedSeconds >= CONFIRM_SECONDS && entry.bytes >= MIN_ACTIVITY_BYTES) {
    entry.triggered = true;
    console.log(
      `${clientIp}:${clientPort} active for ${elapsedSeconds.toFixed(1)}s, ${entry.bytes} bytes exchanged, treating as a real connection, checking relay`,
    );
    void triggerWake();
  }
}

// Bare pings never cross the wake threshold and would otherwise accumulate in
// `activity` forever, since nothing else ever removes them.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of activity) {
    if (now - entry.lastSeen > 60_000) activity.delete(key);
  }
}, 30_000);

const socket = dgram.createSocket("udp4");
let tunnelSocket: net.Socket | null = null;

socket.on("message", (data, rinfo) => {
  console.log(`client -> home: ${rinfo.address}:${rinfo.port} (${data.length} bytes)`);
  trackActivity(rinfo.address, rinfo.port, data.length);
  if (!tunnelSocket) {
    console.warn(`no active tunnel to home, dropping packet from ${rinfo.address}:${rinfo.port}`);
    return;
  }
  tunnelSocket.write(encodeFrame(rinfo.address, rinfo.port, data));
});

socket.bind(PUBLIC_UDP_PORT, BIND_HOST, () => {
  console.log(`listening on UDP ${BIND_HOST}:${PUBLIC_UDP_PORT}`);
});

function connectTunnel() {
  const sock = net.connect(CONTROL_PORT, CONTROL_HOST);
  let buffer = Buffer.alloc(0);
  // A failed net.connect() fires BOTH 'error' and 'close' for the same socket, not
  // just one. Without this guard, reconnect() ran twice per failed attempt, each
  // scheduling its own retry, which scheduled two more on its own next failure, and
  // so on: an exponential reconnect storm, not a steady 3s retry. Confirmed live
  // 2026-07-19: this exhausted a relay VM's resources (CPU pegged, SSH unresponsive)
  // within about a minute of the control channel being down, entirely from this bug,
  // not the underlying (expected, transient) connection failure itself.
  let reconnecting = false;

  sock.on("connect", () => {
    const token = Buffer.from(AUTH_TOKEN, "utf8");
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(token.length);
    sock.write(Buffer.concat([lenPrefix, token]));
    tunnelSocket = sock;
    console.log("tunnel to home established");
  });

  sock.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const frameLen = buffer.readUInt32BE(0);
      if (buffer.length < 4 + frameLen) break;
      const body = buffer.subarray(4, 4 + frameLen);
      buffer = buffer.subarray(4 + frameLen);

      const ipLen = body[0]!;
      const clientIp = body.subarray(1, 1 + ipLen).toString("utf8");
      const clientPort = body.readUInt16BE(1 + ipLen);
      const payload = body.subarray(3 + ipLen);

      console.log(`home -> client: ${clientIp}:${clientPort} (${payload.length} bytes)`);
      trackActivity(clientIp, clientPort, payload.length);
      socket.send(payload, clientPort, clientIp);
    }
  });

  const reconnect = (reason: string) => {
    if (reconnecting) return;
    reconnecting = true;
    console.warn(`tunnel to home lost (${reason}), retrying in 3s`);
    tunnelSocket = null;
    setTimeout(connectTunnel, 3000);
  };
  sock.on("close", () => reconnect("closed"));
  sock.on("error", (err) => reconnect(err.message));
}

connectTunnel();
