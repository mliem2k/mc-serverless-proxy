#!/bin/bash
# Thin wrapper around age for the repo's secrets file (WireGuard keys, frp
# auth token). Does not invent a new workflow, it's just "age -r <recipient>"
# and "age -d -i <identity>" with the recipient and identity paths filled in
# for you and clear errors if either is missing. See secrets/README.md for
# the full walkthrough (generating an identity, encrypting, decrypting,
# sourcing the result before running scripts/provision_wireguard.sh).
#
# Usage:
#   scripts/secrets.sh encrypt <plaintext-file> <output.age>
#   scripts/secrets.sh decrypt <input.age>          # prints to stdout, redirect it yourself
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RECIPIENT_FILE="$REPO_ROOT/secrets/.age-recipient"
IDENTITY_FILE="${AGE_IDENTITY_FILE:-$HOME/.age/mc-serverless-proxy.txt}"

usage() {
  echo "Usage:" >&2
  echo "  $(basename "$0") encrypt <plaintext-file> <output.age>" >&2
  echo "  $(basename "$0") decrypt <input.age>" >&2
  exit 1
}

if ! command -v age >/dev/null 2>&1; then
  echo "ERROR: age is not installed or not on PATH. Install it first (e.g. brew install age)." >&2
  exit 1
fi

if [ "$#" -lt 1 ]; then
  usage
fi

CMD="$1"
shift

case "$CMD" in
  encrypt)
    [ "$#" -eq 2 ] || usage
    PLAINTEXT_FILE="$1"
    OUTPUT_FILE="$2"

    if [ ! -f "$PLAINTEXT_FILE" ]; then
      echo "ERROR: plaintext file not found: $PLAINTEXT_FILE" >&2
      exit 1
    fi

    if [ ! -f "$RECIPIENT_FILE" ]; then
      echo "ERROR: no recipient key at $RECIPIENT_FILE." >&2
      echo "Generate an age identity first with:" >&2
      echo "  age-keygen -o ~/.age/mc-serverless-proxy.txt" >&2
      echo "then copy the public key it prints (starts with age1) into $RECIPIENT_FILE." >&2
      exit 1
    fi

    RECIPIENT="$(tr -d '[:space:]' < "$RECIPIENT_FILE")"
    if [ -z "$RECIPIENT" ]; then
      echo "ERROR: $RECIPIENT_FILE is empty. Put a single age1... public key in it." >&2
      exit 1
    fi

    age -r "$RECIPIENT" -o "$OUTPUT_FILE" "$PLAINTEXT_FILE"
    echo "Encrypted $PLAINTEXT_FILE to $OUTPUT_FILE for recipient $RECIPIENT." >&2
    ;;

  decrypt)
    [ "$#" -eq 1 ] || usage
    INPUT_FILE="$1"

    if [ ! -f "$INPUT_FILE" ]; then
      echo "ERROR: encrypted file not found: $INPUT_FILE" >&2
      exit 1
    fi

    if [ ! -f "$IDENTITY_FILE" ]; then
      echo "ERROR: no age identity file at $IDENTITY_FILE." >&2
      echo "Generate one with:" >&2
      echo "  age-keygen -o ~/.age/mc-serverless-proxy.txt" >&2
      echo "then register the public key it prints (starts with age1) in secrets/.age-recipient" >&2
      echo "so future encrypts target your key. If you're not the one who encrypted the" >&2
      echo "existing secrets.age, ask whoever holds the matching identity to re-encrypt" >&2
      echo "for your new public key, or set AGE_IDENTITY_FILE to point at the right identity file." >&2
      exit 1
    fi

    age -d -i "$IDENTITY_FILE" "$INPUT_FILE"
    ;;

  *)
    usage
    ;;
esac
