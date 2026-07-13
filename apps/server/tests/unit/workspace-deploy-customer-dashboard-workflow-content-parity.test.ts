// W543.A — drift guard for /.github/workflows/deploy-customer-dashboard.yml.
// V-259 / V-278.B/F customer-dashboard Cloudflare Pages deploy. Drift
// here either drops the PUBLIC_API_BASE_URL fallback (would ship a
// dashboard pointing at localhost:3000 to production), changes the
// custom-domain anchor (would break the canonical app.driftstack.dev
// route), or widens the path-filter (would redeploy the dashboard
// on every backend-only commit).
//
//   • @astrojs/cloudflare adapter + Pages Functions (_worker.js)
//     for prerender=false pages.
//   • V-278.B/F PUBLIC_API_BASE_URL fallback to api.driftstack.dev.
//   • V-469 per-service Sentry (PUBLIC_SENTRY_DSN_DASHBOARD +
//     SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_RELEASE).
//   • Custom domain app.driftstack.dev via CF Pages CNAME.
//   • Path-filter trigger (apps/customer-dashboard/** + this
//     workflow + package.json + package-lock.json).
//   • cancel-in-progress: false (let deploys finish).
//   • CLOUDFLARE_DASHBOARD_PROJECT_NAME (distinct from marketing +
//     docs var names).
//   • V-259 founder runbook (section C).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/deploy-customer-dashboard.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W543.A /.github/workflows/deploy-customer-dashboard.yml content parity', () => {
  const body = read(LIB);

  it('Header pins static Astro output, Wrangler deployment, and narrow path filters', () => {
    expect(body).toMatch(/# Customer dashboard — deploy pipeline\./);
    expect(body).toMatch(
      /Builds the Astro app at\s*\n#\s*`apps\/customer-dashboard\/` as static Astro output/,
    );
    expect(body).toMatch(/`wrangler` CLI/);
    expect(body).not.toMatch(/_worker\.js|Pages Functions|@astrojs\/cloudflare/);
    expect(body).toMatch(/Path-filter triggers are deliberate/);
    expect(body).toMatch(/backend-only commits don't redeploy the dashboard\./);
  });

  it("Secret-gate + V-259 runbook + CLOUDFLARE_DASHBOARD_PROJECT_NAME framing pinned: 'CLOUDFLARE_API_TOKEN          — token with `Cloudflare Pages — Edit` permission.' + 'CLOUDFLARE_ACCOUNT_ID' + 'CLOUDFLARE_DASHBOARD_PROJECT_NAME — Cloudflare Pages project slug for the dashboard (e.g. `driftstack-customer-dashboard`).' + 'Pre-create the project in the CF dashboard before the first deploy.' + 'app.driftstack.dev → CNAME to the Pages project' + 'Founder runbook: section C of `docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md`.' — pinned so the Cloudflare-Pages-Edit-permission-token + DASHBOARD-specific-project-name-var (distinct from marketing CLOUDFLARE_PAGES_PROJECT_NAME and docs CLOUDFLARE_DOCS_PROJECT_NAME) + app.driftstack.dev-CNAME + V-259-section-C-runbook commitment survives", () => {
    expect(body).toMatch(/#\s+- CLOUDFLARE_API_TOKEN\s+— token with `Cloudflare Pages/);
    expect(body).toMatch(/#\s+— Edit` permission\./);
    expect(body).toMatch(/#\s+- CLOUDFLARE_ACCOUNT_ID\s+— Cloudflare account ID\./);
    expect(body).toMatch(/#\s+- CLOUDFLARE_DASHBOARD_PROJECT_NAME — Cloudflare Pages project/);
    expect(body).toMatch(/slug for the dashboard \(e\.g\./);
    expect(body).toMatch(/`driftstack-customer-dashboard`\)\./);
    expect(body).toMatch(/Pre-create the project in the CF/);
    expect(body).toMatch(/dashboard before the first deploy\./);
    expect(body).toMatch(/#\s+- app\.driftstack\.dev → CNAME to the Pages project/);
    expect(body).toMatch(/# Founder runbook: section C of/);
    expect(body).toMatch(
      /# `docs\/founder-actions\/v259-cloudflare-pages-all-projects-setup\.md`\./,
    );
  });

  it("Path-filter + environment binding framing pinned: 'name: Deploy customer dashboard' + 'paths: apps/customer-dashboard/** + .github/workflows/deploy-customer-dashboard.yml + package.json + package-lock.json' + 'workflow_dispatch' + 'concurrency: group: deploy-customer-dashboard-${{ github.ref }} + cancel-in-progress: false' + 'permissions: contents: read + deployments: write' + 'environment: name: customer-dashboard-production + url: https://app.driftstack.dev' — pinned so the 4-path-filter (app-dir + workflow + 2-root-manifest) + customer-dashboard-production env-binding + app.driftstack.dev URL + cancel-in-progress: FALSE commitment survives", () => {
    expect(body).toMatch(/^name: Deploy customer dashboard$/m);
    expect(body).toMatch(/- 'apps\/customer-dashboard\/\*\*'/);
    expect(body).toMatch(/- '\.github\/workflows\/deploy-customer-dashboard\.yml'/);
    expect(body).toMatch(/- 'package\.json'/);
    expect(body).toMatch(/- 'package-lock\.json'/);
    expect(body).toMatch(/workflow_dispatch:/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: deploy-customer-dashboard-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
    expect(body).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*deployments: write/);
    expect(body).toMatch(
      /environment:\s*\n\s*name: customer-dashboard-production\s*\n\s*url: https:\/\/app\.driftstack\.dev/,
    );
  });

  it("V-278.B/F PUBLIC_API_BASE_URL fallback + V-469 per-service Sentry framing pinned: '# V-278.B/F follow-up — bake the live API origin into the client bundle so the dashboard talks to api.driftstack.dev, not localhost:3000.' + 'PUBLIC_API_BASE_URL: ${{ vars.PUBLIC_API_BASE_URL || \\'https://api.driftstack.dev\\' }}' + '# V-469 — per-service Sentry. DSN is build-time-baked into client bundle; integration skips entirely when DSN unset. SENTRY_AUTH_TOKEN governs source-map upload (no-op when unset, runtime unaffected). All four are reused-or-shared with the marketing deploy.' + 'PUBLIC_SENTRY_DSN_DASHBOARD: ${{ secrets.PUBLIC_SENTRY_DSN_DASHBOARD }}' + 'SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}' + 'SENTRY_ORG: ${{ secrets.SENTRY_ORG }}' + 'SENTRY_RELEASE: ${{ github.sha }}' + 'GIT_SHA: ${{ github.sha }}' + 'npm run build --workspace apps/customer-dashboard' — pinned so the V-278.B/F api.driftstack.dev-fallback (not localhost:3000) + V-469 4-Sentry-env (DSN_DASHBOARD + AUTH_TOKEN + ORG + RELEASE) + GIT_SHA-passthrough + workspace-scoped-build commitment survives", () => {
    expect(body).toMatch(/# V-278\.B\/F follow-up — bake the live API origin into the/);
    expect(body).toMatch(/# client bundle so the dashboard talks to api\.driftstack\.dev,/);
    expect(body).toMatch(/# not localhost:3000\./);
    expect(body).toMatch(
      /PUBLIC_API_BASE_URL: \$\{\{ vars\.PUBLIC_API_BASE_URL \|\| 'https:\/\/api\.driftstack\.dev' \}\}/,
    );
    expect(body).toMatch(/# V-469 — per-service Sentry\. DSN is build-time-baked into/);
    expect(body).toMatch(/# client bundle; integration skips entirely when DSN unset\./);
    expect(body).toMatch(/# SENTRY_AUTH_TOKEN governs source-map upload \(no-op when/);
    expect(body).toMatch(/# unset, runtime unaffected\)\. All four are reused-or-shared/);
    expect(body).toMatch(/# with the marketing deploy\./);
    expect(body).toMatch(
      /PUBLIC_SENTRY_DSN_DASHBOARD: \$\{\{ secrets\.PUBLIC_SENTRY_DSN_DASHBOARD \}\}/,
    );
    expect(body).toMatch(/SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/);
    expect(body).toMatch(/SENTRY_ORG: \$\{\{ secrets\.SENTRY_ORG \}\}/);
    expect(body).toMatch(/SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
    expect(body).toMatch(/GIT_SHA: \$\{\{ github\.sha \}\}/);
    expect(body).toMatch(/run: npm run build --workspace apps\/customer-dashboard/);
  });

  it('wrangler deploy + graceful-skip + actionable-project-name-error framing pinned: \'PROJECT_NAME: ${{ vars.CLOUDFLARE_DASHBOARD_PROJECT_NAME }}\' + \'if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then echo "CLOUDFLARE_API_TOKEN unset — skipping Cloudflare Pages upload."; echo "Build artifact is at apps/customer-dashboard/dist/ and verified above."; exit 0; fi\' + \'if [ -z "${PROJECT_NAME}" ]; then echo "CLOUDFLARE_DASHBOARD_PROJECT_NAME variable unset — set as a repo variable in Settings → Variables."; exit 1; fi\' + \'npx --yes wrangler@^3 pages deploy apps/customer-dashboard/dist --project-name=${PROJECT_NAME} --branch=${GITHUB_REF_NAME} --commit-hash=${GITHUB_SHA} --commit-message=${GITHUB_SHA::8} — $(git log -1 --pretty=%s)\' — pinned so the wrangler@^3 + 4-flag-deploy (project-name + branch + commit-hash + commit-message) + 8-char-sha + git-log-subject-line + graceful-skip-on-missing-token + hard-fail-with-actionable-msg-on-missing-project-var commitment survives', () => {
    expect(body).toMatch(/PROJECT_NAME: \$\{\{ vars\.CLOUDFLARE_DASHBOARD_PROJECT_NAME \}\}/);
    expect(body).toMatch(/if \[ -z "\$\{CLOUDFLARE_API_TOKEN\}" \]; then/);
    expect(body).toMatch(/echo "CLOUDFLARE_API_TOKEN unset — skipping Cloudflare Pages upload\."/);
    expect(body).toMatch(
      /echo "Build artifact is at apps\/customer-dashboard\/dist\/ and verified above\."/,
    );
    expect(body).toMatch(/if \[ -z "\$\{PROJECT_NAME\}" \]; then/);
    expect(body).toMatch(
      /echo "CLOUDFLARE_DASHBOARD_PROJECT_NAME variable unset — set as a repo variable in Settings → Variables\."/,
    );
    expect(body).toMatch(
      /npx --no-install wrangler pages deploy apps\/customer-dashboard\/dist \\/,
    );
    expect(body).toMatch(/--project-name="\$\{PROJECT_NAME\}" \\/);
    expect(body).toMatch(/--branch="\$\{GITHUB_REF_NAME\}" \\/);
    expect(body).toMatch(/--commit-hash="\$\{GITHUB_SHA\}" \\/);
    expect(body).toMatch(/--commit-message="\$\{GITHUB_SHA::8\} — \$\(git log -1 --pretty=%s\)"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
