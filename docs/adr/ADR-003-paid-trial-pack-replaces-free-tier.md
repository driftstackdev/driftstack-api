# ADR-003 — $2.99 paid trial pack replaces the free tier

**Status:** Accepted — **but REVERSED BY THE SHIPPED SYSTEM as of 2026-08-10.
A superseding ADR is owed and has no author yet (see the note below).**
**Date:** 2026-05-03

> ### ⚠️ 2026-08-10 reality check (V-750)
>
> This ADR records that a $2.99 one-time **trial pack replaces the free tier**.
> Both halves are now reversed: `free` is a live value in `AccountTierSchema`
> and the pre-launch checklist calls it a "perpetual free tier", while the
> trial pack was retired 2026-05-27 and survives in the source only as comments
> explaining its removal (`lib/config.ts`, `routes/billing.ts`).
>
> As with ADR-002, no `Status: Superseded by ADR-MMM` was recorded, so the
> reasoning for reinstating a perpetual free tier is written down nowhere. This
> note states the fact, not the rationale — the latter belongs to whoever made
> the call.
> **Tier:** Contractual (explicit; commercial-commitment shape)
> **Related V-entry:** V-061 (file-127 sweep that initially carried forward the "free trial" framing — withdrawn here), V-063 (this ADR + memory + scaffolding annotations).
> **Related D-entry:** none yet — the file-127 §6 deviation lives in this ADR; if a one-line summary becomes necessary it adds as a future `D-NNN`.

## Context

Parent driftstack repo file 127 (`docs/planning/127-pricing-self-hosted-strategy.md`) §6 specs a **free trial**: 25 browser-hours one-time, 7-day window, no card required, 1 concurrent, 1 archetype, Community support. The framing was "more generous than competitors" — a deliberate acquisition lever paid for out of fleet-cost margin.

V-061 (pricing-correction sweep) carried that shape forward into the backend by setting `usage.ts` `TIER_QUOTAS.free.session_minute = 1500` (25 hours × 60 min) with a note that the trial-credit primitive (account-level `trial_started_at` + windowed expiry + one-time semantic) would land in Workstream F. The acquisition-funnel framing was unchanged.

Two constraints reshaped the decision before Workstream B (marketing site) shipped public copy:

1. **Anti-abuse infrastructure scope.** A free trial — even a 25-hour one — is the canonical signup-abuse vector for any service with a non-trivial unit cost (here, MacStadium fleet time). Defending it requires speculative infrastructure: signup fingerprinting, IP rate limits on signup endpoints, GitHub-OAuth-quality gates ("require ≥5 public repos and ≥6 months account age"), Cloudflare Turnstile on signup forms, email-domain blocklists, post-signup behaviour-anomaly detection. Each layer is meaningful work; together they are months of solo-engineer effort that produce no customer-visible value.

2. **Self-funding fleet costs at first session.** Each browser-hour costs Driftstack ~$0.04 in MacStadium time at planned utilisation. A 25-hour free trial costs ~$1.00 of fleet time per signup; abuse + sock-puppet accounts make the actual unit cost higher. A paid trial that funds its own fleet usage from cent zero eliminates the asymmetry.

The trade-off accepted: **$2.99 is invisible friction for a B2B technical buyer audience**. iPhone Safari fidelity is the premium positioning per file 127's overage-pricing rationale; the same audience that pays $0.18/hr in overage will not balk at $2.99 to start. For consumer or hobbyist audiences a free trial would be load-bearing for funnel; Driftstack's audience is not that.

## Decision

**Replace the file-127 §6 free trial with a $2.99 paid trial pack.** The charge is itself the anti-abuse mechanism: low-friction for the B2B technical buyer audience, effective filter against sock-puppet and bulk-signup abuse, no anti-abuse infrastructure required.

Trial-pack shape:

