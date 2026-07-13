// W543.C — drift guard for /.github/workflows/deploy-marketing.yml.
// Original Cloudflare Pages deploy template (the docs + customer-
// dashboard deploys derive their shape from this one). Drift here
// either weakens the V-469 per-service Sentry framing (would lose
// marketing-site error telemetry), drops the apex+www DNS framing
// (would break the driftstack.dev front door), or renames
// CLOUDFLARE_PAGES_PROJECT_NAME (would diverge from the historical
// var name that the docs + dashboard explicitly distinguish from).
//
//   • Original template — historical var name CLOUDFLARE_PAGES_
//     PROJECT_NAME (no "_MARKETING_" suffix; docs + dashboard added
//     suffixes to distinguish from this baseline).
//   • V-469 per-service Sentry (PUBLIC_SENTRY_DSN_MARKETING +
//     SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_RELEASE + GIT_SHA).
//   • Custom domains: driftstack.dev (apex) + www.driftstack.dev
//     (CNAME).
//   • Path-filter trigger (apps/marketing-site/** + workflow + 2
//     root manifests).
//   • marketing-production env-binding + driftstack.dev URL.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/deploy-marketing.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W543.C /.github/workflows/deploy-marketing.yml content parity', () => {
  const body = read(LIB);

  it("Header + Astro-static + path-filter-rationale framing pinned: '# Marketing site — deploy pipeline.' + 'Builds the Astro static site at `apps/marketing-site/` and deploys the resulting `dist/` to Cloudflare Pages via the `wrangler` CLI.' + 'Path-filter triggers are deliberate' + 'a backend-only commit doesn't redeploy the marketing site.' + 'Skipped if `CLOUDFLARE_API_TOKEN` is unset' — pinned so the marketing-site Astro-static + wrangler-CLI-deploy + path-filter-deliberate + backend-only-commit-doesn't-redeploy + graceful-skip commitment survives", () => {
    expect(body).toMatch(/# Marketing site — deploy pipeline\./);
    expect(body).toMatch(
      /Builds the Astro static site at\s*\n#\s*`apps\/marketing-site\/` and deploys the resulting `dist\/` to/,
    );
    expect(body).toMatch(/Cloudflare Pages via the `wrangler` CLI\./);
    expect(body).toMatch(/Path-filter triggers are deliberate: the workflow only runs when/);
    expect(body).toMatch(/something under `apps\/marketing-site\/`, this workflow file, or/);
    expect(body).toMatch(/the shared root manifests changes — so a backend-only commit/);
    expect(body).toMatch(/doesn't redeploy the marketing site\./);
    expect(body).toMatch(/Skipped if `CLOUDFLARE_API_TOKEN` is unset \(e\.g\. fresh repo/);
  });

  it("Secret framing + historical-naming + apex/www DNS framing pinned: 'Required GitHub secrets (repository-wide; not per-environment):' + 'CLOUDFLARE_API_TOKEN          — token with `Cloudflare Pages — Edit` permission. Generated at dash.cloudflare.com → My Profile → API Tokens.' + 'CLOUDFLARE_ACCOUNT_ID         — Cloudflare account ID (32 hex chars). Visible in any zone overview page.' + 'Required repository variable:' + 'CLOUDFLARE_PAGES_PROJECT_NAME — Cloudflare Pages project slug (e.g. `driftstack-marketing`)' + 'Set as a repo variable (not a secret) since it's not sensitive.' + 'driftstack.dev → apex of the Pages project' + 'www.driftstack.dev → CNAME to the Pages project' — pinned so the original-template historical CLOUDFLARE_PAGES_PROJECT_NAME-no-suffix (the baseline that docs + customer-dashboard explicitly distinguish from) + 32-hex-account-ID + apex+www-DNS commitment survives", () => {
    expect(body).toMatch(/# Required GitHub secrets \(repository-wide; not per-environment\):/);
    expect(body).toMatch(/#\s+- CLOUDFLARE_API_TOKEN\s+— token with `Cloudflare Pages/);
    expect(body).toMatch(/#\s+— Edit` permission\. Generated/);
    expect(body).toMatch(/#\s+at dash\.cloudflare\.com →/);
    expect(body).toMatch(/#\s+My Profile → API Tokens\./);
    expect(body).toMatch(/#\s+- CLOUDFLARE_ACCOUNT_ID\s+— Cloudflare account ID \(32 hex/);
    expect(body).toMatch(/#\s+chars\)\. Visible in any zone/);
    expect(body).toMatch(/#\s+overview page\./);
    expect(body).toMatch(/# Required repository variable:/);
    expect(body).toMatch(/#\s+- CLOUDFLARE_PAGES_PROJECT_NAME — Cloudflare Pages project slug/);
    expect(body).toMatch(/#\s+\(e\.g\. `driftstack-marketing`\)\./);
    expect(body).toMatch(/Set as a repo variable/);
    expect(body).toMatch(/\(not a secret\) since it's not/);
    expect(body).toMatch(/sensitive\./);
    expect(body).toMatch(/#\s+- driftstack\.dev → apex of the Pages project/);
    expect(body).toMatch(/#\s+- www\.driftstack\.dev → CNAME to the Pages project/);
  });

  it("Trigger + path-filter + env-binding framing pinned: 'name: Deploy marketing site' + 'paths: apps/marketing-site/** + .github/workflows/deploy-marketing.yml + package.json + package-lock.json' + 'workflow_dispatch' + 'concurrency: group: deploy-marketing-${{ github.ref }} + cancel-in-progress: false' + 'permissions: contents: read + deployments: write' + 'environment: name: marketing-production + url: https://driftstack.dev' — pinned so the 4-path-filter + marketing-production-env-binding + driftstack.dev-apex URL + cancel-in-progress: FALSE commitment survives", () => {
    expect(body).toMatch(/^name: Deploy marketing site$/m);
    expect(body).toMatch(/- 'apps\/marketing-site\/\*\*'/);
    expect(body).toMatch(/- '\.github\/workflows\/deploy-marketing\.yml'/);
    expect(body).toMatch(/- 'package\.json'/);
    expect(body).toMatch(/- 'package-lock\.json'/);
    expect(body).toMatch(/workflow_dispatch:/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: deploy-marketing-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
    expect(body).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*deployments: write/);
    expect(body).toMatch(
      /environment:\s*\n\s*name: marketing-production\s*\n\s*url: https:\/\/driftstack\.dev/,
    );
  });

  it("V-469 per-service Sentry framing pinned: '# V-469 — per-service Sentry. DSN is build-time-baked into client bundle; integration skips entirely when DSN unset. SENTRY_AUTH_TOKEN governs source-map upload (no-op when unset, runtime unaffected).' + 'PUBLIC_SENTRY_DSN_MARKETING: ${{ secrets.PUBLIC_SENTRY_DSN_MARKETING }}' + 'SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}' + 'SENTRY_ORG: ${{ secrets.SENTRY_ORG }}' + 'SENTRY_RELEASE: ${{ github.sha }}' + 'GIT_SHA: ${{ github.sha }}' + 'npm run build --workspace apps/marketing-site' — pinned so the V-469 4-Sentry-env (DSN_MARKETING + AUTH_TOKEN + ORG + RELEASE) + GIT_SHA-passthrough + workspace-scoped-build commitment survives (drift to renaming DSN_MARKETING to a generic name would break the per-service Sentry projection)", () => {
    expect(body).toMatch(/# V-469 — per-service Sentry\. DSN is build-time-baked into/);
    expect(body).toMatch(/# client bundle; integration skips entirely when DSN unset\./);
    expect(body).toMatch(/# SENTRY_AUTH_TOKEN governs source-map upload \(no-op when/);
    expect(body).toMatch(/# unset, runtime unaffected\)\./);
    expect(body).toMatch(
      /PUBLIC_SENTRY_DSN_MARKETING: \$\{\{ secrets\.PUBLIC_SENTRY_DSN_MARKETING \}\}/,
    );
    expect(body).toMatch(/SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/);
    expect(body).toMatch(/SENTRY_ORG: \$\{\{ secrets\.SENTRY_ORG \}\}/);
    expect(body).toMatch(/SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
    expect(body).toMatch(/GIT_SHA: \$\{\{ github\.sha \}\}/);
    expect(body).toMatch(/run: npm run build --workspace apps\/marketing-site/);
  });

  it('wrangler deploy + graceful-skip + CLOUDFLARE_PAGES_PROJECT_NAME framing pinned: \'PROJECT_NAME: ${{ vars.CLOUDFLARE_PAGES_PROJECT_NAME }}\' + \'if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then echo "CLOUDFLARE_API_TOKEN unset — skipping Cloudflare Pages upload."; echo "Build artifact is at apps/marketing-site/dist/ and verified above."; exit 0; fi\' + \'if [ -z "${PROJECT_NAME}" ]; then echo "CLOUDFLARE_PAGES_PROJECT_NAME variable unset — set as a repo variable in Settings → Variables."; exit 1; fi\' + \'npx --yes wrangler@^3 pages deploy apps/marketing-site/dist --project-name + --branch + --commit-hash + --commit-message\' — pinned so the wrangler@^3 + 4-flag-deploy + historical-no-suffix CLOUDFLARE_PAGES_PROJECT_NAME project-var + apps/marketing-site/dist artifact-path commitment survives', () => {
    expect(body).toMatch(/PROJECT_NAME: \$\{\{ vars\.CLOUDFLARE_PAGES_PROJECT_NAME \}\}/);
    expect(body).toMatch(/if \[ -z "\$\{CLOUDFLARE_API_TOKEN\}" \]; then/);
    expect(body).toMatch(/echo "CLOUDFLARE_API_TOKEN unset — skipping Cloudflare Pages upload\."/);
    expect(body).toMatch(
      /echo "Build artifact is at apps\/marketing-site\/dist\/ and verified above\."/,
    );
    expect(body).toMatch(
      /echo "CLOUDFLARE_PAGES_PROJECT_NAME variable unset — set as a repo variable in Settings → Variables\."/,
    );
    expect(body).toMatch(/npx --no-install wrangler pages deploy apps\/marketing-site\/dist \\/);
    expect(body).toMatch(/--project-name="\$\{PROJECT_NAME\}" \\/);
    expect(body).toMatch(/--branch="\$\{GITHUB_REF_NAME\}" \\/);
    expect(body).toMatch(/--commit-hash="\$\{GITHUB_SHA\}" \\/);
    expect(body).toMatch(/--commit-message="\$\{GITHUB_SHA::8\} — \$\(git log -1 --pretty=%s\)"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
