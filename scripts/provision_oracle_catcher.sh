#!/bin/bash
# Provisions the Oracle Always Free catcher VM with the same two systemd
# services already running in production on the GCP catcher box: frps,
# udp-relay-catcher. Run ON the target Oracle VM as root (e.g.
# `ssh ubuntu@host 'sudo bash -s' < scripts/provision_oracle_catcher.sh`).
#
# Idempotent: safe to re-run. frps and the bun script must already be
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

echo "==> [1/8] bun"
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

echo "==> [2/8] /etc/frp/frps.toml"
mkdir -p /etc/frp
cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "${FRP_AUTH_TOKEN}"
EOF
chown root:root /etc/frp/frps.toml

echo "==> [3/8] frps binary"
if [ ! -x /usr/local/bin/frps ]; then
  echo "ERROR: frps binary not found at /usr/local/bin/frps, copy it from the GCP catcher first (scp the amd64 binary over, then chmod +x it)." >&2
  exit 1
fi

echo "==> [4/8] udp_relay_catcher.ts"
if [ ! -f /usr/local/bin/udp_relay_catcher.ts ]; then
  echo "ERROR: /usr/local/bin/udp_relay_catcher.ts not found, copy it from the GCP catcher first (scp it into place)." >&2
  exit 1
fi

echo "==> [5/8] systemd unit files"
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

echo "==> [6/8] locking down secrets (frps.toml auth token)"
chmod 600 /etc/frp/frps.toml

echo "==> [7/8] enabling + starting services (frps first, then the one that depends on it)"
systemctl daemon-reload
for svc in frps.service udp-relay-catcher.service; do
  systemctl enable "$svc"
  systemctl restart "$svc"
done

echo "==> [8/8] status check"
for svc in frps.service udp-relay-catcher.service; do
  echo
  echo "=== $svc ==="
  systemctl is-active "$svc" || true
  echo "--- last 5 journal lines ---"
  journalctl -u "$svc" -n 5 --no-pager || true
done
