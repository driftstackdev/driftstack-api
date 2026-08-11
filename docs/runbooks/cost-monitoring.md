# Cost monitoring runbook (V-673)

Operational reference for the cost-monitoring pipeline shipped in
V-541.B → V-541.E. Read this when:

- A cost alert (`cost.threshold.breached`) fires for a customer.
- The nightly recompute (`cost.recompute_nightly` scheduled job) is
  missing or late.
- An operator needs to tune per-tier soft/hard thresholds.
- An operator needs to interpret the customer-facing
  `GET /v1/account/cost` response when a customer asks "why is my
  number different from what I see in my invoice?"

## Architecture at a glance

```
   usage tables ──► UsageAggregator
                         │
                         ▼
                CostMonitoringService     ◄── tier resolver
                  (V-541.B, pure)            (billing repo)
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
    GET /v1/admin/  GET /v1/account/  CostAlertDispatcher
      cost/...        cost              (V-541.C, in-memory
                                         prior-state map)
                                              │
                                              ▼
                                        AlertSink
                                       (Sentry/Slack)
```

The nightly job (`cost.recompute_nightly`, V-541.E) ticks once per
UTC day:

1. `accounts.listAllAccountIds()` enumerates accounts to evaluate.
2. The dispatcher pulls usage + tier per account, classifies the
   threshold transition (`under-soft → approaching → over-soft →
over-hard`), and fires an alert through `AlertSink` ONLY when the
   state changes.
3. The handler re-enqueues itself for the next UTC midnight via
   `enqueueNextNightlyRun` (idempotent via the
   `dedup_on_account_and_type` flag on `scheduled_jobs`).

## Where state lives

| Concern                   | Storage                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Per-account usage         | Whatever `UsageAggregator` reads (today: `usage_events` aggregate) |
| Per-tier rates            | `CostRates` config — wired at app boot (`config/cost-rates.ts`)    |
| Per-tier thresholds       | `tierThresholds` map — wired at app boot                           |
| Last-seen threshold state | **In-memory** on the dispatcher (Map<accountId, ThresholdState>)   |
| Scheduled-job ledger      | `scheduled_jobs` table (V-202d)                                    |

> **Important — dispatcher state is in-memory.** On every deploy or
> server restart, the prior-state map resets. The first nightly tick
> after a deploy will re-alert every account currently above
> `over-soft` (no state-change suppression because there's no prior
> state to compare against). This is **expected** at the current
> traffic level (single-digit paid accounts) but will need a Redis
> backing once the alert volume becomes annoying for ops.

## Common operations

### Triage an alert

1. Open the alert in Sentry / the alert sink and grab `account_id`
   - `severity` + `billing_cycle`.
2. Pull the breakdown from the admin panel (`/cost` page, V-541.B,
   landed 2026-05-16): paste the `account_id` + optional billing
   cycle, hit Query. Reads `/v1/admin/cost/accounts/:id` under the
   hood, surfaces total + 4-dimension breakdown + threshold state.
   Or via curl directly:

   curl -H "Authorization: Bearer <internal-admin-key>" \
    "$BASE_URL/v1/admin/cost/accounts/<account_id>?billing_cycle=<YYYY-MM>"

3. Identify which line dominates the total (`computeCents`,
   `storageCents`, `egressCents`, `emailCents`, `llmCents`).
4. Compare against the tier-soft / tier-hard thresholds — both are
   in the alert payload (`soft_cents`, `hard_cents`).
5. If `severity == 'critical'` (over-hard) — page on-call. Hard
   threshold means the account is past the cost ceiling we'd be
   willing to absorb for a single billing cycle.
6. If `severity == 'warning'` (over-soft) — file a follow-up to
   contact the customer within 48h about upgrading or shaping their
   usage.

### Re-enqueue the nightly job after a missed tick

