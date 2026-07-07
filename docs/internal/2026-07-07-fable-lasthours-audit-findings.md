# Fable last-hours adversarial audit — findings + founder decisions

**Date:** 2026-07-07
**Method:** 8-dimension adversarial audit (find → two refute-by-default verifier
lenses per finding) over the freshly-shipped money/authz/security surfaces from
the founder-approved wave (crypto tier activation, Stripe tier changes, the
S42/S46 tier gates, the S44 billing emails, the S45 incident SSE broadcast) plus
genuinely-fresh veins (webhook-delivery, SSRF/proxy, profile-snapshot authz,
cost/billing reads).
**Raw yield:** 13 findings → **10 CONFIRMED, 1 DISPUTED, 2 KILLED**. Every
survivor was independently re-verified against the live source before any action
(verify-the-verifier); a few verifier claims were themselves wrong and are noted.

---

## SHIPPED THIS SESSION (correctness / contract-aligned, fully tested, ride the next staged API deploy)

### C4 — HIGH / money — Stripe active/trialing branch blindly wrote the event's tier

`apps/server/src/services/stripe-webhooks.ts` (active/trialing upsert branch)

The downgrade paths (`subscription.deleted`, `past_due`/`unpaid`) were already
hardened to `downgradeAccountTierToBestRemaining` (Fable 2026-07-02), but the
**active/trialing** branch still did an unconditional `setAccountTier(thisEventTier)`.
An account can hold more than one active subscription (re-checkout is permitted
while an old one is past_due), so a routine `customer.subscription.updated` on a
LOWER sub — a payment-method swap, a `cancel_at_period_end` toggle — silently
downgraded a customer still paying for a HIGHER active sub. Also the mechanism by
which a mixed-rail crypto entitlement gets wiped (see C1).

