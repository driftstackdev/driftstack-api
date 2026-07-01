#!/usr/bin/env bash
# V-278.B — Deploy the Fastify control-plane API to a Hetzner host.
#
# Usage:
#   infra/bootstrap/deploy-api.sh production   # → root@128.140.37.74
#   infra/bootstrap/deploy-api.sh staging      # → root@116.203.22.197
#
# Pre-requisites:
#   - bootstrap.sh has run on the target host (V-278.A).
#   - The agent's SSH key is authorized for `root` on the target.
#   - Local build is up-to-date (`npm run build` in repo root).
#   - `infra/env-templates/$ROLE.env` exists with REAL secrets
#     (NOT the .template; copy to a sibling, fill in REDACTED values).
#
# The script:
#   1. Verifies the target host responds + has bootstrap.sh artefacts.
#   2. Rsyncs the built monorepo (dist/ trees + package*.json) to
#      /opt/driftstack/api/.
#   3. Runs `npm ci --omit=dev --workspaces=false` to install just the
#      runtime deps (workspaces are pre-resolved into dist via tsc).
#   4. Writes /opt/driftstack/api/.env from the local template-copy.
#   5. Installs the systemd unit + the appropriate nginx vhost.
#   6. Reloads nginx, restarts driftstack-api, waits for health.
#
# Idempotent: re-running deploys the latest local build without
# downtime (systemd Restart=always + brief in-flight request loss
# during the restart; <1s by design).

set -euo pipefail

ROLE="${1:-}"
case "$ROLE" in
  production)
    HOST=128.140.37.74
    NGINX_VHOST=infra/nginx/api.driftstack.dev.conf
    NGINX_VHOST_NAME=api.driftstack.dev
    ;;
  staging)
    HOST=116.203.22.197
    NGINX_VHOST=infra/nginx/staging.driftstack.dev.conf
    NGINX_VHOST_NAME=staging.driftstack.dev
    ;;
  *)
    echo "usage: $0 {production|staging}" >&2
    exit 64
    ;;
esac

ENV_FILE_LOCAL="infra/env-templates/$ROLE.env"
if [ ! -f "$ENV_FILE_LOCAL" ]; then
  echo "✗ $ENV_FILE_LOCAL not found." >&2
  echo "  Copy infra/env-templates/$ROLE.env.template to $ENV_FILE_LOCAL" >&2
  echo "  and fill in the REDACTED secrets before deploying." >&2
  exit 65
fi

echo "=== V-278.B deploy (role=$ROLE, host=$HOST) ==="

# 1. Connectivity probe.
ssh -o ConnectTimeout=10 -o BatchMode=yes "root@$HOST" \
  'test -d /opt/driftstack/api && echo bootstrapped' >/dev/null \
  || { echo "✗ host not bootstrapped or SSH failed" >&2; exit 70; }

# 2. Build (monorepo).
echo "→ building monorepo (npm run build)"
npm run build --workspace @driftstack/server --if-present
npm run build --workspace @driftstack/api-types --if-present

# 3. Rsync. Preserve permissions; delete files removed locally.
#    Sends every workspace's package.json (npm needs all of them to
#    resolve the workspace graph) but only apps/server + packages/api-
#    types dist trees (the only runtime artefacts the API needs).
echo "→ rsync to $HOST:/opt/driftstack/api/"
rsync -az --delete \
  --include 'package.json' --include 'package-lock.json' \
  --include 'apps/' --include 'apps/*/' \
  --include 'apps/*/package.json' \
  --include 'apps/server/dist/***' \
  --include 'packages/' --include 'packages/*/' \
  --include 'packages/*/package.json' \
  --include 'packages/api-types/dist/***' \
  --include 'docs/' --include 'docs/legal/' --include 'docs/legal/*.md' \
  --exclude '*' \
  ./ "root@$HOST:/opt/driftstack/api/"

# 4. Install runtime deps + write .env + install unit/vhost.
echo "→ remote: npm ci --omit=dev"
# --ignore-scripts: the root prepare hook calls husky (dev-only); we
# don't want it on the host. Workspace lifecycle scripts are skipped
# too, but apps/server has no install/postinstall — only its build
# step (which we ran locally before rsync).
ssh "root@$HOST" 'cd /opt/driftstack/api && npm ci --omit=dev --ignore-scripts --no-audit --no-fund'

