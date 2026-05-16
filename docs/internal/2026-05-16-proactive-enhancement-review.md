# Proactive enhancement review (Issue 6, Wave 1086+)

Per founder direction (Issue 6 of Wave 1085+ paste): "do a proactive
codebase + website review pass post fix-paste, surface enhancement
opportunities." Done. 15 findings below, grouped by area + scored
by impact:effort. Top several land autonomously this wave; the rest
need founder triage.

## Tier A — ship autonomously (small, customer-visible)

### A1. Customer-dashboard sidebar missing /subscription link

`apps/customer-dashboard/src/layouts/DashboardLayout.astro` — the
`/subscription` page exists (invoice history, plan changes) but
isn't in `navItems`. Reachable only via the "Back" link from
`/billing`. Billing-conscious customers expect a dedicated
subscription-management entry in nav.

**Fix:** add `{ href: '/subscription', label: 'Subscription' }` to
the dashboard sidebar.

### A2. /first-session archetype line lacks plain-English explanation

`apps/customer-dashboard/src/pages/first-session.astro:23` — copy
says "Default archetype: {LOCKED_ARCHETYPE_DISPLAY_LABEL}." First-
time customers don't know what an archetype is. Reads as jargon.

**Fix:** rewrite to "Archetype defines the iPhone model, OS, and
Safari version. You're starting with {label} — our standard test
profile. Higher tiers unlock more archetypes."

### A3. /first-session API key explanation reads as "magic happens"

`apps/customer-dashboard/src/pages/first-session.astro:26-29` —
"We'll mint your first API key in the background — you'll see it
on the next page." First-time customers don't know what an API
key is OR why they should care about safekeeping.

**Fix:** "We'll create your first API key (a secret token your
code uses to call the SDK). You'll copy it from the next page —
it's shown only once, so store it safely (1Password / git-ignored
.env / similar)."

### A4. /webhooks delivery-counts placeholder banner reads as "broken"

`apps/customer-dashboard/src/pages/webhooks.astro:1346` — success
banner says "Aggregate delivery counts (delivered/failed/DLQ) are
not exposed via /v1/webhooks; inspect /v1/webhooks/{id}/deliveries
for per-event detail." Wave 17 cleaned this up but it could go
further — link directly to the per-endpoint deliveries surface.

**Fix:** confirm the per-endpoint deliveries page is reachable from
each webhook row and the banner cross-links it.

### A5. /pricing page "concurrent session metering" lacks anchor for deep-linking

`apps/marketing-site/src/pages/pricing.astro` — docs/guides could
deep-link `/pricing#no-overages` to drive home the no-per-call-
markup pillar. The relevant section exists but has no `id`.

**Fix:** add `<section id="no-overages">` to the section that
explains concurrent-session metering.

## Tier B — substantive, surface for founder confirm

### B1. Billing pre-Stripe-wire: CTAs 404 with no graceful surface

`apps/customer-dashboard/src/pages/select-tier.astro` +
`apps/marketing-site/src/pages/pricing.astro` link to
`/v1/billing/trial-pack` and `/v1/billing/checkout-session`, which
return 404 today because Stripe price IDs aren't wired (per Wave
1085+ Issue 4 diagnostic).

Currently a customer clicking "Start trial" → API 404 → vague
client error. Two-part fix:

1. Server: route returns 503 (not 404) with body
   `{type: ".../billing-not-configured", title: "Billing not yet
configured", status: 503, detail: "Stripe price IDs not wired
server-side; check /pricing in a few hours."}` when env vars
   are missing. Better signal than 404.
2. Client: select-tier.astro detects 503 + shows a professional
   "Billing setup in progress. Continue with the $2.99 trial pack
   for now, or check back later" banner instead of generic error.

Founder decision: would you like this graceful-degradation surface,
or do you want billing to land FIRST (i.e., resolve Wave 1085+
Issue 4) so the graceful path is never reached?

### B2. Account-deletion still goes through support email

`apps/customer-dashboard/src/pages/settings.astro:565-573` — copy
says "deletion is currently processed by emailing
support@driftstack.dev". Updated in Wave 20 to be less
apology-shaped, but a self-service deletion flow would dramatically
reduce support load + improve GDPR Article 17 (right-to-erasure)
posture.

Founder decision: ship the deletion endpoint pre-launch
(~6-8h: schema migration for deletion_requested_at + soft-delete
flow + 14-day cancellation window + scheduled hard-delete job)?
Or keep support-mailbox path for v1.0?

### B3. /sessions empty state lacks "next steps after first session" prompt

`apps/customer-dashboard/src/pages/sessions.astro` — after a new
customer's first session completes, no contextual prompt suggests
the natural next actions (create profile for persistent identity,
explore captures, review usage).

Founder decision: ship a contextual banner (light scope, ~1h)?
Or leave the discovery to the docs onboarding?

### B4. Status-site /history page lacks month-by-month grouping

`apps/status-site/src/pages/history.astro` — flat list across the
90-day window. Buyers reviewing reliability want to see "May 2026 ·
3 incidents" / "April 2026 · 1 incident" rollups for at-a-glance
trend reading.

Founder decision: ship the grouping (~2h)?

### B5. RateLimitedError (429) missing `Retry-After` header

`apps/server/src/lib/errors.ts` — the problem+json body carries
`retry_after_seconds` in extensions but the HTTP `Retry-After`
header isn't set. SDK auto-retry logic typically reads the header
first; the body extension is a fallback. Adding the header
improves cross-client compatibility (Browserless / Bright Data
clients sometimes hit our API directly during migration).

Founder decision: server-side fix, low-risk, ~30min?

## Tier C — surface for prioritization (heavier)

### C1. Status-page /subscribe lacks visible confirmation UX

`apps/status-site/src/pages/subscribe.astro` — form posts but
confirmation page doesn't exist. Customer doesn't know if it
worked.

### C2. Webhook reliability guide missing from /docs

Customers will ask: "what counts as failure?" / "how does backoff
work?" / "when do I see failures in the dashboard?" Currently
inferable from source but not documented.

### C3. Python SDK lacks `py.typed` marker

`packages/sdk-python/` — TypeScript SDK exports types; Python likely
has docstrings but no `py.typed` marker means IDE autocomplete on
response shape fields is missing.

### C4. /select-tier pro-rata refund timeline vague

`apps/customer-dashboard/src/pages/select-tier.astro:42` — current
copy "Cancel anytime; pro-rated refunds within the first 14 days"
doesn't clarify what "pro-rated" means or what triggers a refund.

### C5. /profiles empty state could onboarding-hint

`apps/customer-dashboard/src/pages/profiles.astro` — new customer
sees an empty list with no explanation of what profiles are or why
they matter.

## What I'm shipping autonomously this wave

A1 + A2 + A3 + A5 (small copy/nav improvements; no behavioral
risk). Tier B + C items wait for founder triage.

## Next-step recommendations for founder

1. **Resolve Wave 1085+ blockers first** (Google Console + Stripe
   price IDs). Those unlock real-IDP browser test + trial-pack
   checkout. Until then, Tier B1 (graceful billing degradation)
   is the highest-leverage UX patch.
2. **Decide on AI chat agent layer v1.0 inclusion.** ~120h Agent 2
   scope addition. Affects which Tier B/C items make the launch
   cut.
3. **Triage Tier B + Tier C list above.** I'll ship the green-lit
   items as bounded slices.
