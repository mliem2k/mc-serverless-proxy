#!/bin/bash
# Provisions the WireGuard tunnel between catcher and home (see
# considerations.md's "Bedrock UDP head-of-line-blocking tradeoff fixed"
# entry for why this exists: genuine UDP end to end for Bedrock, catcher
# DNATs public UDP 19132 straight to home over wg0). Run ON the target box
# as root, once per box, with the role that box plays:
#
#   ssh ubuntu@catcher-host 'sudo bash -s -- --role catcher' < scripts/provision_wireguard.sh
#   ssh mc-home 'sudo bash -s -- --role home' < scripts/provision_wireguard.sh
#
# Idempotent: safe to re-run. Never regenerates an existing private key,
# that would break the tunnel by invalidating the peer relationship, it
# only generates one the first time /etc/wireguard/wg0.conf doesn't exist
# or has no PrivateKey line yet. Public key exchange between the two boxes
# is manual by design, this script does not talk to the other box.
set -euo pipefail
umask 077

if [ "$EUID" -ne 0 ]; then
  echo "run as root (sudo)" >&2
  exit 1
fi

ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --role)
      ROLE="${2:-}"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$ROLE" != "catcher" ] && [ "$ROLE" != "home" ]; then
  echo "usage: provision_wireguard.sh --role catcher|home" >&2
  exit 1
fi

if [ "$ROLE" = "catcher" ]; then
  TOTAL_STEPS=10
else
  TOTAL_STEPS=6
fi

require_var() {
  local name="$1"
  local hint="$2"
  if [ -z "${!name:-}" ]; then
    echo "ERROR: $name must be set in the environment." >&2
    echo "$hint" >&2
    exit 1
  fi
}

echo "==> [1/$TOTAL_STEPS] validating required environment variables for role $ROLE"
require_var WG_OWN_ADDRESS "Set this box's own tunnel address with prefix, e.g. WG_OWN_ADDRESS=10.99.0.1/30"
require_var WG_PEER_PUBLIC_KEY "Set the other box's WireGuard public key, e.g. WG_PEER_PUBLIC_KEY=<pubkey from the other box's wg pubkey output>"
require_var WG_PEER_ADDRESS "Set the other box's tunnel address with no prefix, e.g. WG_PEER_ADDRESS=10.99.0.2 (used for AllowedIPs and, on catcher, the DNAT target)"
if [ "$ROLE" = "catcher" ]; then
  require_var WG_LISTEN_PORT "Set the UDP port WireGuard listens on, e.g. WG_LISTEN_PORT=51820"
  require_var WG_MTU "Set the tunnel MTU, e.g. WG_MTU=1420. Catcher needs this set explicitly, its interface otherwise inherits the host's jumbo MTU and silently drops packets over the public internet."
else
  require_var WG_PEER_ENDPOINT "Set catcher's public endpoint, e.g. WG_PEER_ENDPOINT=129.150.56.135:51820"
fi

echo "==> [2/$TOTAL_STEPS] wireguard-tools"
if ! command -v wg >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard
fi

WG_CONF=/etc/wireguard/wg0.conf

echo "==> [3/$TOTAL_STEPS] $WG_CONF"
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard

EXISTING_PRIVATE_KEY=""
if [ -f "$WG_CONF" ]; then
  EXISTING_PRIVATE_KEY="$(grep -m1 '^PrivateKey' "$WG_CONF" | sed 's/^PrivateKey[[:space:]]*=[[:space:]]*//' || true)"
fi

FRESH_KEY=0
if [ -n "$EXISTING_PRIVATE_KEY" ]; then
  PRIVATE_KEY="$EXISTING_PRIVATE_KEY"
  echo "existing private key found in $WG_CONF, leaving it alone"
else
  PRIVATE_KEY="$(wg genkey)"
  FRESH_KEY=1
  echo "no private key found, generated a fresh one"
fi
PUBLIC_KEY="$(echo "$PRIVATE_KEY" | wg pubkey)"

OLD_CONF_CONTENT=""
if [ -f "$WG_CONF" ]; then
  OLD_CONF_CONTENT="$(cat "$WG_CONF")"
fi

if [ "$ROLE" = "catcher" ]; then
  NEW_CONF_CONTENT="$(cat <<EOF
[Interface]
MTU = ${WG_MTU}
PrivateKey = ${PRIVATE_KEY}
Address = ${WG_OWN_ADDRESS}
ListenPort = ${WG_LISTEN_PORT}

[Peer]
PublicKey = ${WG_PEER_PUBLIC_KEY}
AllowedIPs = ${WG_PEER_ADDRESS}/32
EOF
)"
else
  NEW_CONF_CONTENT="$(cat <<EOF
[Interface]
PrivateKey = ${PRIVATE_KEY}
Address = ${WG_OWN_ADDRESS}

[Peer]
PublicKey = ${WG_PEER_PUBLIC_KEY}
Endpoint = ${WG_PEER_ENDPOINT}
AllowedIPs = ${WG_PEER_ADDRESS}/32
PersistentKeepalive = 25
EOF
)"
fi

CONFIG_CHANGED=1
if [ "$NEW_CONF_CONTENT" = "$OLD_CONF_CONTENT" ]; then
  CONFIG_CHANGED=0
  echo "config content unchanged"
