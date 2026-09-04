# V-280 — Admin panel Cloudflare Pages setup

**Status:** founder action pending. Admin panel source lives at
`apps/admin-panel/`. Deploy workflow at
`.github/workflows/deploy-admin-panel.yml`. Customer panel scope guard
(`driftstack_internal_admin`) is already wired on the server; the
remaining gap is the Cloudflare Pages project + DNS for
`admin.driftstack.io`.

## Symptom that drove this runbook

Customer reports they can't see the admin panel — `admin.driftstack.io`
returns DNS-NXDOMAIN (no record exists). Account
`joeltheunissen89@gmail.com` is correctly enrolled in
`DRIFTSTACK_STAFF_EMAILS` on the api server, so the `/v1/admin/*` scope
gate would let them through if they could only reach the panel.

## 4-step setup

1. **Create the Cloudflare Pages project** (operator):
   - Cloudflare dashboard → Pages → Create project → "Direct Upload" (do
     NOT use Git integration; we deploy via wrangler in CI).
   - Project name: `driftstack-admin-panel` (this is the slug that goes
     into the repo variable below).
   - Production branch: `main`.

2. **Add the repo variable** (operator):
   - GitHub → repo → Settings → Variables → New repository variable
   - Name: `CLOUDFLARE_ADMIN_PANEL_PROJECT_NAME`
   - Value: `driftstack-admin-panel` (or whatever slug from step 1).

3. **Add the DNS record** (operator):
   - Cloudflare DNS → driftstack.io zone → Add record
   - Type: CNAME
   - Name: `admin`
   - Target: `<project-name>.pages.dev` (the URL the Pages project gives
     you after first deploy).
   - Proxy: ON (orange cloud — Cloudflare TLS termination).

4. **Trigger first deploy**:
   - Push any change under `apps/admin-panel/**` (or manually trigger via
     Actions → "Deploy admin panel" → Run workflow). The path-filter
     auto-triggers subsequent deploys on relevant changes.

## Verification (after deploy lands)

- `curl -I https://admin.driftstack.io/` should return 200.
- Log into the customer dashboard as `joeltheunissen89@gmail.com`. The
  web-session synthetic api-key gets `driftstack_internal_admin`
  appended via the `DRIFTSTACK_STAFF_EMAILS` env-var allowlist on the
  api server (already set in prod 2026-05-19).
- Navigate to `https://admin.driftstack.io/` — the index page renders
  the admin nav. Click through to `/accounts`, `/audit-log`, `/cost`,
  etc. All routes call `/v1/admin/*` on api.driftstack.dev which
  scope-gates via V-134.

## Why staff-emails not a column

`DRIFTSTACK_STAFF_EMAILS` is an env-var allowlist rather than an
`accounts.is_staff` column because (a) the staff set is small + stable
(< 10), (b) rotation is a deploy-env-var update, not a DB write, and
(c) accidentally bumping somebody to staff via a DB cell-edit is more
likely than accidentally bumping via env-var (deploy review catches
the latter).
