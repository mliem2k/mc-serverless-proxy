#!/bin/bash
# Provisions the Oracle Always Free catcher VM with frps, the only tunnel
# service catcher needs. Bedrock/UDP no longer goes through a custom relay
# here, it's a WireGuard tunnel + DNAT instead (manual setup, see
# considerations.md's "WireGuard Bedrock tunnel" section). Run ON the target
# Oracle VM as root
# (e.g. `ssh ubuntu@host 'sudo bash -s' < scripts/provision_oracle_catcher.sh`).
#
# Idempotent: safe to re-run. frps must already be copied onto the box
# (scp'd from wherever it was built/downloaded) before running this; it
# checks and errors out with a clear message rather than silently writing a
# broken systemd unit.
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "run as root (sudo)" >&2
  exit 1
fi

if [ -z "${FRP_AUTH_TOKEN:-}" ]; then
  echo "ERROR: FRP_AUTH_TOKEN must be set in the environment." >&2
  echo "Copy it from the existing catcher's live config (/etc/frp/frps.toml's auth.token)," >&2
  echo "it must match exactly or the home server's tunnel won't authenticate." >&2
  exit 1
fi

echo "==> [1/6] /etc/frp/frps.toml"
mkdir -p /etc/frp
cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "${FRP_AUTH_TOKEN}"
EOF
chown root:root /etc/frp/frps.toml

echo "==> [2/6] frps binary"
if [ ! -x /usr/local/bin/frps ]; then
  echo "ERROR: frps binary not found at /usr/local/bin/frps, copy it into place first (chmod +x it)." >&2
  exit 1
fi

echo "==> [3/6] systemd unit"
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

echo "==> [4/6] locking down secrets (frps.toml auth token)"
chmod 600 /etc/frp/frps.toml

echo "==> [5/6] enabling + starting"
systemctl daemon-reload
systemctl enable frps.service
systemctl restart frps.service

echo "==> [6/6] status check"
systemctl is-active frps.service || true
journalctl -u frps.service -n 5 --no-pager || true

echo
echo "Bedrock/UDP is NOT set up by this script. See considerations.md's"
echo "'WireGuard Bedrock tunnel' section for the manual WireGuard + DNAT setup."
