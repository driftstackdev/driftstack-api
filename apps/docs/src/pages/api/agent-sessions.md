---
layout: ../../layouts/DocLayout.astro
title: Agent sessions
description: AI-driven + manual + pair-mode browser automation — decompose natural-language intent into structured intents, take over interactively, or drive raw intents directly.
---

# Agent sessions

An **agent session** layers a chat-style decompose→execute loop on
top of a regular driver-backed browser session. The customer sends
natural-language messages (`"open https://example.com and capture a
screenshot"`); the server's decomposer translates that into typed
intents (`navigate`, `interact`, `wait`, `capture`); the runtime
executes them; results stream back in the response.

Three operational modes:

- `ai` (default) — every customer message goes through the
  decomposer + executor. Closed sessions return 409.
- `manual` — `message` is a transcript-only pass-through. The
  customer's gui-client drives the real actions via the
  gui_control plane (a separate per-session HMAC channel).
- `pair` — interactive takeover state machine. AI drives by
  default; the customer can call `takeover` to seize control,
  then `handback` to return control to AI. State transitions are
  audit-logged.

## Resource shape

```json
{
  "id": "agt_<uuid>",
  "account_id": "<account-uuid>",
  "driftstack_session_id": "ses_<uuid> | null",
  "status": "active | paused | closed",
  "closed_reason": "<string> | null",
  "closed_at": "<ISO-8601> | null",
  "token_budget_total": 100000,
  "token_budget_remaining": 99500,
  "transcript_length": 12,
  "created_by_user_id": "<user-uuid> | null",
  "mode": "ai | manual | pair",
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>"
}
```

## Create

`POST /v1/agent-sessions`

Request body (all fields optional):

```json
{
  "mode": "ai | manual | pair",
  "driftstack_session_id": "ses_<uuid>",
  "token_budget": 100000
}
```

Headers:

- `Idempotency-Key: <string>` (optional, Stripe-pattern) — retries
  with the same key replay the original 201 instead of minting a
  duplicate row.

Response `201 Created` returns the resource above.

If `mode` is omitted the server defaults to `ai`. `token_budget`
defaults to the deployment-configured value (typically 100,000
tokens). The optional `driftstack_session_id` ties the agent
session to a pre-existing driver session; without it the runtime
spawns one on the first executed intent.

## Get

`GET /v1/agent-sessions/{id}`

Returns the resource above. Cross-account lookups return 404 (no
existence disclosure).

## Message

`POST /v1/agent-sessions/{id}/message`

Run one decompose→execute turn (or, in `manual` mode, log the
message and return without executing).

Request body:

```json
{ "user_message": "open https://example.com and capture a screenshot" }
```

Headers:

- `x-byok-anthropic-api-key: sk-ant-...` (optional) — supply a
  per-request BYOK key that overrides any account-stored key for
  this turn. Useful for users who don't want to persist a key but
  do want each request authenticated against their own Anthropic
  account. Never logged.

Response (200) is a discriminated union by `kind`:

```json
// "plan-executed"
{
  "kind": "plan-executed",
  "session": { ...AgentSession },
  "intents": [ { "kind": "navigate", "url": "https://example.com" } ],
  "results": [
    { "kind": "success", "intent": { ... }, "summary": "navigated", "captureId": "cap_..." }
  ],
  "ok": true
}

// "clarify" — decomposer needs more info
{
  "kind": "clarify",
  "session": { ...AgentSession },
  "clarifying_question": "Which page should I capture — the home page or the pricing page?"
}

// "refuse" — decomposer judged the request out of scope / unsafe
{
  "kind": "refuse",
  "session": { ...AgentSession },
  "refuse_reason": "This site's terms of service explicitly forbid automated scraping."
}

// "logged-manual" — mode='manual' pass-through; no decompose, no execute
{
  "kind": "logged-manual",
  "session": { ...AgentSession }
}
```

Closed sessions return `409 Conflict`. Sessions whose
`token_budget_remaining` is below the per-turn floor return
`402 Payment Required` (BundledLlmBudgetExhausted) when the
customer is on the bundled-LLM rail.

## Close

`DELETE /v1/agent-sessions/{id}`

Sets `status='closed'` with `closed_at` stamped. Idempotent.

## Live transcript stream (SSE)

`GET /v1/agent-sessions/{id}/transcript`

Server-Sent Events stream that publishes every transcript append
in real time. Customers building their own UIs (dashboard,
desktop apps) can subscribe instead of polling.

Auth: bearer token via `Authorization: Bearer <token>` header
OR `?ds_token=<token>` query-string fallback (`EventSource` API
in browsers doesn't support custom headers; the query-string
fallback exists for that use case).

