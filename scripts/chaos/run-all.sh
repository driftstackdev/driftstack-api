#!/usr/bin/env bash
# V-659 (V-547.B) — chaos rehearsal runner.
#
# Iterates the scenario scripts in order, captures their PASS/FAIL
# lines, and reports a final summary. Inherits CHAOS_MODE from the
# environment (default dry-run).
#
# Usage:
#   scripts/chaos/run-all.sh                  # dry-run, prints what each scenario would do
#   CHAOS_MODE=execute scripts/chaos/run-all.sh   # actually run each scenario
#
# Exits non-zero if any scenario emits FAIL.

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHAOS_MODE="${CHAOS_MODE:-dry-run}"
export CHAOS_MODE

SCENARIOS=(
  01-postmark-outage
  02-stripe-bad-signature
  03-nowpayments-bad-signature
  04-postgres-restart
  06-redis-down
)

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LINES=()

for slug in "${SCENARIOS[@]}"; do
  printf '\n=== Scenario: %s (mode=%s) ===\n' "$slug" "$CHAOS_MODE" >&2
  if RESULT=$("$SCRIPT_DIR/$slug.sh"); then
    printf '%s\n' "$RESULT"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAIL_LINES+=("$slug")
  fi
done

printf '\n=== Summary (mode=%s) ===\n' "$CHAOS_MODE"
printf '  pass: %d\n' "$PASS_COUNT"
printf '  fail: %d\n' "$FAIL_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  for f in "${FAIL_LINES[@]}"; do printf '    - %s\n' "$f"; done
  exit 1
fi
