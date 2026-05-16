#!/usr/bin/env bash
# V-549.B — manual revert to the last-known-good SHA on a target env.
#
# Companion to scripts/deploy-bridge.sh. After every successful
# deploy-bridge run (post-deploy-verify 8/8 OK), the bridge writes
# the deployed SHA into /opt/driftstack/api/.last-good-sha. This
# script reads that file and runs deploy-bridge.sh against the same
# env with --sha, forcing a fresh clone + build + atomic-swap +
# health-poll against the previously-confirmed-healthy SHA.
#
# Usage:
#   ./scripts/revert-bridge.sh staging
#   ./scripts/revert-bridge.sh prod
#
# Why a fresh clone + rebuild rather than swapping back to dist.bak.*?
# - dist.bak.* directories are cleaned up by deploy-bridge after a
#   successful health-poll (~10s post-restart). They survive only the
#   in-flight deploy that created them, so a revert hours later has
#   no .bak to swap from.
# - Rebuilding from the recorded SHA is slower (~60s) but the
#   reverted state is byte-identical to the original deploy's build
#   product. Same npm ci, same tsc --build, same atomic swap.

set -euo pipefail

ENV=""
DRY_RUN=0
TO_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --to-sha) TO_SHA="${2:-}"; shift 2 ;;
    prod|staging) ENV="$1"; shift ;;
    *) echo "usage: $0 [--dry-run] [--to-sha <sha>] <staging|prod>" >&2; exit 2 ;;
  esac
done

case "$ENV" in
  prod) HOST="128.140.37.74" ;;
  staging) HOST="116.203.22.197" ;;
  *)
    echo "usage: $0 [--dry-run] <staging|prod>" >&2
    exit 2
    ;;
esac

if [ -n "$TO_SHA" ]; then
  # Explicit operator override — use --to-sha and skip the .last-good
  # discovery. Useful when the last-good-sha is itself the regression
  # (e.g. a subtle bug shipped and passed the 10-invariant smoke).
  LAST_GOOD="$TO_SHA"
  echo "[revert] $ENV revert TARGET = $LAST_GOOD (from --to-sha)" >&2
else
  echo "[revert] reading $ENV last-good-sha…" >&2
  LAST_GOOD=$(ssh "root@${HOST}" "cat /opt/driftstack/api/.last-good-sha 2>/dev/null || echo ''")
  if [ -z "$LAST_GOOD" ]; then
    echo "[revert] no .last-good-sha on $HOST — nothing to revert to" >&2
    echo "[revert]   (the file is written by deploy-bridge.sh after a successful deploy;" >&2
    echo "[revert]    a fresh server / hand-touched .env will not yet have one)" >&2
    echo "[revert]   use --to-sha <sha> to explicitly target a SHA" >&2
    exit 1
  fi
fi

CURRENT=$(curl -fsS "https://$([ "$ENV" = "prod" ] && echo "api" || echo "staging").driftstack.dev/version" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("git_sha",""))' 2>/dev/null || echo "?")

echo "[revert] $ENV current /version git_sha = $CURRENT" >&2
echo "[revert] $ENV last-good-sha           = $LAST_GOOD" >&2

# Surface the last 5 deploy-history entries so the operator sees
# context — "thrashing on a bad SHA?" / "what was the deploy before
# the current one?" — without a separate SSH.
echo "[revert] recent $ENV deploy history (last 5):" >&2
ssh "root@${HOST}" "tail -5 /opt/driftstack/api/.deploy-history.log 2>/dev/null | sed 's/^/[revert]   /' >&2 || echo '[revert]   (no .deploy-history.log yet)' >&2"

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$CURRENT" = "$LAST_GOOD" ] || [ "${CURRENT:0:7}" = "${LAST_GOOD:0:7}" ]; then
    echo "[revert] DRY-RUN: current already matches last-good; no revert needed (exit 0)" >&2
    exit 0
  fi
  echo "[revert] DRY-RUN: current $CURRENT != last-good $LAST_GOOD — would fire bash scripts/deploy-bridge.sh $ENV $LAST_GOOD (exit 2 signals revert-required)" >&2
  exit 2
fi
echo "[revert] firing deploy-bridge $ENV $LAST_GOOD" >&2
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec bash "$SCRIPT_DIR/deploy-bridge.sh" "$ENV" "$LAST_GOOD"