The job is self-re-arming, and **a missed tick needs no operator
action**. `claimDue` selects on `run_at <= now`, so the background
poller re-claims any past-due job on its next tick and runs it then.
There is no HTTP trigger: no `/v1/admin/scheduled-jobs/*` route exists
(this section previously documented a `run-once` endpoint that was
never built, so the curl 404'd).

If a job stays pending well past its `run_at`, the poller itself is the
thing to check — not the job. Confirm the api service is up and look for
the `scheduled-jobs tick processed due jobs` log line; a dead poller is
the only way a due job goes unclaimed.

If the endpoint above doesn't exist yet in the version deployed, the
fallback is to enqueue the job manually with `runAt = now()` via the
scheduled-jobs repo — the handler will pick it up on the next
processTick + re-enqueue the regular next-midnight slot afterwards.

### Reset the dispatcher prior-state map

Used when an alert fired in error (e.g. wrong threshold config
deployed) and ops wants to suppress re-fires until the next genuine
transition. Two options:

- **Soft reset (preferred)**: redeploy. The dispatcher map is
  in-memory and resets on boot.
- **Hard reset via admin route** — when implemented (V-673 follow-up
  is to expose this via the admin API; until then a deploy is the
  blunt tool).

### Tune per-tier thresholds

`tierThresholds` is wired at app boot from `config/cost-thresholds.ts`.
Edit + redeploy. Thresholds are in **cents**; the convention is:

- `softCents` — first alert; "approaching the limit" — friendly notice
- `hardCents` — second alert; "over the limit" — operator action

Rule of thumb for picking thresholds at a new tier:

1. Take the tier's monthly price `P`.
2. `softCents = round(P * 0.6)` — gives the customer headroom to
   tune their usage before hitting the operator-action band.
3. `hardCents = round(P * 0.9)` — leaves ~10% margin between cost
   and revenue for the cycle.

The customer-facing route (`GET /v1/account/cost`) intentionally
**redacts** the numeric thresholds from the response — the customer
sees a categorical `thresholdState` (`under-soft` / `approaching` /
`over-soft` / `over-hard`) but not the operator-tuned cents values.
This prevents customers from optimising right up to the hard line.

## When the customer asks "why doesn't this match my Stripe invoice?"

The cost-monitoring numbers are an **internal cost projection**, not
a Stripe-issued invoice. Differences are expected and not a bug:

- The cost-monitoring view shows our internal estimated unit costs
  (compute, storage, egress, LLM). The Stripe invoice shows the
  subscription price + any metered overage line items configured at
  the price-list level.
- The cost-monitoring window is the **current calendar UTC month**.
  The Stripe billing cycle anchors on the customer's subscription
  start date.
- The customer's tier may include cost the customer doesn't pay for
  directly (e.g. compute included in a subscription tier).

If a customer is confused, the script is:

> "The dashboard's usage panel shows our internal cost projection
> for the current calendar month so you can plan ahead. Your Stripe
> invoice is the source of truth for what you actually pay — it
> follows your subscription's billing cycle, not the calendar month,
> and includes the tier subscription on top of any metered usage."

## Failure modes

| Symptom                             | Likely cause                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Nightly job hasn't enqueued in >24h | Scheduled-jobs worker is down — check `scheduled_jobs` claim count + worker liveness; restart the worker if stale.          |
| Re-alerts after every deploy        | Expected per the in-memory dispatcher caveat above. If the rate is intolerable, escalate to wire dispatcher state to Redis. |
| Customer breakdown shows zero       | `UsageAggregator` returned null for that account-cycle; verify usage events landed (check `usage_events` row count).        |
| `GET /v1/account/cost` 403s         | Caller is missing the implicit account-owner gate; route auth is `requireAuth` (any key with read on the calling account).  |

## Related runbooks

- [`incidents.md`](incidents.md) — when a cost-monitoring alert is
  the **trigger** for a customer-facing incident.
- [`observability.md`](observability.md) — Sentry / Slack alert sink
  configuration.
- [`../deployment/runbook.md`](../deployment/runbook.md) — routine
  deploys (relevant because dispatcher resets on each one).
