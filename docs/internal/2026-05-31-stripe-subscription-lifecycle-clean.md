# 2026-05-31 — Stripe subscription → tier lifecycle: VERIFIED CLEAN (Agent 2)

Fresh money-path audit of the Stripe webhook subscription lifecycle in
`services/stripe-webhooks.ts` (event-type → account-tier transitions). A dimension
distinct from the prior Stripe memories (concurrent double-dispatch is a deliberate
at-least-once tradeoff; the atomic `FOR UPDATE` tier update shipped as `b16c76e3`).
**No bug found — recorded so future waves don't re-audit.** Sharp edge checked first:
_does cancellation actually downgrade?_ — yes.

## Lifecycle is correct

- **Upgrade** (`customer.subscription.created` / `.updated`): maps `priceId` via
  `config.priceToTier`, upserts the subscription mirror, and calls `setAccountTier`
  **only** when `status === 'active' || 'trialing'`. So a transient non-active status
  does NOT change the account tier.
- **Dunning** (`past_due`): the `active/trialing`-only guard means a failed payment
  does NOT immediately downgrade — the customer keeps their tier through Stripe's
  retry window. Correct (don't punish a transient failure); the eventual terminal
  cancellation comes via `customer.subscription.deleted`.
- **Cancel-at-period-end**: Stripe fires `subscription.updated` with status still
  `active` (+ `cancel_at_period_end=true`) → tier unchanged (a same-tier no-op),
  customer keeps access until period end; then `subscription.deleted` downgrades.
  Correct.
- **Cancellation** (`customer.subscription.deleted`): `handleSubscriptionDeleted`
  downgrades to `config.cancelDowngradeTier ?? 'free'` unconditionally — the customer
  loses paid privileges and lands on the perpetual free tier. The downgrade is the
  real account-tier change; the mirror row's `tier` default of `enterprise` for an
  unknown price is informational only (never granted to the account).
- **Unknown price id**: `priceToTier[priceId] === undefined` → the upsert writes the
  mirror but `setAccountTier` is gated on `tier !== undefined`, so an unrecognized
  price never wrongly grants a tier. Logged at warn.
- **Re-delivery idempotency**: the lifecycle emit (`subscription.tier_changed` → audit
  - tier-changed email) short-circuits internally when `previousTier === newTier`, so
    a re-delivered event is a no-op fan-out.
- Always ACKs 200 on a verified/parseable event (even ignored/duplicate) so Stripe
  doesn't retry-loop on "ignored" event types.

## One edge — noted, do NOT "fix"

The downgrade is driven by `customer.subscription.deleted`, per Stripe's documented
cancellation flow (Stripe fires `deleted` when a subscription ends). A purely
status-based downgrade on `subscription.updated` (e.g. treat `unpaid`/`canceled`
status as a downgrade trigger) would be a FALSE-DOWNGRADE risk — `unpaid` is not
reliably terminal (the customer can still pay and reactivate), so downgrading on it
could revoke a paying customer's access. The current deleted-driven design is the
correct, safe one; this is flagged only so the "updated never downgrades" behavior
isn't mistaken for a gap.

Signature verification + the concurrent double-dispatch tradeoff are covered
elsewhere ([[project_billing_and_apikey_surfaced_findings]],
[[project_idor_ownership_review_clean]] payment-webhook-sigs).

Recorded in memory `project_stripe_subscription_lifecycle_clean`.
