#!/usr/bin/env bun
// Runs on the relay VM. Relay's own equivalent of catcher/udp_relay_catcher.ts,
// giving Bedrock players the same low-latency relay path Java players already get.
// Relay previously had zero Bedrock support at all, confirmed live: mc.mliem.com
// flipping to relay's IP on every wake silently broke Bedrock connectivity for
// real players until this existed.
//
// Listens on the real public UDP port (Bedrock's 19132) for real client packets,
// and connects out (as a TCP client) to CONTROL_PORT, exposed via a plain frp TCP
// proxy in the home server's DYNAMIC frpc.toml (not the permanent one catcher's
// copy of this control channel lives on: this script's control channel only ever
// needs to be reachable while frpc.service is actually pointed at the relay, which
// is exactly when the dynamic tunnel connects here, no permanent-tunnel complexity
// needed). Uses a distinct CONTROL_PORT (19135) from catcher's (19133) so both
// channels can coexist without a frps proxy-name/port collision on the rare
// occasion frpc.toml briefly registers against catcher instead.
//
// Unlike catcher, this VM has no load balancer in front of it, its own ephemeral
// external IP is directly on the NIC (a plain 1:1 NAT), so binding to 0.0.0.0
// works normally here, no anti-spoofing workaround needed.
//
// No wake-detection logic here (relay doesn't wake itself, it's already running by
// the time this does anything useful). Instead, real client activity touches
// ACTIVITY_FILE so idle_shutdown.ts can tell a live Bedrock session apart from true
// idle, the same discriminating byte-growth + persistence heuristic as catcher's
// wake watcher, just driving a "stay awake" signal instead of a "wake up" one.
import dgram from "node:dgram";
import { writeFileSync } from "node:fs";
import net from "node:net";

const CONFIRM_SECONDS = Number(process.env.ACTIVE_CONFIRM_SECONDS || 9);
const MIN_ACTIVITY_BYTES = Number(process.env.ACTIVE_MIN_ACTIVITY_BYTES || 2048);
const ACTIVITY_FILE = process.env.ACTIVITY_FILE || "/var/run/udp-relay-relay-last-activity";

const PUBLIC_UDP_PORT = Number(process.env.PUBLIC_UDP_PORT || 19132);
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const CONTROL_HOST = process.env.CONTROL_HOST || "127.0.0.1";
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 19135);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || "REPLACE_ME";

function markActive() {
  try {
    writeFileSync(ACTIVITY_FILE, String(Math.floor(Date.now() / 1000)));
  } catch (err) {
    console.warn(`failed writing activity file ${ACTIVITY_FILE}: ${err}`);
  }
}

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

interface ActivityEntry {
  firstSeen: number;
  lastSeen: number;
  bytes: number;
  confirmed: boolean;
}

const activity = new Map<string, ActivityEntry>();

function trackActivity(clientIp: string, clientPort: number, nbytes: number) {
  const key = `${clientIp}:${clientPort}`;
  const now = Date.now();
  let entry = activity.get(key);
  if (!entry) {
    entry = { firstSeen: now, lastSeen: now, bytes: nbytes, confirmed: false };
    activity.set(key, entry);
    return;
  }
  entry.bytes += nbytes;
  entry.lastSeen = now;
  if (entry.confirmed) {
    markActive();
    return;
  }
  const elapsedSeconds = (now - entry.firstSeen) / 1000;
  if (elapsedSeconds >= CONFIRM_SECONDS && entry.bytes >= MIN_ACTIVITY_BYTES) {
    entry.confirmed = true;
    console.log(
      `${clientIp}:${clientPort} active for ${elapsedSeconds.toFixed(1)}s, ${entry.bytes} bytes exchanged, treating as a real session, marking relay active`,
    );
    markActive();
  }
}

// Bare pings never cross the confirm threshold and would otherwise accumulate in
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
  // 2026-07-19: this exhausted this exact VM's resources (CPU pegged, SSH
  // unresponsive) within about a minute of the control channel being down (which it
  // always is for a while right after boot, waiting on the dynamic tunnel to reach
  // this VM), entirely from this bug, not the underlying (expected, transient)
  // connection failure itself.
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