echo "→ remote: write .env"
scp -q "$ENV_FILE_LOCAL" "root@$HOST:/opt/driftstack/api/.env"
GIT_SHA=$(git rev-parse --short HEAD)
ssh "root@$HOST" "
  # Inject the actual deploy-time SHA over any PLACEHOLDER_GIT_SHA.
  if grep -q '^GIT_SHA=' /opt/driftstack/api/.env; then
    sed -i 's|^GIT_SHA=.*|GIT_SHA=$GIT_SHA|' /opt/driftstack/api/.env
  else
    echo 'GIT_SHA=$GIT_SHA' >> /opt/driftstack/api/.env
  fi
  chown driftstack:driftstack /opt/driftstack/api/.env
  chmod 600 /opt/driftstack/api/.env
"

echo "→ remote: install systemd unit + nginx vhost"
scp -q infra/systemd/driftstack-api.service \
  "root@$HOST:/etc/systemd/system/driftstack-api.service"
# Security fix (2026-07-01) — Cloudflare-only real-IP trust, both prod + staging
# (both are Cloudflare-proxied and both had the 0.0.0.0/0 origin-spoof gap; see
# infra/nginx/cloudflare-real-ip.conf for the full rationale). Installed BEFORE
# `nginx -t` runs below so the vhost's removal of its own set_real_ip_from is
# validated against the final config — conf.d/*.conf is auto-loaded at
# http-context (no explicit `include` needed in the vhost), same mechanism as
# ws_upgrade_map.conf below for the fleet vhost.
scp -q infra/nginx/cloudflare-real-ip.conf \
  "root@$HOST:/etc/nginx/conf.d/cloudflare-real-ip.conf"
scp -q "$NGINX_VHOST" \
  "root@$HOST:/etc/nginx/sites-available/$NGINX_VHOST_NAME.conf"
ssh "root@$HOST" "
  ln -sf /etc/nginx/sites-available/$NGINX_VHOST_NAME.conf \
         /etc/nginx/sites-enabled/$NGINX_VHOST_NAME.conf
  nginx -t
  systemctl daemon-reload
  systemctl enable driftstack-api
  systemctl restart driftstack-api
  systemctl reload nginx
"

# 4b. Fleet control-plane WS vhost (PRODUCTION only) — fleet.driftstack.dev is a DIRECT
# grey-cloud origin so the long-lived Mac-worker control WS isn't Cloudflare-mangled
# (the Code=57 / -1011 flap; bus W2863/W2866, the founder's sim-bug fix). Installed only
# when its Let's Encrypt cert is present (else `nginx -t` would fail on the missing cert
# and 502 the whole box); the $connection_upgrade map is always safe to drop in. If the
# cert is absent the workers fall back to the CF-proxied api. and the flap returns — so
# warn loudly with the one-time provisioning command instead of silently degrading.
if [ "$ROLE" = production ]; then
  echo "→ remote: install fleet.driftstack.dev control-WS vhost (cert-guarded)"
  scp -q infra/nginx/ws_upgrade_map.conf \
    "root@$HOST:/etc/nginx/conf.d/ws_upgrade_map.conf"
  scp -q infra/nginx/fleet.driftstack.dev.conf \
    "root@$HOST:/etc/nginx/sites-available/fleet.driftstack.dev.conf"
  ssh "root@$HOST" "
    if [ -f /etc/letsencrypt/live/fleet.driftstack.dev/fullchain.pem ]; then
      ln -sf /etc/nginx/sites-available/fleet.driftstack.dev.conf \
             /etc/nginx/sites-enabled/fleet.driftstack.dev.conf
      nginx -t
      systemctl reload nginx
      echo '✓ fleet.driftstack.dev control-WS vhost installed'
    else
      echo '⚠ fleet.driftstack.dev LE cert missing — fleet vhost NOT enabled (workers will'
      echo '  use the CF-proxied api. and the -1011 flap returns). Provision it, then re-run:'
      echo '    certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cf-dns-creds.ini -d fleet.driftstack.dev'
    fi
  "
fi

# 5. Health probe.
echo "→ remote: health probe"
for _i in 1 2 3 4 5; do
  if ssh "root@$HOST" 'curl -fsS http://127.0.0.1:7780/health' >/dev/null 2>&1; then
    echo "✓ /health OK"
    break
  fi
  sleep 2
done
ssh "root@$HOST" 'systemctl --no-pager -l status driftstack-api | head -20' || true

echo "=== V-278.B deploy complete (role=$ROLE) ==="
