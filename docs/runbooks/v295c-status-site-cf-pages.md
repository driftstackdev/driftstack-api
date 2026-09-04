# V-295c — status.driftstack.io Cloudflare Pages runbook

Founder-facing one-time setup for the status page CF Pages project +
DNS. Once these steps are done the GitHub-Pages-style auto-deploy
takes over; future commits to `main` redeploy the static bundle from
`apps/status-site/dist/`.

## Prerequisites

- Cloudflare account with `driftstack.io` zone already managed (same
  zone as `driftstack.io` marketing-site + `api.driftstack.dev` API).
- GitHub access to `driftstackdev/driftstack-api`.
- The driftstack-api repo's `main` branch contains `apps/status-site/`.

## One-time CF Pages project setup

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → select `driftstackdev/driftstack-api`.
2. **Project name**: `driftstack-status` (the deploy URL becomes
   `driftstack-status.pages.dev`; we override it with the custom
   subdomain in step 5).
3. **Production branch**: `main`.
4. **Build settings**:
   - Framework preset: **Astro**
   - Build command: `npm install && npm run build --workspace apps/status-site`
   - Build output directory: `apps/status-site/dist`
   - Root directory: leave empty (the project is a workspace)
5. **Environment variables** (production + preview):
   - `PUBLIC_API_BASE_URL` = `https://api.driftstack.dev` (production)
     and `https://staging.driftstack.dev` (preview, once staging
     exists; for now leave preview = production).
   - `PUBLIC_STATUS_R2_URL` = the public-readable URL of the R2 status
     snapshot, e.g. `https://r2-public.driftstack.dev/status/incidents-public.json`.
     Required for the V-295c2 R2 fallback when the live API is
     unreachable. The R2 bucket must have a custom public domain (see
     "R2 public domain" section below).
6. Click **Save and Deploy**. The first build runs ~90s.

## R2 public bucket (V-295c2 fallback)

The status site falls back to a public R2 object when the live API is
unreachable. **A separate R2 bucket** holds this object — the recordings
bucket stays private (it contains Customer Data; making it public would
be a compliance break).

Setup:

1. Cloudflare dashboard → **R2** → **Create bucket** →
   `driftstack-public` (or chosen name). Region: same as the recordings
   bucket (EU per data-residency).
2. New bucket → **Settings** → **Public access** → **Custom domain** →
   connect `r2-public.driftstack.dev` (or chosen subdomain). Add the
   matching CNAME in the DNS panel as Cloudflare prompts.
3. Set the API server env `R2_BUCKET_PUBLIC` to the new bucket name in
   the Hetzner deploy `.env`. (The same R2 credentials that already
   write the recordings bucket work for the public bucket — both share
   the same R2 token; bucket-level scoping is enforced by the bucket
   name in the request.)
4. Restart the API server (or wait for the next deploy). Within 60s
   after restart, the snapshot writer poller should produce the file.
5. Confirm the public URL works:
   `curl -sS https://r2-public.driftstack.dev/status/incidents-public.json`
   should return JSON `{ generated_at, data: [...] }`.

If `R2_BUCKET_PUBLIC` is unset the API server logs a warning at boot and
the snapshot writer is disabled; the status site then has no fallback
and shows "Status currently unavailable" if the live API is down.

## DNS — point status.driftstack.io at the Pages project

1. Cloudflare dashboard → **driftstack.io zone** → **DNS** → **Records**.
2. Add **CNAME**:
   - Name: `status`
   - Target: `driftstack-status.pages.dev`
   - Proxy status: **Proxied** (orange cloud — keeps Cloudflare's TLS,
     HTTP/3, and caching layer in front).
3. CF Pages dashboard → the new project → **Custom domains** → **Set
   up a custom domain** → `status.driftstack.io`. Cloudflare auto-
   verifies via the CNAME you just created and issues an EV-style cert.

## Verification (post-deploy, founder runs once)

1. Visit `https://status.driftstack.io/`. The page should load with
   the "Loading current status…" card briefly, then transition to
   "All systems operational" (green dot) — assuming no incident is
   open at that moment.
2. Open browser devtools → Network tab → confirm a request to
   `https://api.driftstack.dev/v1/status/incidents` returns 200 with
   `{ data: [...] }`.
3. Post a test incident from the admin panel
   (`/incidents` → "Post new incident") with `public=true`. Within
   ~60s the status page should auto-refresh and show the incident
   under "Open".
4. Resolve the test incident from the admin panel detail view. Within
   ~60s the page should move it to "Resolved".

## Re-deploy semantics

- Every push to `main` that touches `apps/status-site/**` triggers a
  Pages build automatically.
- Pages keeps the previous deployment available for instant rollback
  via the dashboard if a deploy ships broken HTML.
- The build is hermetic — it does NOT call the API at build time.
  All incident data is fetched at runtime by the page's inline JS.

## Failure modes

- **API down**: the page shows "Status currently unavailable"; the
  page itself stays up because it's static HTML on Cloudflare's CDN.
  V-295c2 will add an R2-mirrored snapshot fallback so the page can
  still surface the last-known incidents when the API is unreachable.
- **CF Pages outage**: extremely rare; the only mitigation is multi-
  CDN, which is out of scope until traffic justifies it. CF Pages
  shares the same SLA as Cloudflare's edge, which is the same edge
  that fronts api.driftstack.dev.
- **DNS misconfiguration**: covered by step-2 verification above. If
  `status.driftstack.io` returns a CF "page not found" error, the
  CNAME is wrong; if TLS fails, the custom-domain hookup in CF Pages
  is incomplete.
