#!/usr/bin/env bash
# V-659 (V-547.B) — Scenario 1: Postmark unavailable for 5 minutes.
#
# Expected behaviour (per V-547 catalogue):
#   - Email-send service buffers messages to `pending_emails` table.
#   - Retry with exponential backoff (1m / 2m / 5m / 15m / 60m).
#   - After 5 retries → `failed` + admin alert.
#   - Control plane stays HTTP-200; signup flow queues verification email.
#
# Rehearsal:
#   1. Block api.postmarkapp.com (override /etc/hosts → 127.0.0.1).
#   2. Trigger a fresh signup against /v1/auth/signup.
#   3. Verify /health is 200.
#   4. Verify pending_emails row was created with kind=signup-verification.
#   5. Restore Postmark; observe retry succeed within next backoff window.
#
# CHAOS_MODE=execute performs the rehearsal for real (requires sudo for
# /etc/hosts edit). Default dry-run prints the steps without touching
# the host.

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO=01
NAME=postmark-outage
SIGNUP_EMAIL="chaos-rehearsal-${SCENARIO}-$(date +%s)@driftstack.test"

log_step "Scenario $SCENARIO ($NAME) — starting in CHAOS_MODE=$CHAOS_MODE"

# 1. Block Postmark DNS resolution.
run_or_describe "echo '127.0.0.1 api.postmarkapp.com' | sudo tee -a /etc/hosts"

# 2. Signup.
if ! assert_http_status 200 "$API_BASE/v1/auth/signup" \
    -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$SIGNUP_EMAIL\",\"password\":\"Chaos!RehearsalPasswd-1\"}"; then
  emit_fail "$SCENARIO" "$NAME" "signup-rejected"
  exit 1
fi

# 3. Control plane still healthy.
if ! assert_http_status 200 "$API_BASE/health"; then
  emit_fail "$SCENARIO" "$NAME" "control-plane-degraded"
  exit 1
fi

# 4. Pending email row should exist. Only verified in execute mode
#    because dry-run can't query the DB.
if [[ "$CHAOS_MODE" == "execute" ]]; then
  log_step "Verify pending_emails has a row for $SIGNUP_EMAIL"
  # Adjust connection string as needed; defaults to local dev compose.
  PSQL_URL="${PSQL_URL:-postgresql://driftstack:driftstack@localhost:5432/driftstack}"
  ROW_COUNT=$(psql "$PSQL_URL" -tAc \
    "SELECT COUNT(*) FROM pending_emails WHERE to_address = '$SIGNUP_EMAIL' AND status = 'pending';")
  if [[ "$ROW_COUNT" -ne 1 ]]; then
    emit_fail "$SCENARIO" "$NAME" "pending-row-not-created (count=$ROW_COUNT)"
    exit 1
  fi
  log_ok "pending_emails row present"
fi

# 5. Restore Postmark.
run_or_describe "sudo sed -i.bak '/api.postmarkapp.com/d' /etc/hosts"

emit_pass "$SCENARIO" "$NAME"
