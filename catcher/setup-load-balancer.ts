#!/usr/bin/env bun
// Moves the catcher VM's reserved static IP off the VM's own network interface and onto
// a passthrough Network Load Balancer forwarding rule instead.
//
// Why: since GCP's Feb 2024 pricing change, every external IPv4 address in use by a
// running VM bills ~$0.005/hour, static or ephemeral, and Compute Engine's Always Free
// tier (VM-hours, 30GB disk, 1GB egress) never covered IP addresses. That means an
// otherwise fully free-tier e2-micro catcher VM still costs ~$3.65/month just for its
// address. GCP separately exempts static IPs assigned to a load balancer forwarding rule
// from that charge (a distinct, longstanding rule, unrelated to the 2024 change), so
// fronting the exact same VM with a passthrough Network Load Balancer using the same
// reserved IP removes the charge entirely, with no other behavior change: a passthrough
// NLB preserves the original client source IP at L3, so nothing downstream (the wake
// watcher's connection detection, PROXY protocol handling) needs to change.
//
// Run this once, after catcher's VM and its reserved static IP already exist. Test
// thoroughly against a throwaway IP before doing this against a live production address,
// see the README for the validate-before-cutover procedure this was built and verified
// with.
import { spawnSync } from "node:child_process";

const PROJECT = "YOUR_GCP_PROJECT_ID";
const ZONE = "YOUR_CATCHER_ZONE"; // e.g. us-west1-a
const REGION = "YOUR_CATCHER_REGION"; // e.g. us-west1, must match ZONE's region
const INSTANCE = "YOUR_CATCHER_VM_NAME"; // e.g. mc-catcher-vm
const STATIC_IP_NAME = "YOUR_RESERVED_IP_NAME"; // the gcloud compute addresses resource name
const MC_PORT = 25565;
const FRP_CONTROL_PORT = 7000;

function gcloud(args: string[]) {
  console.log(`$ gcloud ${args.join(" ")}`);
  const result = spawnSync("gcloud", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`gcloud ${args[0]} ${args[1]} failed with exit code ${result.status}`);
  }
}

gcloud([
  "compute", "health-checks", "create", "tcp", "mc-catcher-hc",
  "--project", PROJECT, "--region", REGION,
  "--port", String(FRP_CONTROL_PORT), "--check-interval=10s", "--timeout=5s",
  "--healthy-threshold=2", "--unhealthy-threshold=3",
]);

gcloud([
  "compute", "instance-groups", "unmanaged", "create", "mc-catcher-ig",
  "--project", PROJECT, "--zone", ZONE,
]);

gcloud([
  "compute", "instance-groups", "unmanaged", "set-named-ports", "mc-catcher-ig",
  "--project", PROJECT, "--zone", ZONE,
  "--named-ports", `mc-game:${MC_PORT},frp-control:${FRP_CONTROL_PORT}`,
]);

gcloud([
  "compute", "instance-groups", "unmanaged", "add-instances", "mc-catcher-ig",
  "--project", PROJECT, "--zone", ZONE,
  "--instances", INSTANCE,
]);

gcloud([
  "compute", "backend-services", "create", "mc-catcher-backend",
  "--project", PROJECT, "--region", REGION,
  "--load-balancing-scheme=EXTERNAL", "--protocol=TCP",
  "--health-checks", "mc-catcher-hc", "--health-checks-region", REGION,
]);

gcloud([
  "compute", "backend-services", "add-backend", "mc-catcher-backend",
  "--project", PROJECT, "--region", REGION,
  "--instance-group", "mc-catcher-ig", "--instance-group-zone", ZONE,
]);

// A separate UDP backend service for Bedrock. GCP forwarding rules and backend
// services are protocol-specific, one rule can't mix TCP and UDP, so this always
// gets created even if you're not doing Bedrock cross-play yet; it costs nothing
// extra to have and saves a step later. The TCP health check above is reused, GCP
// has no native UDP health check, using TCP/HTTP as a liveness proxy for a UDP
// backend is the documented pattern.
gcloud([
  "compute", "backend-services", "create", "mc-catcher-backend-udp",
  "--project", PROJECT, "--region", REGION,
  "--load-balancing-scheme=EXTERNAL", "--protocol=UDP",
  "--health-checks", "mc-catcher-hc", "--health-checks-region", REGION,
]);

gcloud([
  "compute", "backend-services", "add-backend", "mc-catcher-backend-udp",
  "--project", PROJECT, "--region", REGION,
  "--instance-group", "mc-catcher-ig", "--instance-group-zone", ZONE,
]);

const BEDROCK_PORT = 19132;

console.log(`
Backend services created. Validate against a throwaway test IP before cutting the
real static IP over, see the README. The actual cutover (production) is:

  gcloud compute instances delete-access-config ${INSTANCE} \\
    --zone=${ZONE} --project=${PROJECT} --access-config-name=external-nat

  gcloud compute forwarding-rules create mc-catcher-fr \\
    --project=${PROJECT} --region=${REGION} \\
    --load-balancing-scheme=EXTERNAL --ip-protocol=TCP \\
    --ports=${MC_PORT},${FRP_CONTROL_PORT} \\
    --address=${STATIC_IP_NAME} \\
    --backend-service=mc-catcher-backend --backend-service-region=${REGION}

If you're also doing Bedrock cross-play (see the README's "Bedrock/mobile cross-play"
section), the same static IP can carry a second, UDP-protocol forwarding rule
alongside the TCP one:

  gcloud compute forwarding-rules create mc-catcher-fr-udp \\
    --project=${PROJECT} --region=${REGION} \\
    --load-balancing-scheme=EXTERNAL --ip-protocol=UDP \\
    --ports=${BEDROCK_PORT} \\
    --address=${STATIC_IP_NAME} \\
    --backend-service=mc-catcher-backend-udp --backend-service-region=${REGION}

Run the TCP cutover pair back to back (the same static IP can't be in two places at
once, so there is a brief real gap between them), during a moment with zero players
online. The UDP forwarding rule can be created any time after, it doesn't touch the
TCP path at all.
`);
