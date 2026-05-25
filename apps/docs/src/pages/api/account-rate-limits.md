---
layout: ../../layouts/DocLayout.astro
title: Account rate limits
description: Read your account's effective per-bucket rate-limit config — tier defaults plus any active admin overrides.
---

# Account rate limits

Driftstack enforces per-tier token-bucket rate
limits on every authenticated `/v1/*` call. The
`/v1/account/rate-limits` endpoint exposes the **effective** config
your account is hitting right now — tier defaults merged with any
active admin overrides.

For the broader explanation of how rate limits work + the per-tier
defaults table, see [/reference/rate-limits](/reference/rate-limits).

## Get effective rate-limit config

`GET /v1/account/rate-limits`

Returns the rate-limit config that's actually being applied to
this account. Four bucket keys exist: `global` (every
authenticated `/v1/*` call), `sessions:create`
(`POST /v1/sessions` only — lower cap because session creation is
expensive), `agent_sessions:message`
(`POST /v1/agent-sessions/:id/message` — separate cap so an
LLM-driven message loop can't drain the global bucket), and
`agent_sessions:input_event`
(`POST /v1/agent-sessions/:id/input-event` — separate cap sized for
high-frequency live input so input streams don't drain the global
bucket).

Response (200):

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
    },
    {
      "bucket_key": "agent_sessions:message",
      "capacity": 300,
      "refill_per_second": 3,
      "source": "tier_default",
      "override_expires_at": null
    },
    {
      "bucket_key": "agent_sessions:input_event",
      "capacity": 600,
      "refill_per_second": 150,
      "source": "tier_default",
      "override_expires_at": null
    }
  ]
}
```

When an active admin override is in place for a bucket, that row
shows `source: "override"` plus the override's `override_expires_at`
timestamp:

```json
{
  "bucket_key": "global",
  "capacity": 6000,
  "refill_per_second": 100,
  "source": "override",
  "override_expires_at": "2026-06-15T12:00:00Z"
}
```

After the override expires, subsequent reads return the
tier-default row again. The override doesn't disappear from the
admin's audit trail — only from the calling account's effective
config.

Required scope: `read` or `account_owner`.

## Bucket reference

| Bucket key                   | Consumed by                               | Why a separate bucket?                                                                                        |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `global`                     | Every authenticated `/v1/*`               | Coarse anti-abuse cap — protects against runaway scripts                                                      |
| `sessions:create`            | `POST /v1/sessions` only                  | Lower cap because session creation is the most expensive op (driver allocation)                               |
| `agent_sessions:message`     | `POST /v1/agent-sessions/:id/message`     | Isolated from `global` so an LLM-driven message loop can't drain the global cap                               |
| `agent_sessions:input_event` | `POST /v1/agent-sessions/:id/input-event` | High-frequency live input (sized for ≤120Hz mouseMove) — isolated so input streams can't drain the global cap |

A `POST /v1/sessions` consumes from BOTH buckets — hitting either
cap returns 429.

## Per-tier defaults

The defaults the endpoint returns when no override is active are
locked in `packages/api-types/src/common.ts:TIER_RATE_LIMIT_DEFAULTS`.
Full table at [/reference/rate-limits](/reference/rate-limits).

## Admin overrides

Driftstack staff can configure per-account, per-bucket overrides
that supersede tier defaults for a configurable window. Overrides
have:

- `capacity` and `refill_per_second` — the new ceiling
- `expires_at` — when the override automatically reverts to tier
  default
- `reason` — admin-side audit string (not exposed on the customer
  endpoint)

When an override exists for a bucket and `now < expires_at`, the
override takes effect. When `now >= expires_at`, the bucket falls
back to the tier default automatically.

Customers needing legitimate high-throughput workloads (Enterprise,
agencies running scraping jobs across many domains) request
overrides via `support@driftstack.dev` with workload shape +
expected steady-state RPS. Admins evaluate, set the override via
`/v1/admin/rate-limit-overrides`, and notify the customer.

## Customer-dashboard surface

Read this endpoint directly via the SDK or `curl` — the customer
dashboard does not yet render the rate-limit bucket config
visually. The `/usage` page on the dashboard shows time-series
usage counts (session minutes, navigates, captures, etc.) but not
the per-bucket capacity / refill / source rows from this endpoint.
A dedicated rate-limits surface is queued for a future dashboard
slice.

## Response headers

Every authenticated `/v1/*` response (whether the call landed at
200, 4xx, or hit the cap with 429) carries four `x-ratelimit-*`
headers reflecting the bucket your call consumed from. The headers
are emitted regardless of HTTP status so retry logic can read them
even after a hard error.

| Header                  | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `x-ratelimit-bucket`    | Which bucket the call drained — see the bucket reference above.             |
| `x-ratelimit-limit`     | Bucket capacity — same as `capacity` from this endpoint.                    |
| `x-ratelimit-remaining` | Tokens left in the bucket _after_ this call (integer, floor of fractional). |
| `x-ratelimit-reset`     | Unix-seconds timestamp when the bucket refills to full capacity.            |

A `POST /v1/sessions` consumes from both `global` and
`sessions:create`. The headers reflect the more-constrained bucket —
typically `sessions:create`, since its capacity is much lower than
the global bucket.

These headers are also surfaced on `429` responses; combine
`x-ratelimit-remaining=0` + `Retry-After` to drive a back-off
without an extra round-trip.

## What happens when you hit a cap

The API returns HTTP 429 with an RFC 9457 problem-details body:

```json
{
  "type": "https://errors.driftstack.dev/rate-limited",
  "title": "Rate limit exceeded",
  "status": 429,
  "detail": "Rate limit for \"global\" exceeded for tier \"api_starter\".",
  "bucket": "global",
  "retry_after_seconds": 12
}
```

The `Retry-After` HTTP header carries the same value as
`retry_after_seconds`. SDK clients honour it automatically with
exponential backoff capped at 30s; see
[/reference/errors](/reference/errors) for retry-loop examples.

## Source of truth

Routes: `apps/server/src/routes/account-rate-limits.ts`. Schema:
`packages/api-types/src/common.ts:TIER_RATE_LIMIT_DEFAULTS`.
Override repo: `apps/server/src/db/rate-limit-overrides-repo.ts`.
Admin route: `apps/server/src/routes/admin-rate-limit-overrides.ts`.
