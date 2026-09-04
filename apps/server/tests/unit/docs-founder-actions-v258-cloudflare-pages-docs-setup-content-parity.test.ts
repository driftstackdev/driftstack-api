// W544.B — drift guard for /docs/founder-actions/v258-cloudflare-pages-docs-setup.md.
// Founder runbook for docs.driftstack.io Cloudflare Pages setup.
// Cross-referenced from W543.B deploy-docs.yml parity. Drift here
// either drops the direct-upload-not-GitHub-integration rationale
// (would race the CF GitHub integration against the wrangler workflow),
// changes the CLOUDFLARE_DOCS_PROJECT_NAME variable name (would
// diverge from the workflow), or weakens the rollback paths.
//
//   • V-258 anchor + secret-reuse-with-marketing.
//   • Direct-upload-NOT-GitHub-integration rationale (race avoidance).
//   • CLOUDFLARE_DOCS_PROJECT_NAME as a VARIABLE not a SECRET.
//   • CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID as REPO secrets
//     (already exist from marketing setup).
//   • Push-to-main OR manual-dispatch first-deploy.
//   • docs.driftstack.io custom-domain wiring + Universal SSL.
//   • CF-side rollback (atomic) vs repo-side rollback (slower but
//     tracked).
//   • Cost: 500 builds/month free tier.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/founder-actions/v258-cloudflare-pages-docs-setup.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W544.B /docs/founder-actions/v258-cloudflare-pages-docs-setup.md content parity', () => {
  const body = read(LIB);

  it("Header + secret-reuse + path-filtered-workflow framing pinned: '# V-258 — Cloudflare Pages setup for `docs.driftstack.io` (founder ops action)' + 'Per V-258: the doc-site CI workflow (`.github/workflows/deploy-docs.yml`) needs a Cloudflare Pages project + DNS record + the same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets that the marketing-site deploy already uses.' + 'The workflow is path-filtered: it only runs when something under `apps/docs/` changes (or its workflow file). Until you complete the steps below, every push to main will run the build-and-skip-upload path successfully (build artifact verified, upload step exits 0 with a \"secret unset\" message).' — pinned so the V-258 + secret-reuse-with-marketing + path-filtered-workflow + build-and-skip-upload-graceful-fallback commitment survives", () => {
    expect(body).toMatch(
      /# V-258 — Cloudflare Pages setup for `docs\.driftstack\.io` \(founder ops action\)/,
    );
    expect(body).toMatch(
      /Per V-258: the doc-site CI workflow \(`\.github\/workflows\/deploy-docs\.yml`\) needs a Cloudflare Pages project \+ DNS record \+ the same `CLOUDFLARE_API_TOKEN` \/ `CLOUDFLARE_ACCOUNT_ID` secrets that the marketing-site deploy already uses\./,
    );
    expect(body).toMatch(
      /The workflow is path-filtered: it only runs when something under `apps\/docs\/` changes \(or its workflow file\)\./,
    );
    expect(body).toMatch(/build-and-skip-upload path successfully/);
    expect(body).toMatch(/upload step exits 0 with a "secret unset" message/);
  });

  it("What's-already-done framing pinned: '## What's already done' + 'Workflow file `.github/workflows/deploy-docs.yml` lives in the repo.' + '`apps/docs/` builds 13 pages clean locally + in CI.' + 'Marketing-site deploy already uses `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` — same secrets are reused.' — pinned so the workflow-exists + 13-page-clean-build + marketing-secrets-reused commitment survives", () => {
    expect(body).toMatch(/## What's already done/);
    expect(body).toMatch(
      /- Workflow file `\.github\/workflows\/deploy-docs\.yml` lives in the repo\./,
    );
    expect(body).toMatch(/- `apps\/docs\/` builds 13 pages clean locally \+ in CI\./);
    expect(body).toMatch(
      /- Marketing-site deploy already uses `CLOUDFLARE_API_TOKEN` \+ `CLOUDFLARE_ACCOUNT_ID` — same secrets are reused\./,
    );
  });

  it("Direct-upload-NOT-GitHub-integration + CF-project + VARIABLE-not-SECRET framing pinned: '### 1. Create the Cloudflare Pages project' + 'Open <https://dash.cloudflare.com> → **Workers & Pages** → **Create application** → **Pages** → **Create using direct upload**.' + '(Direct upload, NOT GitHub integration — the GitHub Actions workflow handles deploy via wrangler, and a CF GitHub integration would race against it.)' + '**Project name:** `driftstack-docs` (or any slug — record what you pick).' + '**Production branch:** `main`.' + 'Skip the upload step on first creation; just confirm the empty project exists.' + '### 2. Set the repo variable' + 'Name: `CLOUDFLARE_DOCS_PROJECT_NAME`' + 'Value: the project slug from step 1 (e.g. `driftstack-docs`).' + 'This is a **variable**, not a secret — it's just a project name and not sensitive.' — pinned so the Direct-upload-NOT-GitHub-integration race-avoidance + production-branch:main + CLOUDFLARE_DOCS_PROJECT_NAME-is-VARIABLE-not-SECRET commitment survives (drift to enabling CF GitHub integration would race the wrangler deploy and produce non-deterministic deploys)", () => {
    expect(body).toMatch(/### 1\. Create the Cloudflare Pages project/);
    expect(body).toMatch(
      /Open <https:\/\/dash\.cloudflare\.com> → \*\*Workers & Pages\*\* → \*\*Create application\*\* → \*\*Pages\*\* → \*\*Create using direct upload\*\*\./,
    );
    expect(body).toMatch(
      /\(Direct upload, NOT GitHub integration — the GitHub Actions workflow handles deploy via wrangler, and a CF GitHub integration would race against it\.\)/,
    );
    expect(body).toMatch(/\*\*Project name:\*\* `driftstack-docs`/);
    expect(body).toMatch(/\*\*Production branch:\*\* `main`\./);
    expect(body).toMatch(
      /Skip the upload step on first creation; just confirm the empty project exists\./,
    );
    expect(body).toMatch(/### 2\. Set the repo variable/);
    expect(body).toMatch(/- Name: `CLOUDFLARE_DOCS_PROJECT_NAME`/);
    expect(body).toMatch(
      /This is a \*\*variable\*\*, not a secret — it's just a project name and not sensitive\./,
    );
  });

  it("Shared-secrets + Pages-Edit-only-permission framing pinned: '### 3. Confirm the shared secrets exist' + '`CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Cloudflare Pages — Edit` permission scope.' + '`CLOUDFLARE_ACCOUNT_ID` — 32-hex Cloudflare account ID, visible on any zone overview page.' + 'If they don't, create them now (the marketing-site workflow uses the same secrets and would have surfaced if missing). The token does NOT need any DNS or zone permissions — Pages-Edit alone is sufficient.' — pinned so the shared-with-marketing + Pages-Edit-only-scope (not DNS, not zone) + 32-hex-account-ID commitment survives (drift to granting wider scopes would over-permission the token)", () => {
    expect(body).toMatch(/### 3\. Confirm the shared secrets exist/);
    expect(body).toMatch(
      /- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Cloudflare Pages — Edit` permission scope\./,
    );
    expect(body).toMatch(
      /- `CLOUDFLARE_ACCOUNT_ID` — 32-hex Cloudflare account ID, visible on any zone overview page\./,
    );
    expect(body).toMatch(
      /The token does NOT need any DNS or zone permissions — Pages-Edit alone is sufficient\./,
    );
  });

  it("First-deploy 2-options + custom-domain + Universal-SSL framing pinned: '### 4. Trigger the first deploy' + '**Option A — push-to-main:** any change under `apps/docs/` triggers `Deploy doc site`.' + '**Option B — manual dispatch:** GitHub repo → **Actions** → **Deploy doc site** → **Run workflow** → from `main`. No code change needed' + '### 5. Wire up the custom domain' + 'CF dashboard → Pages project → **Custom domains** → **Set up a custom domain** → `docs.driftstack.io`.' + 'CF will prompt to add a DNS record.' + 'TLS provisions automatically (CF universal SSL).' + 'DNS propagation: usually under a minute when the zone is in CF; up to a few minutes elsewhere.' — pinned so the 2-options-for-first-deploy + docs.driftstack.io custom-domain + universal-SSL + sub-minute-propagation-when-zone-in-CF commitment survives", () => {
    expect(body).toMatch(/### 4\. Trigger the first deploy/);
    expect(body).toMatch(
      /\*\*Option A — push-to-main:\*\* any change under `apps\/docs\/` triggers `Deploy doc site`\./,
    );
    expect(body).toMatch(
      /\*\*Option B — manual dispatch:\*\* GitHub repo → \*\*Actions\*\* → \*\*Deploy doc site\*\* → \*\*Run workflow\*\* → from `main`\. No code change needed/,
    );
    expect(body).toMatch(/### 5\. Wire up the custom domain/);
    expect(body).toMatch(
      /- CF dashboard → Pages project → \*\*Custom domains\*\* → \*\*Set up a custom domain\*\* → `docs\.driftstack\.io`\./,
    );
    expect(body).toMatch(/TLS provisions automatically \(CF universal SSL\)\./);
    expect(body).toMatch(
      /DNS propagation: usually under a minute when the zone is in CF; up to a few minutes elsewhere\./,
    );
  });

  it("CF-rollback-atomic + repo-rollback-slower-but-tracked + free-tier framing pinned: '## Rollback' + 'If a deploy ships a regression, two options:' + '**Cloudflare-side rollback** (fastest): CF Pages project → **Deployments** → pick a prior green deploy → **Rollback to this deployment**. Atomic; no re-build needed.' + '**Repo-side rollback:** `git revert <bad-sha>` + push. The workflow re-runs and deploys the reverted state. Slower (~2 min) but the source of truth tracks the rollback.' + '## Cost' + 'Cloudflare Pages free tier: 500 builds/month, unlimited bandwidth on static assets. The doc site won't approach those limits pre-launch.' + '## Related runbooks' + '`docs/founder-actions/v243-tauri-updater-keys.md` — GUI client signing keys.' + '`.github/workflows/deploy-marketing.yml` — sibling marketing-site deploy (same shape, different paths).' — pinned so the CF-side-atomic-rollback + repo-side-slower-but-tracked + 500-builds-month-free-tier + 2-related-runbook commitment survives", () => {
    expect(body).toMatch(/## Rollback/);
    expect(body).toMatch(/If a deploy ships a regression, two options:/);
    expect(body).toMatch(
      /\*\*Cloudflare-side rollback\*\* \(fastest\): CF Pages project → \*\*Deployments\*\* → pick a prior green deploy → \*\*Rollback to this deployment\*\*\. Atomic; no re-build needed\./,
    );
    expect(body).toMatch(
      /\*\*Repo-side rollback:\*\* `git revert <bad-sha>` \+ push\. The workflow re-runs and deploys the reverted state\. Slower \(~2 min\) but the source of truth tracks the rollback\./,
    );
    expect(body).toMatch(/## Cost/);
    expect(body).toMatch(
      /Cloudflare Pages free tier: 500 builds\/month, unlimited bandwidth on static assets\. The doc site won't approach those limits pre-launch\./,
    );
    expect(body).toMatch(/## Related runbooks/);
    expect(body).toMatch(
      /- `docs\/founder-actions\/v243-tauri-updater-keys\.md` — GUI client signing keys\./,
    );
    expect(body).toMatch(
      /- `\.github\/workflows\/deploy-marketing\.yml` — sibling marketing-site deploy \(same shape, different paths\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
