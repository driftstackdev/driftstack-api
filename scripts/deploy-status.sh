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

declare -a TARGETS
case "${1:-}" in
  prod)    TARGETS=("prod") ;;
  staging) TARGETS=("staging") ;;
  "")      TARGETS=("staging" "prod") ;;
  *)       echo "usage: $0 [staging|prod]" >&2; exit 2 ;;
esac

for ENV in "${TARGETS[@]}"; do
  case "$ENV" in
    prod)    HOST="128.140.37.74"; PUBLIC_URL="https://api.driftstack.dev" ;;
    staging) HOST="116.203.22.197"; PUBLIC_URL="https://staging.driftstack.dev" ;;
  esac

  printf '\n\033[1;36m=== %s (%s) ===\033[0m\n' "$ENV" "$HOST"
  # /version from public URL — surfaces the actually-running SHA.
  VERSION=$(curl -fsS "$PUBLIC_URL/version" 2>/dev/null || echo "{}")
  GIT_SHA=$(echo "$VERSION" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("git_sha","?"))' 2>/dev/null || echo "?")
  STARTED=$(echo "$VERSION" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("started_at","?"))' 2>/dev/null || echo "?")

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
  echo "  /version           : git_sha=$GIT_SHA uptime=$UPTIME (since $STARTED)"

  # .last-good-sha — what revert-bridge would target.
  LAST_GOOD=$(ssh "root@${HOST}" "cat /opt/driftstack/api/.last-good-sha 2>/dev/null || echo '(none)'")
  echo "  .last-good-sha     : $LAST_GOOD"

  # Most recent boot-complete line — surfaces sentry/email/livekit/oauthClient flags.
  FLAGS=$(ssh "root@${HOST}" "journalctl -u driftstack-api --no-pager 2>/dev/null | grep '\"bootstrap complete\"' | tail -1 | grep -oE '\"sentry\":[a-z]+|\"email\":[a-z]+|\"livekit\":[a-z]+|\"oauthClient\":[a-z]+|\"env\":\"[a-z]+\"' | tr '\\n' ' '" || echo "(no boot log)")
  echo "  activation flags   : $FLAGS"

  # Last 3 deploy-history entries.
  echo "  recent deploys     :"
  ssh "root@${HOST}" "tail -3 /opt/driftstack/api/.deploy-history.log 2>/dev/null | sed 's/^/    /' || echo '    (no history yet)'"
done

echo
