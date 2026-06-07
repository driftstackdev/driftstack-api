#!/usr/bin/env bash
# V-262 — dev-bootstrap.sh: end-to-end dev key in one command.
#
# Spins through the same flow V-261 walked the founder through manually:
#   1. POST /v1/auth/signup → get debug_token (requires AUTH_EXPOSE_DEBUG_TOKEN=true)
#   2. POST /v1/auth/verify-email with that token → get a web session token
#   3. GET /v1/legal/documents → fetch the four current document hashes
#   4. POST /v1/legal/accept ×4 (tos, privacy, dpa, aup) with version + content_hash
#   5. POST /v1/api-keys with name + scopes:["read","write","account_owner"] → emit the plaintext key
#
# Prints the resulting API key, account_id, and the base URL to use in the
# GUI client wizard / SDK.
#
# Usage:
#   AUTH_EXPOSE_DEBUG_TOKEN=true npm run dev --workspace apps/server   # in another terminal
#   ./scripts/dev-bootstrap.sh
#
# Optional env overrides:
#   API_BASE       — default http://localhost:3000
#   EMAIL          — default founder-dev-$(date +%s)@local.test (unique per run)
#   PASSWORD       — default "correct horse battery staple"
#   KEY_NAME       — default "dev-bootstrap"
#
# Pre-launch only. The debug_token plumbing is gated on AUTH_EXPOSE_DEBUG_TOKEN
# in the server config; production deployments won't have this set.

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
EMAIL="${EMAIL:-founder-dev-$(date +%s)@local.test}"
PASSWORD="${PASSWORD:-correct horse battery staple}"
KEY_NAME="${KEY_NAME:-dev-bootstrap}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (brew install jq)" >&2
  exit 1
fi

if ! curl -sf "$API_BASE/v1/status" >/dev/null 2>&1; then
  echo "error: server not reachable at $API_BASE" >&2
  echo "  start it with: AUTH_EXPOSE_DEBUG_TOKEN=true npm run dev --workspace apps/server" >&2
  exit 1
fi

echo "▸ signup as $EMAIL"
SIGNUP=$(curl -sf -X POST "$API_BASE/v1/auth/signup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

VERIFY_TOKEN=$(echo "$SIGNUP" | jq -r '.debug_token // empty')
if [ -z "$VERIFY_TOKEN" ]; then
  echo "error: no debug_token in signup response — restart the server with AUTH_EXPOSE_DEBUG_TOKEN=true" >&2
  echo "  response: $SIGNUP" >&2
  exit 1
fi

echo "▸ verify email"
VERIFY=$(curl -sf -X POST "$API_BASE/v1/auth/verify-email" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$VERIFY_TOKEN\"}")

SESSION_TOKEN=$(echo "$VERIFY" | jq -r '.session.token')
ACCOUNT_ID=$(echo "$VERIFY" | jq -r '.session.account_id')

echo "▸ fetch legal-document hashes"
DOCS=$(curl -sf -H "authorization: Bearer $SESSION_TOKEN" "$API_BASE/v1/legal/documents")

for k in tos privacy dpa aup; do
  HASH=$(echo "$DOCS" | jq -r --arg k "$k" '.data[] | select(.document_key==$k) | .content_hash')
  VERSION=$(echo "$DOCS" | jq -r --arg k "$k" '.data[] | select(.document_key==$k) | .version')
  if [ -z "$HASH" ] || [ -z "$VERSION" ]; then
    echo "error: failed to find $k document in legal catalog" >&2
    exit 1
  fi
  echo "▸ accept $k v$VERSION"
  curl -sf -X POST "$API_BASE/v1/legal/accept" \
    -H "authorization: Bearer $SESSION_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"document_key\":\"$k\",\"version\":\"$VERSION\",\"content_hash\":\"$HASH\"}" \
    >/dev/null
done

echo "▸ create api key"
KEY=$(curl -sf -X POST "$API_BASE/v1/api-keys" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$KEY_NAME\",\"scopes\":[\"read\",\"write\",\"account_owner\"]}")

PLAINTEXT=$(echo "$KEY" | jq -r '.plaintext')

cat <<EOF

✓ dev account ready

  Email:      $EMAIL
  Account:    $ACCOUNT_ID
  Base URL:   $API_BASE
  API key:    $PLAINTEXT

Paste into the GUI client wizard (Self-hosted mode + the base URL above),
or export for SDK calls:

  export DRIFTSTACK_API_KEY="$PLAINTEXT"
  export DRIFTSTACK_BASE_URL="$API_BASE"

EOF