**Fix:** new rank-aware `setAccountTierToBestActive` (Drizzle + in-memory twin +
interface) reconciles the account to the highest-**ranked** active/trialing
subscription (via `tierActivationRank`), never blindly this event's tier. Single-
active-subscription accounts are unaffected (best-active == the event's tier), and
a genuine single-sub plan downgrade still lowers the tier (seeded from the active
set only, never `previousTier`). Two new integration tests (multi-active no-downgrade;
single-sub downgrade still applies) + re-pinned content parity.

### C9 — MEDIUM / data-leak — profile-snapshot reads missing the `read:profiles` floor

`apps/server/src/routes/profile-snapshots.ts` (3 GET routes)

The three snapshot GET routes required only `requireAuth` while their write
siblings (and every `GET /v1/profiles/*` route, V-553.B-21) gate on the profile
scope — so a narrow granular key without `read:profiles` could read snapshot
metadata. **The reference already documents these as requiring `read` or
`read:profiles`** (profile-snapshots.md) and `write:profiles` is documented as
"Does not include read", so this only aligned the code to the already-promised
contract (no customer could reasonably rely on the gap).

**Fix:** `requireScope('read:profiles')` on all three GETs (a broad `read` /
`account_owner` key still satisfies it via V-481). Four new enforcement tests
(write:profiles-only key → 403 on each read; read:profiles key → 200) + re-pin.

---

## FLAGGED FOR YOUR DECISION (policy / intentional / breaking / hot-path — not shipped autonomously)

### C1 — HIGH / money — a Stripe event wipes a crypto-paid tier (mixed rails)

`stripe-webhooks.ts` + `crypto-tier-activation.ts`

A customer with an active Stripe sub who ALSO buys a higher tier via crypto gets
their crypto entitlement destroyed within days: crypto activation writes only
`accounts.tier` with **no subscription-mirror row and no term/expiry**, so it's
invisible to every Stripe-side tier computation. C4's rank-aware reconcile does
NOT fix this (crypto isn't in the mirror). A real fix needs (a) crypto activation
to persist an entitlement record and (b) that record to be visible to the Stripe
tier reconcile — **and a policy decision**: a one-time crypto payment of a monthly
price has no natural expiry, so "how long does a crypto purchase entitle a tier"
is a founder call. Protecting it forever would block legitimate future Stripe
downgrades in perpetuity; not protecting it loses paid, non-refundable money.
**Options:** (A) give crypto orders a term + a sweeper, reconcile across both
rails; (B) block mixed-rail crypto checkout when an active Stripe sub exists;
(C) accept + document the interaction. Needs your steer on entitlement duration.

### C10 — MEDIUM / authz — `read:billing` floor incomplete across the billing read family

`billing-crypto-orders.ts` (5 customer GETs) + `account-cost.ts` (1 GET)

Direct siblings of the S46-gated `GET /v1/billing` still read crypto payment
history / receipts / cost / LLM spend with only `requireAuth`, so a narrow
write-only or `read:sessions`-only key can read them. Completing S46's floor
across these is the right direction — **but** the billing docs currently call
`GET /v1/billing` the "one read exception" requiring `read:billing`, so gating
these contradicts the documented contract AND breaks narrow-key cron/wget receipt
fetchers (the receipt.txt/.pdf routes are explicitly marketed for that). This is
the #122 "breaking change, founder call". Recommend: approve extending
`read:billing` to the crypto-order reads + `/v1/account/cost`, update the billing
doc's "one exception" framing, keep the OTHER read:\* families
(sessions/webhooks/api-keys/audit) as the still-open #122 rollout.

### C8 — MEDIUM / money — bundled-LLM billed at turn-time on a downgraded (non-eligible) tier

`agent-sessions.ts` (message/turn handler, ~:3622)

The bundled-LLM tier gate (`requireBundledLlmTier`) runs only at **consent
opt-in** (the PATCH), not at **turn-time consumption**. A customer who opted in on
an eligible tier and later downgraded to `byok_only` keeps consuming — and being
billed for — bundled LLM. Fix = re-check `requireBundledLlmTier(ownerTier)` at the
turn before using the bundled key. Flagged (not shipped) because it needs an
owner-tier lookup plumbed onto the **hot per-turn path** (the gui_control_key path
has no request-account context, so it needs an `authRepo.getAccount(turnAccountId)`
read — ideally cached to avoid a per-turn DB hit) **and** a behavior choice: refuse
with the 402 consent-CTA shape, a 403 tier error, or silently fall through to
BYOK-required. Recommend: 402-style refusal + a short-TTL owner-tier cache.

### C3 — MEDIUM / money — refund after `finished` is silently dropped (customer keeps the tier)

`crypto-orders.ts` (~:1455)

A crypto refund/chargeback after an order reached `finished`/`paid` doesn't claw
back the activated tier and raises no ops alarm. Whether to auto-downgrade on
refund is a **policy** question (Stripe's model vs. crypto's irreversibility).
Recommend at minimum: emit an ops alarm on a post-paid refund IPN so support can
reconcile; auto-clawback is your call.

### C5 — MEDIUM / correctness — transient handler errors are recorded as processed → never retried

`stripe-webhooks.ts` (`dispatch` catch, ~:335)

The catch records `error:<code>` in `processed_stripe_events` and returns 200, so
a **transient** infra error (DB/network blip) permanently consumes the event —
Stripe never retries, and a paying customer can be stuck un-upgraded (or a
cancelled one stuck paid). The code comment consciously chose this ("retrying
won't help if it's a code bug"), which is right for PERMANENT errors but wrong for
transient ones. Fix = classify: rethrow (→ non-2xx, Stripe retries) on transient
infra errors, keep swallow+record for permanent/validation. Flagged for the
retry-storm tradeoff + the classification policy.

### C7 — LOW / money — `paused` subscription status never downgrades

`stripe-webhooks.ts` (~:438)

A `paused` sub (Stripe pause-collection) isn't in the past_due/unpaid downgrade
branch, so a trial-granted paid tier can persist indefinitely after a pause with
no payment. Whether `paused` should downgrade depends on how you use pause
collection (intentional grace vs. stop-billing) — a product call. Small fix if you
want it (add `paused` to the best-remaining downgrade branch).

### C6 — LOW / correctness — idempotency ledger row written AFTER side effects (double-email window)

`stripe-webhooks.ts` (`handle`, ~:239)

`recordEvent` runs after the handler's side effects, so a crash/restart between
the S44 billing email send and `recordEvent` (or overlapping concurrent
deliveries) could send the receipt/failure email twice. Narrow window, LOW. Fix =
make the email send idempotent (dedupe key) or claim the event row before side
effects. Noted for completeness.

### D1 — DISPUTED — unmapped Stripe price mirrored as `tier='enterprise'`

`stripe-webhooks.ts` (~:397, :501)

An unknown price id is stored in the subscription mirror as `enterprise` (rank
+∞), which the best-remaining/best-active reconcile then trusts — so an unmapped
price grants enterprise entitlement. **Likely intentional**: custom enterprise
contracts use prices deliberately absent from the self-serve `priceToTier` map,
and `tierActivationRank` documents enterprise/unpriced as "never overwritten". The
real risk is a config-hygiene one: a genuine NON-enterprise price accidentally
left out of the map would wrongly promote. Not attacker-reachable (Driftstack
creates the prices). **Please confirm** unmapped-price ⇒ enterprise is intended; if
so, no change (C4's reconcile preserves it correctly). If not, the sentinel should
be a lowest-rank/nullable value the reconcile ignores.

---

## VERIFY-THE-VERIFIER NOTES (findings the verifiers over/under-called)

- **C2** (crash between crypto paid-commit and tier activation) was rated
  "permanent loss with no alarm" — but the code **already logs a loud integrity
  alarm** naming the admin change-tier remediation, and documents the
  no-auto-heal tradeoff. Real residual = no AUTOMATIC retry-heal (manual ops from
  the alarm). Enhancement, not a bug — flagged as such, not fixed.
- **KILLED (2):** two candidate findings did not survive both lenses (guarded
  upstream / misread control flow).

---

## Provenance

Full raw findings + both verifier reasonings per item:
`scratchpad/audit-findings-full.md` (this session). Workflow run
`wf_c76996ad-946` — 34 agents, 0 errors.
