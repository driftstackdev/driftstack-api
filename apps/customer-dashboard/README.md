# @driftstack/customer-dashboard

The pre-launch customer account portal served at `app.driftstack.io`.

## Stack

- Astro 7 static output on Cloudflare Pages
- Tailwind CSS 3 through PostCSS, with tokens shared with `apps/marketing-site/`
- Geist Sans and JetBrains Mono/Berkeley Mono fallbacks
- Browser-side API hydration against `api.driftstack.dev`
- Optional Sentry telemetry when `PUBLIC_SENTRY_DSN_DASHBOARD` is set at build time

No current route requires server-side rendering or a Pages Function. If a future route needs on-demand server execution, choose and document the runtime at that point instead of keeping an unused adapter in every build.

## Local development

From the repository root:

```bash
npm install
npm run dev --workspace @driftstack/customer-dashboard
```

The local Astro server uses the same static page modules and client-side API wiring as production. Set `PUBLIC_API_BASE_URL` only when intentionally targeting a non-default control plane.

## Authentication

The dashboard uses the web-session flow under `/v1/auth/*`. Browser code reads the current `ds_web_session_token`, sends it as a bearer credential to the control plane, and includes cookies where the endpoint contract requires them. API keys remain a separate SDK credential surface.

## Build and deploy

```bash
npm run typecheck --workspace @driftstack/customer-dashboard
npm run build --workspace @driftstack/customer-dashboard
```

The build writes static assets to `apps/customer-dashboard/dist/`. `.github/workflows/deploy-customer-dashboard.yml` and `scripts/deploy-frontend.sh customer-dashboard` deploy that directory to the `driftstack-customer-dashboard` Cloudflare Pages project. The production custom domain is `app.driftstack.io`.

Security headers and retired-route redirects live in `public/_headers` and `public/_redirects`. Keep authenticated data out of generated HTML and browser-persistent caches.
