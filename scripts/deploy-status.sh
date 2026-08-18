#!/usr/bin/env bash
# Show current deploy state of both servers — running SHA, last-good
# SHA, bootstrap activation flags, recent deploy-history.
#
# Read-only; safe to run anywhere with SSH access to the Hetzner
# hosts. Useful before firing revert-bridge.sh ("what am I about
# to revert from?") or after operator env-wires ("did my restart
# actually take?").
#
# Usage:
#   bash scripts/deploy-status.sh                    # both servers
#   bash scripts/deploy-status.sh staging            # just staging
#   bash scripts/deploy-status.sh prod               # just prod

set -euo pipefail

# Anchored to this script rather than $PWD so the build-age comparison below
# reads the right history when invoked from cron, a systemd unit, or another
# repo entirely.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Commits-behind-HEAD that --check tolerates. Overridable so an operator mid
# release train can raise it deliberately instead of learning to ignore a red.
MAX_BEHIND="${DEPLOY_MAX_BEHIND:-100}"

# How far a running build is behind this checkout, as "<commits> <built-date>".
# Either field is "?" when the sha is not an object this clone knows — a shallow
# or stale clone must not silently report "0 behind", which is the one answer
# that would be read as healthy.
#
# A function with two callers rather than inline code, so `--build-age` below
# can drive exactly what the deploy snapshot runs instead of a copy of it.
compute_build_age() {
  local sha="$1" behind="?" built="?"
  if [ "$sha" != "?" ] && [ -n "$sha" ] && git -C "$REPO_ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    behind=$(git -C "$REPO_ROOT" rev-list --count "${sha}..HEAD" 2>/dev/null || echo "?")
    built=$(git -C "$REPO_ROOT" log -1 --format=%cs "$sha" 2>/dev/null || echo "?")
  fi
  printf '%s %s\n' "$behind" "$built"
}

JSON=0
CHECK=0
QUIET=0
declare -a TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    # Print "<commits-behind> <built-date>" for a sha and exit. No network, no
    # SSH — exists so the build-age assertion can be tested against the real
    # implementation rather than a regex over this file.
    --build-age) compute_build_age "${2:-?}"; exit 0 ;;
    --json)  JSON=1; shift ;;
    --check) CHECK=1; shift ;;
    --quiet) QUIET=1; shift ;;
    prod)    TARGETS+=("prod"); shift ;;
    staging) TARGETS+=("staging"); shift ;;
    *)       echo "usage: $0 [--json] [--check] [--quiet] [--build-age <sha>] [staging|prod]" >&2; exit 2 ;;
  esac
done

# --quiet pairs with --check for cron usage. Suppresses the human
# snapshot; --check FAIL messages still escape to stderr; --json
# output still goes to stdout. Effectively: "exit code is the
# signal, output is for failures only".
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("staging" "prod")
fi

if [ "$JSON" -eq 1 ]; then
  printf '['
fi
FIRST=1
# V-549.B-followup — --check exits non-zero if any monitored
# activation flag drops to false on any target. Designed for cron /
# health-monitor wiring: `bash scripts/deploy-status.sh --check ||
# alert`.
CHECK_FAIL=0

