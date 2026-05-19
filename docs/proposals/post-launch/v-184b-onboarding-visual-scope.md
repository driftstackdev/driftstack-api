# V-184b — Onboarding visual UX scope proposal

**Status:** Tier 3 scope outline — surfaces for founder redline. Contains NO autonomously-drafted customer-facing copy; lists the **structural shape** of what V-184b would change, marks each Tier 3 copy decision with `[FOUNDER COPY]` so the redline pass is bounded.
**Source:** Autopilot direction 2026-05-05 — "V-184b Tier 3 onboarding visual UX (founder-redline Tier 3 — DRAFT working-tree only, NOT commit; founder reviews on wake)".
**V-184a baseline:** `apps/customer-dashboard/src/pages/{signup,verify-email,welcome,select-tier,first-session}.astro` — all five Tier 1 scaffolding pages exist with minimal placeholder UX.

## Why a scope proposal instead of a working-tree draft

Per autopilot guardrails: "T3 (security architecture, customer data handling, pricing/$-numbers, marketing language): NEVER autonomously decide. If encountered, draft + surface for founder, move to next T1."

V-184b is largely customer-facing copy + visual decisions. Drafting actual `.astro` content would mean making autonomous Tier 3 calls on tone, hierarchy, conversion messaging, and brand voice. Rather than draft choices the founder might reject anyway, this proposal lists the SHAPE of changes per page so the founder can:

- Approve / reject the per-page **scope** of changes (what KINDS of edits each page gets).
- Provide the actual COPY in a redline pass.
- Optionally request specific structural patterns (e.g. "add progress indicator at top of every step").

Once the founder reds in copy + structure choices, the actual `.astro` edits become mechanical and can land in a future V-184b commit (or split as V-184b-1 / V-184b-2 etc. per page).

## Already-approved patterns to apply uniformly

These are the `V-219*` PHASE 3 patterns already approved + landed elsewhere; safe to apply to onboarding pages without further redline:

- **Minimal horizontal header** (D-badge + `font-mono` "driftstack" wordmark) — `withSidebar={false}` in `DashboardLayout.astro` already does this. All five onboarding pages currently use it; verified ✓.
- **Oxblood-700 brand accent** for primary CTAs + active states (already in `base.css`).
- **Footer with Privacy / Terms / DPA / AUP / Sub-processors** — `DashboardLayout.astro` already renders this. Onboarding pages inherit ✓.

## Per-page scope outline

### 1. `signup.astro`

**Structural changes the autopilot can safely propose:**

- Add a `progress-step` component (visual: 5-step indicator with current step highlighted in oxblood-700) at top of the form panel. Same pattern across all 5 onboarding pages. Founder picks: highlighted vs filled-bar style.
- Add an inline link to `/legal/terms` + `/legal/privacy` near the submit button (acceptance via the implicit "by clicking Create account" pattern, not a separate checkbox). Server side: legal-acceptance gate (V-049) handles the API-key issuance gate; signup itself doesn't require explicit consent UI per current design. Confirm with founder whether the implicit-acceptance pattern stays or flips to explicit-checkbox.

**Tier 3 copy redlines needed:**

