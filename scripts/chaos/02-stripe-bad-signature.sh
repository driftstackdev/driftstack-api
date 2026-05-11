#!/usr/bin/env bash
# V-659 (V-547.B) — Scenario 2: Stripe webhook with bad signature.
#
# Expected:
#   - /v1/webhooks/stripe returns 401 (Unauthorized) on bad sig.
#   - No state mutation.
#
# This scenario is the lowest-risk rehearsal — pure HTTP, no
# infrastructure manipulation. Safe to run in CI on every PR.

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO=02
NAME=stripe-bad-signature
log_step "Scenario $SCENARIO ($NAME) — starting in CHAOS_MODE=$CHAOS_MODE"

# A well-formed-ish Stripe event body but a forged signature.
BODY='{"id":"evt_chaos_002","object":"event","type":"customer.subscription.created","data":{"object":{}}}'
BAD_SIG='t=1700000000,v1=deadbeef00deadbeef00deadbeef00deadbeef00deadbeef00deadbeef00dead'

if ! assert_http_status 401 "$API_BASE/v1/webhooks/stripe" \
    -X POST \
    -H 'content-type: application/json' \
    -H "stripe-signature: $BAD_SIG" \
    -d "$BODY"; then
  emit_fail "$SCENARIO" "$NAME" "expected-401-on-bad-sig"
  exit 1
fi

# Also verify missing signature header → 401.
if ! assert_http_status 401 "$API_BASE/v1/webhooks/stripe" \
    -X POST \
    -H 'content-type: application/json' \
    -d "$BODY"; then
  emit_fail "$SCENARIO" "$NAME" "expected-401-on-missing-sig"
  exit 1
fi

emit_pass "$SCENARIO" "$NAME"
