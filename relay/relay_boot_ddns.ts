#!/usr/bin/env bun
// Runs on every boot of the relay VM. Points mc-backend.YOURDOMAIN.com and
// mc.YOURDOMAIN.com at this VM's current ephemeral external IP, via cf_dns_update.ts
// (single Cloudflare API call per attempt instead of a delete+add+separate-TTL-fixup
// sequence). The two records update concurrently since they're independent. The relay's
// own IP genuinely changes on every boot (it's ephemeral, on purpose, since it only
// needs to be free while the VM is running), which is why this exists at all; the
// catcher VM, by contrast, keeps one fixed address forever (see catcher/setup-load-balancer.ts).
import { execFileSync } from "node:child_process";

function logger(message: string) {
  try {
    execFileSync("logger", [message]);
  } catch {
    console.log(message);
  }
}

async function currentExternalIp(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  return (await res.text()).trim();
}

function runDnsUpdate(name: string, ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/cf_dns_update.ts`, name, ip], {
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.exited.then((code) => resolve(code === 0));
  });
}

const curIp = await currentExternalIp();

const [backendOk, mcOk] = await Promise.all([
  runDnsUpdate("mc-backend", curIp),
  runDnsUpdate("mc", curIp),
]);

if (!backendOk || !mcOk) {
  logger(`relay_boot_ddns: DNS update incomplete for one or more records, IP=${curIp}`);
  process.exit(1);
}

logger(`relay boot: DNS updated to ${curIp} (ttl=60)`);
