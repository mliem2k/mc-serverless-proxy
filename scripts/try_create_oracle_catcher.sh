#!/bin/bash
# Retries creating the Oracle Always Free catcher VM until capacity is available.
# Networking (VCN/subnet/IGW/security list) is already set up, only the instance
# launch itself is capacity-constrained, so this only retries that one call.
set -uo pipefail

TENANCY="ocid1.tenancy.oc1..aaaaaaaa5s3rc3f4xqo3z4nemth4o6h3llvmdui5atm3cujs7sdrck5eswmq"
AD="IOXO:AP-SINGAPORE-1-AD-1"
SHAPE="VM.Standard.E2.1.Micro"
IMAGE="ocid1.image.oc1.ap-singapore-1.aaaaaaaakgjofu6mpvfu4mhyrqvigr6nvqhckq5oexw7pyqg2utdsi3ghs2a"
SUBNET="ocid1.subnet.oc1.ap-singapore-1.aaaaaaaahu2fqge2b7k5ghedocv6oulullluz4hcyhtulj32svc2aznmgraq"
SSH_PUB="$(cat ~/.ssh/id_ed25519_oracle_mc_catcher.pub)"
STATE_FILE="$(dirname "$0")/oracle_catcher_instance.json"

if [ -f "$STATE_FILE" ]; then
  echo "Instance already created, see $STATE_FILE"
  exit 0
fi

echo "$(date -u +%FT%TZ) attempting launch..."
OUT=$(oci compute instance launch \
  -c "$TENANCY" \
  --availability-domain "$AD" \
  --shape "$SHAPE" \
  --image-id "$IMAGE" \
  --subnet-id "$SUBNET" \
  --display-name "mc-catcher-oracle" \
  --assign-public-ip true \
  --metadata "{\"ssh_authorized_keys\":\"$SSH_PUB\"}" \
  --wait-for-state RUNNING \
  --query "data.{id:id,state:\"lifecycle-state\"}" 2>&1)
RC=$?

if [ $RC -eq 0 ]; then
  echo "$OUT" | tee "$STATE_FILE"
  echo "SUCCESS"
  exit 0
fi

if echo "$OUT" | grep -qiE "capacity|TooManyRequests|connection to endpoint timed out"; then
  echo "$(date -u +%FT%TZ) still out of capacity (or transient throttle/timeout)"
  exit 1
fi

echo "$(date -u +%FT%TZ) unexpected error:"
echo "$OUT"
exit 2
