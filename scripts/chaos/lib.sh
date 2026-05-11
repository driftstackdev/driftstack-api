#!/usr/bin/env bash
# V-659 (V-547.B) — chaos rehearsal shared helpers.
#
# Sourced by every scenario script. All output goes to stderr; the
# scenario emits a single line on stdout at the end:
#   "PASS scenario=<N> name=<slug>"  or  "FAIL scenario=<N> reason=<...>"
# so the runner (scripts/chaos/run-all.sh) can grep results without
# parsing the rehearsal log.

set -euo pipefail

CHAOS_MODE="${CHAOS_MODE:-dry-run}"

usage_chaos() {
  cat >&2 <<EOF
Chaos rehearsal script. Modes (env var CHAOS_MODE):
  dry-run  (default) — print the steps that would execute; touch nothing.
  execute  — actually perform the fault injection. Requires local docker
             compose + the control-plane running locally.

Common env vars:
  API_BASE   — URL of the control plane to probe (default http://localhost:3000)
  DOCKER     — docker compose command (default 'docker compose')
EOF
}

log_step()  { printf '\033[1;34m[chaos]\033[0m %s\n' "$*" >&2; }
log_warn()  { printf '\033[1;33m[chaos]\033[0m %s\n' "$*" >&2; }
log_ok()    { printf '\033[1;32m[chaos]\033[0m %s\n' "$*" >&2; }
log_fail()  { printf '\033[1;31m[chaos]\033[0m %s\n' "$*" >&2; }

API_BASE="${API_BASE:-http://localhost:3000}"
DOCKER="${DOCKER:-docker compose}"

run_or_describe() {
  # In dry-run mode, just print what would run. In execute mode, actually run it.
  if [[ "$CHAOS_MODE" == "dry-run" ]]; then
    log_step "DRY: $*"
    return 0
  fi
  log_step "EXEC: $*"
  eval "$@"
}

assert_http_status() {
  # assert_http_status <expected> <url> [curl-args...]
  local expected="$1"; shift
  local url="$1"; shift
  if [[ "$CHAOS_MODE" == "dry-run" ]]; then
    log_step "DRY: curl $url → expect HTTP $expected"
    return 0
  fi
  local actual
  actual=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url")
  if [[ "$actual" != "$expected" ]]; then
    log_fail "HTTP $expected expected, got $actual from $url"
    return 1
  fi
  log_ok "HTTP $actual from $url"
}

emit_pass() {
  # emit_pass <scenario-number> <slug>
  printf 'PASS scenario=%s name=%s\n' "$1" "$2"
}
emit_fail() {
  # emit_fail <scenario-number> <slug> <reason>
  printf 'FAIL scenario=%s name=%s reason=%s\n' "$1" "$2" "$3"
}
