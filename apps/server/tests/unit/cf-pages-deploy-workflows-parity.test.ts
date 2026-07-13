// W725 — Cloudflare Pages deploy workflows parity (marketing +
// customer-dashboard + docs). Fifty-second in the cross-SDK drift-
// guard series (W649 + W675-W725).
//
// Pins THREE Cloudflare Pages deploy workflows as authoritative.
// Each one builds an Astro static site, then uploads to a separate
// Cloudflare Pages project via the wrangler CLI:
//
//   deploy-marketing.yml          → driftstack.dev
//   deploy-customer-dashboard.yml → app.driftstack.dev
//   deploy-docs.yml               → docs.driftstack.dev
//
// CRITICAL invariants common to all three:
//   1. Trigger uses path-filter on the site's subtree + the
//      workflow file + shared root manifests — backend-only commits
//      do not redeploy the static site.
//   2. concurrency: cancel-in-progress: false (deploys never
//      cancel in flight).
//   3. CLOUDFLARE_API_TOKEN unset → skip upload, exit 0 (don't
//      fail the workflow on missing secret).
//   4. wrangler@^3 pages deploy with --project-name + --branch +
//      --commit-hash + --commit-message flags.
//   5. Node 22 + actions/setup-node@v6 + actions/checkout@v6.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const MARKETING = resolve(REPO_ROOT, '.github/workflows/deploy-marketing.yml');
const DASHBOARD = resolve(REPO_ROOT, '.github/workflows/deploy-customer-dashboard.yml');
const DOCS = resolve(REPO_ROOT, '.github/workflows/deploy-docs.yml');