- **$2.99 one-time charge** via Stripe Checkout at trial activation.
- Funds account credit balance at **299 cents**.
- Sessions metered at **Starter tier rate ($0.18/hr)** decrementing the credit balance — yields ~16 hours of usage.
- **1 concurrent session** (matches the file-127 free-tier concurrency floor).
- **14-day window** from purchase (any unused balance expires after 14 days).
- **Once per account** — `trial_pack_redeemed` boolean prevents re-activation; no reset on downgrade or churn.

Accounts that purchase the trial pack and want to continue beyond it must subscribe to a paid tier (Starter through Scale, or Enterprise via sales). Trial-pack revenue is **one-time**, not MRR, and accounts to a separate Moneybird ledger line.

## Consequences

**Enables:**

- **Zero anti-abuse infrastructure required.** Signup-fingerprinting, IP rate limits on signups, GitHub-OAuth-quality gates, Cloudflare Turnstile on signup forms, email-domain blocklists, post-signup behaviour-anomaly detection — all unnecessary. The $2.99 charge filters sock-puppets and bulk-signup abuse on first contact with Stripe; abuse defense is a paid problem instead of a code problem.
- **Self-funding from session 1.** Each trial-pack session decrements pre-paid credit; Driftstack's MacStadium fleet cost is covered by the trial-pack revenue. No subsidy line item.
- **Cleaner funnel framing.** "Buy 16 hours of iPhone Safari sessions for $2.99" is concrete and compares favourably to chromium-cloud free-trial-then-card-required flows. The price is the qualification filter.
- **Single Stripe Checkout flow at first session.** No separate "verify email" / "qualify trial" pre-step; the user pays $2.99, the credit hits the account, the first session creates immediately.

**Rules out:**

- **The "more generous than competitors" framing of file 127 §6.** The pricing-page copy moves from "Try Driftstack free for 25 hours" to "Trial pack: 16 hours for $2.99, no subscription required." Loss for SEO + funnel-top metrics; gain for the abuse-defense + self-funding constraints above.
- **Free-trial-driven funnel optimisation.** Cannot run "extend your free trial" / "trial extension" / "free month" promotions. The trial pack is once-per-account and the path to continued usage is a paid subscription.
- **Reactivation-as-trial.** A churned customer cannot reactivate by re-purchasing the trial pack — `trial_pack_redeemed` stays true forever per account. They subscribe to a paid tier to come back.

**Operational cost accepted:**

- **Stripe per-transaction fees on a $2.99 charge are non-trivial.** A typical EU card transaction at Stripe's standard rate (1.5% + €0.25) costs ~€0.29 on a €2.99 charge — about 10% of the ticket. Effective trial-pack revenue is ~$2.70 per signup. Accepted as the cost of running the abuse filter through a payment processor.
- **Conversion-rate visibility.** With a $2.99 paywall before any usage, signup-to-first-session conversion is no longer a free-funnel metric; it's a checkout-conversion metric. Need to instrument Stripe Checkout abandonment + post-trial-pack subscription conversion separately. Standard Stripe + analytics work, but not free.
- **Accounting line separation.** Trial-pack revenue must accrue to a one-time-revenue line in Moneybird, not the subscription MRR line. Workstream E (Moneybird scoping) accommodates this explicitly.

## Alternatives considered

### File-127 §6 free trial (the original spec)

- **Pro:** maximally generous; competitive against chromium-cloud free trials; SEO-friendly "free" framing.
- **Con:** requires anti-abuse infrastructure (signup-fingerprinting, IP rate limits, OAuth-quality gates, Turnstile, behaviour-anomaly detection — months of solo-engineer effort); doesn't self-fund fleet cost; abuse + sock-puppet accounts disproportionately consume fleet time.
- **Why rejected:** the anti-abuse-infrastructure cost is not paid for by the marginal acquisition lift, especially given the B2B technical buyer audience for whom $2.99 is invisible friction. Founder explicit: trade-off is intentional.

### Free tier with credit-card-required pre-auth (the chromium-cloud model)

