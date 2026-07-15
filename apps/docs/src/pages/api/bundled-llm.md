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

Activation: the settings + status routes are always registered (the
bootstrap wires a `BundledLlmService` by default), so they don't
return a `503` stub. Consent and budget enforcement surface as `402`
at agent-session turn time (see below); any `503` you encounter is
likewise returned on the agent-session turn route, not on these
settings/status reads.

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
  "cap_cents": 2000,
  "used_this_month_cents": 450,
  "remaining_cents": 1550,
  "refused_count_this_month": 0,
  "month_started_at": "2026-05-01T00:00:00.000Z"
}
```

Note the status record names the cap `cap_cents` (the settings
record uses `monthly_cap_usd_cents` — same value, different field
name per surface). `remaining_cents` is `max(0, cap_cents −
used_this_month_cents)`. `month_started_at` is the UTC
calendar-month boundary so the dashboard can render "resets on
&lt;date&gt;" without re-deriving it.

`used_this_month_cents` sums `usage_records.cost_usd_cents` over
the rows where `record_type = 'agent_decomposer_bundled'` and
`recorded_at >= start_of_calendar_month` (UTC).

`refused_count_this_month` is a compatibility field and returns `0`.
Refusal events (`402 BundledLlmBudgetExhausted`) are not persisted as
usage rows. Branch on `remaining_cents <= 0` to drive a "you've hit the
cap" / "raise your cap" CTA; that field is derived from real spend.

## Get current settings

`GET /v1/account/me/bundled-llm-settings`

Returns the settings record. Defaults to
`{ consent: false, monthly_cap_usd_cents: 2000 }` for accounts
that have never PATCHed.

Requires broad `read` (or `account_owner`). Resource-granular,
write-only, and zero-scope keys cannot inspect billing consent or cap.

## Get current status (settings + spend)

`GET /v1/account/me/bundled-llm-status`

Returns the status record above. The dashboard's
`BundledLlmStatusPanel` reads this on page-load to render consent,
cap, used spend, and remaining budget.

Requires the same broad `read` scope because the response includes
account-wide month-to-date spend and remaining budget.

## Update settings (PATCH)

`PATCH /v1/account/me/bundled-llm-settings`

The same controls are live in the desktop app under **Settings → AI
& billing**. The desktop form and this endpoint update the same
consent and monthly-cap record.

Partial update — either field may be omitted, but at least one of
`consent` / `monthly_cap_usd_cents` must be present. An empty body
is rejected with `400` (it carries no change to apply).

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

> **Tier availability.** Opting **in** (`consent: true`) requires a
> tier that offers bundled-LLM billing: API Builder, API Scale, or
> Enterprise. On BYOK-only tiers (Team, Agency, API Starter) — and
> on tiers without the AI agent at all — the opt-in is refused with
> a 403 `forbidden` tier error. Opting **out** (`consent: false`)
> and cap-only updates are accepted on every tier, so a downgraded
> account can always switch bundled billing off. BYOK key management
> (`/v1/account/me/byok-anthropic`) is not tier-gated beyond the
> AI-agent tiers themselves.

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

| Status | Type                         | When                                                                      |
| -----: | ---------------------------- | ------------------------------------------------------------------------- |
|    400 | validation                   | body fails schema (negative cap, > 1_000_000 cap)                         |
|    401 | unauthorized                 | missing or invalid bearer token                                           |
|    403 | forbidden                    | `consent: true` on a tier without bundled-LLM billing (below API Builder) |
|    402 | bundled-llm-budget-exhausted | spend reached the cap; recover via PATCH / BYOK / next month              |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but the customer hasn't opted in               |

The settings + status routes above do not return a `503`. A `503`
for an unwired bundled-LLM service is returned on the **agent-session
turn** route, not on these reads.

## Privacy + billing

- Bundled-LLM costs are billed alongside the customer's tier
  subscription. Standard API Builder and API Scale usage posts a
  flat **$0.10 per agent turn**, independent of model choice and
  token count; Enterprise can use a contracted custom rate. The
  recorder stores the posted per-call amount in cents with
  `cost_basis = 'bundled_flat_per_turn'` for auditability. It does
  not expose Driftstack's upstream provider cost.
- No prompt content is logged on Driftstack's side beyond what
  customers can read in their own session transcripts.
- Bundled-LLM consent does NOT grant Driftstack any rights to
  train models on customer prompts. The current bundled-LLM
  provider is Anthropic Claude; per their API terms, customer
  data is not used for training.
