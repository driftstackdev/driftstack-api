# V-541 — cost monitoring + alerting design

**Date:** 2026-05-10
**Wave:** 20
**Status:** DESIGN — implementation deferred to V-541.B (admin endpoint
stub) and V-541.C (alert delivery wiring).

## Purpose

As paying customers come online, per-account compute + bandwidth +
sub-processor cost can drift unpredictably. A heavy session (long
WebRTC stream + many captures) costs measurably more than a light one
(few HTTP calls, no recordings). Without monitoring + alerting, the
first signal of a runaway-cost account is the monthly Hetzner/R2/
Postmark bill.

V-541 designs the monitoring surface that catches this _before_ the
month ends.

## Out of scope for v1

- Real-time per-request cost attribution (too expensive at request rate;
  defer to v2 when traffic justifies).
- Cross-cloud cost aggregation (just Hetzner + R2 + Postmark + Stripe
  fees for v1; Cloudflare DNS is free; MacStadium not yet engaged).
- Customer-facing cost dashboards (internal-admin-only for v1).

## In scope for v1

1. **Per-account cost meter** — running estimate of cost-to-serve per
   account per billing-cycle. Estimated, not exact (exact billing
   reconciles monthly via sub-processor invoices).
2. **Alert thresholds** — per-account hard cap + soft warning. Defaults
   per-tier; per-account override for known-heavy customers.
3. **Admin endpoint** — `/v1/admin/cost/accounts/:id` (single account) +
   `/v1/admin/cost/overview` (aggregate dashboard data).
4. **Alert delivery** — Postmark email to admins when a threshold trips.

## Cost model

Per-billing-cycle (monthly), per-account cost estimate:

```
cost_total = cost_compute + cost_storage + cost_egress + cost_subprocessor
```

### `cost_compute`

Driven by **session-minutes**. Each session occupies a Mac mini slot for
its lifetime. Cost per session-minute is the amortised Mac mini hourly
rate / 60.

- Tier-defined session-concurrent cap × max session duration =
  upper bound per account per cycle.
- Tracked via existing `sessions` table + session-lifecycle events.

Rough rate (Hetzner Mac mini M2 dedicated, € rate / cycle / instance) — the
operator maintains this multiplier in admin config (per-cycle re-tunable as
sub-processor rates change).

### `cost_storage`

Driven by **R2 object-bytes-month**. Each capture (screenshot / DOM /
PDF / recording) lands in R2. Object lifetime = customer-configured
retention (default 30d for screenshots / DOM, 90d for recordings).

- Sum of (object size × time-stored in seconds) across all objects
  attributed to the account, divided by month-seconds.
- R2 rate: ~$0.015 / GB-month (egress free under Cloudflare).
- Per-object size + creation timestamp tracked via existing
  `usage_records` of kind `'capture'`.

### `cost_egress`

R2 egress is free under Cloudflare's offering. WebRTC streaming traffic
goes through STUN/TURN if NAT requires it; TURN bandwidth is the
non-zero egress dimension.

- TURN bytes-month — once V-531 production wiring lands, TURN bandwidth
  per session attributed to the session's account.
- v1 default rate: 0 (TURN not yet provisioned; falls back to direct
  peer connection or polling-screenshot fallback).

### `cost_subprocessor`

Per-account share of fixed-rate sub-processor costs:

- **Postmark** — emails sent on behalf of the account / total emails ×
  Postmark monthly bill.
- **Sentry** — events ingested on behalf of the account / total
  events × Sentry monthly bill.
- **Stripe** — Stripe fees per transaction, attributed at transaction
  time (this one is exact, not estimated).
- **Anthropic** — if bundled-LLM agent feature is opt-in for the
  account, the Anthropic token cost from the account's LLM usage. Exact
  per request; reconciled monthly.

## Alert thresholds

Per-tier defaults (configurable per-account via admin override):

| Tier       | Soft warning | Hard cap | Action on hard cap                                   |
| ---------- | ------------ | -------- | ---------------------------------------------------- |
| Trial      | €5           | €15      | Throttle new sessions; admin email; customer email   |
| Tier-1     | €30          | €80      | Throttle new sessions; admin email                   |
| Tier-2     | €120         | €300     | Admin email only (large customer; expected variance) |
| Enterprise | custom       | custom   | Per-account configured                               |