- `[FOUNDER COPY]` Headline: currently "Sign up". Redline against marketing voice — currently no brand voice document exists for the dashboard surface (marketing site's voice in `apps/marketing-site/` is the closest reference).
- `[FOUNDER COPY]` Subhead: currently "Create your Driftstack account. After signup we'll email you a verification code; one signup per email."
- `[FOUNDER COPY]` Password helper: currently "12+ characters. Use a passphrase." — could elaborate on passphrase recommendation OR add a real-time strength indicator (V-184b decision).
- `[FOUNDER COPY]` Optional: trust microcopy near submit ("Why we ask for X", "What happens next", etc.).

### 2. `verify-email.astro`

**Structural:**

- Same progress-step indicator (step 2/5).
- "Resend verification email" link (~30s lockout to prevent abuse). Currently the page accepts a token paste-in; should also offer a resend trigger that hits `POST /v1/auth/signup` with the same email. Founder approval needed for resend rate-limit cadence + UX copy.
- "Wrong email?" link → `/signup` to start over.

**Tier 3 copy redlines:**

- `[FOUNDER COPY]` Page headline + subhead.
- `[FOUNDER COPY]` Resend button copy + lockout messaging.
- `[FOUNDER COPY]` Error states: invalid token / expired token / already-verified.

### 3. `welcome.astro`

**Structural:**

- Same progress-step indicator (step 3/5).
- "What's next" callouts pointing at the next steps (select tier → first session). Could be 2-card or 3-card layout.
- Optional: link to docs / quickstart for self-directed customers who want to skip ahead.

**Tier 3 copy redlines:**

- `[FOUNDER COPY]` Welcome message — most marketing-voice-sensitive page in the flow.
- `[FOUNDER COPY]` "What's next" callout copy.

### 4. `select-tier.astro`

**Tier 3 sensitivity is HIGHEST on this page** — this is where the customer commits to a tier with $-amount visible. Per autopilot guardrails: "pricing/$-numbers: NEVER autonomously decide."

**Structural changes the autopilot can safely propose (NO pricing-touching):**

- Same progress-step indicator (step 4/5).
- Tier comparison shape — table vs card-row vs vertical-list. Founder picks; autopilot does NOT pick.
- "Start with trial pack" CTA must be visually distinct from "Skip to paid tier" path (per ADR-003 — trial pack is the recommended onboarding path).

**Tier 3 copy + numeric redlines:**

- `[FOUNDER COPY + PRICING]` Tier names + descriptions + $-amounts. Per founder's locked tier-3-explicit-values memory, the canonical numbers live in `driftstack-repo` file 127 — autopilot must not invent any numbers here. Source: `packages/api-types/src/capabilities.ts` for the per-tier display strings.
- `[FOUNDER COPY]` Trial-pack pitch ($2.99 / 14 days / $0.18-per-hour decrement per ADR-003 — those numbers are locked, but the pitch language is open).

### 5. `first-session.astro`

**Structural:**

- Same progress-step indicator (step 5/5 = "you're done!").
- Two-pane layout: code snippet on the left, visual session-running placeholder on the right.
- "Reveal API key (one-time)" button — once revealed + copied, the key is gone from the UI. Currently the page has the API key minted from the previous step; surfacing pattern needs founder approval (one-shot reveal vs persistent display vs auto-copy).
- Code snippet language switcher (TypeScript / Python / cURL).

**Tier 3 copy redlines:**

- `[FOUNDER COPY]` Headline + subhead.
- `[FOUNDER COPY]` Code snippet copy — needs to be production-correct (uses `@driftstack/sdk` the right way) AND demo-friendly (returns visible output the customer can verify in <30s).
- `[FOUNDER COPY]` "What's next" tail copy pointing at docs / dashboard / API reference.

## Cross-page consistency proposals

- **Progress-step component** — propose a single `<OnboardingSteps step={N} of={5} />` Astro component lives in `apps/customer-dashboard/src/components/onboarding-steps.astro`. Founder picks visual: dots / numbered chips / horizontal bar / etc.
- **Help / contact link** in the minimal header (so customers stuck mid-flow can reach support) — needs founder decision on what link points at (existing `/contact` doesn't exist; `support@driftstack.dev` mailto:?).
- **Visual hierarchy alignment** — confirm signup.astro's `text-3xl font-semibold tracking-tight` heading style is the canonical onboarding-page headline (vs e.g. `text-4xl`). Apply uniformly.

## What's deliberately OUT of scope for V-184b

- Login flow (`/login` page exists as href but no implementation). V-184a notes flagged this as "V-184b or separate V-NNN"; recommend separate V-entry to avoid scope creep.
- Onboarding flow telemetry (drop-off-per-step metrics). Tier 1 work; not visual.
- Dashboard `/billing` page redesign (tied to billing flow, separate from onboarding).

## Recommended next step on founder wake

1. Founder reviews this proposal, marks structural items APPROVE / REJECT.
2. Founder provides COPY for the `[FOUNDER COPY]` markers OR delegates back to autopilot with constraints (e.g. "use marketing-site voice; no $-numbers; max 25 words per heading").
3. Either the founder or a future autopilot session translates the redlines into actual `.astro` edits, lands as V-184b-1 / V-184b-2 etc. per page (smaller PRs preferred for onboarding flow).

This proposal itself is committed (it's structural, not customer-facing copy). The actual page edits remain unwritten until founder redline.
