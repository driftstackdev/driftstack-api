# V-259 — Cloudflare Pages: full project setup (founder ops action)

Per V-259 / paired with V-258: consolidates all four Cloudflare Pages projects the Driftstack stack needs, in one runbook so the founder can do this in a single Cloudflare-dashboard session.

All four projects now have path-filtered GitHub Actions deploy workflows and production custom domains. This runbook remains the inventory, first-time setup, verification, and rollback reference.

## What this runbook covers

| Project slug                    | Custom domain              | Workflow                                          | Status |
| ------------------------------- | -------------------------- | ------------------------------------------------- | ------ |
| `driftstack-marketing`          | `driftstack.dev` + `www.…` | `.github/workflows/deploy-marketing.yml`          | Wired  |
| `driftstack-docs`               | `docs.driftstack.dev`      | `.github/workflows/deploy-docs.yml`               | Wired  |
| `driftstack-customer-dashboard` | `app.driftstack.dev`       | `.github/workflows/deploy-customer-dashboard.yml` | Wired  |
| `driftstack-admin-panel`        | `admin.driftstack.dev`     | `.github/workflows/deploy-admin-panel.yml`        | Wired  |

## Shared prerequisites (do once)

### 1. Cloudflare API token

`CLOUDFLARE_API_TOKEN` — single repo-wide secret used by all four Pages deploy workflows.

- CF dashboard → top-right profile menu → **My Profile** → **API Tokens** → **Create Token** → use the **Edit Cloudflare Pages** template, OR custom token with these permissions:
  - `Account` → `Cloudflare Pages` → `Edit`.
  - Account resources: include the Driftstack Cloudflare account.
- Copy the token value (shown once).
- GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab → **New repository secret** → name `CLOUDFLARE_API_TOKEN`, paste token.

### 2. Cloudflare account ID

`CLOUDFLARE_ACCOUNT_ID` — same repo-wide secret.

- CF dashboard → any zone overview page → right-hand sidebar shows **Account ID** (32 hex chars).
- GitHub → secrets → **New repository secret** → name `CLOUDFLARE_ACCOUNT_ID`, paste value.

### 3. DNS zone

`driftstack.dev` zone must be in the same Cloudflare account as the Pages projects so custom-domain wiring is one-click. If the zone lives elsewhere, custom-domain setup falls back to a manual CNAME record per project (still works; just not one-click).

## Per-project setup

Each project follows the same five-step shape. Repeat for each slug.

### A. `driftstack-marketing` (workflow: `.github/workflows/deploy-marketing.yml`)

1. CF dashboard → **Workers & Pages** → **Create application** → **Pages** → **Create using direct upload**.
   - Project name: `driftstack-marketing`.
   - Production branch: `main`.
   - Skip the upload step on creation.
2. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**:
   - Name: `CLOUDFLARE_PAGES_PROJECT_NAME`
   - Value: `driftstack-marketing`
3. Trigger first deploy: GitHub repo → **Actions** → **Deploy marketing site** → **Run workflow** → from `main`.
4. Wire custom domains: CF Pages project → **Custom domains** → add `driftstack.dev` AND `www.driftstack.dev`. CF auto-creates DNS records if the zone is in this account.
5. Verify <https://driftstack.dev>: `index.astro` should render with the V-219 brand identity (oxblood D-badge + Geist Sans + slate palette).

### B. `driftstack-docs` (workflow: `.github/workflows/deploy-docs.yml`)

Detailed runbook: `docs/founder-actions/v258-cloudflare-pages-docs-setup.md`. Summary:

1. CF: create Pages project `driftstack-docs` via direct upload.
2. GitHub: set repo variable `CLOUDFLARE_DOCS_PROJECT_NAME` = `driftstack-docs`.
3. Trigger first deploy via Actions → **Deploy doc site** → Run workflow.
4. Wire custom domain `docs.driftstack.dev`.
5. Verify quickstart, sdk/installation, license-activation, guides/profile-management, guides/session-lifecycle pages.

### C. `driftstack-customer-dashboard` (workflow: `.github/workflows/deploy-customer-dashboard.yml`)

