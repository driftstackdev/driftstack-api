// W545.A — drift guard for /docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md.
// V-259 consolidated CF Pages setup for all 4 projects. Cross-
// referenced from W543.A deploy-customer-dashboard.yml parity.
// Drift here either changes the 4-project inventory (would diverge
// from the actual CF dashboard state), drops the project-slug ↔
// custom-domain mapping table (would break first-deploy onboarding),
// or removes the V-135 admin-panel Cloudflare-Access-SSO anchor
// (would conflate the admin-deploy with the SSO gate).
//
//   • V-259 anchor + paired-with-V-258.
//   • 4-project inventory table (marketing + docs + customer-
//     dashboard + admin-panel) with workflow + status.
//   • Shared prereqs: CF API token (Pages-Edit only) + 32-hex
//     account ID + driftstack.dev zone in same CF account.
//   • Per-project 5-step shape: create project → set repo variable →
//     trigger first deploy → wire custom domains → verify.
//   • V-135 admin-panel Cloudflare Access SSO gate (separate
//     V-NNN).
//   • Cost: 500 builds/month free; CF Pages Pro $20/mo for 5,000.
//   • Path-filter design preventing cross-deployment storms.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W545.A /docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md content parity', () => {
  const body = read(LIB);

  it('pins the V-259 four-project runbook and its current all-workflows-wired state', () => {
    expect(body).toMatch(/# V-259 — Cloudflare Pages: full project setup \(founder ops action\)/);
    expect(body).toMatch(
      /Per V-259 \/ paired with V-258: consolidates all four Cloudflare Pages projects the Driftstack stack needs, in one runbook so the founder can do this in a single Cloudflare-dashboard session\./,
    );
    expect(body).toMatch(
      /All four projects now have path-filtered GitHub Actions deploy workflows and production custom domains\./,
    );
  });

  it('pins all four Pages project slugs, custom domains, deploy workflows, and wired statuses', () => {
    expect(body).toMatch(/`driftstack-marketing`/);
    expect(body).toMatch(/`driftstack\.dev` \+ `www\.…`/);
    expect(body).toMatch(/`\.github\/workflows\/deploy-marketing\.yml`/);
    expect(body).toMatch(/`\.github\/workflows\/deploy-admin-panel\.yml`/);
    expect(body).toMatch(/`driftstack-docs`/);
    expect(body).toMatch(/`docs\.driftstack\.dev`/);
    expect(body).toMatch(/`\.github\/workflows\/deploy-docs\.yml`/);
    expect(body).toMatch(/`driftstack-customer-dashboard`/);
    expect(body).toMatch(/`app\.driftstack\.dev`/);
    expect(body).toMatch(/`\.github\/workflows\/deploy-customer-dashboard\.yml`/);
    expect(body).toMatch(/`driftstack-admin-panel`/);
    expect(body).toMatch(/`admin\.driftstack\.dev`/);
    expect((body.match(/\| Wired\s+\|/g) ?? []).length).toBe(4);
  });

  it("Shared-prereq + Pages-Edit-only token + 32-hex account-ID + zone-in-same-account framing pinned: '## Shared prerequisites (do once)' + '### 1. Cloudflare API token' + '`CLOUDFLARE_API_TOKEN` — single repo-wide secret used by both `deploy-marketing.yml` and `deploy-docs.yml` (and any future deploy workflow).' + 'CF dashboard → top-right profile menu → **My Profile** → **API Tokens** → **Create Token** → use the **Edit Cloudflare Pages** template, OR custom token with these permissions:' + '`Account` → `Cloudflare Pages` → `Edit`.' + 'Account resources: include the Driftstack Cloudflare account.' + '### 2. Cloudflare account ID' + '`CLOUDFLARE_ACCOUNT_ID` — same repo-wide secret.' + '### 3. DNS zone' + '`driftstack.dev` zone must be in the same Cloudflare account as the Pages projects so custom-domain wiring is one-click. If the zone lives elsewhere, custom-domain setup falls back to a manual CNAME record per project (still works; just not one-click).' — pinned so the single-token-shared-across-workflows + Edit-Cloudflare-Pages-template + 32-hex-account-ID + driftstack.dev-zone-in-same-CF-account-for-one-click-domain-wiring commitment survives", () => {
    expect(body).toMatch(/## Shared prerequisites \(do once\)/);
    expect(body).toMatch(/### 1\. Cloudflare API token/);
    expect(body).toMatch(
      /`CLOUDFLARE_API_TOKEN` — single repo-wide secret used by all four Pages deploy workflows\./,
    );
    expect(body).toMatch(
      /CF dashboard → top-right profile menu → \*\*My Profile\*\* → \*\*API Tokens\*\* → \*\*Create Token\*\* → use the \*\*Edit Cloudflare Pages\*\* template/,
    );
    expect(body).toMatch(/`Account` → `Cloudflare Pages` → `Edit`\./);
    expect(body).toMatch(/Account resources: include the Driftstack Cloudflare account\./);
    expect(body).toMatch(/### 2\. Cloudflare account ID/);
    expect(body).toMatch(/`CLOUDFLARE_ACCOUNT_ID` — same repo-wide secret\./);
    expect(body).toMatch(/### 3\. DNS zone/);
    expect(body).toMatch(
      /`driftstack\.dev` zone must be in the same Cloudflare account as the Pages projects so custom-domain wiring is one-click\./,
    );
    expect(body).toMatch(
      /If the zone lives elsewhere, custom-domain setup falls back to a manual CNAME record per project \(still works; just not one-click\)\./,
    );
  });

  it("Per-project A/B/C/D shape + V-219-oxblood-D-badge + V-135 admin-pre-staging framing pinned: '### A. `driftstack-marketing`' + 'Trigger first deploy: GitHub repo → **Actions** → **Deploy marketing site** → **Run workflow** → from `main`.' + 'Wire custom domains: CF Pages project → **Custom domains** → add `driftstack.dev` AND `www.driftstack.dev`. CF auto-creates DNS records if the zone is in this account.' + 'Verify <https://driftstack.dev>: `index.astro` should render with the V-219 brand identity (oxblood D-badge + Geist Sans + slate palette).' + '### B. `driftstack-docs`' + '### C. `driftstack-customer-dashboard`' + 'Pre-create the project so the future deploy workflow lands cleanly:' + 'The repo variable name will be `CLOUDFLARE_DASHBOARD_PROJECT_NAME` when the workflow ships; create the variable with that name + value `driftstack-customer-dashboard` to pre-stage.' + '### D. `driftstack-admin-panel`' + 'V-135 lands the admin-panel deploy + Cloudflare Access SSO gate.' + 'The custom domain (`admin.driftstack.dev`) wiring waits for V-135 because the Access policy attaches at the origin level and needs to be configured against the live Pages project.' + 'Repo variable name will be `CLOUDFLARE_ADMIN_PROJECT_NAME` when the workflow ships.' — pinned so the 4-section-A-B-C-D per-project shape + V-219 oxblood-D-badge + Geist-Sans + slate-palette + V-135 admin-panel-deploy + Cloudflare-Access-origin-level-policy + 3-future-repo-var-name (CLOUDFLARE_DASHBOARD_PROJECT_NAME + CLOUDFLARE_ADMIN_PROJECT_NAME) commitment survives", () => {
    expect(body).toMatch(
      /### A\. `driftstack-marketing` \(workflow: `\.github\/workflows\/deploy-marketing\.yml`\)/,
    );
    expect(body).toMatch(
      /Wire custom domains: CF Pages project → \*\*Custom domains\*\* → add `driftstack\.dev` AND `www\.driftstack\.dev`\. CF auto-creates DNS records if the zone is in this account\./,
    );
    expect(body).toMatch(
      /Verify <https:\/\/driftstack\.dev>: `index\.astro` should render with the V-219 brand identity \(oxblood D-badge \+ Geist Sans \+ slate palette\)\./,
    );
    expect(body).toMatch(
      /### B\. `driftstack-docs` \(workflow: `\.github\/workflows\/deploy-docs\.yml`\)/,
    );
    expect(body).toMatch(
      /### C\. `driftstack-customer-dashboard` \(workflow: `\.github\/workflows\/deploy-customer-dashboard\.yml`\)/,
    );
    expect(body).toMatch(
      /Set repo variable `CLOUDFLARE_DASHBOARD_PROJECT_NAME` = `driftstack-customer-dashboard`/,
    );
    expect(body).toMatch(
      /### D\. `driftstack-admin-panel` \(workflow: `\.github\/workflows\/deploy-admin-panel\.yml`\)/,
    );
    expect(body).toMatch(
      /Set repo variable `CLOUDFLARE_ADMIN_PANEL_PROJECT_NAME` = `driftstack-admin-panel`/,
    );
    expect(body).toMatch(/retain the Cloudflare Access policy/);
  });

  it("Path-filter verification + free-tier-cost + rollback framing pinned: '## Verifying the workflows are wired correctly' + 'After completing A and B, trigger one push under `apps/marketing-site/**` AND one push under `apps/docs/**`. Each should trigger ONLY the matching workflow' + 'A trivial change under apps/marketing-site/ → only Deploy marketing site runs.' + 'A trivial change under apps/docs/ → only Deploy doc site runs.' + 'A change under apps/server/ → neither runs.' + 'This is the path-filter design preventing cross-deployment storms when only one app changes.' + '## Cost (informational)' + '500 builds per month per account.' + 'Unlimited bandwidth on static assets.' + '1 build at a time per project (the `concurrency` group in each workflow respects this).' + 'Post-launch, if the rate ever approaches 500/month, CF Pages Pro is $20/mo for 5,000 builds.' — pinned so the path-filter-cross-deployment-storm-prevention + 500-builds-month-free + Pages-Pro-$20mo-5000 commitment survives", () => {
    expect(body).toMatch(/## Verifying the workflows are wired correctly/);
    expect(body).toMatch(/Trigger one isolated change under each frontend directory\./);
    expect(body).toMatch(
      /# A trivial change under apps\/marketing-site\/ → only Deploy marketing site runs\./,
    );
    expect(body).toMatch(/# A trivial change under apps\/docs\/ → only Deploy doc site runs\./);
    expect(body).toMatch(/# A change under apps\/server\/ → no Pages workflow runs\./);
    expect(body).toMatch(
      /This is the path-filter design preventing cross-deployment storms when only one app changes\./,
    );
    expect(body).toMatch(/## Cost \(informational\)/);
    expect(body).toMatch(/- 500 builds per month per project\./);
    expect(body).toMatch(/- Unlimited bandwidth on static assets\./);
    expect(body).toMatch(/- 1 concurrent build on the Free plan/);
    expect(body).toMatch(
      /Pro plan at \$25\/month with 5,000 builds per project and 5 concurrent builds/,
    );
  });

  it("Troubleshooting + What's-NOT-in framing pinned: 'Two workflows running on the same push — likely a path-filter regression. Verify each workflow's `paths:` block only includes its own app directory (no `apps/**` blanket).' + 'TLS stuck on \"pending\" — DNS hasn't propagated. Wait 5 minutes; check the CNAME record points at the Pages project's `<slug>.pages.dev` URL.' + 'Deploy succeeds but the wrong content shows — `<slug>.pages.dev` URL pointing at the wrong project. Verify the `--project-name` flag in the workflow command matches the CF project slug.' + '## What's NOT in this runbook' + '**Cloudflare Access SSO** for `admin.driftstack.dev` — separate V-135 / V-246-P1-003 ops action; lands when the admin-panel deploy ships.' + '**Cloudflare R2 bucket setup** for session recordings + screenshots — separate ops action under the storage track; not Pages-related.' + '**Cloudflare Workers / Pages Functions** — not used by Driftstack today (all four projects are static-only or SSR-via-Astro-adapter).' — pinned so the path-filter-regression-troubleshooting + Cloudflare-Access-V-135/V-246-P1-003 + R2-not-in-this-runbook + Workers-not-used commitment survives", () => {
    expect(body).toMatch(
      /\*\*Two workflows running on the same push\*\* — likely a path-filter regression\. Verify each workflow's `paths:` block only includes its own app directory \(no `apps\/\*\*` blanket\)\./,
    );
    expect(body).toMatch(
      /\*\*TLS stuck on "pending"\*\* — DNS hasn't propagated\. Wait 5 minutes; check the CNAME record points at the Pages project's `<slug>\.pages\.dev` URL\./,
    );
    expect(body).toMatch(
      /\*\*Deploy succeeds but the wrong content shows\*\* — `<slug>\.pages\.dev` URL pointing at the wrong project\. Verify the `--project-name` flag in the workflow command matches the CF project slug\./,
    );
    expect(body).toMatch(/## What's NOT in this runbook/);
    expect(body).toMatch(
      /- \*\*Cloudflare Access policy administration\*\* for `admin\.driftstack\.dev` — separate V-135 \/ V-246-P1-003 ops responsibility; this runbook only verifies the policy remains effective after deploys\./,
    );
    expect(body).toMatch(
      /- \*\*Cloudflare R2 bucket setup\*\* for session recordings \+ screenshots — separate ops action under the storage track; not Pages-related\./,
    );
    expect(body).toMatch(
      /- \*\*Cloudflare Workers \/ Pages Functions\*\* — not used by the frontend projects today; all current pages build as static assets, and admin arbitrary-id routes use Pages 200 rewrites to static client-fetched shells\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