fi

printf '%s\n' "$NEW_CONF_CONTENT" > "$WG_CONF"
chmod 600 "$WG_CONF"

# systemd's own "is this unit active" bookkeeping can desync from the real
# kernel interface state (observed live: a prior successful `wg-quick up`
# left the interface healthy but systemctl later reported it inactive), so
# "restart" is unsafe to call blindly, it can hit wg-quick's own
# "wg0 already exists" failure against an interface systemd thinks is down.
# Base the decision on the kernel's own view (ip link) instead, and when a
# reload is genuinely needed, tear the interface down by force before
# bringing it back up rather than trusting a plain restart to sequence that
# correctly.
bring_up_wg0() {
  if [ "$CONFIG_CHANGED" = "0" ] && ip link show wg0 >/dev/null 2>&1; then
    echo "wg0 interface already up with matching config, leaving it running"
    return 0
  fi
  wg-quick down wg0 >/dev/null 2>&1 || true
  ip link delete wg0 >/dev/null 2>&1 || true
  systemctl start wg-quick@wg0
}

if [ "$ROLE" = "catcher" ]; then
  # ensure_iptables_rule <chain> <rule args...>
  # No-op if the rule already exists. Otherwise inserts it right before the
  # chain's catch-all REJECT/DROP rule if one exists (a rule appended after
  # a catch-all REJECT never runs), else appends normally.
  ensure_iptables_rule() {
    local chain="$1"
    shift
    if iptables -C "$chain" "$@" 2>/dev/null; then
      return 0
    fi
    local reject_line
    reject_line="$(iptables -L "$chain" --line-numbers -n 2>/dev/null | awk '$1 ~ /^[0-9]+$/ && /REJECT|DROP/ {print $1; exit}')"
    if [ -n "$reject_line" ]; then
      iptables -I "$chain" "$reject_line" "$@"
    else
      iptables -A "$chain" "$@"
    fi
  }

  # ensure_nat_rule <chain> <rule args...>, check then append, nat table
  # has no catch-all REJECT to insert ahead of.
  ensure_nat_rule() {
    local chain="$1"
    shift
    iptables -t nat -C "$chain" "$@" 2>/dev/null || iptables -t nat -A "$chain" "$@"
  }

  echo "==> [4/$TOTAL_STEPS] DNAT public UDP 19132 to ${WG_PEER_ADDRESS}"
  ensure_nat_rule PREROUTING -p udp --dport 19132 -j DNAT --to-destination "${WG_PEER_ADDRESS}:19132"
  ensure_nat_rule POSTROUTING -d "${WG_PEER_ADDRESS}/32" -p udp --dport 19132 -j MASQUERADE

  echo "==> [5/$TOTAL_STEPS] FORWARD/INPUT accept rules for wg0"
  ensure_iptables_rule INPUT -p udp --dport "${WG_LISTEN_PORT}" -j ACCEPT
  ensure_iptables_rule FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
  ensure_iptables_rule FORWARD -i wg0 -j ACCEPT
  ensure_iptables_rule FORWARD -o wg0 -j ACCEPT

  echo "==> [6/$TOTAL_STEPS] net.ipv4.ip_forward"
  if grep -q '^net\.ipv4\.ip_forward[[:space:]]*=[[:space:]]*1' /etc/sysctl.conf; then
    :
  elif grep -q '^net\.ipv4\.ip_forward[[:space:]]*=' /etc/sysctl.conf; then
    sed -i 's/^net\.ipv4\.ip_forward[[:space:]]*=.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
  elif grep -q '^#[[:space:]]*net\.ipv4\.ip_forward' /etc/sysctl.conf; then
    sed -i 's/^#[[:space:]]*net\.ipv4\.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
  else
    echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
  fi
  sysctl -w net.ipv4.ip_forward=1 >/dev/null

  echo "==> [7/$TOTAL_STEPS] iptables-persistent"
  if ! dpkg -s iptables-persistent >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
  fi
  netfilter-persistent save

  echo "==> [8/$TOTAL_STEPS] enabling + starting wg-quick@wg0"
  systemctl daemon-reload
  systemctl enable wg-quick@wg0
  bring_up_wg0

  echo "==> [9/$TOTAL_STEPS] status check"
  systemctl is-active wg-quick@wg0 || true
  wg show || true

  echo "==> [10/$TOTAL_STEPS] done"
else
  echo "==> [4/$TOTAL_STEPS] enabling + starting wg-quick@wg0"
  systemctl daemon-reload
  systemctl enable wg-quick@wg0
  bring_up_wg0

  echo "==> [5/$TOTAL_STEPS] status check"
  systemctl is-active wg-quick@wg0 || true
  wg show || true

  echo "==> [6/$TOTAL_STEPS] done"
fi

echo
echo "Own public key: ${PUBLIC_KEY}"
if [ "$FRESH_KEY" = "1" ]; then
  echo "This is a freshly generated key. Give this public key to the other box"
  echo "as its WG_PEER_PUBLIC_KEY before running this script there, the tunnel"
  echo "will not come up until both sides know each other's public key."
fi
