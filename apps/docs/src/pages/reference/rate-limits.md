---
layout: ../../layouts/DocLayout.astro
title: Rate limits
description: Per-tier rate limit defaults — token-bucket capacity, refill rate, and what happens when you hit the cap.
---

# Rate limits

Driftstack enforces per-tier token-bucket rate
limits on every authenticated `/v1/*` call. The limits are
intentional anti-abuse caps (runaway scripts, accidental DoS),
not the pricing meter. Pricing is concurrent-only per ADR-004.

## Three bucket keys

Every authenticated request consumes from one or more buckets:

- **`global`** — every authenticated `/v1/*` call.
- **`sessions:create`** — `POST /v1/sessions` only. Lower cap
  because session creation is the most expensive op in the
  system (driver allocation, archetype hydration, fingerprint
  pinning).
- **`agent_sessions:message`** —
  `POST /v1/agent-sessions/:id/message` only. Isolated from
  `global` so an LLM-driven message loop can't drain the
  global cap (v2-#8 sub-slice 8.20).

A `POST /v1/sessions` consumes from BOTH `global` and
`sessions:create`. A `POST /v1/agent-sessions/:id/message`
consumes from `agent_sessions:message` only — hitting any cap
returns 429.

## Per-tier defaults

| Tier            | global capacity | global refill (rps) | sessions:create capacity | sessions:create refill (rps) | agent_sessions:message capacity | agent_sessions:message refill (rps) |
| --------------- | --------------- | ------------------- | ------------------------ | ---------------------------- | ------------------------------- | ----------------------------------- |
| `trial_pack`    | 60              | 1                   | 5                        | 1/60 (1 per minute)          | 20                              | 1/5 (12 per minute)                 |
| `solo_manual`   | 120             | 2                   | 10                       | 1/30 (2 per minute)          | 40                              | 1/3 (20 per minute)                 |
| `team_manual`   | 360             | 6                   | 20                       | 1/10 (6 per minute)          | 100                             | 1                                   |
| `agency_manual` | 1,800           | 30                  | 60                       | 1                            | 300                             | 3                                   |
| `api_starter`   | 240             | 4                   | 15                       | 1/20 (3 per minute)          | 60                              | 1/2 (30 per minute)                 |
| `api_builder`   | 1,800           | 30                  | 60                       | 1                            | 300                             | 3                                   |
| `api_scale`     | 6,000           | 100                 | 120                      | 2                            | 1,000                           | 10                                  |
| `enterprise`    | 60,000          | 1,000               | 600                      | 10                           | 10,000                          | 100                                 |

Capacity = max burst size before the next refill kicks in.
Refill = sustained rate (tokens per second). Effective sustained
RPS for a default-cost call is the `refill` column.

## What happens when you hit the cap

The API returns HTTP 429 with an RFC 7807 problem-details body
(`application/problem+json`):

```json
{
  "type": "https://errors.driftstack.dev/rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Rate limit for \"global\" exceeded for tier \"api_starter\".",
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
  "buckets": [
    {
      "bucket_key": "global",
      "capacity": 1800,
      "refill_per_second": 30,
      "source": "tier_default",
      "override_expires_at": null
    },
    {
      "bucket_key": "sessions:create",
      "capacity": 60,
      "refill_per_second": 1,
      "source": "tier_default",
      "override_expires_at": null
    }
  ]
}
```

`source` is `"tier_default"` or `"override"`; when an override is
active, `override_expires_at` carries the auto-revert timestamp.
Full read-endpoint docs at
[/api/account-rate-limits](/api/account-rate-limits/).

The customer dashboard does not yet render this data visually —
`/usage` on the dashboard shows time-series usage counts (session
minutes, navigates, captures) but not the per-bucket rate-limit
rows. Read this endpoint directly via the SDK or `curl`; a
dedicated dashboard surface is queued for a future slice.

## Response headers

Every authenticated `/v1/*` response carries four `x-ratelimit-*`
headers reflecting the bucket consumed:

| Header                  | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `x-ratelimit-bucket`    | Which bucket the call drained — see the bucket keys above.                  |
| `x-ratelimit-limit`     | Bucket capacity (matches the `capacity` row from the read endpoint).        |
| `x-ratelimit-remaining` | Tokens left in the bucket _after_ this call (integer, floor of fractional). |
| `x-ratelimit-reset`     | Unix-seconds timestamp when the bucket refills to full capacity.            |

The headers are emitted on every status code (including `429`), so
retry loops can read them without an extra round-trip — combine
`x-ratelimit-remaining=0` with `Retry-After` to drive a back-off.

## Source of truth

The numbers above are mirrored from
`packages/api-types/src/common.ts:TIER_RATE_LIMIT_DEFAULTS` —
the API server reads from the same constant via
`bucketConfigFor()` in
`apps/server/src/services/rate-limit.ts`. Customer dashboard +
this docs page must agree with the server. If you spot a
discrepancy, file a bug at
[support@driftstack.dev](mailto:support@driftstack.dev).
