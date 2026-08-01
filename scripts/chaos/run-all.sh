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
  set +e
  RESULT=$("$SCRIPT_DIR/$slug.sh")
  STATUS=$?
  set -e

  # Print the scenario's own output either way. This used to print only on
  # success, so a FAILING scenario had its reason= field discarded and the
  # summary named the slug with no indication of what went wrong — the one
  # moment the detail is worth having.
  [[ -n "$RESULT" ]] && printf '%s\n' "$RESULT"

  # A scenario counts as failed if it exited non-zero OR emitted a FAIL line.
  # Judging on exit status alone made the header's promise above false: a
  # scenario that emitted FAIL and then returned 0 was counted as a PASS and
  # the run reported all-green. Every scenario today pairs `emit_fail` with
  # `exit 1`, so the two agree — but nothing enforced that pairing, and the
  # aggregator is the wrong place to depend on it.
  FAIL_LINE=$(printf '%s' "$RESULT" | grep -m1 '^FAIL ' || true)
  if [[ $STATUS -ne 0 || -n "$FAIL_LINE" ]]; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAIL_LINES+=("${slug} (exit=${STATUS})${FAIL_LINE:+ ${FAIL_LINE}}")
  else
    PASS_COUNT=$((PASS_COUNT + 1))
  fi
done

printf '\n=== Summary (mode=%s) ===\n' "$CHAOS_MODE"
printf '  pass: %d\n' "$PASS_COUNT"
printf '  fail: %d\n' "$FAIL_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  for f in "${FAIL_LINES[@]}"; do printf '    - %s\n' "$f"; done
  exit 1
fi

# Explicit, so the exit status is this script's verdict rather than whatever
# the last command above happened to return.
exit 0
