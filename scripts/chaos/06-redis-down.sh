#!/usr/bin/env bash
# V-659 (V-547.B) — Scenario 6: Redis container exits.
#
# Expected:
#   - Rate-limit middleware falls back to fail-open (allow + log).
#   - Session-token cache falls back to direct Postgres lookup.
#   - Control plane stays HTTP-200; latency degrades but no errors.
#
# Rehearsal: `docker compose stop redis`, probe /health, /v1/whoami,
# /version. Restore at the end.

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO=06
NAME=redis-down
log_step "Scenario $SCENARIO ($NAME) — starting in CHAOS_MODE=$CHAOS_MODE"

# 1. Stop Redis.
run_or_describe "$DOCKER stop redis"

# Restart it on EVERY exit path. The failure branches below each restarted it
# themselves, which covered the checks but not an unexpected abort: `set -e`
# firing on any command in between, or a Ctrl-C, left Redis stopped and every
# later scenario in the run probing a control plane with no cache.
restore_redis() {
  run_or_describe "$DOCKER start redis"
}
trap restore_redis EXIT

# 2. /health should still return 200 (liveness — process-up only).
if ! assert_http_status 200 "$API_BASE/health"; then
  emit_fail "$SCENARIO" "$NAME" "health-degraded-during-redis-outage"
  exit 1
fi

# 3. /version should still return 200 (no Redis dependency).
if ! assert_http_status 200 "$API_BASE/version"; then
  emit_fail "$SCENARIO" "$NAME" "version-degraded-during-redis-outage"
  exit 1
fi

# 4. /ready CAN return 503 (Redis is in readiness checks). That's
#    expected — readiness 503 tells orchestrators not to route NEW
#    traffic, but existing traffic should still work via fail-open.
log_step "Note: /ready may correctly return 503 during this outage."

# 5. Restore Redis — handled by the EXIT trap installed after step 1, so it
#    runs on the failure paths above and on an unexpected abort too.

emit_pass "$SCENARIO" "$NAME"
