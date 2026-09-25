#!/usr/bin/env bash
# V-278.K — Neon prod/staging split cutover.
#
# Today: prod + staging share one Neon project. This script splits
# them: provisions separate Neon projects, pg_dumps the shared db,
# restores into each, swaps DATABASE_URL on the respective server.
#
# Risk: the DATABASE_URL rotation is the highest-risk single step
# in the launch checklist (typo here means prod silently points at
# staging). Founder should drive this hands-on; the script automates
# the boilerplate around the manual decision points.
#
# Pre-reqs:
#   - neonctl CLI authenticated (NEON_API_KEY in env or `neonctl auth`)
#   - SSH keys appended to /root/.ssh/authorized_keys on both servers
#     (pre-authorized 2026-05-12 — see the internal 2026-05-15
#     session wrap-up notes)
#   - pg_dump + psql 16+ locally
#   - CURRENT_SHARED_PROJECT exported (the shared project id step 1 lists)
#
# Modes:
#   --dry-run   default; print every command, write nothing
#   --execute   actually fire each step
#
# Each phase emits a step number + a confirmation prompt (in execute
# mode); answering 'n' bails out early. The 7-day rollback window is
# preserved by not dropping the old shared Neon project until day 8.

set -eo pipefail
# Env vars referenced below (NEW_PROD_DATABASE_URL etc.) are
# populated mid-flight by the operator between steps; we deliberately
# do NOT set -u so dry-run can print the steps before they're known.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MODE="${MODE:-dry-run}"

# ─── argument parsing ────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --execute) MODE=execute; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── the database snapshot ───────────────────────────────────────
# Security sweep E-27 (2026-09-24). Step 4 dumps the WHOLE shared database. It
# used to go to the fixed path /tmp/v278k-snapshot.sql: 0644 under the default
# umask, so every other local account could read it, and nothing ever removed
# it. It now goes into a private directory (umask 077, mktemp -d) that is
# removed on every exit path, including an operator answering "n" part way
# through. Dry-run creates nothing.
SNAPSHOT_DIR=""
remove_snapshot() {
  if [[ -n "$SNAPSHOT_DIR" ]]; then rm -rf -- "$SNAPSHOT_DIR"; fi
}
trap remove_snapshot EXIT
# A signal must still reach the EXIT trap, or an interrupted run leaves the dump.
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [[ "$MODE" == "execute" ]]; then
  umask 077
  SNAPSHOT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/v278k.XXXXXXXX")
  SNAPSHOT="$SNAPSHOT_DIR/snapshot.sql"
else
  SNAPSHOT="<private temp dir>/snapshot.sql"
fi

log()   { printf '\033[1;34m[v278k]\033[0m %s\n' "$*" >&2; }
warn()  { printf '\033[1;33m[v278k]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m[v278k]\033[0m %s\n' "$*" >&2; exit 1; }

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

# ─── phase 1: discover current shared db ─────────────────────────
step 1 "Discover current shared Neon project + branch"
dry_or_run "neonctl projects list --output json | jq '.[] | {id, name, region_id}'"
# An environment variable, not a <PLACEHOLDER>: execute mode evals this line, and
# `<NAME>` there is an input redirect from a file called NAME, not a prompt.
dry_or_run "neonctl branches list --project-id \"\${CURRENT_SHARED_PROJECT:?set CURRENT_SHARED_PROJECT to the shared project id from step 1}\" --output json"

# ─── phase 2: provision new projects ─────────────────────────────
step 2 "Provision new Neon prod project (driftstack-prod, region aws-eu-central-1)"
dry_or_run "neonctl projects create --name driftstack-prod --region-id aws-eu-central-1"
step 3 "Provision new Neon staging project (driftstack-staging, region aws-eu-central-1)"
dry_or_run "neonctl projects create --name driftstack-staging --region-id aws-eu-central-1"

# ─── phase 3: dump shared + restore into both ────────────────────
step 4 "pg_dump the current shared db → a private temp dir (removed on exit)"
dry_or_run "pg_dump \"\$SHARED_DATABASE_URL\" --schema=public --no-owner --no-acl > \"$SNAPSHOT\""
step 5 "Restore the snapshot into the new prod project"
dry_or_run "psql \"\$NEW_PROD_DATABASE_URL\" < \"$SNAPSHOT\""
step 6 "Restore the snapshot into the new staging project"
dry_or_run "psql \"\$NEW_STAGING_DATABASE_URL\" < \"$SNAPSHOT\""

# ─── phase 4: SSH-swap DATABASE_URL ──────────────────────────────
# NOTE: the new URL is interpolated into a `sed 's|...|...|'` replacement
# below. sed treats an unescaped `&` in the replacement as "insert the
# whole matched line" — and Neon's standard connection strings commonly
# append `&channel_binding=require`, which would silently corrupt the
# written DATABASE_URL. Escape sed's replacement-special chars (\, &,
# and the `|` delimiter) before interpolating, and fail loudly instead
# of writing an empty DATABASE_URL= if the var was never set.
step 7 "SSH-swap DATABASE_URL on prod (128.140.37.74)"
dry_or_run "test -n \"\$NEW_PROD_DATABASE_URL\" || (echo 'error: NEW_PROD_DATABASE_URL unset' >&2; exit 1)"
ESCAPED_PROD_DATABASE_URL=$(printf '%s' "$NEW_PROD_DATABASE_URL" | sed -e 's/[\&|]/\\&/g')
dry_or_run "ssh root@128.140.37.74 \"sed -i.bak 's|^DATABASE_URL=.*|DATABASE_URL=$ESCAPED_PROD_DATABASE_URL|' /opt/driftstack/api/.env && chmod 600 /opt/driftstack/api/.env && systemctl restart driftstack-api && sleep 3 && systemctl is-active driftstack-api\""
step 8 "SSH-swap DATABASE_URL on staging (116.203.22.197)"
dry_or_run "test -n \"\$NEW_STAGING_DATABASE_URL\" || (echo 'error: NEW_STAGING_DATABASE_URL unset' >&2; exit 1)"
ESCAPED_STAGING_DATABASE_URL=$(printf '%s' "$NEW_STAGING_DATABASE_URL" | sed -e 's/[\&|]/\\&/g')
dry_or_run "ssh root@116.203.22.197 \"sed -i.bak 's|^DATABASE_URL=.*|DATABASE_URL=$ESCAPED_STAGING_DATABASE_URL|' /opt/driftstack/api/.env && chmod 600 /opt/driftstack/api/.env && systemctl restart driftstack-api && sleep 3 && systemctl is-active driftstack-api\""

# ─── phase 5: smoke ──────────────────────────────────────────────
step 9 "Smoke test prod /health + /v1/status"
dry_or_run "curl -fsS https://api.driftstack.dev/health"
dry_or_run "curl -fsS https://api.driftstack.dev/v1/status | jq .status"

# ─── phase 6: 7-day rollback window ──────────────────────────────
step 10 "Note 7-day rollback window — keep old shared project active until day 8 then delete via 'neonctl projects delete <OLD_SHARED_PROJECT>'"
log "Old shared DATABASE_URL preserved as DATABASE_URL_PRE_V278K on both /opt/driftstack/api/.env.bak"

log "v278k cutover complete (mode=$MODE)"
