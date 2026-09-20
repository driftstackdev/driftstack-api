---
layout: ../../layouts/DocLayout.astro
title: Bundled LLM
description: Run agent sessions on Driftstack's bundled AI model — opt-in consent, monthly soft cap, used / remaining budget.
---

# Bundled LLM

Driftstack's **bundled LLM** option lets customers run AI-driven
[agent sessions](/api/agent-sessions/) without their own Anthropic
API key. Each agent turn counts a fixed amount against a monthly cap
the customer controls (default $20).

Opt-in is explicit (`consent: true`) and revocable; the soft cap is
customer-configurable up to a $100/month ceiling. If the customer
has a [BYOK](/api/byok-anthropic/) key (per-request header or stored),
it is used instead of the bundled LLM.

The settings and status endpoints are always available. Consent and
budget enforcement surface as typed `402` responses at agent-session
turn time (see below). If bundled AI is not available, a turn with no
key of your own returns `502 byok-anthropic-required`; the settings and
status reads stay available.

Bundled billing is offered on API Builder, API Scale and Enterprise. Team,
Agency and API Starter run the AI agent with your own Anthropic key only.

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

`used_this_month_cents` is the account's total bundled-LLM spend, in
cents, on agent-session turns since the start of the current UTC
calendar month (`month_started_at`).

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

Returns the status record above. The dashboard reads this on page
load to render consent, cap, used spend, and remaining budget.

Requires the same broad `read` scope because the response includes
account-wide month-to-date spend and remaining budget.

## Update settings (PATCH)

`PATCH /v1/account/me/bundled-llm-settings`

Requires `account_owner` — a broad `read` + `write` key cannot change
consent or the cap.

The same controls are live in the desktop app under **Settings → AI
& billing** and in the dashboard's Settings page. The desktop form, the
dashboard and this endpoint all update the same consent and monthly-cap
record.

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
- `monthly_cap_usd_cents` — integer; 0 to 10,000 ($100 ceiling).
  Negative values rejected with `400`. A cap set above $100 before
  2026-09-19 (the earlier ceiling was 1,000,000 cents, $10,000) is kept:
  it is still enforced and returned, and sending that same value back
  (for example when saving the whole settings form) is accepted. It can
  also be lowered to any smaller value, even one still above 10,000, and
  the lowered value then becomes the most it can be. It can never be
  raised: any other value above 10,000 is rejected with `400`.

> **Tier availability.** Opting **in** (`consent: true`) requires a
> tier that offers bundled-LLM access: API Builder, API Scale, or
> Enterprise. On BYOK-only tiers (Team, Agency, API Starter) — and
> on tiers without the AI agent at all — the opt-in is refused with
> a 403 `forbidden` tier error. Opting **out** (`consent: false`)
> and cap-only updates are accepted on every tier, so a downgraded
> account can always switch bundled access off. BYOK key management
> (`/v1/account/me/byok-anthropic-key`) is not tier-gated beyond the
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
  "detail": "You've used $20.00 of your $20.00 monthly bundled-LLM budget. Raise the cap via PATCH /v1/account/me/bundled-llm-settings, supply your own Anthropic API key via PUT /v1/account/me/byok-anthropic-key, or wait for the next calendar month.",
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

When the deployment offers bundled-LLM but the customer hasn't
opted in (`consent: false`), the agent session route refuses with:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/problem+json

{
  "type": "https://errors.driftstack.dev/bundled-llm-consent-required",
  "title": "Bundled-LLM consent required",
  "status": 402,
  "detail": "This deployment offers bundled-LLM but your account has not opted in. PATCH /v1/account/me/bundled-llm-settings with { \"consent\": true } to enable, or PUT /v1/account/me/byok-anthropic-key to bring your own Anthropic key (BYOK always wins)."
}
```

The SDK exposes the typed `BundledLlmConsentRequiredError` (no
extension fields).

On plans without bundled billing (Team, Agency, API Starter) this error does
not mean "opt in": opting in is refused on those plans. Add your own key
instead — `PUT /v1/account/me/byok-anthropic-key`, or the
`x-byok-anthropic-api-key` header on each message.

When consent is on but the account's current plan no longer includes
bundled billing (after a downgrade, for example), the turn returns
`403 forbidden` instead, asking you to upgrade or add your own key.

Branch on the problem `type`, not on the `detail` text: the detail is written
for people and can change.

## Models on bundled billing

Bundled billing runs the default model, Claude Sonnet 5, and the other
non-Opus models in the picker. **Claude Opus models are available with
your own Anthropic key only.** When a session would run an Opus model on
bundled billing — because the account has no key of its own — the
request is refused with a `403`:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{
  "type": "https://errors.driftstack.dev/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "Claude Opus 5 is available with your own Anthropic key. Add your key (PUT /v1/account/me/byok-anthropic-key, or the x-byok-anthropic-api-key header), or start a session with Claude Sonnet 5.",
  "requires_own_key": true,
  "model": "claude-opus-5"
}
```

This is checked when the session is created (for an account with no key
of its own and bundled billing on) and again on every turn, because a
session created with your own key moves to bundled billing if that key is
removed or expires. A session using your own key keeps every model.

In the SDKs this is a `ForbiddenError`; read the flag from
`err.extensions.requires_own_key` (TypeScript),
`err.problem["requires_own_key"]` (Python) or
`Problem["requires_own_key"]` (Go).

## Errors

| Status | Type                         | When                                                                                |
| -----: | ---------------------------- | ----------------------------------------------------------------------------------- |
|    400 | validation-failed            | body fails schema (negative cap), or a cap above 10,000 higher than the current one |
|    401 | unauthorized                 | missing or invalid bearer token                                                     |
|    403 | forbidden                    | `consent: true` on a tier without bundled-LLM access (below API Builder)            |
|    403 | forbidden                    | an Opus model on bundled billing (agent-session create or turn)                     |
|    402 | bundled-llm-budget-exhausted | spend reached the cap; recover via PATCH / BYOK / next month                        |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but the customer hasn't opted in                         |

The settings + status routes above do not return a `503`. When
bundled-LLM is not available on the deployment, the agent-session turn
route returns `502 byok-anthropic-required` for a turn with no key of your
own; these reads keep working.

Agent-session turns on bundled billing can also return `403 forbidden` (the
plan no longer includes bundled billing) and `429 rate-limited` with
`retry_after_seconds: 5` (your account already has 3 turns running on bundled
billing). No step ran, so wait for one to finish and send the same message
again, [`Idempotency-Key`](/reference/idempotency/) and all. See
[Agent sessions — Errors](/api/agent-sessions/#errors).

## Privacy + how turns are counted

- On API Builder and API Scale, each agent turn counts a flat
  **$0.10** against the customer-controlled monthly budget, whatever
  the model or token count. This budget is enforced by Driftstack but
  is not a separately itemized charge on your Stripe invoice today;
  Enterprise can use a contracted custom budget. The amount counted
  against the budget per turn is this flat value, not Driftstack's actual provider cost.
- No prompt content is logged on Driftstack's side beyond what
  customers can read in their own session transcripts.
- Bundled-LLM consent does NOT grant Driftstack any rights to
  train models on customer prompts. The current bundled-LLM
  provider is Anthropic Claude; per their API terms, customer
  data is not used for training.
