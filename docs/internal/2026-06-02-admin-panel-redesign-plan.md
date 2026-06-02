# Admin Panel Redesign + Buildout — Plan (Agent-2, 2026-06-02)

**Founder directive (verbatim intent):** the admin panel is the full-control cockpit of the whole
project. It needs (1) a **large frontend redesign** — the current look isn't good enough ("I don't
like it right now"); (2) **accurate data** everywhere (no fake/mock); (3) **full control + management
of everything**; (4) **easy to understand / founder-friendly**; (5) **full functionality +
statistics**. Run full-autopilot; Agent-2 chooses order; one validated + deployed slice per wave.

## Current state (2026-06-02 orientation)

- **Stack:** Astro 5 + Tailwind (`tailwind.config.mjs`) + vanilla-JS progressive-enhancement (no
  React). Bearer auth via the app.driftstack.dev SSO bridge (`localStorage ds_web_session_token`),
  `PUBLIC_API_BASE_URL`. Deployed at admin.driftstack.dev (CF Pages).
- **~13 pages:** index (dashboard), accounts + accounts/[id], api-keys, audit-log, cost, incidents
  (+[id]), rate-limit-overrides, sessions, status-subscribers, webhook-dlq, atlas-priority-queue, leads.
- **Pattern:** pages SSR a **mock placeholder** (`data/mocks.ts`, 166 LOC) then client-fetch real data
  and hydrate (V-190). Works, but: fake numbers on first paint / if JS lags; `leads` is permanently
  mock (no endpoint); inconsistent across pages.
- **API surface available (40+ `/v1/admin/*` routes):** accounts (list/detail/suspend/unsuspend/tier/
  usage/quota-override/audit-note/refund-record), api-keys(+revoke), audit-log, cost(overview/config/
  accounts), crypto-orders (list/detail/events/stats/daily/pending-age/idempotency-metrics/sweep-
  expired/apply-ipn/internal-note/CSV), incidents(+resolve/reopen/updates), overview, rate-limit-
  overrides, sessions(+destroy), status-subscribers(+force-sub/unsub), validation-schedules(+trigger),
  webhook-dlq(+requeue/discard), webhook-deliveries/:id(+replay), atlas-priority/queue.
- **Gaps:** crypto-orders management entirely absent from the panel; webhook-deliveries per-item +
  validation-schedules absent; account-lifecycle actions (suspend/tier/refund/audit-note) need
  verifying/completing in the detail page; `/v1/admin/overview` returns only 4 counts (thin stats).

## Redesign vision

Modern SaaS-admin aesthetic (Stripe Dashboard / Linear / Vercel direction): neutral slate/zinc
palette, ONE accent (driftstack red — CTAs/alerts/badges only, never gradient-on-text per
[[feedback_no_red_gradient_on_text]]), strong type hierarchy, dense-but-scannable, card + data-table

- stat-tile + chart driven. Real-data-first with skeleton loaders (no mock placeholders). Persistent
  sectioned left sidebar + top bar (global search, env indicator, account/sign-out). Fully responsive.
  Founder-friendly: every screen answers "what's the state + what can I do about it" at a glance.

## Design system (Phase 0 — the reusable foundation, build FIRST)

Astro components under `src/components/ui/` + a shared `admin.css`/Tailwind tokens:

- **Tokens:** color scale (slate/zinc neutrals + red accent + semantic success/warn/danger/info),
  spacing, radius, shadow, type scale. Light theme first; dark optional later.
- **Shell:** `AppShell` (sidebar + topbar + main), sectioned `Sidebar` nav, `TopBar` (search + env +
  user), `PageHeader` (title + actions + breadcrumb).
- **Primitives:** `StatTile` (value + label + delta/trend + sparkline), `Card`/`Panel`, `DataTable`
  (sortable, filterable, paginated, empty-state, row-actions), `Badge` (status variants), `Button`
  (variants), `Tabs`, `Toast`, `Skeleton`, `EmptyState`, `Modal`/`ConfirmDialog` (for destructive
  ops), `Chart` (lightweight inline-SVG line/bar/sparkline — no heavy dep).
