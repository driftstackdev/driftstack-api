# @driftstack/customer-dashboard

The pre-launch customer account portal served at `app.driftstack.io`.

## Stack

- Astro 7 static output on Cloudflare Pages
- Tailwind CSS 3 through PostCSS, on the shared design tokens (`packages/design-tokens`: the desktop app's own light and dark theme, light by default)
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

### Preview with sample data (development only)

To look at every signed-in page without an API:

```bash
cd apps/customer-dashboard
DASHBOARD_DEV_FIXTURES=1 npx astro dev --port 4410 --host 127.0.0.1
```

Open `http://127.0.0.1:4410/__dev-fixture-sign-in` once: it signs this browser in to an invented sample account and opens the Overview. The dev server answers every API read from `dev-fixtures/fixtures.mjs` and accepts, then discards, every write. The flag works only with `astro dev`; a build ignores it, and `tests/unit/the-dashboard-sample-data-never-reaches-a-production-build.test.ts` checks that the built site contains none of the sample data.

## Authentication

The dashboard uses the web-session flow under `/v1/auth/*`. Browser code reads the current `ds_web_session_token`, sends it as a bearer credential to the control plane, and includes cookies where the endpoint contract requires them. API keys remain a separate SDK credential surface.

## Build and deploy

```bash
npm run typecheck --workspace @driftstack/customer-dashboard
npm run build --workspace @driftstack/customer-dashboard
```

The build writes static assets to `apps/customer-dashboard/dist/`. `.github/workflows/deploy-customer-dashboard.yml` and `scripts/deploy-frontend.sh customer-dashboard` deploy that directory to the `driftstack-customer-dashboard` Cloudflare Pages project. The production custom domain is `app.driftstack.io`.

Security headers and retired-route redirects live in `public/_headers` and `public/_redirects`. Keep authenticated data out of generated HTML and browser-persistent caches.