1. CF: create Pages project `driftstack-customer-dashboard` via direct upload.
2. Set repo variable `CLOUDFLARE_DASHBOARD_PROJECT_NAME` = `driftstack-customer-dashboard`.
3. Trigger **Deploy customer dashboard** from `main`.
4. Wire `app.driftstack.dev` and verify login plus one authenticated account page.

### D. `driftstack-admin-panel` (workflow: `.github/workflows/deploy-admin-panel.yml`)

1. CF: create Pages project `driftstack-admin-panel` via direct upload.
2. Set repo variable `CLOUDFLARE_ADMIN_PANEL_PROJECT_NAME` = `driftstack-admin-panel`.
3. Trigger **Deploy admin panel** from `main`.
4. Wire `admin.driftstack.dev`, retain the Cloudflare Access policy, and verify a staff-scoped account can open the panel while a non-staff account cannot.

## Verifying the workflows are wired correctly

Trigger one isolated change under each frontend directory. Each should trigger only its matching workflow:

```sh
# A trivial change under apps/marketing-site/ → only Deploy marketing site runs.
# A trivial change under apps/docs/ → only Deploy doc site runs.
# A trivial change under apps/customer-dashboard/ → only Deploy customer dashboard runs.
# A trivial change under apps/admin-panel/ → only Deploy admin panel runs.
# A change under apps/server/ → no Pages workflow runs.
```

This is the path-filter design preventing cross-deployment storms when only one app changes.

## Cost (informational)

These workflows build in GitHub Actions and Direct Upload the prebuilt `dist/` directories with Wrangler. Cloudflare's Pages build quota applies to its built-in Git integration, so it is not the limiting compute budget for this deployment path. If the projects ever move to Git integration, the current Pages limits are:

CF Pages free tier:

- 500 builds per month per project.
- Unlimited bandwidth on static assets.
- 1 concurrent build on the Free plan (Cloudflare counts concurrency per account; each workflow also serializes its own production deploys).

The Driftstack stack pre-launch is well under the build cap. Cloudflare currently lists the Pro plan at $25/month with 5,000 builds per project and 5 concurrent builds; re-check the official limits and pricing pages before changing plans.

## Rollback

Same pattern across all projects:

- **CF dashboard** rollback: Pages project → **Deployments** → pick a prior green deploy → **Rollback to this deployment**. Atomic.
- **Repo-side** rollback: `git revert <bad-sha>` + push. The workflow re-runs and deploys the reverted state.

## Troubleshooting

- **Workflow shows "CLOUDFLARE_API_TOKEN unset — skipping upload"** — secret isn't visible to the workflow. Check it's in the **repository** secrets (not an environment-scoped one).
- **"Project not found"** — repo variable name doesn't match CF Pages project slug. Match exactly.
- **Two workflows running on the same push** — likely a path-filter regression. Verify each workflow's `paths:` block only includes its own app directory (no `apps/**` blanket).
- **TLS stuck on "pending"** — DNS hasn't propagated. Wait 5 minutes; check the CNAME record points at the Pages project's `<slug>.pages.dev` URL.
- **Deploy succeeds but the wrong content shows** — `<slug>.pages.dev` URL pointing at the wrong project. Verify the `--project-name` flag in the workflow command matches the CF project slug.

## Related runbooks

- `docs/founder-actions/v258-cloudflare-pages-docs-setup.md` — docs-specific deep dive (subset of section B above).
- `docs/founder-actions/v243-tauri-updater-keys.md` — GUI client signing keys (unrelated; included for ops-runbook completeness).

## What's NOT in this runbook

- **Cloudflare Access policy administration** for `admin.driftstack.dev` — separate V-135 / V-246-P1-003 ops responsibility; this runbook only verifies the policy remains effective after deploys.
- **Cloudflare R2 bucket setup** for session recordings + screenshots — separate ops action under the storage track; not Pages-related.
- **Cloudflare Workers / Pages Functions** — not used by the frontend projects today; all current pages build as static assets, and admin arbitrary-id routes use Pages 200 rewrites to static client-fetched shells.
