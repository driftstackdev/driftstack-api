#!/usr/bin/env bash
# V-278.L — Upstash Redis prod/staging split cutover.
#
# Sister script to v278k-neon-split-cutover.sh. Today prod + staging
# share one Upstash Redis instance (REDIS_URL); this script splits
# them: provisions two separate Upstash databases, swaps REDIS_URL on
# each server.
#
# Risk profile differs from V-278.K:
#   - Redis holds rate-limit buckets (V-016), cli-authorize codes
#     (V-266), and the auth-cache (V-237). All three are recoverable:
#       rate-limit: empty bucket = full token allowance, safe.
#       cli-authorize: codes expire in 5min anyway, any in-flight
#         flow restarts cleanly.
#       auth-cache: misses fall through to Postgres, slower but
#         correct.
#   - No data migration needed — new instances start empty by design.
#   - Risk is mostly "did we typo the new REDIS_URL?"; the post-
#     restart /health poll catches that.
#
# Pre-reqs:
#   - Upstash account with two databases provisioned (driftstack-prod-
#     redis + driftstack-staging-redis) in the same region as the
#     Neon dbs (V-278.K → aws-eu-central-1, EU GDPR posture).
#   - Per-database TLS endpoints from the Upstash console:
#       NEW_PROD_REDIS_URL=rediss://default:<token>@<host>:6379
#       NEW_STAGING_REDIS_URL=rediss://default:<token>@<host>:6379
#   - SSH access (pre-authorized 2026-05-12).
#
# Modes:
#   --dry-run   default; print every command, write nothing
#   --execute   actually fire each step
#
# Each phase emits a step number + a confirmation prompt (in execute
# mode). The 7-day rollback window is preserved by not deleting the
# old shared Upstash database until day 8.

set -eo pipefail
# Env vars referenced below (NEW_PROD_REDIS_URL etc.) are populated
# mid-flight by the operator between steps; deliberately not -u so
# dry-run can print the steps before they're known.

MODE="${MODE:-dry-run}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --execute) MODE=execute; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()   { printf '\033[1;34m[v278l]\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[1;33m[v278l]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m[v278l]\033[0m %s\n' "$*" >&2; exit 1; }

step() {
  local n="$1"; shift
  printf '\n\033[1;36m=== Step %s ===\033[0m %s\n' "$n" "$*" >&2
  if [[ "$MODE" == "execute" ]]; then
    printf 'Proceed? [y/N] ' >&2
    read -r ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || fail "aborted at step $n"
  fi
}

dry_or_run() {
  if [[ "$MODE" == "dry-run" ]]; then
    log "DRY: $*"
  else
    log "EXEC: $*"
    eval "$@"
  fi
}

# ─── phase 1: pre-flight discovery ───────────────────────────────
step 1 "Confirm both new Upstash databases exist + capture endpoints"
dry_or_run "echo 'Visit https://console.upstash.com/redis, copy the rediss:// endpoint for each new db into NEW_PROD_REDIS_URL + NEW_STAGING_REDIS_URL'"
dry_or_run "test -n \"\$NEW_PROD_REDIS_URL\" || (echo 'error: NEW_PROD_REDIS_URL unset' >&2; exit 1)"
dry_or_run "test -n \"\$NEW_STAGING_REDIS_URL\" || (echo 'error: NEW_STAGING_REDIS_URL unset' >&2; exit 1)"

# ─── phase 2: ping the new instances to confirm reachability ─────
step 2 "Ping the new prod Redis with PING (proves TLS + auth)"
dry_or_run "redis-cli -u \"\$NEW_PROD_REDIS_URL\" PING"
step 3 "Ping the new staging Redis with PING"
dry_or_run "redis-cli -u \"\$NEW_STAGING_REDIS_URL\" PING"

# ─── phase 3: SSH-swap REDIS_URL ─────────────────────────────────
# No data migration needed — Redis holds rate-limit buckets (V-016),
# cli-authorize codes (V-266), and auth-cache (V-237). All three
# self-heal: empty buckets = full allowance, expired cli codes
# restart cleanly (5-min TTL), cache misses fall through to PG.
step 4 "SSH-swap REDIS_URL on prod (128.140.37.74)"
dry_or_run "ssh root@128.140.37.74 \"sed -i.bak 's|^REDIS_URL=.*|REDIS_URL=$NEW_PROD_REDIS_URL|' /opt/driftstack/api/.env && chmod 600 /opt/driftstack/api/.env && systemctl restart driftstack-api && sleep 3 && systemctl is-active driftstack-api\""
step 5 "SSH-swap REDIS_URL on staging (116.203.22.197)"
dry_or_run "ssh root@116.203.22.197 \"sed -i.bak 's|^REDIS_URL=.*|REDIS_URL=$NEW_STAGING_REDIS_URL|' /opt/driftstack/api/.env && chmod 600 /opt/driftstack/api/.env && systemctl restart driftstack-api && sleep 3 && systemctl is-active driftstack-api\""

# ─── phase 4: smoke ──────────────────────────────────────────────
step 6 "Smoke test prod /health + /v1/status — Redis-touching paths"
dry_or_run "node scripts/post-deploy-verify.mjs --base-url https://api.driftstack.dev"
step 7 "Smoke test staging /health + /v1/status"
dry_or_run "node scripts/post-deploy-verify.mjs --base-url https://staging.driftstack.dev"

# ─── phase 5: 7-day rollback window ──────────────────────────────
step 8 "Note 7-day rollback window — keep old shared Upstash db active until day 8 then delete via Upstash console"
log "Old shared REDIS_URL preserved as REDIS_URL_PRE_V278L on both /opt/driftstack/api/.env.bak files (auto-created by sed -i.bak)"

log "v278l cutover complete (mode=$MODE)"
