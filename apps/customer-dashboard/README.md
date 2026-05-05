# @driftstack/customer-dashboard

The signed-in customer dashboard for Driftstack — `app.driftstack.dev`.

> **Status:** scaffolding only as of V-099 + V-108. Customer-visible copy + visual treatments on the onboarding flow + management pages are pending founder review per the standing marketing-copy + brand-surface cadence. The project init, design tokens, layout, and route shells are committed; per-page copy lands as Tier 3 drafts surfaced to the founder.

## Stack

- Astro 5 (static-build output) → Cloudflare Pages
- Tailwind CSS (tokens shared with `apps/marketing-site/`)
- Geist Sans + Berkeley Mono (same as marketing site)
- React islands TBD (per V-084 dashboard-stack proposal — Option A approved by default; landing once founder confirms)

The decision rationale lives in `docs/architecture/customer-dashboard-stack.md`.

## Local dev

```bash
npm install                                          # at repo root, once
npm run dev --workspace apps/customer-dashboard      # → http://localhost:4322
```

Pages currently use mock data from `src/data/mocks.ts`. Live wiring against the control plane (`/v1/billing`, `/v1/profiles`, `/v1/api-keys`, `/v1/sessions`, `/v1/usage`) lands once the dashboard moves past scaffolding.

## Layout

```
src/
├── data/mocks.ts        — MOCK_ACCOUNT, MOCK_SUBSCRIPTION, MOCK_PROFILES, etc.
├── layouts/
│   └── DashboardLayout.astro  — sidebar nav + main slot, withSidebar prop
├── pages/
│   ├── index.astro      — overview (concurrent / profiles / API keys / sessions / subscription summary)
│   └── 404.astro        — not-found page
└── styles/base.css      — Tailwind layers + .dashboard-card component
```

The sidebar nav lists 9 items (Overview, Profiles, Sessions, API keys, Usage, Billing, Webhooks, Team, Settings). Sub-pages are pending — each lands as a Tier 3 draft for founder review when the copy + visual decisions are made.

## Auth model

When dashboard pages wire to real APIs:

- The page reads a `driftstack_web_session` cookie (sha256-hashed token from V-079 web sessions).
- Each page fetches its data via `/v1/...` endpoints with `Authorization: Bearer <api-key>` for SDK-style reads, OR via session-cookie auth path (separate endpoint set, TBD).
- Onboarding flow (signup → verify-email → legal-accept → tier-select → payment-redirect → first-key) hits `/v1/auth/*` directly.

## Build + deploy

```bash
npm run build --workspace apps/customer-dashboard
# → apps/customer-dashboard/dist/
```

Deploy pipeline lands when founder confirms the dashboard-stack proposal. Pattern will mirror `.github/workflows/deploy-marketing.yml`: path-filtered trigger on `apps/customer-dashboard/**`, build, push to a Cloudflare Pages project at `driftstack-customer-dashboard`.
