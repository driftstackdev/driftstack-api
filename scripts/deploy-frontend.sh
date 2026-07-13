#!/usr/bin/env bash
# deploy-frontend.sh -- safe Cloudflare Pages deploy for a frontend app (W587).
#
# WHY THIS EXISTS: the W586 production incident. The customer-dashboard +
# admin-panel embed the API base URL at BUILD time from PUBLIC_API_BASE_URL;
# its source default is `http://localhost:3000` (for local dev). Deploying via
# a bare `wrangler pages deploy dist` WITHOUT setting PUBLIC_API_BASE_URL shipped
# `apiBaseUrl="http://localhost:3000"` to production -> every login / account /
# billing call hit localhost -> prod login outage.
#
# This wrapper makes that impossible:
#   1. ALWAYS builds with PUBLIC_API_BASE_URL (defaults to the prod API).
#   2. For apps that embed the API base, ASSERTS the built output does NOT
#      contain a localhost API base AND DOES contain the intended one --
#      BEFORE the deploy. A misbuild aborts instead of shipping.
#   3. Then deploys to the correct Pages project slug.
#
# Usage:
#   scripts/deploy-frontend.sh <app>
#     app in customer-dashboard | admin-panel | status-site | marketing-site | docs | errors-site
#   PUBLIC_API_BASE_URL override respected (defaults to https://api.driftstack.dev).
set -euo pipefail

APP="${1:?usage: deploy-frontend.sh <app>}"
API_BASE="${PUBLIC_API_BASE_URL:-https://api.driftstack.dev}"

# slug = Cloudflare Pages project name; needs_api = embeds the API base at build.
case "$APP" in
  customer-dashboard) SLUG="driftstack-customer-dashboard"; NEEDS_API=1 ;;
  admin-panel)        SLUG="driftstack-admin-panel";         NEEDS_API=1 ;;
  status-site)        SLUG="driftstack-status";              NEEDS_API=1 ;;
  marketing-site)     SLUG="driftstack-marketing";           NEEDS_API=0 ;;
  docs)               SLUG="driftstack-docs";                NEEDS_API=0 ;;
  errors-site)        SLUG="driftstack-errors";              NEEDS_API=0 ;;
  *) echo "[deploy-frontend] unknown app: $APP" >&2; exit 1 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/$APP"
[ -d "$APP_DIR" ] || { echo "[deploy-frontend] no such app dir: $APP_DIR" >&2; exit 1; }
cd "$APP_DIR"

echo "[deploy-frontend] building $APP (PUBLIC_API_BASE_URL=$API_BASE)..."
if [ "$APP" = "errors-site" ]; then
  # errors-site is intentionally dependency-free and has no package.json.
  # Running `npm run build` from this directory walks up to the workspace root
  # and rebuilds every package instead of this site specifically.
  node build.mjs
else
  PUBLIC_API_BASE_URL="$API_BASE" npm run build
fi

if [ "$NEEDS_API" = "1" ]; then
  # ABORT if the build still embeds a localhost API base (the W586 footgun).
  # Two variable-name patterns: customer-dashboard/admin-panel embed it as
  # `apiBaseUrl`; status-site's Astro pages define:vars it as `API_BASE`
  # (grepped — status-site never contains the literal token `apiBaseUrl`, so
  # the original single-pattern check was structurally blind to a localhost
  # leak on that one app).
  if grep -rqE 'apiBaseUrl = "https?://localhost' dist/ 2>/dev/null || grep -rqE 'API_BASE = "https?://localhost' dist/ 2>/dev/null; then
    echo "[deploy-frontend] ABORT: $APP build still points at localhost -- PUBLIC_API_BASE_URL was not applied. NOT deploying." >&2
    exit 1
  fi
  # ABORT if the intended API base isn't present at all (wrong/empty build).
  if ! grep -rqF "$API_BASE" dist/ 2>/dev/null; then
    echo "[deploy-frontend] ABORT: $APP build does not contain $API_BASE. NOT deploying." >&2
    exit 1
  fi
  echo "[deploy-frontend] guard OK: $APP build embeds $API_BASE, no localhost leak."
fi

echo "[deploy-frontend] deploying $APP -> Pages project $SLUG..."
npx --no-install wrangler pages deploy dist --project-name="$SLUG" --branch=main --commit-dirty=true
echo "[deploy-frontend] done: $APP -> $SLUG"
