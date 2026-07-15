#!/usr/bin/env bash
# V-278 / V-667.C — manual-deploy bridge for the systemd+node Hetzner
# servers (until .github/workflows/deploy.yml is rewritten per the
# docs/internal/2026-05-15-deploy-pipeline-mismatch.md verdict).
#
# Today: prod runs systemd + bare node at /opt/driftstack/api, and the
# deploy.yml docker-compose path doesn't apply (no docker on the box,
# no /opt/driftstack/.env, no compose file). All Track A/B/E/H/C code
# is on origin but the deployed binary is from 2026-05-08.
#
# This script bridges the gap: SSH to a host, fresh-clone the repo to
# a tmp dir, build, atomic-swap the new dist + packages + node_modules
# into /opt/driftstack/api, restart the api service, verify /health.
#
# Idempotent + reversible: the previous /opt/driftstack/api/dist is
# renamed to dist.bak before the new build is moved into place. On
# any post-restart /health failure, the script atomic-swaps back +
# restarts.
#
# Usage:
#   ./scripts/deploy-bridge.sh staging      # deploys main HEAD to staging
#   ./scripts/deploy-bridge.sh prod         # deploys main HEAD to prod
#   ./scripts/deploy-bridge.sh staging <SHA>  # deploys a specific SHA
#
# Pre-reqs:
#   - SSH access to root@<host> (autopilot pubkey appended 2026-05-12)
#   - git + Node 22 + npm available on the host (verified 2026-05-15)
#
# WARNING: production rollouts are gated on staging being green for
# at least 60 minutes per V-507 founder posture. The script does not
# enforce this — operator's responsibility.

set -euo pipefail

# Every SSH-family operation shares one fail-closed transport policy. Batch mode
# prevents an unattended deploy from waiting for a password/passphrase prompt;
# connect timeout bounds setup; protocol keepalives terminate a half-open client
# after roughly 30 seconds without a server response. Keep both wrappers on this
# one array so preflight, bundle copy, mutation and metadata calls cannot drift.
readonly -a SSH_TRANSPORT_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=8
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
)

run_ssh() {
  command ssh "${SSH_TRANSPORT_OPTIONS[@]}" "$@"
}

run_scp() {
  command scp "${SSH_TRANSPORT_OPTIONS[@]}" "$@"
}

ENV="${1:-}"
SHA="${2:-main}"

case "$ENV" in
  prod) HOST="128.140.37.74"; PUBLIC_URL="https://api.driftstack.dev" ;;
  staging) HOST="116.203.22.197"; PUBLIC_URL="https://staging.driftstack.dev" ;;
  *)
    echo "usage: $0 <staging|prod> [<git-sha>]" >&2
    exit 2
    ;;
esac

echo "=== deploy-bridge: $ENV ($HOST) → $SHA ===" >&2

# Pre-flight: refuse to deploy to staging if its DATABASE_URL resolves
# to the same Neon host as prod. The 2026-05-19 Slice E audit surfaced
# that both /opt/driftstack/api/.env files pointed at the SAME Neon
# project (ep-aged-pond-al77cutb.../neondb). That means a staging
# rehearsal of a destructive migration would hit prod immediately —
# zero DB isolation despite distinct Hetzner hosts.
#
# Override with DEPLOY_SKIP_STAGING_DB_ISOLATION_CHECK=1 (e.g., during
# the migration window when staging is intentionally pointed at the
# prod DB for one-shot rehearsal). DO NOT habit-form this — fix the
# .env to point at a separate Neon project per the Slice E
# remediation path.
if [ "$ENV" = "staging" ] && [ "${DEPLOY_SKIP_STAGING_DB_ISOLATION_CHECK:-0}" != "1" ]; then
  PROD_DB_HOST=$(run_ssh root@128.140.37.74 \
    "grep '^DATABASE_URL=' /opt/driftstack/api/.env 2>/dev/null | cut -d= -f2- | cut -d'@' -f2 | cut -d/ -f1" 2>/dev/null || echo "")
  STAGING_DB_HOST=$(run_ssh root@116.203.22.197 \
    "grep '^DATABASE_URL=' /opt/driftstack/api/.env 2>/dev/null | cut -d= -f2- | cut -d'@' -f2 | cut -d/ -f1" 2>/dev/null || echo "")
  if [ -z "$PROD_DB_HOST" ] || [ -z "$STAGING_DB_HOST" ]; then
    echo "[bridge] ERROR: could not verify staging DB isolation — refusing staging deploy" >&2
    echo "[bridge]   staging host present = $([ -n "$STAGING_DB_HOST" ] && echo yes || echo no)" >&2
    echo "[bridge]   prod host present    = $([ -n "$PROD_DB_HOST" ] && echo yes || echo no)" >&2
    exit 3
  fi
  if [ "$PROD_DB_HOST" = "$STAGING_DB_HOST" ]; then
    # Fail closed. The former warning allowed a regressed staging .env to run
    # the migration gate and migration apply against production on 2026-07-12.
    # An intentional one-shot rehearsal requires the explicit escape hatch
    # documented above; ordinary deploys must never normalize shared storage.
    echo "[bridge] ERROR: staging+prod DBs match — refusing staging deploy" >&2
    echo "[bridge]   staging .env DATABASE_URL host = $STAGING_DB_HOST" >&2
    echo "[bridge]   prod    .env DATABASE_URL host = $PROD_DB_HOST" >&2
    echo "[bridge]   Expected post-ARC-2 (2026-05-19): staging = ep-lingering-math, prod = ep-aged-pond" >&2
    echo "[bridge]   See docs/internal/2026-05-19-staging-and-prod-share-neondb.md §RESOLVED" >&2
    exit 3
  fi