for ENV in "${TARGETS[@]}"; do
  case "$ENV" in
    prod)    HOST="128.140.37.74"; PUBLIC_URL="https://api.driftstack.dev" ;;
    staging) HOST="116.203.22.197"; PUBLIC_URL="https://staging.driftstack.dev" ;;
  esac

  if [ "$JSON" -eq 0 ] && [ "$QUIET" -eq 0 ]; then
    printf '\n\033[1;36m=== %s (%s) ===\033[0m\n' "$ENV" "$HOST"
  fi
  # /version from public URL — surfaces the actually-running SHA.
  VERSION=$(curl -fsS "$PUBLIC_URL/version" 2>/dev/null || echo "{}")
  GIT_SHA=$(echo "$VERSION" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("git_sha","?"))' 2>/dev/null || echo "?")
  STARTED=$(echo "$VERSION" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("started_at","?"))' 2>/dev/null || echo "?")

  # How far the RUNNING build is behind this checkout. The SHA was already
  # printed and never judged, which is how prod ran a 34-day-old build for
  # 982 commits without anyone noticing — a datum nobody reads is not a
  # signal. Local git only; adds no network or SSH beyond the /version curl
  # above.
  read -r BEHIND BUILT <<<"$(compute_build_age "$GIT_SHA")"

  # Compute uptime in human-friendly format. Surfaces "did my restart
  # take?" (uptime < 30s after env-wire) + "is the process leaky?"
  # (uptime > weeks).
  UPTIME=$(python3 -c "
import sys, datetime
started = '$STARTED'
if started == '?':
    print('?')
    sys.exit()
try:
    s = datetime.datetime.fromisoformat(started.replace('Z', '+00:00'))
    delta = datetime.datetime.now(datetime.timezone.utc) - s
    secs = int(delta.total_seconds())
    if secs < 60: print(f'{secs}s')
    elif secs < 3600: print(f'{secs // 60}m')
    elif secs < 86400: print(f'{secs // 3600}h {(secs % 3600) // 60}m')
    else: print(f'{secs // 86400}d {(secs % 86400) // 3600}h')
except Exception:
    print('?')
" 2>/dev/null || echo "?")
  # .last-good-sha — what revert-bridge would target.
  LAST_GOOD=$(ssh "root@${HOST}" "cat /opt/driftstack/api/.last-good-sha 2>/dev/null || echo '(none)'")
  # Most recent boot-complete line — surfaces sentry/email/livekit/oauthClient flags.
  FLAGS=$(ssh "root@${HOST}" "journalctl -u driftstack-api --no-pager 2>/dev/null | grep '\"bootstrap complete\"' | tail -1 | grep -oE '\"sentry\":[a-z]+|\"email\":[a-z]+|\"livekit\":[a-z]+|\"oauthClient\":[a-z]+|\"env\":\"[a-z]+\"' | tr '\\n' ' '" || echo "(no boot log)")

  # Migration-count drift detection — compares the journal entry
  # count on disk to drizzle.__drizzle_migrations.count. Drift means
  # the migrate.js silent-skip class has bitten (see V-549.B
  # post-condition assertion).
  MIGRATION_DRIFT=$(ssh "root@${HOST}" "
    journal=/opt/driftstack/api/apps/server/src/db/migrations/meta/_journal.json
    expected=\$(grep -c '\"tag\":' \$journal 2>/dev/null || echo 0)
    actual=\$(sudo -u driftstack bash -c 'set -a; source /opt/driftstack/api/.env; set +a; psql \$DATABASE_URL -tA -c \"select count(*) from drizzle.__drizzle_migrations\" 2>/dev/null' || echo 0)
    if [ \"\$expected\" = \"\$actual\" ]; then
      echo \"\$expected/\$actual OK\"
    else
      echo \"DRIFT expected=\$expected actual=\$actual\"
    fi
  ")

  if [ "$JSON" -eq 0 ] && [ "$QUIET" -eq 0 ]; then
    echo "  /version           : git_sha=$GIT_SHA uptime=$UPTIME (since $STARTED)"
    echo "  build age          : $BEHIND commits behind HEAD (built $BUILT)"
    echo "  .last-good-sha     : $LAST_GOOD"
    echo "  activation flags   : $FLAGS"
    echo "  migrations         : $MIGRATION_DRIFT"
  fi

  # --check assertion #2: migration drift is a hard fail.
  if [ "$CHECK" -eq 1 ] && [[ "$MIGRATION_DRIFT" == DRIFT* ]]; then
    echo "  [check] FAIL — $ENV migration drift: $MIGRATION_DRIFT" >&2
    CHECK_FAIL=1
  fi

  # --check assertion: the running build is not far behind this checkout.
  #
  # The threshold is a POLICY choice, not a measurement — a deploy that lands
  # while someone is mid-review is legitimately a few commits behind. What is
  # not legitimate is a month of merged fixes that never shipped, which is the
  # state this assertion was written after finding.
  #
  # An UNKNOWN sha fails too. "I cannot tell you what is running" is not a
  # green readiness check; if this is a shallow clone, `git fetch --unshallow`
  # is the fix rather than a suppression.
  if [ "$CHECK" -eq 1 ]; then
    if [ "$BEHIND" = "?" ]; then
      echo "  [check] FAIL — $ENV running sha $GIT_SHA is unknown to this checkout; cannot judge build age" >&2
      CHECK_FAIL=1
    elif [ "$BEHIND" -gt "$MAX_BEHIND" ]; then
      echo "  [check] FAIL — $ENV is $BEHIND commits behind HEAD (built $BUILT, max $MAX_BEHIND)" >&2
      CHECK_FAIL=1
    fi
  fi

  # --check assertion: every monitored flag is "true". Catches a
  # post-restart regression where env vars were dropped or rotation
  # left a service mis-wired.
  if [ "$CHECK" -eq 1 ]; then
    for flag in sentry email livekit oauthClient; do
      if ! printf '%s' "$FLAGS" | grep -q "\"$flag\":true"; then
        echo "  [check] FAIL — \"$flag\":true not present in $ENV bootstrap log" >&2
        CHECK_FAIL=1
      fi
    done
  fi

  # Last 3 deploy-history entries.
  if [ "$JSON" -eq 0 ] && [ "$QUIET" -eq 0 ]; then
    echo "  recent deploys     :"
    ssh "root@${HOST}" "tail -3 /opt/driftstack/api/.deploy-history.log 2>/dev/null | sed 's/^/    /' || echo '    (no history yet)'"
  elif [ "$JSON" -eq 1 ]; then
    HISTORY=$(ssh "root@${HOST}" "tail -3 /opt/driftstack/api/.deploy-history.log 2>/dev/null || true" | python3 -c '
import sys, json
print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))
')
    if [ "$FIRST" -eq 0 ]; then printf ','; fi
    FIRST=0
    printf '{"env":"%s","host":"%s","git_sha":"%s","started_at":"%s","uptime":"%s","commits_behind_head":"%s","built_on":"%s","last_good_sha":"%s","migrations":"%s","recent_deploys":%s}' "$ENV" "$HOST" "$GIT_SHA" "$STARTED" "$UPTIME" "$BEHIND" "$BUILT" "$LAST_GOOD" "$MIGRATION_DRIFT" "$HISTORY"
  fi
done

if [ "$JSON" -eq 1 ]; then
  printf ']\n'
else
  echo
fi

# Exit non-zero if --check was passed and any target had a flag off.
if [ "$CHECK" -eq 1 ] && [ "$CHECK_FAIL" -ne 0 ]; then
  exit 1
fi
