#!/usr/bin/env bun
// Transfers a single named player to host:port via XferHelper's console command,
// issued through PufferPanel's local REST API. If you're not running PufferPanel,
// replace loginAndTransfer() with however you send a console command to your own
// server (RCON, a different panel's API, tmux send-keys, etc.), the only thing that
// matters is that `xfer $PLAYER $HOST $PORT` reaches the server console.
//
// Usage: bun run transfer_one.ts <player> <host> <port>
import { readFileSync } from "node:fs";

const CREDS_PATH = "/root/pufferpanel-admin-pass.txt"; // plaintext password, not committed
const PANEL_EMAIL = process.env.PUFFERPANEL_EMAIL;
const PANEL_SERVER_ID = "YOUR_PUFFERPANEL_SERVER_ID";

if (!PANEL_EMAIL) {
  console.error("set PUFFERPANEL_EMAIL in the environment");
  process.exit(1);
}

const [player, host, portArg] = process.argv.slice(2);
if (!player || !host || !portArg) {
  console.error("usage: transfer_one.ts <player> <host> <port>");
  process.exit(2);
}

const password = readFileSync(CREDS_PATH, "utf8").trim();

const loginRes = await fetch("http://localhost:8080/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: PANEL_EMAIL, password }),
});

if (loginRes.status !== 200) {
  console.error(`login failed: ${loginRes.status}`);
  process.exit(1);
}

const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
if (!cookie) {
  console.error("login succeeded but no session cookie was returned");
  process.exit(1);
}

await fetch(`http://localhost:8080/api/servers/${PANEL_SERVER_ID}/console`, {
  method: "POST",
  headers: { Cookie: cookie },
  body: `xfer ${player} ${host} ${portArg}`,
});

console.log(`issued transfer for ${player} -> ${host}:${portArg}`);