fi

# Resolve the expected SHA locally so the post-deploy verifier can
# confirm the public /version reports it. `main` resolves via git rev-
# parse so the verify step uses the same short SHA the SSH-side
# `git rev-parse --short HEAD` will compute. For a passed-through
# explicit SHA argument we don't shorten (verifier accepts
# prefix-match).
if [ "$SHA" = "main" ]; then
  # The SSH-side clones origin's main, not the local checkout. Fetch
  # origin first so the EXPECTED_SHORT_SHA matches what the SSH-side
  # `git rev-parse --short HEAD` will compute — otherwise local-only
  # commits that haven't been pushed cause a spurious --expected-sha
  # mismatch even though the actual deploy succeeded.
  git fetch origin main --quiet 2>/dev/null || true
  EXPECTED_SHORT_SHA=$(git rev-parse --short origin/main 2>/dev/null || echo "")
else
  EXPECTED_SHORT_SHA="$SHA"
fi

# Wall-clock timing for ops visibility — printed at the very end so
# operators can spot "this deploy took 2x normal" without grepping.
DEPLOY_STARTED_AT=$(date +%s)

# Capture the SHA we're replacing so the post-deploy summary can
# show "X over Y" — answers "what did I just kick off?" without a
# separate SSH. Empty if no .last-good-sha existed yet (fresh server).
PREVIOUS_SHA=$(run_ssh "root@${HOST}" "cat /opt/driftstack/api/.last-good-sha 2>/dev/null || echo ''" 2>/dev/null || echo "")

# GitHub-independent deploy path (2026-06-09): when DEPLOY_VIA_BUNDLE=1 we ship
# the repo to the host as a git bundle over scp instead of having the host
# `git clone` from github.com. Needed because the GitHub account flag
# ("ineligible for transactions") blocks the host's clone (a read/pull) the same
# way it stalls Actions — so neither the auto-deploy NOR a plain deploy-bridge
# run can pull from GitHub until the flag clears (git PUSH still works, which is
# why this scp-the-bundle path does). The bundle is a full clone of origin/main
# (all history -> every rollback target intact), so the host ends up with a real
# git repo and the build/swap/rollback below are byte-identical to the GitHub
# path. Default (flag unset) still clones from GitHub.
if [ "${DEPLOY_VIA_BUNDLE:-0}" = "1" ]; then
  # Only recompute $SHA when the caller asked for the default ("main") — an
  # explicit $2 (e.g. revert-bridge.sh's last-good-sha rollback target) must
  # survive bundle mode, or the bundle silently ships origin/main HEAD (the
  # bad commit being reverted FROM) instead of the requested rollback SHA.
  if [ "$SHA" = "main" ]; then
    SHA=$(git rev-parse origin/main)
  fi
  echo "[bridge] GitHub-independent mode: bundling $SHA -> $HOST" >&2
  git branch -f __deploy_bundle_tmp "$SHA" >/dev/null 2>&1
  BUNDLE=$(mktemp -t ds-deploy.bundle)
  if ! git bundle create "$BUNDLE" __deploy_bundle_tmp >/dev/null 2>&1; then
    echo "[bridge] bundle create failed" >&2; git branch -D __deploy_bundle_tmp >/dev/null 2>&1; rm -f "$BUNDLE"; exit 1
  fi
  git branch -D __deploy_bundle_tmp >/dev/null 2>&1
  if ! run_scp -q "$BUNDLE" "root@${HOST}:/tmp/ds-deploy.bundle"; then
    echo "[bridge] scp bundle failed" >&2; rm -f "$BUNDLE"; exit 1
  fi
  rm -f "$BUNDLE"
  REMOTE_CLONE="git clone /tmp/ds-deploy.bundle . > /dev/null 2>&1"