- **Data layer:** a single `adminFetch(path, opts)` helper (bearer from localStorage, error→toast,
  401→SSO redirect, typed responses), shared loading/empty/error states, so every page wires real
  data identically. Kill `data/mocks.ts`.

## Information architecture (new sidebar)

- **Overview** — rich KPI + trends dashboard.
- **Accounts** — list/search → detail (full lifecycle control center).
- **Billing** — Stripe subscriptions + Crypto orders (the big missing surface) + revenue.
- **Usage & Cost** — per-account + aggregate + cost-to-serve margins.
- **Sessions** — live monitor + destroy.
- **Operations** — Webhooks (DLQ + deliveries), Incidents, Status subscribers, Rate-limit overrides,
  Validation schedules.
- **Fleet** — atlas-priority queue, mac-nodes (Agent-1-adjacent; read-mostly).
- **Audit log** — global, filterable.

## Statistics (Phase 1 — the dashboard the founder asked for)

Enrich `/v1/admin/overview` (or a new `/v1/admin/stats`) — server-side aggregation, accurate, cached
briefly. KPIs: accounts (total/active/suspended/deleted), signups (today/7d/30d + sparkline), MRR/ARR
(Stripe active+trialing × price), crypto revenue (paid orders), active sessions, DLQ depth, open
incidents, API-keys issued. Trends (time-series): signups/day (30/90d), revenue/day, tier
distribution (pie/bar), sessions/day, cost-to-serve margin. Recent-activity audit feed. (Reuse the
audited cost-estimator + usage + stripe/crypto repos; READ-ONLY aggregation; respect the
audited-clean cost layer — don't duplicate it.)

## Phased roadmap (each phase = multiple per-wave validated+deployed slices)

0. **Design-system foundation** — tokens + AppShell/Sidebar/TopBar + primitives + `adminFetch` +
   skeletons. Migrate the existing dashboard onto it as the proof. Kill mock placeholders.
1. **Overview dashboard** — rich `/v1/admin/stats` endpoint + the KPI/trends dashboard UI.
2. **Accounts control center** — list (search/filter/sort) + detail (suspend/unsuspend, tier change,
   refund-record, audit-note, quota-override, usage, cost, sessions, api-keys, audit). Full control.
3. **Billing** — Stripe subscriptions view + **Crypto-orders management** (list/detail/events/stats/
   daily/pending-age/sweep-expired/apply-ipn/internal-note/CSV) — the biggest coverage gap.
4. **Operations** — webhooks (DLQ + per-delivery view/replay), incidents (migrate + complete),
   status-subscribers, rate-limit-overrides, validation-schedules.
5. **Usage & Cost / Sessions / Fleet / Audit** — migrate onto the new design, real-data-wired.
6. **UX polish** — global search, saved filters, keyboard nav, responsive/mobile, a11y, empty/error
   states, loading skeletons everywhere.

## Execution discipline (per wave)

Pre-push gate GREEN; parity tests updated same commit (the admin-panel has content-parity tests —
grep ALL before editing a page); V-205 (zero AI-tooling trailers); Rule R (<50 files uncommitted);
verify CI inline; deploy via CF-Pages (the admin deploy workflow). Build the design-system FIRST so
every subsequent page is consistent + fast. Real data only — no new mocks; remove old ones as pages
migrate. Each wave: ship ONE coherent slice (a component set, a page, or an endpoint+wiring), validated.

## Open product questions (surface, don't block — pick sensible defaults)

- `leads` tile/page: no backend leads concept exists. Default: remove it (or stub clearly "not wired")
  until a leads source is defined — don't show fake leads. Founder can define a CRM/leads source later.
- Theme: light-first (admin readability). Dark mode deferred to Phase 6 if wanted.
- Charts: lightweight inline-SVG (no heavy charting dep) unless the founder wants richer interactivity.
