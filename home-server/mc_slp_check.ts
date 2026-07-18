#!/usr/bin/env bun
// Minimal Minecraft Server List Ping status check. Exits 0 if host:port answers a
// real handshake + status request with a valid JSON response within timeout seconds,
// 1 otherwise. Used by join_transfer_watcher.ts so "relay is ready" means the whole
// path (frps on relay, the frpc tunnel, and the actual home Minecraft server) answers a
// real Minecraft client handshake, not just that something accepts a raw TCP connect
// (which can succeed even when the tunnel behind it isn't actually forwarding yet).
//
// Usage: bun run mc_slp_check.ts <host> <port> [timeout_seconds]
import { connect, type Socket } from "node:net";

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return Buffer.from(out);
}

function encodeString(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  return Buffer.concat([encodeVarint(body.length), body]);
}

class ByteReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];

  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private async waitForData() {
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async readByte(): Promise<number> {
    while (this.buf.length < 1) await this.waitForData();
    const b = this.buf[0]!;
    this.buf = this.buf.subarray(1);
    return b;
  }

  async readVarint(): Promise<number> {
    let value = 0;
    let position = 0;
    while (true) {
      const byte = await this.readByte();
      value |= (byte & 0x7f) << position;
      if (!(byte & 0x80)) return value;
      position += 7;
    }
  }

  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.waitForData();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

async function check(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock: Socket = connect({ host, port });
    const reader = new ByteReader();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    sock.on("error", () => finish(false));
    sock.on("close", () => finish(false));
    sock.on("data", (chunk) => reader.push(chunk));

    sock.on("connect", async () => {
      try {
        const handshake = Buffer.concat([
          encodeVarint(0x00),
          encodeVarint(760),
          encodeString(host),
          (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16BE(port);
            return b;
          })(),
          encodeVarint(1),
        ]);
        sock.write(Buffer.concat([encodeVarint(handshake.length), handshake]));

        const statusRequest = encodeVarint(0x00);
        sock.write(Buffer.concat([encodeVarint(statusRequest.length), statusRequest]));

        const length = await reader.readVarint();
        const body = await reader.readExact(length);
        if (body[0] !== 0x00) return finish(false);

        let pos = 1;
        let value = 0;
        let shift = 0;
        while (true) {
          const b = body[pos++]!;
          value |= (b & 0x7f) << shift;
          if (!(b & 0x80)) break;
          shift += 7;
        }
        const payload = JSON.parse(body.subarray(pos, pos + value).toString("utf8"));
        clearTimeout(timer);
        finish("version" in payload || "players" in payload);
      } catch {
        finish(false);
      }
    });
  });
}

const [host, portArg, timeoutArg] = process.argv.slice(2);
if (!host || !portArg) {
  console.error("usage: mc_slp_check.ts <host> <port> [timeout_seconds]");
  process.exit(2);
}
const port = Number(portArg);
const timeoutMs = (timeoutArg ? Number(timeoutArg) : 3) * 1000;

const ok = await check(host, port, timeoutMs);
if (!ok) console.error("mc_slp_check: no valid status response");
process.exit(ok ? 0 : 1);
