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

## Four bucket keys

Every authenticated request selects exactly one bucket key:

- **`global`** — every authenticated `/v1/*` call that doesn't
  have a dedicated bucket below.
- **`sessions:create`** — the two session-creating calls,
  `POST /v1/sessions` and `POST /v1/profiles/:id/launch`. Lower
  cap because session creation is the most expensive op in the
  system (driver allocation, archetype hydration, fingerprint
  pinning); a profile launch creates a session too, so it draws
  on the same cap rather than a separate one.
- **`agent_sessions:message`** —
  `POST /v1/agent-sessions/:id/message` only. Isolated from
  `global` so an LLM-driven message loop can't drain the
  global cap and exhaust unrelated API capacity.
- **`agent_sessions:input_event`** —
  `POST /v1/agent-sessions/:id/input-event` only. Sized for
  high-frequency live input (≤120Hz `mouseMove` / `touchMove`); isolated so an
  input stream can't drain the `global` cap.

Each call uses only that named bucket key: a `POST /v1/sessions`
uses `sessions:create` (never `global`), and a
`POST /v1/agent-sessions/:id/message` uses
`agent_sessions:message`.

The account scope depends on who owns the resource:

- A self-scoped request consumes that bucket once for the caller.
- A per-session GUI control key consumes it once for the session owner, at the
  owner's own tier and active overrides — not a reduced desktop allowance. It
  draws on the **same bucket** as that account's API traffic, so a desktop
  Simulator left open (it polls page state roughly every 2s) and your SDK or
  dashboard calls share one budget. Size for the total, not for either alone.
- A **session or agent-session** request made with `X-Driftstack-Account`
  first consumes the actor's bucket, then consumes the **same bucket key and
  cost** for the selected owner. This keeps every member accountable for their
  own traffic while all members share the owner's session budget.

The second consume is scoped to the session and agent-session routes — the
resources that hold a live browser. Other endpoints that honour
`X-Driftstack-Account` (profiles, profile snapshots, webhooks, API keys, audit
log, email preferences, usage and billing) currently charge the acting member
only, so their owner-scoped reads and writes do not aggregate into one shared
budget.

The owner consume uses the owner's current tier and active staff override.
Authorization and role checks happen before the owner bucket is read.

## Per-tier defaults

| Tier            | global capacity | global refill (rps) | sessions:create capacity | sessions:create refill (rps) | agent_sessions:message capacity | agent_sessions:message refill (rps) | agent_sessions:input_event capacity | agent_sessions:input_event refill (rps) |
| --------------- | --------------- | ------------------- | ------------------------ | ---------------------------- | ------------------------------- | ----------------------------------- | ----------------------------------- | --------------------------------------- |
| `free`          | 60              | 1                   | 5                        | 1/60 (1 per minute)          | 20                              | 1/5 (12 per minute)                 | 240                                 | 60                                      |
| `solo_manual`   | 120             | 2                   | 10                       | 1/30 (2 per minute)          | 40                              | 1/3 (20 per minute)                 | 360                                 | 90                                      |
| `team_manual`   | 360             | 6                   | 20                       | 1/10 (6 per minute)          | 100                             | 1                                   | 480                                 | 120                                     |
| `agency_manual` | 1,800           | 30                  | 60                       | 1                            | 300                             | 3                                   | 600                                 | 150                                     |
| `api_starter`   | 240             | 4                   | 15                       | 1/20 (3 per minute)          | 60                              | 1/2 (30 per minute)                 | 360                                 | 90                                      |
| `api_builder`   | 1,800           | 30                  | 60                       | 1                            | 300                             | 3                                   | 600                                 | 150                                     |
| `api_scale`     | 6,000           | 100                 | 120                      | 2                            | 1,000                           | 10                                  | 1,200                               | 300                                     |
| `enterprise`    | 60,000          | 1,000               | 600                      | 10                           | 10,000                          | 100                                 | 12,000                              | 3,000                                   |

Capacity = max burst size before the next refill kicks in.
Refill = sustained rate (tokens per second). Effective sustained
RPS for a default-cost call is the `refill` column.

## What happens when you hit the cap

When the caller's actor bucket is exhausted, the API returns HTTP 429
with an RFC 9457 problem-details body
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
exponential backoff capped at 10s.

When a distinct selected owner's bucket is exhausted, the request also
returns 429, but the problem remains generic (`"Rate limit exceeded."`).
The generic body retains `retry_after_seconds`; among rate-limit headers,
only `Retry-After` remains. The owner's tier, capacity, remaining tokens,
override, and reset policy are not disclosed. The actor token was already
consumed and is not refunded.

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

The dashboard renders this data on
[app.driftstack.dev/usage](https://app.driftstack.dev/usage/) — the
"Rate limits" card lists each bucket's capacity, refill rate, and
source (tier default vs staff override, with the override's
auto-revert date). The endpoint remains available for SDK / `curl`
reads.

## Response headers

Allowed authenticated `/v1/*` responses and actor-bucket denials carry
four `x-ratelimit-*` headers reflecting the actor bucket:

| Header                  | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `x-ratelimit-bucket`    | Which bucket the call drained — see the bucket keys above.                  |
| `x-ratelimit-limit`     | Bucket capacity (matches the `capacity` row from the read endpoint).        |
| `x-ratelimit-remaining` | Tokens left in the bucket _after_ this call (integer, floor of fractional). |
| `x-ratelimit-reset`     | Unix-seconds timestamp when the bucket refills to full capacity.            |

For a distinct effective-owner denial, these policy headers are removed
to avoid disclosing another account's capacity. That response carries
`Retry-After` only. For an actor-bucket 429, retry loops can combine
`x-ratelimit-remaining=0` with `Retry-After` to drive a back-off.

The IETF draft-standard names are emitted alongside the `x-` set, for
gateways and generic client libraries that read the un-prefixed form:

| Header                | Meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `ratelimit-limit`     | Same value as `x-ratelimit-limit`.                                                  |
| `ratelimit-remaining` | Same value as `x-ratelimit-remaining`.                                              |
| `ratelimit-reset`     | Seconds **from now** until full refill (relative, per the draft — NOT a timestamp). |

On successful team requests, these values describe the actor bucket;
the selected owner's remaining budget is intentionally not exposed.

Note the one semantic difference: `ratelimit-reset` is relative
delta-seconds, while `x-ratelimit-reset` is an absolute unix-seconds
timestamp. Parse whichever form your tooling expects.

## Source of truth

The numbers above are mirrored from
`packages/api-types/src/common.ts:TIER_RATE_LIMIT_DEFAULTS` —
the API server reads from the same constant via
`bucketConfigFor()` in
`apps/server/src/services/rate-limit.ts`. Customer dashboard +
this docs page must agree with the server. If you spot a
discrepancy, file a bug at
[support@driftstack.dev](mailto:support@driftstack.dev).
