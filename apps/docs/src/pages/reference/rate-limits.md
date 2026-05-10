---
layout: ../../layouts/DocLayout.astro
title: Rate limits
description: Per-tier rate limit defaults — token-bucket capacity, refill rate, and what happens when you hit the cap.
---

# Rate limits

V-505 reference. Driftstack enforces per-tier token-bucket rate
limits on every authenticated `/v1/*` call. The limits are
intentional anti-abuse caps (runaway scripts, accidental DoS),
not the pricing meter. Pricing is concurrent-only per ADR-004.

## Two bucket keys

Every authenticated request consumes from one or both buckets:

- **`global`** — every authenticated `/v1/*` call.
- **`sessions:create`** — `POST /v1/sessions` only. Lower cap
  because session creation is the most expensive op in the
  system (driver allocation, archetype hydration, fingerprint
  pinning).

A `POST /v1/sessions` consumes from BOTH `global` and
`sessions:create` — hitting either cap returns 429.

## Per-tier defaults

| Tier            | global capacity | global refill (rps) | sessions:create capacity | sessions:create refill (rps) |
| --------------- | --------------- | ------------------- | ------------------------ | ---------------------------- |
| `trial_pack`    | 60              | 1                   | 5                        | 1/60 (1 per minute)          |
| `solo_manual`   | 120             | 2                   | 10                       | 1/30 (2 per minute)          |
| `team_manual`   | 360             | 6                   | 20                       | 1/10 (6 per minute)          |
| `agency_manual` | 1,800           | 30                  | 60                       | 1                            |
| `api_starter`   | 240             | 4                   | 15                       | 1/20 (3 per minute)          |
| `api_builder`   | 1,800           | 30                  | 60                       | 1                            |
| `api_scale`     | 6,000           | 100                 | 120                      | 2                            |
| `enterprise`    | 60,000          | 1,000               | 600                      | 10                           |

Capacity = max burst size before the next refill kicks in.
Refill = sustained rate (tokens per second). Effective sustained
RPS for a default-cost call is the `refill` column.

## What happens when you hit the cap

The API returns HTTP 429 with an RFC 9457 problem-details body:

```json
{
  "type": "https://api.driftstack.dev/errors/rate-limit-exceeded",
  "title": "Rate limit exceeded",
  "status": 429,
  "detail": "Rate limit for \"global\" exceeded for tier \"api_starter\".",
  "bucket": "global",
  "retry_after_seconds": 12
}
```

The standard `Retry-After` HTTP header carries the same value as
`retry_after_seconds`. SDK clients honour it automatically with
exponential backoff capped at 30s.

## Per-account overrides

Driftstack staff can configure per-account overrides via
`/v1/admin/rate-limit-overrides`. Customers reaching legitimate
high-throughput workloads (Enterprise, agencies running scraping
jobs across many domains) are bumped above the per-tier default
on request. Email `support@driftstack.dev` with workload shape +
expected steady-state RPS.

## Reading your current cap

`GET /v1/account/rate-limits` returns the effective per-bucket
config for your account, including any overrides:

```json
{
  "tier": "api_builder",
  "buckets": {
    "global": { "capacity": 1800, "refill_per_second": 30 },
    "sessions:create": { "capacity": 60, "refill_per_second": 1 }
  }
}
```

The customer dashboard at `/usage` surfaces the same data
visually.

## Source of truth

The numbers above are mirrored from
`packages/api-types/src/common.ts:TIER_RATE_LIMIT_DEFAULTS` —
the API server reads from the same constant via
`bucketConfigFor()` in
`apps/server/src/services/rate-limit.ts`. Customer dashboard +
this docs page must agree with the server. If you spot a
discrepancy, file a bug at
[support@driftstack.dev](mailto:support@driftstack.dev).