- **Pro:** filters non-payment-card-having abusers without charging; preserves "free" framing.
- **Con:** card-pre-auth is friction (a real card number is a real psychological barrier), and the abuse-resistance is weaker than charge-required because stolen / disposable card numbers can satisfy a pre-auth without ever being charged. Stripe rejects pre-auth-only transactions on most disposable-card patterns but the filter is not as strong.
- **Why rejected:** card-pre-auth is the worst of both worlds — the friction of a paid trial without the abuse-resistance of an actual charge.

### Time-boxed free tier (e.g., 1 free session ever)

- **Pro:** very small abuse surface (each abuser gets 1 session of fleet time, not 25 hours).
- **Con:** the "1 free session ever" framing is barely a trial — a customer evaluating Driftstack realistically needs 4-8 sessions to assess quality. 1 session is too few to convert evaluators; 25 hours of free time is too many for abuse defence; $2.99 / 16 hours is the negotiated middle.
- **Why rejected:** insufficient evaluation surface for the genuine-customer use case.

### Free during private beta + paid at GA

- **Pro:** zero abuse defence needed during private beta because the beta gate is the filter.
- **Con:** doesn't solve the post-GA problem; just defers it.
- **Why rejected:** post-GA design needs to be locked now so the marketing site, billing flow, and onboarding flow ship coherently.

## Revisit triggers

Re-evaluate this decision if **any** of the following fires:

- **Trial-pack-to-paid conversion rate drops below 8%.** Trigger metric: `subscriptions_created_within_14d_of_trial_pack / trial_pack_purchases`, computed monthly, rolling 90-day window. If below 8%, the $2.99 friction is filtering too aggressively (or the product isn't converting evaluators); reconsider price + window.
- **Competitor pricing pressure forces a free trial.** Trigger event: a peer service in iPhone Safari emulation introduces a generous free trial that is observably acquiring customers Driftstack would otherwise win. Counsel + review on whether to match.
- **Anti-abuse infrastructure becomes "free" via a third-party.** Trigger event: a SaaS abuse-defence service (e.g., Stytch, Castle, Sift) drops to a price point + maturity where the file-127 §6 free trial becomes operationally feasible without months of in-house engineering.
- **MacStadium fleet utilisation drops below the level where trial-pack revenue meaningfully self-funds.** Trigger metric: trial-pack revenue / MacStadium spend < 0.5 over rolling 90 days. If the self-funding argument no longer holds, the $2.99 has lost a load-bearing reason and the price + framing should be re-derived.
- **Audience composition shifts.** Trigger event: customer mix moves from B2B technical buyer (current target) to consumer / hobbyist / educational. The "$2.99 is invisible friction for the audience" argument depends on the audience; a different audience changes the math.

## Notes

The deferred file-127 §6 free-trial design remains the documented planning-side fallback in the parent driftstack repo. If any revisit trigger fires, the reactivation path is to (1) update file 127 §6 back to a free-trial framing, (2) build the anti-abuse infrastructure stack, (3) revise marketing-site pricing copy + onboarding flow, (4) issue Art 28(2) sub-processor amendment notice if anti-abuse infra introduces new processors (Stytch / Castle / Sift would be net-new sub-processors).

Database schema for the trial-pack columns (`accounts.trial_pack_purchased_at`, `accounts.trial_pack_credit_cents`, `accounts.trial_pack_expires_at`, `accounts.trial_pack_redeemed`) lands in Workstream D alongside the Stripe Checkout integration. Marketing-site copy (this ADR drives the framing) lands in Workstream B (active). Admin-panel visibility into trial-pack state per account lands in Workstream C. Onboarding flow that triggers trial-pack purchase at first session attempt lands in Workstream F. Moneybird accounting line separation (trial-pack one-time revenue vs subscription MRR) lands in Workstream E.

Anti-abuse infrastructure is **explicitly out of scope** under this ADR: signup fingerprinting, IP rate limits on signup endpoints, GitHub-OAuth-quality gates, Cloudflare Turnstile on signup forms, behaviour-anomaly detection. The $2.99 charge is the abuse filter. Email verification remains in scope for normal account hygiene (password reset, magic-link auth) but is not load-bearing for abuse defence.