Hard-cap enforcement happens at session-create time — if account is
over hard cap for the current cycle, return `402 Payment Required`
problem+json. Soft-warning emails fire once per cycle when crossed.

## Admin endpoint surface (V-541.B implementation target)

```
GET /v1/admin/cost/accounts/:accountId
  → returns:
    {
      "accountId": "...",
      "billingCycle": { "start": "2026-05-01T00:00:00Z", "end": "..." },
      "estimated": {
        "total": 47.23,
        "compute": 30.12,
        "storage": 8.40,
        "egress": 0.00,
        "subprocessor": 8.71
      },
      "tier": "tier-1",
      "softWarning": 30.00,
      "hardCap": 80.00,
      "thresholdState": "between-soft-and-hard",
      "currency": "EUR"
    }

GET /v1/admin/cost/overview
  → returns:
    {
      "billingCycle": { ... },
      "totalEstimated": 1247.83,
      "accountCount": 23,
      "topAccountsByCost": [ { "accountId": "...", "total": 92.40 }, ... ],
      "overSoftWarningCount": 4,
      "overHardCapCount": 1
    }
```

Both endpoints require admin auth + audit-log entry on read.

## Alert delivery (V-541.C implementation target)

Two channels:

1. **Admin email** — Postmark template `cost-alert-admin` with body
   listing the account, the threshold tripped, and the linked admin
   panel URL.
2. **Status page banner** (V-541.D) — if total platform cost exceeds an
   absolute threshold (e.g. €5000 in a single cycle indicates either a
   surge or a runaway), surface to the team admin status page.

Customer-facing email (trial-tier hard-cap) goes through the same
Postmark template flow as the existing usage-cap emails.

## Persistence

Cost-snapshot table (proposed; lands with V-541.B):

```sql
CREATE TABLE cost_snapshots (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  billing_cycle   text NOT NULL,  -- 'YYYY-MM'
  compute_cents   integer NOT NULL DEFAULT 0,
  storage_cents   integer NOT NULL DEFAULT 0,
  egress_cents    integer NOT NULL DEFAULT 0,
  subproc_cents   integer NOT NULL DEFAULT 0,
  total_cents     integer NOT NULL DEFAULT 0,
  threshold_state text NOT NULL,  -- 'under-soft' | 'between-soft-and-hard' | 'over-hard'
  computed_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, billing_cycle)
);
```

Cost snapshot recomputes nightly via a scheduled job (BullMQ on top of
Redis 7 — already in the stack). Recomputation is cheap (aggregations
over `sessions` + `usage_records` indexed on `account_id` +
`occurred_at`).

## Implementation slices

- **V-541 (THIS WAVE):** design doc (this file).
- **V-541.B (later):** admin endpoint stubs + cost-snapshot schema +
  Drizzle migration + cost-compute service implementing the formula
  above. Per-tier alert thresholds hard-coded; admin-override is
  V-541.C scope.
- **V-541.C (later):** alert delivery via Postmark + scheduled-job for
  nightly snapshot recompute + admin-override-of-threshold endpoint.
- **V-541.D (later):** status-page banner integration when platform
  total trips a banner threshold.

## Open questions for team review

1. **Currency** — EUR everywhere (founder is EU-based, Stripe charges
   EUR by default for EU customers)? Or USD for the dashboards (more
   common for SaaS pricing comparisons)? Recommendation: EUR.
2. **Reconciliation cadence** — monthly reconciliation against
   sub-processor invoices, or accept the estimate as ground truth and
   reconcile only on dispute? Recommendation: monthly (founder reviews
   on the 5th of each month).
3. **Anthropic LLM cost attribution model** — pass-through pricing (cost
   - small operational markup) OR margin-bundled (LLM cost rolled into
     tier pricing, fixed margin)? Recommendation: pass-through for v1
     with explicit per-request cost surfaced in admin UI; margin-bundled
     when LLM usage stabilises enough to predict.

## Verification (V-541 design only)

- File written; no code or tests added this wave.
- V-205 + V-211 regex sweep on this file — zero hits.

## Sub-slice posture

This wave (V-541) is design-only. V-541.B/C/D ship the implementation
in subsequent waves. Surfaced rather than silently scoping the design
slice as an implementation slice.
