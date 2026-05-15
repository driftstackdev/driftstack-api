#!/usr/bin/env bash
# V-659 / V-547.B — Scenario 3: NowPayments IPN webhook with bad sig.
#
# Parallel to scenario 02 (Stripe bad-sig) but exercises the V-487/
# V-666 NowPayments IPN handler. Validates that ops alerting catches
# forged inbound webhook attempts on the crypto rail.
#
# Expected:
#   - /v1/webhooks/nowpayments returns 401 (Unauthorized) on bad sig.
#   - No state mutation. The route only logs at warn-level with
#     component=nowpayments-webhooks (per W1039 drift-guard pin) so
#     ops dashboards can filter the failure mode.
#
# Pre-req: prod or staging has NOWPAYMENTS_IPN_SECRET wired (otherwise
# the route is unregistered + returns 404 instead of 401). Run after
# Track B env wire-up.
#
# Lowest-risk rehearsal — pure HTTP, no infrastructure manipulation.
# Safe to run in CI on every PR.

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO=03
NAME=nowpayments-bad-signature
log_step "Scenario $SCENARIO ($NAME) — starting in CHAOS_MODE=$CHAOS_MODE"

# A well-formed-ish NowPayments IPN body but a forged HMAC-SHA512
# signature. The hex string is the right length (128 chars for SHA-512)
# so the verifier's length-check passes; only the timingSafeEqual will
# reject it.
BODY='{"payment_id":"chaos_003","payment_status":"confirmed","order_id":"ord_chaos_003"}'
BAD_SIG=$(printf 'deadbeef%.0s' {1..16})

if ! assert_http_status 401 "$API_BASE/v1/webhooks/nowpayments" \
    -X POST \
    -H 'content-type: application/json' \
    -H "x-nowpayments-sig: $BAD_SIG" \
    -d "$BODY"; then
  emit_fail "$SCENARIO" "$NAME" "expected-401-on-bad-sig"
  exit 1
fi

# Same assertion against a missing-sig case — should also be 401
# (route treats missing-header the same as bad-sig per W1039 pin).
if ! assert_http_status 401 "$API_BASE/v1/webhooks/nowpayments" \
    -X POST \
    -H 'content-type: application/json' \
    -d "$BODY"; then
  emit_fail "$SCENARIO" "$NAME" "expected-401-on-missing-sig"
  exit 1
fi

emit_pass "$SCENARIO" "$NAME"
