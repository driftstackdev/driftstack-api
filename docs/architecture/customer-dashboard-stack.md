# Customer dashboard — stack proposal

**Status:** Proposal pending founder review
**Date:** 2026-05-03
**Tier:** Architectural (vendor / structural — surfaces for review per Decision authority)
**Related V-entry:** V-084 (this proposal). Workstream C (admin panel) and Workstream F (onboarding flow) both consume the chosen stack.

## Context

Driftstack ships multiple customer-touch surfaces beyond the API:

1. **Marketing site** — `apps/marketing-site/`, Astro static-build on Cloudflace Pages. Already live (V-064-V-067). Goal: SEO + conversion + content. Audience: prospects.
2. **Customer dashboard** — does NOT exist yet. Goal: signed-in users manage their account (subscription, API keys, profiles, sessions, usage, billing portal redirect, legal acceptance UI). Audience: paying customers + trial users.
3. **Admin panel** — does NOT exist yet. Workstream C. Goal: founder operates the business (list accounts, suspend/unsuspend, tier changes, audit log review, webhook delivery review). Audience: founder-only at launch.
4. **Onboarding flow** — does NOT exist yet. Workstream F. Signup → email-verify → legal-accept → tier-select → payment → first-API-key. Largely overlaps with the customer dashboard's auth + billing surfaces; could either share the same SPA shell or live as a multi-page flow.
5. **GUI client** — separate Tauri-based desktop app. Out of scope for this doc.

The decision: **what stack do we use for surfaces 2 + 3 + 4?**

Constraints driving the choice:

