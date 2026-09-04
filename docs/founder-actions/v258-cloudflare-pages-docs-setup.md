# V-258 — Cloudflare Pages setup for `docs.driftstack.io` (founder ops action)

Per V-258: the doc-site CI workflow (`.github/workflows/deploy-docs.yml`) needs a Cloudflare Pages project + DNS record + the same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets that the marketing-site deploy already uses.

The workflow is path-filtered: it only runs when something under `apps/docs/` changes (or its workflow file). Until you complete the steps below, every push to main will run the build-and-skip-upload path successfully (build artifact verified, upload step exits 0 with a "secret unset" message).

## What's already done

- Workflow file `.github/workflows/deploy-docs.yml` lives in the repo.
- `apps/docs/` builds 13 pages clean locally + in CI.
- Marketing-site deploy already uses `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` — same secrets are reused.

## What you (founder) need to do

### 1. Create the Cloudflare Pages project

Open <https://dash.cloudflare.com> → **Workers & Pages** → **Create application** → **Pages** → **Create using direct upload**. (Direct upload, NOT GitHub integration — the GitHub Actions workflow handles deploy via wrangler, and a CF GitHub integration would race against it.)

- **Project name:** `driftstack-docs` (or any slug — record what you pick).
- **Production branch:** `main`.
- Skip the upload step on first creation; just confirm the empty project exists.

### 2. Set the repo variable

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**:

- Name: `CLOUDFLARE_DOCS_PROJECT_NAME`
- Value: the project slug from step 1 (e.g. `driftstack-docs`).

This is a **variable**, not a secret — it's just a project name and not sensitive.

### 3. Confirm the shared secrets exist

Repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab. These should already exist from the marketing-site setup:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Cloudflare Pages — Edit` permission scope.
- `CLOUDFLARE_ACCOUNT_ID` — 32-hex Cloudflare account ID, visible on any zone overview page.

If they don't, create them now (the marketing-site workflow uses the same secrets and would have surfaced if missing). The token does NOT need any DNS or zone permissions — Pages-Edit alone is sufficient.

### 4. Trigger the first deploy

Two options:

**Option A — push-to-main:** any change under `apps/docs/` triggers `Deploy doc site`. Easiest path: edit a doc page (typo fix or similar), commit + push. The workflow runs, builds, deploys.

**Option B — manual dispatch:** GitHub repo → **Actions** → **Deploy doc site** → **Run workflow** → from `main`. No code change needed; the workflow re-builds and deploys whatever's on main.

### 5. Wire up the custom domain

After the first successful deploy, the project will have a `<project-name>.pages.dev` URL. Add the custom domain:

- CF dashboard → Pages project → **Custom domains** → **Set up a custom domain** → `docs.driftstack.io`.
- CF will prompt to add a DNS record. If the `driftstack.io` zone is already in this Cloudflare account, accept the prompt (CF adds the CNAME automatically). If the zone lives elsewhere, add the CNAME manually pointing to the Pages project URL.
- TLS provisions automatically (CF universal SSL).

DNS propagation: usually under a minute when the zone is in CF; up to a few minutes elsewhere.

### 6. Verify

- Visit <https://docs.driftstack.io>.
- Confirm `https` works (CF's universal SSL).
- Confirm sidebar nav renders (Get started → Quickstart, Concept guides → Profile management / Session lifecycle, etc.).
- Confirm the V-256 pages render with sidebar + brand identity:
  - <https://docs.driftstack.io/quickstart/>
  - <https://docs.driftstack.io/sdk/installation/>
  - <https://docs.driftstack.io/license-activation/>
  - <https://docs.driftstack.io/guides/profile-management/>
  - <https://docs.driftstack.io/guides/session-lifecycle/>

## Rollback

If a deploy ships a regression, two options:

**Cloudflare-side rollback** (fastest): CF Pages project → **Deployments** → pick a prior green deploy → **Rollback to this deployment**. Atomic; no re-build needed.

**Repo-side rollback:** `git revert <bad-sha>` + push. The workflow re-runs and deploys the reverted state. Slower (~2 min) but the source of truth tracks the rollback.

## Cost

Cloudflare Pages free tier: 500 builds/month, unlimited bandwidth on static assets. The doc site won't approach those limits pre-launch.

## Troubleshooting

- **Workflow shows "CLOUDFLARE_API_TOKEN unset — skipping upload"** — secret isn't visible to the workflow. Check it's in the **repository** secrets (not an environment-scoped one), and the value isn't empty.
- **Workflow shows "CLOUDFLARE_DOCS_PROJECT_NAME variable unset"** — variable isn't set. Repeat step 2; it's a **variable**, not a secret.
- **Wrangler errors with "project not found"** — the project name in the variable doesn't match the actual CF Pages project slug. Match case-sensitively.
- **Build succeeds locally but fails in CI** — Node version mismatch. The workflow pins Node 22; verify locally with `node --version`.
- **Custom domain SSL stuck on "pending"** — DNS hasn't propagated. Wait 5 minutes; if still stuck, verify the CNAME record points at the project's `pages.dev` URL.

## Related runbooks

- `docs/founder-actions/v243-tauri-updater-keys.md` — GUI client signing keys.
- `.github/workflows/deploy-marketing.yml` — sibling marketing-site deploy (same shape, different paths).
