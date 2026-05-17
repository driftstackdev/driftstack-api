# Agent 2 Q queue — /loop 3m autopilot handoff

**Date:** 2026-05-17
**Fired by:** orchestrator handoff #3 (post-marketing-arc-complete)
**Cron job:** `055b9123` (`*/3 * * * *`, session-only, 7-day auto-expire)
**Sequence:** Q.2 → Q.3 → Q.1 design → Q.4 design → Q.5 → Q.0

Each /loop fire picks the highest-priority unblocked queue item and
fires ≥3 P-tracks per wave (Rule M). Design-doc gates (Q.1, Q.4) land
the design + open questions, then move to NEXT queue item — don't stall.

## Q.2 — Stripe TEST-MODE activation (PARTIAL — landed safety guard,

surfaced env gap)

### Status

| Slice                                                                    | Status                                   |
| ------------------------------------------------------------------------ | ---------------------------------------- |
| Bootstrap fail-fast guard (sk*live* before 2026-05-21 cutover)           | ✓ LANDED                                 |
| 11 unit tests covering the date×prefix matrix                            | ✓ LANDED                                 |
| Cutover constant pinned (`STRIPE_LIVE_KEY_CUTOVER_UTC = 2026-05-21 UTC`) | ✓ LANDED                                 |
| Billing route activation flip                                            | ✗ BLOCKED on env vars                    |
| 7th post-deploy-verify slot                                              | ⌛ DEFERRED (waiting for active billing) |

### What landed

- `apps/server/src/lib/stripe-key-safety.ts` — `validateStripeKeyForLaunch()`
  refuses to boot if STRIPE*SECRET_KEY starts with `sk_live*`AND the
current wall-clock is before the cutover date. Empty / undefined /`sk*test*`keys all pass;`sk*live*` on/after 2026-05-21 passes.
- `apps/server/src/lib/bootstrap.ts` — invokes the guard before
  BillingService creation. Throws with an operator-facing reason that
  names the cutover date.
- `apps/server/tests/unit/stripe-key-safety.test.ts` — 11 cases
  covering absent / empty / `sk_test_` (always ok) / `sk_live_` before /
  on / after cutover / cutover constant pinning / exotic prefixes
  (`rk_live_` passes; `sk_live_test_smuggled` fails).

### Founder dependency — Stripe dashboard work needed

Prod `/opt/driftstack/api/.env` is missing three Stripe vars required
for the billing route activation flip:

```
DRIFTSTACK_TIER_PRICE_IDS    # NOT set
STRIPE_TRIAL_PACK_PRICE_ID   # NOT set
STRIPE_WEBHOOK_SECRET        # NOT set
```

These require interactive Stripe Dashboard work (cannot autonomously
create):

1. **Create test-mode products + prices in Stripe Dashboard** (test
   mode) for each tier in `apps/marketing-site/src/data/pricing.ts`:
   - Manual Solo / Team / Agency ($79/$249/$699 monthly + annual)
   - API Starter / Builder / Scale ($149/$499/$1,499 monthly + annual)
   - Self-hosted Solo / Pro / Enterprise (contact sales — may not need
     price IDs if billed off-Stripe)
   - Trial pack ($2.99 one-time)
2. **Collect the price IDs** (price_XXXXXXXX) and assemble
   `DRIFTSTACK_TIER_PRICE_IDS` as the JSON map the config schema
   expects.
3. **Set `STRIPE_TRIAL_PACK_PRICE_ID`** to the trial-pack one-time
   price ID.
4. **Create a Stripe webhook endpoint** in the dashboard pointing at
   `https://api.driftstack.dev/v1/webhooks/stripe`, capture the signing
   secret as `STRIPE_WEBHOOK_SECRET`.
5. SSH into prod (`root@128.140.37.74`) and append the three vars to
   `/opt/driftstack/api/.env` (chmod 600, owner driftstack — preserve
   the existing convention).
6. Restart `driftstack-api` systemd unit so config reloads (or wait
   for the next deploy).

Once all four env vars are present, the next deploy auto-wires
`BillingService` via the existing `if (config.stripe?.secretKey &&
config.stripe.tierPrices && config.stripe.trialPackPriceId)` gate at
`bootstrap.ts:558`. Routes flip from 503 to 200 with no code change
required.

### Why ship the safety guard now (vs. wait for full activation)

The guard is independent of the env vars — it fires as long as
STRIPE*SECRET_KEY is set, regardless of price IDs. Today's prod state
has `sk_test*`set, so the guard passes. If a future operator
accidentally swaps in`sk*live*` before 2026-05-21 (e.g. founder
copy-pastes a wrong key while wiring the dashboard), the server
refuses to boot with a clear error message. Belt-and-suspenders.

### Post-deploy-verify slot deferred until billing flips on

The orchestrator's "7th activation-gate slot" framing referenced
extending `scripts/post-deploy-verify.mjs` with a check that confirms
the running deployment is using a sk*test* key. That check requires a
new endpoint to expose the key prefix (without echoing the key
itself), which is a separate slice. Holding until billing is fully
activated — meanwhile the bootstrap fail-fast covers the same
threat model.

## Next: Q.3 — AI-B3 token-budget persistence

`/loop` continues. Q.3 is fully unblocked (the `agent_sessions`
migration includes `token_budget_remaining` already; just need
per-turn decrement + closed-reason update on exhaustion).
