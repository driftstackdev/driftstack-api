---
layout: ../../layouts/DocLayout.astro
title: Usage
description: Quota counters, current-period totals, and a daily time series — the /v1/usage and /v1/usage/series endpoints.
---

# Usage

`/v1/usage` exposes the calling account's current billing-period
totals + tier quotas. `/v1/usage/series` returns a daily-bucketed
sparkline for the last N days.

Both endpoints honor the `X-Driftstack-Account` header (Team RBAC):
when set to a team owner's account id, the response covers the
OWNER's usage rather than the calling member's. The owner's tier is
the quota-cap source — being on a team doesn't bump a member's
personal cap.

## Current period summary

`GET /v1/usage`

Response (200):

```json
{
  "period_start": "2026-05-01T00:00:00.000Z",
  "period_end": "2026-06-01T00:00:00.000Z",
  "tier": "api_builder",
  "totals": {
    "session_minute": 1234,
    "navigate": 56789,
    "interact": 12345,
    "wait": 6789,
    "state_capture": 234,
    "screenshot_capture": 78
  },
  "quotas": {
    "session_minute": 50000,
    "navigate": null,
    "interact": null,
    "wait": null,
    "state_capture": null,
    "screenshot_capture": null
  }
}
```

### Fields

- `period_start` / `period_end` — UTC ISO 8601. The current calendar
  month bounds (period_end is exclusive — the first second of the
  next month).
- `tier` — the account's billing tier. The tier determines the
  quota caps below.
- `totals.*` and `quotas.*` use the same key set — the
  `UsageRecordType` enum (singular): `session_minute`, `navigate`,
  `interact`, `wait`, `state_capture`, `screenshot_capture`. Both
  maps always carry all six keys.
- `totals.session_minute` — wall-clock minutes a session was
  active, summed across the calendar month. Drives the
  session-minutes meter on Stripe.
- `totals.navigate` / `interact` / `wait` — count of each driver
  action invoked. Free across all tiers; surfaced for
  observability.
- `totals.state_capture` / `screenshot_capture` — count of state
  reads + screenshot endpoint hits. Same: count-only, no per-tier
  cap.
- `quotas.session_minute` — calendar-month soft cap from the tier
  table. Crossing the cap triggers a 402-style billing-overage
  signal at the BillingService layer (this endpoint reports raw
  counters; the cap is informational here).
- `quotas.<other>` is `null` for record types that are unmetered
  on the calling tier (free / count-only). A non-null value here
  means a hard cap exists; cross-check against `totals.<same-key>`
  to see how much headroom remains.

For the enterprise tier, `quotas.session_minute` may be `null`
(meaning "no fixed cap; see your contract"). All other tiers
return a numeric value.

This endpoint does not surface the concurrent-sessions cap or the
profile-count cap — those are tier-table values enforced at create
time. See [/reference/rate-limits](/reference/rate-limits) for the
full per-tier configuration.

## Daily series

`GET /v1/usage/series?days=30`

Response (200):

```json
{
  "from_date": "2026-04-09",
  "to_date": "2026-05-09",
  "buckets": [
    {
      "date": "2026-04-09",
      "totals": {
        "session_minute": 42,
        "navigate": 1200,
        "interact": 350,
        "wait": 75,
        "state_capture": 8,
        "screenshot_capture": 3
      }
    }
  ]
}
```

`totals` is a record keyed by record type (singular form, matching
the `UsageRecordType` enum + the field names on the
`current_period` `totals`). `days` parameter: 1-90, default 30.
The series is right-aligned on "yesterday" (the most-recent
fully-closed UTC day); today's partial bucket is intentionally
not surfaced — the dashboard's sparkline renders cleaner without
a half-empty trailing bucket.

Empty days return zeros for every counter (not omitted from the
response) so the dashboard can render an empty-state without
client-side date-fill logic.

**SDK usage:**

```ts
const series = await client.usage.series({ days: 30 });
for (const b of series.buckets) {
  console.log(b.date, b.totals.session_minute, b.totals.navigate);
}
```

```python
series = client.usage.series(days=30)
for b in series["buckets"]:
    print(b["date"], b["totals"].get("session_minute", 0))
```

```go
series, _ := client.Usage.Series(ctx, 30)
for _, b := range series.Buckets {
    fmt.Println(b.Date, b.Totals["session_minute"], b.Totals["navigate"])
}
```

## Quota / tier caps

The locked tier table is driven by `TIER_CONCURRENT_SESSION_LIMITS`
and `PROFILES_PER_TIER` in `@driftstack/api-types`. Snapshot:

| Tier            | Concurrent sessions | Profiles | Session minutes / month |
| --------------- | ------------------: | -------: | ----------------------: |
| `free`          |                   1 |        1 |                       — |
| `solo_manual`   |                   1 |       10 |                     600 |
| `team_manual`   |                   3 |       50 |                   6,000 |
| `agency_manual` |                   8 |      200 |                  24,000 |
| `api_starter`   |                   2 |       25 |                   6,000 |
| `api_builder`   |                   8 |      100 |                  50,000 |
| `api_scale`     |                  24 |      500 |                 250,000 |
| `enterprise`    |                  32 |   custom |                  custom |

Crossing the soft cap doesn't cut off the API — it triggers a
billing-overage flag and (per ADR-004) Stripe overage billing at
the configured per-unit rate. Customers approaching the cap get
quota-warning webhooks (`quota.warning_80pct`, `quota.exceeded`)
when an endpoint is subscribed.

## Auth + scoping

Both endpoints accept any valid bearer (API key OR web session)
with `read` scope. The X-Driftstack-Account header is honored for
team scopes per the (member roles read the owner's usage).

## Errors

| Status | Body type           | When                                                                   |
| ------ | ------------------- | ---------------------------------------------------------------------- |
| 401    | `unauthorized`      | Missing / invalid bearer                                               |
| 403    | `forbidden`         | X-Driftstack-Account points at an account the caller isn't a member of |
| 400    | `validation-failed` | `days` outside [1, 90] on /series                                      |

## Backend notes

The `usage_records` table is the source of truth (per the +
. The dashboard currently renders zeros for buckets that
predate the writers landing in production; that's expected
empty-state, not a bug.
