#!/usr/bin/env bun
// Points <name>.YOURDOMAIN's A record at <ip> with a 60s TTL via a single Cloudflare API
// call per attempt (PATCH if the record exists, POST if it doesn't) instead of a
// delete-then-add pair plus a separate TTL-only fixup pass. Retries up to 5 times with
// a 3s backoff since outbound connectivity can be transiently unreachable right after
// boot even once network-online.target is reached.
//
// Usage: bun run cf_dns_update.ts <name> <ip>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DOMAIN = "YOURDOMAIN.com";
const [name, ip] = process.argv.slice(2);
if (!name || !ip) {
  console.error("usage: cf_dns_update.ts <name> <ip>");
  process.exit(2);
}
const fqdn = `${name}.${DOMAIN}`;
const zoneIdCache = join(homedir(), `.cfcli-zone-id-${DOMAIN}`);

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

// Expects a Cloudflare API token with DNS edit permission on DOMAIN's zone, stored as
// a `token:` line in ~/.cfcli.yml (not committed), anywhere in the file regardless of
// indentation (e.g. nested under a `defaults:` key, which is how this file is actually
// laid out on the boxes this runs on).
function readToken(): string {
  const yml = readFileSync(join(homedir(), ".cfcli.yml"), "utf8");
  const line = yml.split("\n").find((l) => l.trim().startsWith("token"));
  // .trim() before splitting matters: an indented line like "    token: cfat_..."
  // otherwise produces an empty leading element from the leading-whitespace match,
  // shifting every index by one and silently grabbing "token:" (the label, colon
  // included) instead of the actual value at [1]. Confirmed live 2026-07-19: this
  // sent "token:" as the bearer token to Cloudflare's API, a real, silent
  // authentication failure this script's own retry loop couldn't distinguish from a
  // transient network issue, since both look like "attempt N failed" from the caller's
  // perspective. Never caught by `bun build`'s syntax check, only running it live did.
  const token = line?.trim().split(/\s+/)[1];
  if (!token) throw new Error("could not find token in ~/.cfcli.yml");
  return token;
}

// Raised from 5 on 2026-07-30. Five attempts at a 3s backoff is only ~15s of tolerance,
// and relay-ddns.service had no restart policy, so a boot whose outbound egress took
// longer than that would lose the DNS update for the whole relay session. Defensive: this
// was NOT the cause of the 2026-07-30 fast-route failure, that boot's update succeeded.
const ATTEMPTS = 10;
const VERIFY_BUDGET_MS = 120_000;
const VERIFY_INTERVAL_MS = 5_000;

// A `success: true` from Cloudflare's API only proves the record was accepted, NOT that
// resolvers are handing out the new answer. The consumer that actually matters here,
// home-server/join_transfer_watcher.ts's readiness gate, reads this name over Cloudflare
// DoH and refuses to transfer anyone while it still sees catcher's IP. So an accepted-but-
// not-yet-served record is functionally identical to no update at all, and used to be
// indistinguishable from success in this script's own logs. Verify through the exact same
// path the gate uses, and treat unverified as failure so the unit's Restart=on-failure
// gets another go instead of leaving a silently-wrong record for the session.
async function resolvesToTarget(): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${fqdn}&type=A`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
    );
    const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return json.Answer?.some((a) => a.type === 1 && a.data === ip) ?? false;
  } catch {
    return false;
  }
}

async function verifyPropagated(): Promise<boolean> {
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  for (;;) {
    if (await resolvesToTarget()) return true;
    if (Date.now() + VERIFY_INTERVAL_MS >= deadline) return false;
    logger(`cf_dns_update(${name}): waiting for DoH to serve ${ip}`);
    await Bun.sleep(VERIFY_INTERVAL_MS);
  }
}

async function getZoneId(token: string): Promise<string | null> {
  if (existsSync(zoneIdCache)) {
    const cached = readFileSync(zoneIdCache, "utf8").trim();
    if (cached) return cached;
  }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { result?: Array<{ id: string }> };
    const zoneId = json.result?.[0]?.id;
    if (zoneId) {
      writeFileSync(zoneIdCache, zoneId);
      return zoneId;
    }
  } catch {
    // fall through to null
  }
  return null;
}

async function run() {
  const token = readToken();

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const zoneId = await getZoneId(token);
    if (!zoneId) {
      logger(`cf_dns_update(${name}): attempt ${attempt} failed fetching zone id, retrying in 3s`);
      await Bun.sleep(3000);
      continue;
    }

    let recordId: string | undefined;
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${fqdn}&type=A`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
      );
      const json = (await res.json()) as { result?: Array<{ id: string }> };
      recordId = json.result?.[0]?.id;
    } catch {
      // treat as "record doesn't exist", the POST branch below will create it
    }

    let resp: { success?: boolean; [key: string]: unknown };
    try {
      if (recordId) {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ content: ip, ttl: 60 }),
            signal: AbortSignal.timeout(5000),
          },
        );
        resp = await res.json();
      } else {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "A", name: fqdn, content: ip, ttl: 60, proxied: false }),
          signal: AbortSignal.timeout(5000),
        });
        resp = await res.json();
      }
    } catch (err) {
      resp = { success: false, error: String(err) };
    }

    if (resp.success) {
      if (await verifyPropagated()) {
        logger(`cf_dns_update(${name}): updated to ${ip} (verified via DoH)`);
        process.exit(0);
      }
      logger(
        `cf_dns_update(${name}): ERROR API accepted ${ip} but DoH never served it within ` +
          `${VERIFY_BUDGET_MS / 1000}s, exiting non-zero so the unit's Restart=on-failure retries`,
      );
      process.exit(1);
    }

    logger(`cf_dns_update(${name}): attempt ${attempt} failed: ${JSON.stringify(resp)}`);
    await Bun.sleep(3000);
  }

  logger(`cf_dns_update(${name}): ERROR giving up on ${name} after ${ATTEMPTS} attempts`);
  process.exit(1);
}

await run();
