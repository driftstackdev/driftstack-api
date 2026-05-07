# V-259 — Cloudflare Pages: full project setup (founder ops action)

Per V-259 / paired with V-258: consolidates all four Cloudflare Pages projects the Driftstack stack needs, in one runbook so the founder can do this in a single Cloudflare-dashboard session.

Two of the four currently have GitHub Actions deploy workflows wired (marketing + docs). The other two (customer-dashboard + admin-panel) have astro configs but their deploy workflows haven't shipped yet — the projects can still be pre-created so the workflow rollouts are unblocked when they land.

## What this runbook covers

| Project slug                    | Custom domain              | Workflow                                    | Status of deploy workflow                                         |
| ------------------------------- | -------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `driftstack-marketing`          | `driftstack.dev` + `www.…` | `.github/workflows/deploy-marketing.yml`    | Wired (V-091 era)                                                 |
| `driftstack-docs`               | `docs.driftstack.dev`      | `.github/workflows/deploy-docs.yml` (V-258) | Wired (V-258)                                                     |
| `driftstack-customer-dashboard` | `app.driftstack.dev`       | (planned)                                   | Not yet wired — Astro SSR via `@astrojs/cloudflare`; future V-NNN |
| `driftstack-admin-panel`        | `admin.driftstack.dev`     | (planned, V-135)                            | Not yet wired — gated on Cloudflare Access SSO config             |

## Shared prerequisites (do once)

### 1. Cloudflare API token

`CLOUDFLARE_API_TOKEN` — single repo-wide secret used by both `deploy-marketing.yml` and `deploy-docs.yml` (and any future deploy workflow).

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

### C. `driftstack-customer-dashboard` (workflow: planned)

Pre-create the project so the future deploy workflow lands cleanly:

1. CF: create Pages project `driftstack-customer-dashboard` via direct upload.
2. Don't wire a domain yet — `app.driftstack.dev` waits for the dashboard SSR build (Astro + `@astrojs/cloudflare` adapter) and the deploy workflow that lands with it (future V-NNN).
3. The repo variable name will be `CLOUDFLARE_DASHBOARD_PROJECT_NAME` when the workflow ships; create the variable with that name + value `driftstack-customer-dashboard` to pre-stage.

### D. `driftstack-admin-panel` (workflow: planned, V-135)

V-135 lands the admin-panel deploy + Cloudflare Access SSO gate. Pre-staging:

1. CF: create Pages project `driftstack-admin-panel` via direct upload.
2. The custom domain (`admin.driftstack.dev`) wiring waits for V-135 because the Access policy attaches at the origin level and needs to be configured against the live Pages project.
3. Repo variable name will be `CLOUDFLARE_ADMIN_PROJECT_NAME` when the workflow ships.

## Verifying the workflows are wired correctly

After completing A and B, trigger one push under `apps/marketing-site/**` AND one push under `apps/docs/**`. Each should trigger ONLY the matching workflow:

```sh
# A trivial change under apps/marketing-site/ → only Deploy marketing site runs.
# A trivial change under apps/docs/ → only Deploy doc site runs.
# A change under apps/server/ → neither runs.
```

This is the path-filter design preventing cross-deployment storms when only one app changes.

## Cost (informational)

CF Pages free tier:

- 500 builds per month per account.
- Unlimited bandwidth on static assets.
- 1 build at a time per project (the `concurrency` group in each workflow respects this).

The Driftstack stack pre-launch is well under the build cap. Post-launch, if the rate ever approaches 500/month, CF Pages Pro is $20/mo for 5,000 builds.

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

- **Cloudflare Access SSO** for `admin.driftstack.dev` — separate V-135 / V-246-P1-003 ops action; lands when the admin-panel deploy ships.
- **Cloudflare R2 bucket setup** for session recordings + screenshots — separate ops action under the storage track; not Pages-related.
- **Cloudflare Workers / Pages Functions** — not used by Driftstack today (all four projects are static-only or SSR-via-Astro-adapter).
