---
layout: ../../layouts/DocLayout.astro
title: Cost monitoring
description: Read your account's per-dimension spend (compute, storage, egress, email, LLM) for the current billing cycle, with threshold state.
---

# Cost monitoring

Every account accrues cost across five dimensions:

- **Compute** — session-minutes (the only metered dimension at
  v1.0; the rest are placeholders).
- **Storage** — recording bytes-month (active when R2 storage
  ships).
- **Egress** — bandwidth bytes (active when egress metering ships).
- **Email** — Postmark sends attributable to the account.
- **LLM** — Claude API calls (BYOK customers bill directly to
  Anthropic; bundled-LLM tier accrues here).

`GET /v1/account/cost` returns the current cycle's breakdown plus
a threshold state so customers can see whether they're approaching
their tier's soft / hard cap.

## Read your cost

`GET /v1/account/cost?billing_cycle=YYYY-MM`

```ts
// The typed SDK helper for this endpoint lands in V-541.E; until then
// call it directly with the same base URL + API key as the SDK client:
const res = await fetch(`${baseUrl}/v1/account/cost?billing_cycle=2026-05`, {
  headers: { authorization: `Bearer ${apiKey}` },
});
const cost = await res.json();
```

`billing_cycle` is optional; omitted requests use the current
cycle (UTC).

Returns:

```json
{
  "account_id": "acc_a1b2c3d4-...",
  "billing_cycle": "2026-05",
  "tier": "api_builder",
  "breakdown": {
    "computeCents": 4720,
    "storageCents": 0,
    "egressCents": 0,
    "emailCents": 12,
    "llmCents": 0,
    "totalCents": 4732,
    "thresholdState": "between-soft-and-hard"
  }
}
```

`account_id` carries the canonical `acc_` prefix, matching the
`id` returned by `GET /v1/account/me` — the two are directly
string-comparable.

All amounts are in USD cents. `totalCents` is the sum of the
five dimensions; rounding is per-dimension (the cost engine rounds
each dimension to the nearest cent via `Math.round`, then sums the
already-rounded integer cents).

### Threshold state

`breakdown.thresholdState` is one of three values relative to
your tier's per-cycle soft warn / hard cap:

| State                   | Meaning                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `under-soft`            | Spend below the soft-warn threshold. Default.                         |
| `between-soft-and-hard` | Spend ≥ soft-warn, < hard cap. We'll email you when this transitions. |
| `over-hard`             | Spend ≥ hard cap. New sessions may be rate-limited.                   |

The actual soft/hard cents values are tier-tuned + operator-
adjustable. The customer surface intentionally hides the numeric
caps (they're operator-only); you see your actual spend + a
qualitative state, not the threshold values.

## Empty-state response

For a fresh account with no usage in the cycle, the response
synthesizes a zero breakdown instead of 404:

```json
{
  "account_id": "acc_<uuid>",
  "billing_cycle": "2026-05",
  "tier": "solo_manual",
  "breakdown": {
    "computeCents": 0,
    "storageCents": 0,
    "egressCents": 0,
    "emailCents": 0,
    "llmCents": 0,
    "totalCents": 0,
    "thresholdState": "under-soft"
  }
}
```

This makes the customer dashboard's `/usage` page rendering
trivial — you can always destructure `breakdown.*` without an
existence check.

## When do dimensions populate?

- **Compute** populates from session completion. Each
  `session.completed` webhook event corresponds to a
  `compute_cents` row in the usage ledger.
- **Email** populates from outbound Postmark sends.
- **Storage**, **egress**, **llm** dimensions currently return
  zero placeholders. They activate once the underlying
  per-account meters land (V-541.I/J/K follow-ups).

`breakdown.totalCents` always sums the live dimensions; it's
safe to use as your customer-facing "this cycle" amount even
during the placeholder period.

## Rate limits

Standard `'global'` bucket. Polling every minute is fine; polling
faster than every 10s on a free tier may hit the bucket.
