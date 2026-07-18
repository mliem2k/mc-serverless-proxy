#!/usr/bin/env bun
// Runs on the home server. Companion to catcher/udp_relay_catcher.ts, see that file's
// header comment for why this exists (frp's UDP proxy type replies from the wrong
// port, breaking NAT traversal for real clients).
//
// Listens on a local TCP port (exposed publicly as catcher:19133 via a plain frp TCP
// proxy, frp's TCP proxying works fine, this only replaces its broken UDP proxy type).
// For each framed packet received from catcher, relays it to the local Geyser instance
// (127.0.0.1:19132) using a per-client UDP socket, so replies from Geyser can be
// correctly attributed back to the right external client without any extra
// bookkeeping, the OS socket itself is the correlation key. Idle per-client sessions
// are cleaned up after IDLE_TIMEOUT_MS, mirroring how a normal NAT expires UDP flows.
import dgram from "node:dgram";
import net from "node:net";

const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 19133);
const GEYSER_HOST = process.env.GEYSER_HOST || "127.0.0.1";
const GEYSER_PORT = Number(process.env.GEYSER_PORT || 19132);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || "REPLACE_ME";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 60_000);

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

interface Session {
  socket: dgram.Socket;
  lastSeen: number;
}

const server = net.createServer((tunnelSocket) => {
  console.log(`tunnel connection from ${tunnelSocket.remoteAddress}:${tunnelSocket.remotePort}`);

  let authenticated = false;
  let buffer = Buffer.alloc(0);
  const sessions = new Map<string, Session>();

  const reap = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastSeen > IDLE_TIMEOUT_MS) {
        session.socket.close();
        sessions.delete(key);
      }
    }
  }, 10_000);

  function getOrCreateSession(clientIp: string, clientPort: number): Session {
    const key = `${clientIp}:${clientPort}`;
    const existing = sessions.get(key);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing;
    }
    const socket = dgram.createSocket("udp4");
    socket.on("message", (data) => {
      const session = sessions.get(key);
      if (session) session.lastSeen = Date.now();
      try {
        tunnelSocket.write(encodeFrame(clientIp, clientPort, data));
      } catch (err) {
        console.warn(`failed writing reply for ${key} back to catcher: ${err}`);
      }
    });
    const session: Session = { socket, lastSeen: Date.now() };
    sessions.set(key, session);
    console.log(`new session for ${key} (${sessions.size} active)`);
    return session;
  }

  tunnelSocket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!authenticated) {
      if (buffer.length < 4) return;
      const tokenLen = buffer.readUInt32BE(0);
      if (buffer.length < 4 + tokenLen) return;
      const token = buffer.subarray(4, 4 + tokenLen).toString("utf8");
      buffer = buffer.subarray(4 + tokenLen);
      if (token !== AUTH_TOKEN) {
        console.warn("rejected tunnel connection, bad token");
        tunnelSocket.destroy();
        return;
      }
      authenticated = true;
      console.log("tunnel authenticated");
    }

    while (buffer.length >= 4) {
      const frameLen = buffer.readUInt32BE(0);
      if (buffer.length < 4 + frameLen) break;
      const body = buffer.subarray(4, 4 + frameLen);
      buffer = buffer.subarray(4 + frameLen);

      const ipLen = body[0]!;
      const clientIp = body.subarray(1, 1 + ipLen).toString("utf8");
      const clientPort = body.readUInt16BE(1 + ipLen);
      const payload = body.subarray(3 + ipLen);

      const session = getOrCreateSession(clientIp, clientPort);
      session.socket.send(payload, GEYSER_PORT, GEYSER_HOST);
    }
  });

  const cleanup = () => {
    clearInterval(reap);
    for (const session of sessions.values()) session.socket.close();
    sessions.clear();
  };
  tunnelSocket.on("close", cleanup);
  tunnelSocket.on("error", cleanup);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`listening for catcher's tunnel on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
