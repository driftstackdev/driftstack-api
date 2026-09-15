---
layout: ../../layouts/DocLayout.astro
title: Operational cost estimate
description: Read Driftstack's estimated cost to serve your account for a UTC month. This is an internal estimate, not your invoice.
---

# Operational cost estimate

Driftstack browser subscriptions are fixed-price and enforced by
concurrent-session capacity. Session hours, API calls, and page
navigations do not create browser-usage overages.

`GET /v1/account/cost` exposes a UTC-calendar-month estimate of
Driftstack's operational cost to serve the calling account. It is not
the amount charged to you, a Stripe invoice, or a NowPayments receipt.

The response keeps five stable component fields:

- **Compute** — populated from session minutes and Driftstack's
  internal per-minute cost rate. Session minutes are not billed;
  `quotas.session_minute` is `null` on every tier.
- **Storage**, **egress**, **email**, and **LLM** — reserved fields that
  currently return zero; they are not measured per account yet.

Bundled LLM has a separate settings/status endpoint. Its 10 cents per
turn counts against your bundled-LLM monthly budget; it is not included
in this estimate or separately itemized on your Stripe invoice.

## Read the estimate

`GET /v1/account/cost?billing_cycle=YYYY-MM`

```ts
// Call the endpoint with the same base URL + API key as the SDK client:
const res = await fetch(`${baseUrl}/v1/account/cost?billing_cycle=2026-05`, {
  headers: { authorization: `Bearer ${apiKey}` },
});
const estimate = await res.json();
```

`billing_cycle` is optional; omitted requests use the current UTC
calendar month.

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
    "emailCents": 0,
    "llmCents": 0,
    "totalCents": 4720,
    "thresholdState": "between-soft-and-hard"
  }
}
```

`account_id` carries the canonical `acc_` prefix, matching the `id`
returned by `GET /v1/account/me`.

All amounts are integer accounting cents. `totalCents` is the sum of
the five response fields; because only compute is populated today, it
currently equals `computeCents`. Do not use it as an invoice total.
Use [billing state](/api/billing/) and Stripe-issued invoices, or the
relevant NowPayments receipt, for payment truth. Read the separate
[bundled-LLM status](/api/bundled-llm/#get-current-status-settings--spend)
for its monthly budget.

### Threshold state

`breakdown.thresholdState` compares the estimate with thresholds
Driftstack sets:

| State                   | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `under-soft`            | Estimate is below Driftstack's warning threshold.         |
| `between-soft-and-hard` | Estimate crossed Driftstack's warning threshold.          |
| `over-hard`             | Estimate crossed Driftstack's higher attention threshold. |

This state is not a customer spending cap. Crossing it does not add an
invoice item, email a customer billing warning, rate-limit a new
session, or stop work already running. Driftstack records an internal
alert and can publish an in-app account notification. The numeric
threshold values are not included in this response.

## Empty-state response

For a fresh account with no session minutes in the
selected month, the endpoint returns `200` with a zero breakdown rather
than `404`:

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

## Rate limits

Standard `global` bucket. Polling every minute is sufficient; polling
faster than every 10 seconds on the free tier may hit the bucket.
