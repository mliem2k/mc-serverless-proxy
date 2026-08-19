#!/usr/bin/env bun
// Bun equivalent of the raw gcloud commands in the README's setup step 1, for anyone
// who wants a runnable script without pulling in Terraform. Does exactly what
// terraform/main.tf does: firewall rules, catcher's reserved static IP, and the VM.
//
// Usage: PROJECT=your-project-id bun run scripts/provision.ts
// Optional env vars: CATCHER_ZONE (default us-west1-a)
import { spawnSync } from "node:child_process";

const PROJECT = process.env.PROJECT;
if (!PROJECT) {
  console.error("usage: PROJECT=your-project-id bun run scripts/provision.ts");
  process.exit(1);
}
const CATCHER_ZONE = process.env.CATCHER_ZONE || "us-west1-a"; // Always Free eligible: us-west1/us-central1/us-east1
const CATCHER_REGION = CATCHER_ZONE.slice(0, CATCHER_ZONE.lastIndexOf("-"));

function gcloud(args: string[]) {
  console.log(`$ gcloud ${args.join(" ")}`);
  const result = spawnSync("gcloud", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`gcloud ${args[0]} ${args[1]} failed with exit code ${result.status}`);
  }
}

gcloud(["config", "set", "project", PROJECT]);
gcloud(["services", "enable", "compute.googleapis.com"]);

gcloud([
  "compute", "firewall-rules", "create", "allow-minecraft",
  "--network=default", "--direction=INGRESS", "--action=ALLOW",
  "--rules=tcp:25565", "--source-ranges=0.0.0.0/0",
]);
gcloud([
  "compute", "firewall-rules", "create", "allow-frp-control",
  "--network=default", "--direction=INGRESS", "--action=ALLOW",
  "--rules=tcp:7000", "--source-ranges=0.0.0.0/0",
]);
// Bedrock/mobile cross-play, see the README's "Bedrock/mobile cross-play" section.
// Only needed if you're setting that up; harmless to leave in otherwise.
gcloud([
  "compute", "firewall-rules", "create", "allow-minecraft-bedrock",
  "--network=default", "--direction=INGRESS", "--action=ALLOW",
  "--rules=udp:19132", "--source-ranges=0.0.0.0/0",
]);
gcloud([
  "compute", "firewall-rules", "create", "allow-ssh",
  "--network=default", "--direction=INGRESS", "--action=ALLOW",
  "--rules=tcp:22", "--source-ranges=0.0.0.0/0",
]);

// Reserve catcher's IP as its own resource before the VM exists, so it survives the
// VM being recreated. Stays a plain 1:1 NAT address on the VM itself; see the
// README's "Getting the idle cost to (almost) $0" for why this repo stopped moving
// it onto a load balancer forwarding rule (catcher/setup-load-balancer.ts).
gcloud(["compute", "addresses", "create", "mc-catcher-ip", `--region=${CATCHER_REGION}`]);

gcloud([
  "compute", "instances", "create", "mc-catcher-vm",
  `--zone=${CATCHER_ZONE}`, "--machine-type=e2-micro",
  "--image-family=debian-12", "--image-project=debian-cloud",
  "--address=mc-catcher-ip", "--tags=mc-catcher",
  // Only settable at creation. Was needed for the Bedrock UDP relay's anti-spoofing
  // workaround when catcher sat behind a load balancer (catcher/udp_relay_catcher.ts
  // has the detail), which this repo no longer sets up by default. Left enabled
  // since it's harmless either way; unverified whether it's still required on a
  // plain 1:1 NAT VM.
  "--can-ip-forward",
]);

console.log("\nDone. Catcher VM provisioned.");