- **Solo engineering team.** Two stacks (one for marketing, one for dashboard) is already a maintenance cost; three would be untenable. Whichever stack lands gets the dashboard + admin + onboarding flow.
- **Server-side auth.** The V-079 web-session model uses opaque token cookies + server-side validation. The dashboard needs to read/refresh those tokens — a pure SPA against the API works but loses the "render once, ship HTML" performance + crawler-resistance benefits.
- **Stripe Checkout / Customer Portal redirect.** Most billing happens off-site (Stripe-hosted UI). The dashboard mainly displays state + initiates redirects. NOT a complex client-rich UI.
- **Rest of stack is TypeScript.** SDK + control plane + marketing site all TS. JS-adjacent stacks (Vue, Svelte) require team-context switching.
- **EU residency.** Whatever runtime hosts the dashboard runs on EU infrastructure. Cloudflare Pages (Workers in EU regions), Hetzner (Helsinki/Falkenstein), or similar. Vercel's EU-region setup is also viable.
- **Keep the marketing-site framing intact.** The marketing site stays Astro (it's working; rebuilding it is a distraction). The dashboard is a separate sub-domain (`app.driftstack.dev`).

## Options

### Option A — Astro + React islands (shared with marketing site)

Same repo, separate Astro project at `apps/customer-dashboard/` with React-island interactivity for the dynamic parts. Output: static + SSR hybrid via Cloudflare Pages's Astro adapter.

**Pros:**

- Same toolchain as the marketing site — solo team's existing Astro mental model carries over.
- Cloudflare Pages already wired (V-067); two-project deploy is `apps/marketing-site/` → `driftstack.dev`, `apps/customer-dashboard/` → `app.driftstack.dev`. No new vendor.
- Astro's island-architecture maps well to "mostly static dashboard pages with a few interactive widgets" (subscription state, API key creation). Most pages are read-mostly: `GET /v1/billing`, `GET /v1/api-keys`, `GET /v1/profiles`. Interactivity is for create/delete/refresh.
- Tailwind already wired; Geist Sans + Berkeley Mono + oxblood accent reusable directly. Brand consistency by sharing the design tokens.
- React 19's server components + use-server actions land in 2026; for the dashboard's mostly-server-driven model that's a future-proof choice.

**Cons:**

- Astro's SSR story is less mature than Next.js for highly-dynamic apps. The dashboard's "edit-and-save" flows (rename profile, revoke API key) require client-side state management; Astro doesn't ship that out of the box.
- Form-heavy onboarding flow (signup → verify → legal-accept → tier-select → payment) is more naturally a multi-step React form library (e.g. react-hook-form). Astro's MPA model with island forms works but each step is a full page load.
- Astro's auth-cookie story is "you handle it" — no built-in middleware. Re-implementing the V-079 session-token-cookie + 401-redirect logic in Astro middleware is a one-time cost; if we do it well it's portable.

**Effort estimate:** Medium. ~2-3 weeks of focused work for dashboard + admin + onboarding. Auth middleware + design system reuse is the load-bearing setup; pages flow once that lands.

### Option B — Next.js (App Router) on Vercel or Cloudflare

New `apps/customer-dashboard/` as a Next.js project. Server components + use-server for the read paths; client components for interactive widgets. Deploys to either Vercel (EU region) or Cloudflare Pages (Next.js adapter).

**Pros:**

- Best-in-class form ergonomics, SSR maturity, server-actions story. The onboarding flow's multi-step form fits Next.js's mental model directly.
- Largest ecosystem — react-hook-form, shadcn/ui, Tanstack Query, NextAuth (we DON'T use NextAuth; auth is server-side V-079, but the rest of the ecosystem benefits).
- Single-repo + `apps/customer-dashboard/` works fine; build pipeline parallels the existing `apps/server/` + `apps/marketing-site/` pattern.
- Auth middleware (Next.js's `middleware.ts`) is a clean fit for the V-079 web-session-cookie pattern.

**Cons:**

- New stack to learn / maintain alongside Astro + Tauri. Two SSR frameworks for one company is real surface area for a solo team.
- Vercel = US-based vendor for the runtime even if the EU region is used; sub-processor amendment needed (DPA Annex 3 + Privacy Policy update), 30-day customer notice. If we go Cloudflare-Pages-Next.js-adapter that's already on the sub-processor list, but the adapter's edge runtime has caveats (no Node.js APIs in middleware, etc.).
- Next.js's complexity tax: the App Router is mature but its mental model (server components + client components + use-server + use-client + the layout cascade) has a steeper ramp than Astro's "static page + island" model.

**Effort estimate:** Medium-high. Faster iteration once ramped, but ramp + tooling debt is real for a solo team.

### Option C — SvelteKit

Drop-in alternative to Next.js with a smaller mental model + smaller bundle. Same separate-app-in-monorepo pattern.

**Pros:**

- Smaller, simpler reactive model. Less ecosystem-context switching cost than React+Next.
- Excellent SSR story; cookie-based auth is straightforward.

**Cons:**

- Team-context switching cost: rest of the stack is TypeScript-with-React adjacency (api-types Zod schemas have no UI binding, but every JS-side helper assumes React/TS conventions). Adding Svelte adds a third "this part of the codebase has different idioms" surface.
- Smaller component-library ecosystem than React. The custom-design-system path is fine for marketing but for a dashboard with tabs / data tables / forms, having shadcn/ui or similar is a real productivity win.
- Less staff-engineering market depth — if we hire later, React-experienced candidates outnumber Svelte-experienced 5-10x.

**Effort estimate:** Medium-low for the dashboard itself, medium-high for ecosystem-component-library work + future hiring fit.

### Option D — Server-rendered HTML + htmx (no SPA framework)

The Fastify control plane serves dashboard pages directly. htmx handles dynamic interactions (form submits, partial replacements). Templates via Pug / Eta / Handlebars.

**Pros:**

- Zero new framework dependency. Fastify already runs the API; serving HTML is a small extension.
- Minimal client-side JS — fast pages, minimal hydration cost.
- Auth is trivial: V-079 web sessions are already in the server context.

**Cons:**

- Form-heavy flows like onboarding work but feel dated. Modern customers expect SPA-grade interactivity at the form level (real-time validation, multi-step progress, payment-method-element embedding from Stripe).
- htmx forces a server-driven mental model that's the opposite of what most front-end developers expect. If we ever need to bring in contract help, the onboarding cost is high.
- Stripe Elements (embedded payment-element) is a React-leaning ecosystem. Going htmx means each Stripe Element is a manual integration.
- Brand surface mismatch: marketing site is a polished Astro+Tailwind product, dashboard would be a server-rendered jQuery-of-2026 product. Visual consistency suffers.

**Effort estimate:** Low for the basic surface, but the surface ceiling is also low — not a real candidate for the long-term dashboard.

## Recommendation

**Lean Option A (Astro + React islands)** for these reasons:

1. **Same toolchain as the marketing site.** Solo engineering team's biggest cost is context-switching. Two stacks rather than three.
2. **The dashboard's actual interactivity surface is shallow.** Most pages are read-mostly with one or two write actions (create API key, rename profile, revoke session). Astro islands are designed for exactly this shape.
3. **The onboarding flow's multi-step form** is the one place where Next.js would shine. Mitigation: build the onboarding flow as a single Astro page with a React form component that owns the state machine. We don't need Next.js's full Suspense + use-server stack; we need a stateful form component, which is a single React island.
4. **Cloudflare Pages already wired** for the marketing site. The dashboard at `app.driftstack.dev` is a second Pages project pointing at `apps/customer-dashboard/`. No new vendor in the DPA.
5. **Brand surface continuity.** Same Tailwind tokens, same fonts, same oxblood accent. Marketing → signup → dashboard → admin reads as one product, not as a marketing site stitched to a third-party admin tool.

The decision is reversible: if the dashboard hits Astro's complexity ceiling (real-time updates, complex client routing, etc.), the migration to Next.js is a matter of moving page components — the API contracts (v1 endpoints, web-session cookie) are unchanged.

## Out of scope for this proposal

- Real-time event streaming (live session telemetry on the dashboard) — not needed at launch; polling `GET /v1/sessions` every 5 seconds is fine for the dashboard's "what's running right now" widget.
- Offline support — dashboard requires connectivity; no offline mode planned.
- Mobile-app-shell experience — `app.driftstack.dev` is responsive HTML, not a native app. PWA install prompt is a potential follow-on, not a launch requirement.
- Internationalisation — English only at launch; Dutch + German follow when there's customer demand. The Astro stack supports i18n if/when this changes; not a stack-decision driver.

## Open questions for founder review

1. **Are the brand-design-system reuse benefits load-bearing for the choice?** If the dashboard MUST share the marketing site's tokens / fonts / accent, Option A is the path of least resistance. If a different visual identity for "the app" is acceptable (different background, different accent colour), Option B opens up.
2. **Onboarding flow shape — single page with a state-machine React island, or multi-page MPA with one URL per step?** Single-page is friendlier (no full-page reloads between "enter email" → "verify email" → "accept ToS" → "select tier" → "pay"), but multi-page is dead simple in Astro. If you have a strong preference, that affects the dashboard's React-island scope.
3. **Cloudflare Pages vs Vercel for the dashboard runtime.** Cloudflare is already on the sub-processor list (V-052 lock); Vercel would require a DPA Annex 3 amendment + customer notice. Default recommendation: Cloudflare unless Vercel offers something specific (e.g. better Stripe-integration tooling) that's worth the sub-processor cost.
4. **Admin panel co-locates or splits?** Two reasonable shapes: (a) admin panel is a separate Cloudflare Pages project at `admin.driftstack.dev` with its own deploy + DNS + auth gate; (b) admin panel lives at `/admin/*` inside the customer dashboard project, gated on an admin-scope check. Option (b) is fewer moving parts but the admin surface lives next to customer-facing code; option (a) keeps blast radius separated.

## Decision authority

This is **architectural / structural** — surfaces for founder review per the Decision authority section in AGENTS.md. No commit until founder confirms the recommendation (or redirects to one of B / C / D).

## Related docs

- `docs/architecture/team-roles-taxonomy.md` (V-142) — owner / admin / member / viewer roles + scope mapping; gates which dashboard surfaces a signed-in user can see.
- `docs/architecture/webhook-system-design.md` — webhook subscription + event-type model; the `/webhooks` page in the dashboard is the customer surface for this.
- `docs/architecture/api-versioning.md` (V-220) — deprecation cycle for any UI-exposed breaking change (e.g. scope rename surfacing in the API-keys page).
- `docs/api/webhook-events.md` (V-203) — canonical event-type catalog displayed in the webhook subscription UI.
- `apps/marketing-site/public/_headers` + `docs/deployment/cdn-strategy.md` (V-221) — marketing and the static dashboard build at `app.driftstack.dev` use Cloudflare Pages and follow the same authenticated-data discipline (no customer data in generated HTML or publicly cacheable responses).
