---
layout: ../../layouts/DocLayout.astro
title: Operational cost estimate
description: Read Driftstack's estimated cost to serve your account for a UTC month. This is operational telemetry, not your invoice.
---

# Operational cost estimate

Driftstack browser subscriptions are fixed-price and enforced by
concurrent-session capacity. Session hours, API calls, and page
navigations do not create browser-usage overages.

`GET /v1/account/cost` exposes a UTC-calendar-month estimate of
Driftstack's operational cost to serve the calling account. It is not
the amount charged to you, a Stripe invoice, or a NowPayments receipt.

The response keeps five stable component fields:

- **Compute** — populated from lifecycle-derived session minutes and
  Driftstack's internal fleet-cost rate. Session minutes remain
  analytics/unit-economics input; `quotas.session_minute` is `null` on
  every tier.
- **Storage**, **egress**, **email**, and **LLM** — reserved fields that
  currently return zero because production has no per-account meters
  feeding them.

Bundled LLM has a separate settings/status endpoint. Its 10-cent-per-turn
value is an included-service monthly budget guardrail today; it is not
included in this estimate or separately itemized by Stripe.

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
for its included-service budget.

### Operator threshold state

`breakdown.thresholdState` compares the operational estimate with
operator-tuned unit-economics thresholds:

| State                   | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `under-soft`            | Estimate is below the operator warning threshold.         |
| `between-soft-and-hard` | Estimate crossed the operator warning threshold.          |
| `over-hard`             | Estimate crossed the higher operator attention threshold. |

This state is not a customer spending cap. Crossing it does not add an
invoice item, email a customer billing warning, rate-limit a new
session, or stop work already running. The platform records an operator
alert and can publish an in-app account notification. Numeric threshold
values remain operator-only and are not included in this response.

## Empty-state response

For a fresh account with no lifecycle-derived session minutes in the
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
