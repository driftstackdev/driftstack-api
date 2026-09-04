// W543.B — drift guard for /.github/workflows/deploy-docs.yml.
// V-258 doc site Cloudflare Pages deploy. Most minimal of the 3
// Cloudflare deploys (no Sentry — docs site has no client telemetry).
// Drift here either adds Sentry to the docs build (intentional gap
// per V-469 — docs is read-only public content), changes the custom
// domain (would break docs.driftstack.io), or widens the path-filter
// (would redeploy on every backend commit).
//
//   • Pure Astro static-site (no @astrojs/cloudflare adapter — only
//     the marketing + customer-dashboard need it).
//   • NO Sentry envs (deliberate — docs.driftstack.io is read-only
//     public content with no customer-error telemetry; parity with
//     status-site).
//   • Custom domain docs.driftstack.io.
//   • V-258 founder runbook (single-project setup, not the section-C
//     subset of V-259).
//   • CLOUDFLARE_DOCS_PROJECT_NAME (distinct repo var).
//   • Path-filter trigger (apps/docs/** + workflow + 2 root manifests).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/deploy-docs.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W543.B /.github/workflows/deploy-docs.yml content parity', () => {
  const body = read(LIB);

  it("Header + Astro-static + path-filter-rationale framing pinned: '# Doc site — deploy pipeline.' + 'Builds the Astro static site at `apps/docs/` and deploys the resulting `dist/` to Cloudflare Pages via the `wrangler` CLI.' + 'Path-filter triggers are deliberate: the workflow only runs when something under `apps/docs/`, this workflow file, or the shared root manifests changes — so a backend-only commit doesn't redeploy the doc site.' + 'Skipped if `CLOUDFLARE_API_TOKEN` is unset (e.g. fresh repo without secrets populated).' — pinned so the Astro-static-site (no @astrojs/cloudflare adapter — pure static, no Pages Functions) + path-filter-deliberate + graceful-skip-on-fresh-repo commitment survives", () => {
    expect(body).toMatch(/# Doc site — deploy pipeline\./);
    expect(body).toMatch(
      /Builds the Astro static site at\s*\n#\s*`apps\/docs\/` and deploys the resulting `dist\/` to Cloudflare Pages/,
    );
    expect(body).toMatch(/via the `wrangler` CLI\./);
    expect(body).toMatch(/Path-filter triggers are deliberate: the workflow only runs when/);
    expect(body).toMatch(/something under `apps\/docs\/`, this workflow file, or the shared/);
    expect(body).toMatch(/root manifests changes — so a backend-only commit doesn't redeploy/);
    expect(body).toMatch(/the doc site\./);
    expect(body).toMatch(/Skipped if `CLOUDFLARE_API_TOKEN` is unset \(e\.g\. fresh repo without/);
  });

  it("Shared-secret + V-258 distinct project-var + docs.driftstack.io framing pinned: 'Required GitHub secrets (repository-wide; shared with the marketing-site deploy):' + 'CLOUDFLARE_API_TOKEN          — token with `Cloudflare Pages — Edit` permission.' + 'CLOUDFLARE_ACCOUNT_ID         — Cloudflare account ID.' + 'Required repository variable (DISTINCT from the marketing project):' + 'CLOUDFLARE_DOCS_PROJECT_NAME  — Cloudflare Pages project slug for the doc site (e.g. `driftstack-docs`).' + 'docs.driftstack.io → CNAME to the Pages project' + 'Founder runbook for first-time setup: `docs/founder-actions/v258-cloudflare-pages-docs-setup.md`.' — pinned so the shared-with-marketing-CLOUDFLARE-secret + DISTINCT-from-marketing-CLOUDFLARE_DOCS_PROJECT_NAME-var + docs.driftstack.io-CNAME + V-258-founder-runbook commitment survives", () => {
    expect(body).toMatch(/# Required GitHub secrets \(repository-wide; shared with the marketing-/);
    expect(body).toMatch(/# site deploy\):/);
    expect(body).toMatch(/#\s+- CLOUDFLARE_API_TOKEN\s+— token with `Cloudflare Pages/);
    expect(body).toMatch(/#\s+— Edit` permission\./);
    expect(body).toMatch(/#\s+- CLOUDFLARE_ACCOUNT_ID\s+— Cloudflare account ID\./);
    expect(body).toMatch(/# Required repository variable \(DISTINCT from the marketing project\):/);
    expect(body).toMatch(/#\s+- CLOUDFLARE_DOCS_PROJECT_NAME\s+— Cloudflare Pages project slug/);
    expect(body).toMatch(/#\s+for the doc site \(e\.g\./);
    expect(body).toMatch(/#\s+`driftstack-docs`\)\. Pre-create/);
    expect(body).toMatch(/#\s+- docs\.driftstack\.io → CNAME to the Pages project/);
    expect(body).toMatch(/# Founder runbook for first-time setup:/);
    expect(body).toMatch(/# `docs\/founder-actions\/v258-cloudflare-pages-docs-setup\.md`\./);
  });

  it("Trigger + path-filter + env-binding framing pinned: 'name: Deploy doc site' + 'paths: apps/docs/** + .github/workflows/deploy-docs.yml + package.json + package-lock.json' + 'workflow_dispatch' + 'concurrency: group: deploy-docs-${{ github.ref }} + cancel-in-progress: false' + 'permissions: contents: read + deployments: write' + 'environment: name: docs-production + url: https://docs.driftstack.io' — pinned so the 4-path-filter + docs-production env-binding + docs.driftstack.io + cancel-in-progress: FALSE commitment survives", () => {
    expect(body).toMatch(/^name: Deploy doc site$/m);
    expect(body).toMatch(/- 'apps\/docs\/\*\*'/);
    expect(body).toMatch(/- '\.github\/workflows\/deploy-docs\.yml'/);
    expect(body).toMatch(/- 'package\.json'/);
    expect(body).toMatch(/- 'package-lock\.json'/);
    expect(body).toMatch(/workflow_dispatch:/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: deploy-docs-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
    expect(body).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*deployments: write/);
    expect(body).toMatch(
      /environment:\s*\n\s*name: docs-production\s*\n\s*url: https:\/\/docs\.driftstack\.io/,
    );
  });

  it("NO-Sentry-in-build-step framing pinned: 'name: Build doc site' + 'run: npm run build --workspace apps/docs' (with NO env: block — no Sentry envs, no GIT_SHA passthrough — distinct from marketing + customer-dashboard which both have V-469 Sentry env blocks) — pinned so the docs-build-has-no-Sentry-envs (parity with status-site no-Sentry posture; docs is read-only public content with no customer-error telemetry need) commitment survives (drift to adding Sentry envs here would diverge from the V-469 'per-service Sentry: docs+status excluded' design)", () => {
    expect(body).toMatch(/name: Build doc site\s*\n\s*run: npm run build --workspace apps\/docs/);
    expect(body).not.toMatch(/PUBLIC_SENTRY_DSN_DOCS/);
    expect(body).not.toMatch(/PUBLIC_SENTRY_DSN_DASHBOARD/);
    expect(body).not.toMatch(/PUBLIC_SENTRY_DSN_MARKETING/);
  });

  it('wrangler deploy + graceful-skip + V-258-project-var framing pinned: \'PROJECT_NAME: ${{ vars.CLOUDFLARE_DOCS_PROJECT_NAME }}\' + \'if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then echo "CLOUDFLARE_API_TOKEN unset — skipping Cloudflare Pages upload."; echo "Build artifact is at apps/docs/dist/ and verified above."; exit 0; fi\' + \'if [ -z "${PROJECT_NAME}" ]; then echo "CLOUDFLARE_DOCS_PROJECT_NAME variable unset — set as a repo variable in Settings → Variables."; exit 1; fi\' + \'npx --yes wrangler@^3 pages deploy apps/docs/dist --project-name + --branch + --commit-hash + --commit-message\' — pinned so the wrangler@^3 + 4-flag-deploy + DOCS-specific project-var + apps/docs/dist artifact-path + 8-char-sha commit-message commitment survives', () => {
    expect(body).toMatch(/PROJECT_NAME: \$\{\{ vars\.CLOUDFLARE_DOCS_PROJECT_NAME \}\}/);
    expect(body).toMatch(/if \[ -z "\$\{CLOUDFLARE_API_TOKEN\}" \]; then/);
    expect(body).toMatch(/echo "CLOUDFLARE_API_TOKEN unset — skipping Cloudflare Pages upload\."/);
    expect(body).toMatch(/echo "Build artifact is at apps\/docs\/dist\/ and verified above\."/);
    expect(body).toMatch(
      /echo "CLOUDFLARE_DOCS_PROJECT_NAME variable unset — set as a repo variable in Settings → Variables\."/,
    );
    expect(body).toMatch(/npx --no-install wrangler pages deploy apps\/docs\/dist \\/);
    expect(body).toMatch(/--project-name="\$\{PROJECT_NAME\}" \\/);
    expect(body).toMatch(/--branch="\$\{GITHUB_REF_NAME\}" \\/);
    expect(body).toMatch(/--commit-hash="\$\{GITHUB_SHA\}" \\/);
    expect(body).toMatch(/--commit-message="\$\{GITHUB_SHA::8\} — \$\(git log -1 --pretty=%s\)"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
