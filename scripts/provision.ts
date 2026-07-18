#!/usr/bin/env bun
// Bun equivalent of the raw gcloud commands in the README's setup step 1, for anyone
// who wants a runnable script without pulling in Terraform. Does exactly what
// terraform/main.tf does: firewall rules, catcher's reserved static IP, both VMs
// (relay created then immediately stopped, it's the on-demand one), and an
// IAM-condition-scoped binding so catcher's service account can only start/stop the
// relay instance specifically, not the whole project.
//
// Usage: PROJECT=your-project-id bun run scripts/provision.ts
// Optional env vars: CATCHER_ZONE (default us-west1-a), RELAY_ZONE (default asia-southeast1-b)
import { spawnSync } from "node:child_process";

const PROJECT = process.env.PROJECT;
if (!PROJECT) {
  console.error("usage: PROJECT=your-project-id bun run scripts/provision.ts");
  process.exit(1);
}
const CATCHER_ZONE = process.env.CATCHER_ZONE || "us-west1-a"; // Always Free eligible: us-west1/us-central1/us-east1
const RELAY_ZONE = process.env.RELAY_ZONE || "asia-southeast1-b"; // whichever region you want low latency for
const CATCHER_REGION = CATCHER_ZONE.slice(0, CATCHER_ZONE.lastIndexOf("-"));

function gcloud(args: string[]) {
  console.log(`$ gcloud ${args.join(" ")}`);
  const result = spawnSync("gcloud", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`gcloud ${args[0]} ${args[1]} failed with exit code ${result.status}`);
  }
}

function gcloudCapture(args: string[]): string {
  const result = spawnSync("gcloud", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gcloud ${args[0]} ${args[1]} failed with exit code ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
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

// Reserve catcher's IP as its own resource before the VM exists, it later moves onto
// a load balancer forwarding rule (catcher/setup-load-balancer.ts), which only works
// for a static IP that outlives the VM it's currently attached to.
gcloud(["compute", "addresses", "create", "mc-catcher-ip", `--region=${CATCHER_REGION}`]);

gcloud([
  "compute", "instances", "create", "mc-catcher-vm",
  `--zone=${CATCHER_ZONE}`, "--machine-type=e2-micro",
  "--image-family=debian-12", "--image-project=debian-cloud",
  "--address=mc-catcher-ip", "--scopes=compute-rw", "--tags=mc-catcher",
  // Only settable at creation. Needed for the Bedrock UDP relay
  // (catcher/udp_relay_catcher.ts): without it, GCP silently drops any reply whose
  // source IP doesn't match the VM's own primary address, exactly what a reply
  // through the load balancer's IP looks like once setup-load-balancer.ts runs.
  "--can-ip-forward",
]);

gcloud([
  "compute", "instances", "create", "mc-relay-vm",
  `--zone=${RELAY_ZONE}`, "--machine-type=e2-micro",
  "--image-family=debian-12", "--image-project=debian-cloud",
  "--scopes=cloud-platform", "--tags=mc-relay",
]);
gcloud(["compute", "instances", "stop", "mc-relay-vm", `--zone=${RELAY_ZONE}`]);

// Scope catcher's ability to start/stop VMs down to just the relay instance.
// --scopes on the VM controls what the metadata-server token is CAPABLE of
// requesting; this IAM binding controls what it's actually ALLOWED to do. Both are
// needed, the scope alone grants nothing without the IAM role.
const catcherSa = gcloudCapture([
  "compute", "instances", "describe", "mc-catcher-vm", `--zone=${CATCHER_ZONE}`,
  "--format=value(serviceAccounts[0].email)",
]);

gcloud([
  "projects", "add-iam-policy-binding", PROJECT,
  `--member=serviceAccount:${catcherSa}`,
  "--role=roles/compute.instanceAdmin.v1",
  '--condition=expression=resource.name.endsWith("/instances/mc-relay-vm"),title=catcher-can-only-touch-relay',
]);

console.log("\nDone. Catcher and relay VMs provisioned, relay stopped (on-demand).");
