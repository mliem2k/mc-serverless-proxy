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
// Wire protocol over the TCP tunnel, both directions identical:
//   4 bytes  total length of everything after this field (big-endian uint32)
//   1 byte   client IP string length (N)
//   N bytes  client IP as UTF-8 (dotted decimal)
//   2 bytes  client port (big-endian uint16)
//   rest     raw UDP payload
import dgram from "node:dgram";
import net from "node:net";

const PUBLIC_UDP_PORT = Number(process.env.PUBLIC_UDP_PORT || 19132);
// 0.0.0.0 is correct for catcher's current setup: a plain 1:1 NAT static IP
// on the VM's own access config, same as relay. The guest OS never sees the
// external IP on any interface, GCP's SDN rewrites the destination to the
// internal IP before the packet reaches the guest, so 0.0.0.0 (or the
// internal IP) is the only address that can actually receive it.
//
// This used to need BIND_HOST set to the load balancer's own IP instead,
// back when catcher sat behind one (see README, "Getting the idle cost to
// (almost) $0"): GCP's passthrough NLB programs its forwarding rule's IP as
// a valid local route on the backend VM specifically, which made binding to
// that exact address work, and a reply sent from a socket natively bound
// there went out through the kernel path GCP's SDN expected for the LB's
// return traffic, rather than an iptables-SNAT'd packet after the fact,
// which never made it back to real clients despite leaving the VM's own NIC
// correctly (confirmed live 2026-07-18: netfilter processed and counted the
// SNAT, tcpdump inconsistently showed it on the wire, and it never reached a
// real external client). That NLB-specific local-route trick is the only
// scenario where binding to a specific external IP (instead of 0.0.0.0)
// works at all; catcher dropped the load balancer entirely (2026-08-17, it
// turned out to cost more than the per-VM-IP charge it was avoiding), so
// this reverted to the same 0.0.0.0 binding relay always used.
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const CONTROL_HOST = process.env.CONTROL_HOST || "127.0.0.1"; // loops back through frp's own TCP tunnel to home
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 19133);
const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || "REPLACE_ME";

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

const socket = dgram.createSocket("udp4");
let tunnelSocket: net.Socket | null = null;

socket.on("message", (data, rinfo) => {
  console.log(`client -> home: ${rinfo.address}:${rinfo.port} (${data.length} bytes)`);
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
