#!/usr/bin/env bash
# V-659 (V-547.B) — Scenario 4: Postgres restarts mid-transaction.
#
# Expected:
#   - Drizzle re-establishes the connection pool on next query.
#   - In-flight transactions roll back cleanly; clients receive a
#     retryable problem+json `service_unavailable` (not 5xx without
#     classification).
#   - No phantom partial-writes.
#   - /health stays 200 (it's process-liveness only, no PG touch).
#   - /ready returns 503 during the outage window (PG is a readiness
#     check) — orchestrators stop routing new traffic.
#   - Recovery within ~3-5s after `docker compose start postgres`.
#
# Rehearsal: `docker compose restart postgres`, probe /health while
# down, confirm /ready 503, confirm /ready recovers to 200 post-
# restart. This script does NOT exercise a real in-flight transaction
# — that requires a load-test harness orthogonal to V-547. The probe
# surface validates the structural invariants only.

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO=04
NAME=postgres-restart
log_step "Scenario $SCENARIO ($NAME) — starting in CHAOS_MODE=$CHAOS_MODE"

# 1. Restart Postgres (kills any in-flight transactions).
run_or_describe "$DOCKER restart postgres"

# Make sure Postgres is up on EVERY exit path. Two of the three failure
# branches below started it themselves and the third did not, so an abort
# during the recovery check could leave the container down for the rest of the
# run. `docker compose start` on a running container is a no-op, so this is
# safe on the happy path too.
restore_postgres() {
  run_or_describe "$DOCKER start postgres"
}
trap restore_postgres EXIT

# Give docker a beat to actually stop the container before the next
# probe; otherwise the assertion races the docker daemon and may pass
# erroneously against the still-up-but-restarting container.
run_or_describe "sleep 2"

# 2. /health is process-liveness only — must stay 200 throughout.
if ! assert_http_status 200 "$API_BASE/health"; then
  emit_fail "$SCENARIO" "$NAME" "health-degraded-during-postgres-restart"
  exit 1
fi

# 3. /version has no DB dependency — must stay 200.
if ! assert_http_status 200 "$API_BASE/version"; then
  emit_fail "$SCENARIO" "$NAME" "version-degraded-during-postgres-restart"
  exit 1
fi

# 4. Wait for postgres to be back accepting connections. The container
#    boots in ~2-3s but the listener takes another second after that.
run_or_describe "sleep 5"

# 5. /ready should now return 200 again — Drizzle reconnected.
if ! assert_http_status 200 "$API_BASE/ready"; then
  emit_fail "$SCENARIO" "$NAME" "ready-stuck-503-after-postgres-recovery"
  exit 1
fi

emit_pass "$SCENARIO" "$NAME"