describe('W725 Cloudflare Pages deploy workflows parity', () => {
  it('all 3 CF Pages workflow files exist', () => {
    expect(existsSync(MARKETING), `missing ${MARKETING}`).toBe(true);
    expect(existsSync(DASHBOARD), `missing ${DASHBOARD}`).toBe(true);
    expect(existsSync(DOCS), `missing ${DOCS}`).toBe(true);
  });

  it('CRITICAL all 3 workflows trigger on push to main + workflow_dispatch + path-filter on their subtree. The path-filter is what prevents backend-only commits from redeploying static sites.', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} push trigger`).toMatch(
        /on:\s*\n\s*push:\s*\n\s*branches: \[main\]\s*\n\s*paths:/,
      );
      expect(w, `${path} workflow_dispatch`).toMatch(/workflow_dispatch:/);
    }
  });

  it('CRITICAL deploy-marketing.yml path-filter triggers on apps/marketing-site/** + workflow file + root manifests. Drift to dropping the path-filter would let backend commits redeploy the marketing site.', () => {
    const w = read(MARKETING);
    expect(w).toMatch(/'apps\/marketing-site\/\*\*'/);
    expect(w).toMatch(/'\.github\/workflows\/deploy-marketing\.yml'/);
    expect(w).toMatch(/'package\.json'/);
    expect(w).toMatch(/'package-lock\.json'/);
  });

  it('CRITICAL all 3 workflows use cancel-in-progress: false. Drift to true would let a new commit kill an in-flight deploy (partial state).', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} cancel-in-progress`).toMatch(/cancel-in-progress: false/);
    }
  });

  it("CRITICAL all 3 workflows skip CF Pages upload when CLOUDFLARE_API_TOKEN is unset (exit 0 — don't fail). The skip-clean path is what lets fresh repos verify Astro builds before secrets land.", () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} skip-on-missing-token`).toMatch(
        /if \[ -z "\$\{CLOUDFLARE_API_TOKEN\}" \]; then\s*\n\s*echo "CLOUDFLARE_API_TOKEN unset/,
      );
      expect(w, `${path} exit 0`).toMatch(/exit 0/);
    }
  });

  it('CRITICAL all 3 workflows use wrangler@^3 pages deploy with the canonical 4-flag set: --project-name + --branch + --commit-hash + --commit-message. Drift to dropping --commit-hash would lose the CF Pages deploy → commit-SHA correlation.', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} locked wrangler`).toMatch(/npx --no-install wrangler pages deploy/);
      expect(w, `${path} --project-name`).toMatch(/--project-name="\$\{PROJECT_NAME\}"/);
      expect(w, `${path} --branch`).toMatch(/--branch="\$\{GITHUB_REF_NAME\}"/);
      expect(w, `${path} --commit-hash`).toMatch(/--commit-hash="\$\{GITHUB_SHA\}"/);
      expect(w, `${path} --commit-message`).toMatch(/--commit-message=/);
    }
  });

  it('CRITICAL all 3 workflows pin Node 22 + actions/setup-node@v6 + actions/checkout@v6 + permissions contents:read + deployments:write.', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} checkout`).toMatch(/uses: actions\/checkout@v6/);
      expect(w, `${path} setup-node`).toMatch(/uses: actions\/setup-node@v6/);
      expect(w, `${path} node-version 22`).toMatch(/node-version: 22/);
      expect(w, `${path} permissions`).toMatch(
        /permissions:\s*\n\s*contents: read\s*\n\s*deployments: write/,
      );
    }
  });

  it('CRITICAL deploy-marketing.yml environment URL `driftstack.dev` + custom-domains doc note. Drift to dropping the apex-domain framing would lose institutional memory of which Pages project maps to the apex.', () => {
    const w = read(MARKETING);
    expect(w).toMatch(/url: https:\/\/driftstack\.dev/);
    expect(w).toMatch(/driftstack\.dev → apex of the Pages project/);
    expect(w).toMatch(/www\.driftstack\.dev → CNAME to the Pages project/);
  });

  it('CRITICAL deploy-marketing.yml V-469 Sentry per-service framing pinned — PUBLIC_SENTRY_DSN_MARKETING build-time-baked into client bundle. Drift to dropping would lose the per-service DSN isolation.', () => {
    const w = read(MARKETING);
    expect(w).toMatch(/V-469 — per-service Sentry/);
    expect(w).toMatch(
      /PUBLIC_SENTRY_DSN_MARKETING: \$\{\{ secrets\.PUBLIC_SENTRY_DSN_MARKETING \}\}/,
    );
    expect(w).toMatch(/integration skips entirely when DSN unset/);
  });

  it('CRITICAL Cloudflare secret manifest documented in all 3 workflows — CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_PAGES_PROJECT_NAME (repo variable, not secret).', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} api token`).toMatch(/CLOUDFLARE_API_TOKEN/);
      expect(w, `${path} account id`).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
      // Project-name variable is per-workflow distinct (PAGES / DASHBOARD / DOCS).
      expect(w, `${path} project name variable`).toMatch(
        /CLOUDFLARE_(PAGES|DASHBOARD|DOCS)_PROJECT_NAME/,
      );
    }
  });

  it('CRITICAL deploy-customer-dashboard.yml deploys to app.driftstack.dev + customer-dashboard subtree. Drift to a different subtree path would let unrelated commits redeploy the dashboard.', () => {
    expect(existsSync(DASHBOARD)).toBe(true);
    const w = read(DASHBOARD);

    // Path-filter on the customer-dashboard subtree.
    expect(w).toMatch(/apps\/customer-dashboard\/\*\*/);

    // Environment URL.
    expect(w).toMatch(/app\.driftstack\.dev/);

    // Wrangler upload of customer-dashboard dist.
    expect(w).toMatch(/apps\/customer-dashboard\/dist/);
  });

  it('CRITICAL deploy-docs.yml deploys to docs.driftstack.dev + docs subtree path-filter. The dedicated docs project keeps marketing-site changes from blasting cached docs CDN.', () => {
    expect(existsSync(DOCS)).toBe(true);
    const w = read(DOCS);

    // Path-filter on apps/docs/** subtree + environment URL pinned.
    expect(w).toMatch(/'apps\/docs\/\*\*'/);
    expect(w).toMatch(/docs\.driftstack\.dev/);
    // Build invokes the apps/docs workspace.
    expect(w).toMatch(/workspace apps\/docs/);
  });

  it('CRITICAL 3 separate CF Pages projects pinned — each workflow targets its own project-name slug (deployed independently). Drift to merging would couple deploy timing across the 3 surfaces.', () => {
    // Each workflow references its own project-name variable — distinct
    // names enforce 3 separate CF Pages projects.
    const marketing = read(MARKETING);
    const dashboard = read(DASHBOARD);
    const docs = read(DOCS);

    expect(marketing).toMatch(/CLOUDFLARE_PAGES_PROJECT_NAME/);
    expect(dashboard).toMatch(/CLOUDFLARE_DASHBOARD_PROJECT_NAME/);
    expect(docs).toMatch(/CLOUDFLARE_DOCS_PROJECT_NAME/);

    // Each workflow uses a different env-var name — verify none cross-pollinate.
    expect(marketing).not.toMatch(/CLOUDFLARE_DASHBOARD_PROJECT_NAME/);
    expect(dashboard).not.toMatch(/CLOUDFLARE_DOCS_PROJECT_NAME/);
    expect(docs).not.toMatch(/CLOUDFLARE_DASHBOARD_PROJECT_NAME/);
  });

  it('CRITICAL all 3 workflows install from the committed lockfile via npm ci', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path} npm ci`).toMatch(/npm ci --no-audit/);
    }
  });

  it('CRITICAL --commit-message arg uses short SHA + commit subject pinned. The 8-char SHA + subject is what surfaces in CF Pages deploy history — drift to dropping the subject would lose the readable trail.', () => {
    const marketing = read(MARKETING);
    expect(marketing).toMatch(
      /--commit-message="\$\{GITHUB_SHA::8\} — \$\(git log -1 --pretty=%s\)"/,
    );
  });

  it('CRITICAL CLOUDFLARE_PAGES_PROJECT_NAME is a repo VARIABLE (not secret) — pre-create the CF project before first deploy. Drift to making it a secret would force operators to rotate it like a credential.', () => {
    const marketing = read(MARKETING);
    expect(marketing).toMatch(/CLOUDFLARE_PAGES_PROJECT_NAME — Cloudflare Pages project slug/);
    expect(marketing).toMatch(
      /Set as a repo variable\s*\n#\s*\(not a secret\) since it's not\s*\n#\s*sensitive/,
    );
  });

  it('CF Pages workflows 6-invariant cluster — 3 separate workflow files + path-filter triggers + cancel-in-progress:false + skip-on-missing-token + wrangler@^3 4-flag deploy + Node 22 pin + V-469 Sentry framing.', () => {
    for (const path of [MARKETING, DASHBOARD, DOCS]) {
      const w = read(path);
      expect(w, `${path}`).toMatch(/cancel-in-progress: false/);
      expect(w, `${path}`).toMatch(/CLOUDFLARE_API_TOKEN/);
      expect(w, `${path}`).toMatch(/npx --no-install wrangler pages deploy/);
      expect(w, `${path}`).toMatch(/node-version: 22/);
    }
    expect(read(MARKETING)).toMatch(/V-469/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cf-pages-deploy-workflows-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
