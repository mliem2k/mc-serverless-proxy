#!/bin/bash
# Provisions the Oracle Always Free catcher VM with the same three systemd
# services already running in production on the GCP catcher box: frps,
# catcher-wake-watcher, udp-relay-catcher. Run ON the target Oracle VM as
# root (e.g. `ssh ubuntu@host 'sudo bash -s' < scripts/provision_oracle_catcher.sh`).
#
# Idempotent: safe to re-run. frps and the two bun scripts must already be
# copied onto the box (scp'd from the GCP catcher) before running this; it
# checks for them and errors out with a clear message rather than silently
# writing a broken systemd unit.
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "run as root (sudo)" >&2
  exit 1
fi

if [ -z "${FRP_AUTH_TOKEN:-}" ] || [ -z "${RELAY_AUTH_TOKEN:-}" ]; then
  echo "ERROR: FRP_AUTH_TOKEN and RELAY_AUTH_TOKEN must be set in the environment." >&2
  echo "Copy both from the existing catcher's live config (/etc/frp/frps.toml's auth.token," >&2
  echo "and udp-relay-catcher.service's RELAY_AUTH_TOKEN), they must match exactly or the" >&2
  echo "home server's tunnel and UDP relay control channel won't authenticate." >&2
  exit 1
fi

echo "==> [1/9] bun"
if [ -x /usr/local/bin/bun ]; then
  echo "    already at /usr/local/bin/bun, skipping install"
else
  export BUN_INSTALL="${HOME:-/root}/.bun"
  curl -fsSL https://bun.sh/install | bash
  if [ ! -f "$BUN_INSTALL/bin/bun" ]; then
    echo "ERROR: bun installer finished but $BUN_INSTALL/bin/bun does not exist" >&2
    exit 1
  fi
  install -m 755 -o root -g root "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
fi

echo "==> [2/9] /etc/frp/frps.toml"
mkdir -p /etc/frp
cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "${FRP_AUTH_TOKEN}"
EOF
chown root:root /etc/frp/frps.toml

echo "==> [3/9] frps binary"
if [ ! -x /usr/local/bin/frps ]; then
  echo "ERROR: frps binary not found at /usr/local/bin/frps, copy it from the GCP catcher first (scp the amd64 binary over, then chmod +x it)." >&2
  exit 1
fi

echo "==> [4/9] catcher_wake_watcher.ts / udp_relay_catcher.ts"
for f in /usr/local/bin/catcher_wake_watcher.ts /usr/local/bin/udp_relay_catcher.ts; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found, copy it from the GCP catcher first (scp it into place)." >&2
    exit 1
  fi
done

echo "==> [5/9] /etc/frp/gcp-sa-key.json"
if [ ! -f /etc/frp/gcp-sa-key.json ]; then
  echo "ERROR: /etc/frp/gcp-sa-key.json not found. Place the GCP service-account key there first (separate manual step, not done by this script)." >&2
  exit 1
fi
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import json; json.load(open('/etc/frp/gcp-sa-key.json'))" \
    || echo "WARNING: /etc/frp/gcp-sa-key.json does not look like valid JSON (checked with python3), double check it"
elif command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync('/etc/frp/gcp-sa-key.json','utf8'))" \
    || echo "WARNING: /etc/frp/gcp-sa-key.json does not look like valid JSON (checked with node), double check it"
else
  echo "    neither python3 nor node available, skipping JSON validation"
  if [ ! -s /etc/frp/gcp-sa-key.json ]; then
    echo "WARNING: /etc/frp/gcp-sa-key.json is empty"
  fi
fi

echo "==> [6/9] systemd unit files"
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server (catcher always-on relay)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/catcher-wake-watcher.service <<'EOF'
[Unit]
Description=Watch for new connections on the always-on catcher tunnel and wake mc-relay-vm
After=network.target frps.service

[Service]
Type=simple
Environment=GCP_SA_KEY_PATH=/etc/frp/gcp-sa-key.json
ExecStart=/usr/local/bin/bun /usr/local/bin/catcher_wake_watcher.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/udp-relay-catcher.service <<EOF
[Unit]
Description=Custom UDP relay (catcher side), fixes frp's NAT-breaking UDP proxy for Bedrock
After=network.target frps.service
Requires=frps.service

[Service]
Type=simple
Environment=RELAY_AUTH_TOKEN=${RELAY_AUTH_TOKEN}
Environment=BIND_HOST=0.0.0.0
ExecStart=/usr/local/bin/bun /usr/local/bin/udp_relay_catcher.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "==> [7/9] locking down secrets (frps.toml auth token, gcp-sa-key.json)"
chmod 600 /etc/frp/frps.toml
chmod 600 /etc/frp/gcp-sa-key.json

echo "==> [8/9] enabling + starting services (frps first, then the two that depend on it)"
systemctl daemon-reload
for svc in frps.service catcher-wake-watcher.service udp-relay-catcher.service; do
  systemctl enable "$svc"
  systemctl restart "$svc"
done

echo "==> [9/9] status check"
for svc in frps.service catcher-wake-watcher.service udp-relay-catcher.service; do
  echo
  echo "=== $svc ==="
  systemctl is-active "$svc" || true
  echo "--- last 5 journal lines ---"
  journalctl -u "$svc" -n 5 --no-pager || true
done