Event types emitted:

- `transcript.entry` — fires for each transcript append. The
  `id:` SSE field is the entry's monotonic index; the `data:`
  field is JSON with `{ index, entry }` where `entry` has the
  same shape as the elements of `Session.transcript` (role +
  body + at + optional `intents` for plan-executed agent turns).

Resume semantics (RFC 6202 + EventSource spec):

- The client's last received id is sent back as
  `Last-Event-ID: <n>` header on reconnect. The server replays
  every transcript entry with index > n, then live-streams new
  appends.
- The replay is exclusive (strictly greater than the supplied
  index) so a resumed subscriber doesn't see duplicate events.

Heartbeat: server sends a `: stream open` comment on connect.
Browsers' EventSource auto-reconnect on disconnect uses
`Last-Event-ID` for resume, so a transient network blip doesn't
lose any transcript content as long as the customer's auth
token is still valid.

Example (TypeScript browser):

```ts
const url = new URL(`/v1/agent-sessions/${id}/transcript`, 'https://api.driftstack.dev');
url.searchParams.set('ds_token', token);
const stream = new EventSource(url.toString());
stream.addEventListener('transcript.entry', (ev) => {
  const { index, entry } = JSON.parse(ev.data);
  console.log(`[${index}] ${entry.role}: ${entry.body}`);
});
stream.addEventListener('error', () => {
  // Browser auto-reconnects with Last-Event-ID.
});
```

Closing the EventSource on `beforeunload` is the customer's
responsibility — the server doesn't enforce a max-subscribers
limit per session, but each subscriber consumes a long-lived
TCP connection.

## Pair-mode takeover + handback

For `mode: 'pair'` sessions only — these endpoints return 409 on
non-pair sessions.

### Request takeover

`POST /v1/agent-sessions/{id}/takeover`

```json
{ "client_id": "<your-internal-client-id>" }
```

State machine: `ai-driving → takeover-pending`, or
`takeover-queued` if the runtime is mid-decompose (the queued
takeover promotes to `takeover-pending` when the in-flight turn
settles).

Response (200):

```json
{
  "pair_mode_state": {
    "kind": "takeover-pending",
    "requestedByClientId": "<your-client-id>",
    "requestedAt": "<ISO-8601>"
  }
}
```

A second concurrent takeover from a different client returns
`409 PairModeStateInvalidTransitionError` with `from` +
`transition` extension fields naming the conflict precisely.

### Request handback

`POST /v1/agent-sessions/{id}/handback`

Body: `{}` (empty).

State machine: `human-driving → handback-pending`, or
`handback-queued` if mid-decompose.

Response (200):

```json
{ "pair_mode_state": { "kind": "handback-pending", "requestedAt": "<ISO-8601>" } }
```

### Heartbeat-timeout auto-handback

If a `human-driving` session goes 30s without a client heartbeat,
the harness auto-handbacks the session to `ai-driving`. The
transition emits an `agent_session.pair_mode.timeout` audit row.

## Audit log

Three actions land on the customer audit log per pair-mode
transition (see [Audit log](/api/audit-log/)):

- `agent_session.pair_mode.takeover` (customer-initiated)
- `agent_session.pair_mode.handback` (customer-initiated)
- `agent_session.pair_mode.timeout` (system-emitted on
  heartbeat-timeout sweeps)

Payload carries `{ from, to, client_id? }` for downstream
reconstruction of the state-machine history. Filter via
`GET /v1/account/audit-log?action=agent_session.pair_mode.takeover`.

## Errors

| Status | Type                         | When                                                                 |
| -----: | ---------------------------- | -------------------------------------------------------------------- |
|    400 | validation                   | body fails schema (missing `user_message`, etc.)                     |
|    404 | not-found                    | session id unknown to the calling account                            |
|    409 | conflict                     | mode mismatch (e.g. takeover on `mode: 'ai'`)                        |
|    409 | pair-mode-invalid-transition | state-machine refused the transition (carries `from` + `transition`) |
|    402 | bundled-llm-budget-exhausted | bundled-LLM monthly cap reached                                      |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but customer hasn't opted in              |
|    502 | byok-anthropic-required      | no BYOK + no consent + no fallback                                   |
|    503 | feature-unavailable          | deployment activation gate is off (no LLM key path wired)            |

The pair-mode state-machine transition errors are typed in all
three SDKs: `PairModeStateInvalidTransitionError`. Branch on
the `from` + `transition` fields to recover (e.g. wait for the
queued transition to settle before retrying).