else
  REMOTE_CLONE="git clone --depth 400 https://github.com/driftstackdev/driftstack-api.git . > /dev/null 2>&1"
fi

# All work happens in /tmp/driftstack-deploy-<unix> on the host so we
# can atomic-swap at the end.
run_ssh "root@${HOST}" "set -euo pipefail; \
  STAMP=\$(date +%s); \
  BUILD_DIR=/tmp/driftstack-deploy-\$STAMP; \
  mkdir -p \$BUILD_DIR; \
  cd \$BUILD_DIR; \
  echo '[bridge] cloning…' >&2; \
  # Source = GitHub clone (default) OR the scp'd bundle (DEPLOY_VIA_BUNDLE=1);
  # both leave a real git repo so checkout + rollback work identically. The
  # GitHub path uses --depth=400 to cover rollback targets the .last-good-sha
  # may point at (2026-05-19: --depth=50 couldn't reach a 4-day-back
  # last-good-sha; 400 commits ~= 1-2 weeks, cheap + generous). The bundle path
  # carries full origin/main history, so its rollback reach is unbounded.
  ${REMOTE_CLONE}; \
  git checkout '$SHA'; \
  GIT_SHA=\$(git rev-parse --short HEAD); \
  APP_VERSION=\$(node -p \"require('./apps/server/package.json').version\"); \
  if [[ ! \"\$APP_VERSION\" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?\$ ]]; then \
    echo \"[bridge] invalid server package version: \$APP_VERSION\" >&2; \
    exit 1; \
  fi; \
  echo \"[bridge] HEAD=\$GIT_SHA APP_VERSION=\$APP_VERSION\" >&2; \
  echo '[bridge] npm ci (lockfile-strict; include dev for build)' >&2; \
  npm ci --no-audit --include=dev > /tmp/deploy-install.log 2>&1 || (tail -50 /tmp/deploy-install.log; exit 1); \
  echo '[bridge] tsc --build api-types + webhook-delivery' >&2; \
  npx tsc --build packages/api-types packages/webhook-delivery; \
  echo '[bridge] npm run build --workspace=@driftstack/server' >&2; \
  npm run build --workspace=@driftstack/server > /tmp/deploy-build.log 2>&1 || (tail -50 /tmp/deploy-build.log; exit 1); \
  # NOT pruning dev deps — fresh npm-install diverges from lockfile + drops
  # transitive runtime deps like require-in-the-middle that the runtime
  # needs (caught 2026-05-15 first staging-deploy attempt). The runtime
  # image gets dev + prod deps; slightly bigger but matches lockfile
  # exactly. Acceptable until docker-compose deploy lands.
\
  # Pre-swap immutability + journal-integrity gate. Runs BEFORE the
  # atomic swap so a misconfigured journal aborts the deploy at the
  # gate, not at /health-poll-timeout-then-rollback (or worse, after a
  # half-applied schema). Catches: applied-row-hash drift, pending
  # journal entries with when <= max(DB.created_at) that drizzle-orm
  # 0.38.4 would silent-skip, journal/DB count mismatch. See the
  # 2026-05-19 migration-audit incident for the prevention rationale.
  echo '[bridge] migration-immutability + journal-integrity pre-gate' >&2; \
  # Subshell-scope the .env source so DATABASE_URL is exported to the
  # migration-check.mjs child without polluting the parent shell — the
  # parent has GIT_SHA set from line 91 (git rev-parse on the freshly-
  # cloned build dir, e.g. f9da041) and the .env on disk still has the
  # PRIOR deploy's GIT_SHA (e.g. b48f557). Pre-2026-05-19 16:00 UTC this
  # was \`set -a; source .env; set +a;\` in the parent shell which
  # overwrote \$GIT_SHA with the stale .env value, and the subsequent
  # \"GIT_SHA=\$GIT_SHA\" >> .env at line 138 below wrote the OLD sha
  # back into .env. Net: every deploy left .env with the previous
  # deploy's GIT_SHA, /version misreported, post-deploy-verify failed
  # the --expected-sha check, auto-revert flailed. Subshell isolates the
  # source so parent \$GIT_SHA stays correct.
  (set -a; source /opt/driftstack/api/.env; set +a; \
    node \$BUILD_DIR/scripts/migration-immutability-check.mjs > /tmp/deploy-mig-check.log 2>&1) \
    || (tail -30 /tmp/deploy-mig-check.log; exit 1); \
\
  echo '[bridge] swapping artefacts into /opt/driftstack/api' >&2; \
  cd /opt/driftstack/api; \
  for d in node_modules apps/server/dist apps/server/src/db/migrations packages/api-types packages/webhook-delivery; do \
    [ -e \"\$d\" ] && mv \"\$d\" \"\$d.bak.\$STAMP\" || true; \
  done; \
  mv \$BUILD_DIR/node_modules ./node_modules; \
  mkdir -p apps/server packages/api-types packages/webhook-delivery apps/server/src/db; \
  mv \$BUILD_DIR/apps/server/dist apps/server/dist; \
  mv \$BUILD_DIR/apps/server/src/db/migrations apps/server/src/db/migrations; \
  cp -r \$BUILD_DIR/packages/api-types/dist packages/api-types/dist || true; \
  cp -r \$BUILD_DIR/packages/api-types/package.json packages/api-types/; \
  cp -r \$BUILD_DIR/packages/webhook-delivery/dist packages/webhook-delivery/dist; \
  cp -r \$BUILD_DIR/packages/webhook-delivery/package.json packages/webhook-delivery/; \
  echo \"GIT_SHA=\$GIT_SHA\" >> /opt/driftstack/api/.env.deploy-marker; \
  # V-667.C-followup#2 — upsert GIT_SHA into /opt/driftstack/api/.env
  # so /version's git_sha actually reflects the deployed SHA. Old
  # behaviour baked GIT_SHA at the original /opt/driftstack/api
  # build time and never refreshed, so /version stayed stale across
  # bridge deploys. Idempotent: drops any existing GIT_SHA line and
  # appends the fresh value; preserves file permissions (chmod 600
  # driftstack:driftstack).
  sed -i '/^GIT_SHA=/d' /opt/driftstack/api/.env; \
  echo \"GIT_SHA=\$GIT_SHA\" >> /opt/driftstack/api/.env; \
  sed -i '/^APP_VERSION=/d' /opt/driftstack/api/.env; \
  echo \"APP_VERSION=\$APP_VERSION\" >> /opt/driftstack/api/.env; \
  chown driftstack:driftstack /opt/driftstack/api/.env; \
  chmod 600 /opt/driftstack/api/.env; \
  # V-667.C-followup — apply pending DB migrations BEFORE restart so
  # the new code never sees a schema older than itself. node + the
  # compiled migrate.js are pinned via DATABASE_URL from .env;
  # migrate.js bails non-zero on any failure, blocking the restart.
  echo '[bridge] applying DB migrations (idempotent)' >&2; \
  sudo -u driftstack bash -c 'set -a; source /opt/driftstack/api/.env; set +a; node /opt/driftstack/api/apps/server/dist/db/migrate.js' > /tmp/deploy-migrate.log 2>&1 \
    || (tail -30 /tmp/deploy-migrate.log; exit 1); \
  echo '[bridge] systemctl restart driftstack-api' >&2; \
  systemctl restart driftstack-api; \
  for i in 1 2 3 4 5 6 7 8 9 10; do \
    if curl -fsS http://127.0.0.1:7780/health > /dev/null 2>&1; then \
      echo \"[bridge] /health healthy on attempt \$i\" >&2; \
      curl -fsS http://127.0.0.1:7780/version 2>&1 | head -c 200; \
      echo; \
      echo \"[bridge] cleaning .bak.\$STAMP\" >&2; \
      find /opt/driftstack/api -maxdepth 4 -name '*.bak.'\$STAMP -exec rm -rf {} + 2>/dev/null || true; \
      rm -rf \$BUILD_DIR; \
      exit 0; \
    fi; \
    echo \"[bridge] attempt \$i: not healthy yet, sleeping 3s\" >&2; \
    sleep 3; \
  done; \
  echo '[bridge] /health never returned 200 — rolling back' >&2; \
  for d in node_modules apps/server/dist apps/server/src/db/migrations packages/api-types packages/webhook-delivery; do \
    [ -e \"\$d.bak.\$STAMP\" ] && rm -rf \"\$d\" && mv \"\$d.bak.\$STAMP\" \"\$d\" || true; \
  done; \
  systemctl restart driftstack-api; \
  exit 1"

# Post-deploy verification — runs locally against the public origin
# (not just the SSH-side localhost loopback). Catches route-registration
# regressions, openapi-spec gaps, version-SHA mismatch — anything the
# on-host /health-poll can't see.
#
# V-549.B auto-revert: post-deploy-verify FAIL → fire revert-bridge.sh
# against the previously-recorded .last-good-sha. Keeps prod hot at a
# known-passing SHA without operator intervention. Skip auto-revert
# when AUTO_REVERT=0 is passed (e.g. revert-bridge.sh itself shouldn't
# infinitely recurse on a bad last-good-sha).
set +e
if [ -n "$EXPECTED_SHORT_SHA" ]; then
  echo "[bridge] post-deploy verify against $PUBLIC_URL (--expected-sha $EXPECTED_SHORT_SHA)" >&2
  node scripts/post-deploy-verify.mjs --base-url "$PUBLIC_URL" --expected-sha "$EXPECTED_SHORT_SHA"
else
  echo "[bridge] post-deploy verify against $PUBLIC_URL (no --expected-sha)" >&2
  node scripts/post-deploy-verify.mjs --base-url "$PUBLIC_URL"
fi
VERIFY_EXIT=$?
set -e

DEPLOY_ELAPSED=$(($(date +%s) - DEPLOY_STARTED_AT))

if [ "$VERIFY_EXIT" -ne 0 ]; then
  echo "[bridge] === $ENV deploy ($EXPECTED_SHORT_SHA) FAILED post-deploy-verify after ${DEPLOY_ELAPSED}s ===" >&2
  if [ "${AUTO_REVERT:-1}" != "0" ]; then
    echo "[bridge] V-549.B auto-revert firing: bash scripts/revert-bridge.sh $ENV" >&2
    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    AUTO_REVERT=0 bash "$SCRIPT_DIR/revert-bridge.sh" "$ENV" || echo "[bridge] revert-bridge.sh ALSO failed — manual intervention required" >&2
  else
    echo "[bridge] AUTO_REVERT=0 — skipping auto-revert (operator must investigate)" >&2
  fi
  exit "$VERIFY_EXIT"
fi

if [ -n "$PREVIOUS_SHA" ] && [ "$PREVIOUS_SHA" != "$EXPECTED_SHORT_SHA" ]; then
  echo "[bridge] === $ENV deploy ($EXPECTED_SHORT_SHA over $PREVIOUS_SHA) done in ${DEPLOY_ELAPSED}s ===" >&2
else
  echo "[bridge] === $ENV deploy ($EXPECTED_SHORT_SHA) done in ${DEPLOY_ELAPSED}s ===" >&2
fi

# V-549 auto-rollback (skeleton) — only confirmed-healthy SHAs land in
# /opt/driftstack/api/.last-good-sha, so revert-bridge.sh always
# reverts to a SHA that previously passed all 8 post-deploy-verify
# invariants. Idempotent overwrite.
if [ -n "$EXPECTED_SHORT_SHA" ]; then
  run_ssh "root@${HOST}" "echo '$EXPECTED_SHORT_SHA' > /opt/driftstack/api/.last-good-sha && chown driftstack:driftstack /opt/driftstack/api/.last-good-sha"
  echo "[bridge] recorded $EXPECTED_SHORT_SHA as $ENV last-good-sha" >&2
fi

# Deploy-history audit log on the host — every successful deploy
# appends one line "<iso-utc> <SHA> <prev-SHA-or-fresh> <elapsed-s>".
# Useful for forensics ("what was running at 04:32 UTC?") + spotting
# recurring rollbacks (same SHA appearing as both new + previous in
# adjacent rows = thrash). Tail-only — no rotation needed; file is
# tiny (~80 bytes/deploy × ~10 deploys/day × 365 days ≈ 290 KB/year).
if [ -n "$EXPECTED_SHORT_SHA" ]; then
  run_ssh "root@${HOST}" "echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) $EXPECTED_SHORT_SHA ${PREVIOUS_SHA:-fresh} ${DEPLOY_ELAPSED}s\" >> /opt/driftstack/api/.deploy-history.log && chown driftstack:driftstack /opt/driftstack/api/.deploy-history.log"
fi
