---
layout: ../../layouts/DocLayout.astro
title: Bundled LLM
description: Customer-facing API for the bundled-LLM agent layer — opt-in consent, monthly soft cap, used / remaining / refused state.
---

# Bundled LLM

Driftstack's **bundled LLM** rail lets customers run AI-driven
[agent sessions](/api/agent-sessions/) without supplying their own
Anthropic API key. Driftstack hosts the decomposer + bills usage
against a customer-controlled monthly soft cap (default $20).

Opt-in is explicit (`consent: true`) and revocable; the soft cap is
customer-configurable up to a $10,000/month ceiling. The agent
session route's resolution chain prefers [BYOK](/api/byok-anthropic/)
(per-request header or stored) over bundled-LLM — bundled-LLM is
the no-BYOK fallback.

Activation: routes return `503 FeatureUnavailable` when the
deployment hasn't wired a `BundledLlmService` (typical pre-launch
state). When wired, all customer accounts can opt in.

## Resource shape

The bundled-LLM settings record:

```json
{
  "consent": true,
  "monthly_cap_usd_cents": 2000
}
```

The bundled-LLM status record (settings + month-to-date spend):

```json
{
  "consent": true,
  "monthly_cap_usd_cents": 2000,
  "used_this_month_cents": 450,
  "remaining_this_month_cents": 1550,
  "refused_count_this_month": 0
}
```

`used_this_month_cents` sums `usage_records.cost_usd_cents` over
the rows where `record_type = 'agent_decomposer_bundled'` and
`recorded_at >= start_of_calendar_month` (UTC).

`refused_count_this_month` is the number of times the route
returned `402 BundledLlmBudgetExhausted` this month — useful for
the dashboard to surface "raise your cap" CTAs when it grows.

## Get current settings

`GET /v1/account/me/bundled-llm-settings`

Returns the settings record. Defaults to
`{ consent: false, monthly_cap_usd_cents: 2000 }` for accounts
that have never PATCHed.

## Get current status (settings + spend)

`GET /v1/account/me/bundled-llm-status`

Returns the status record above. The dashboard's
`BundledLlmStatusPanel` reads this on page-load to render consent

- cap + used.

## Update settings (PATCH)

`PATCH /v1/account/me/bundled-llm-settings`

Partial update — either field may be omitted. When both omitted,
the response is a no-op (returns the current state).

Request body:

```json
{
  "consent": true,
  "monthly_cap_usd_cents": 5000
}
```

Constraints:

- `consent` — boolean.
- `monthly_cap_usd_cents` — integer; 0 to 1,000,000 ($10,000 ceiling).
  Negative values rejected with `400`.

Response (200) is the post-update settings record:

```json
{
  "consent": true,
  "monthly_cap_usd_cents": 5000
}
```

## Soft-cap enforcement

When the customer's bundled-LLM spend reaches the cap, the agent
session route refuses the turn with:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/problem+json

{
  "type": "https://errors.driftstack.dev/bundled-llm-budget-exhausted",
  "title": "Bundled-LLM monthly cap reached",
  "status": 402,
  "detail": "Spend this month has reached the configured cap.",
  "spent_cents": 2000,
  "cap_cents": 2000
}
```

Recovery paths surfaced in the problem-detail string:

1. Raise the cap via `PATCH /v1/account/me/bundled-llm-settings`
2. Supply a BYOK key via the `x-byok-anthropic-api-key` header or
   `PUT /v1/account/me/byok-anthropic-key`
3. Wait for the next calendar month

The SDK exposes the typed `BundledLlmBudgetExhaustedError` with
`.spent_cents` / `.cap_cents` extension fields (Python:
`spent_cents` / `cap_cents`; TS: `spentCents` / `capCents`; Go:
`SpentCents` / `CapCents`).

## Consent-required gate

When the deployment has bundled-LLM wired but the customer hasn't
opted in (`consent: false`), the agent session route refuses with:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/problem+json

{
  "type": "https://errors.driftstack.dev/bundled-llm-consent-required",
  "title": "Bundled-LLM consent required",
  "status": 402,
  "detail": "Opt in via PATCH /v1/account/me/bundled-llm-settings."
}
```

The SDK exposes the typed `BundledLlmConsentRequiredError` (no
extension fields).

## Errors

| Status | Type                         | When                                                                   |
| -----: | ---------------------------- | ---------------------------------------------------------------------- |
|    400 | validation                   | body fails schema (negative cap, > 1_000_000 cap)                      |
|    401 | unauthorized                 | missing or invalid bearer token                                        |
|    402 | bundled-llm-budget-exhausted | spend reached the cap; recover via PATCH / BYOK / next month           |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but the customer hasn't opted in            |
|    503 | feature-unavailable          | deployment hasn't wired BundledLlmService (typical pre-launch posture) |

## Privacy + billing

- Bundled-LLM costs are billed alongside the customer's tier
  subscription. Cost-per-turn varies with the underlying model;
  the recorder tracks per-call usage in cents for auditability.
- No prompt content is logged on Driftstack's side beyond what
  customers can read in their own session transcripts.
- Bundled-LLM consent does NOT grant Driftstack any rights to
  train models on customer prompts. The current bundled-LLM
  provider is Anthropic Claude; per their API terms, customer
  data is not used for training.
