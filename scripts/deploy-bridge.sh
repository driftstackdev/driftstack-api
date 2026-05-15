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

# Resolve the expected SHA locally so the post-deploy verifier can
# confirm the public /version reports it. `main` resolves via git rev-
# parse so the verify step uses the same short SHA the SSH-side
# `git rev-parse --short HEAD` will compute. For a passed-through
# explicit SHA argument we don't shorten (verifier accepts
# prefix-match).
if [ "$SHA" = "main" ]; then
  EXPECTED_SHORT_SHA=$(git rev-parse --short main 2>/dev/null || echo "")
else
  EXPECTED_SHORT_SHA="$SHA"
fi

# Wall-clock timing for ops visibility — printed at the very end so
# operators can spot "this deploy took 2x normal" without grepping.
DEPLOY_STARTED_AT=$(date +%s)

# All work happens in /tmp/driftstack-deploy-<unix> on the host so we
# can atomic-swap at the end.
ssh "root@${HOST}" "set -euo pipefail; \
  STAMP=\$(date +%s); \
  BUILD_DIR=/tmp/driftstack-deploy-\$STAMP; \
  mkdir -p \$BUILD_DIR; \
  cd \$BUILD_DIR; \
  echo '[bridge] cloning…' >&2; \
  git clone --depth 50 https://github.com/driftstackdev/driftstack-api.git . > /dev/null 2>&1; \
  git checkout '$SHA'; \
  GIT_SHA=\$(git rev-parse --short HEAD); \
  echo \"[bridge] HEAD=\$GIT_SHA\" >&2; \
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
if [ -n "$EXPECTED_SHORT_SHA" ]; then
  echo "[bridge] post-deploy verify against $PUBLIC_URL (--expected-sha $EXPECTED_SHORT_SHA)" >&2
  node scripts/post-deploy-verify.mjs --base-url "$PUBLIC_URL" --expected-sha "$EXPECTED_SHORT_SHA"
else
  echo "[bridge] post-deploy verify against $PUBLIC_URL (no --expected-sha)" >&2
  node scripts/post-deploy-verify.mjs --base-url "$PUBLIC_URL"
fi

DEPLOY_ELAPSED=$(($(date +%s) - DEPLOY_STARTED_AT))
echo "[bridge] === $ENV deploy ($EXPECTED_SHORT_SHA) done in ${DEPLOY_ELAPSED}s ===" >&2
