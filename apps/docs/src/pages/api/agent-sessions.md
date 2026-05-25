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
  "account_id": "<uuid>",
  "driftstack_session_id": "<uuid> | null",
  "status": "active | paused | closed",
  "closed_reason": "<string> | null",
  "closed_at": "<ISO-8601> | null",
  "token_budget_total": 100000,
  "token_budget_remaining": 99500,
  "transcript_length": 12,
  "created_by_user_id": "<user-uuid> | null",
  "mode": "ai | manual | pair",
  "pair_mode_state": "{ \"kind\": ... } | null",
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "livekit": {
    "ws_url": "wss://mac-NNN.driftstack.dev:8443",
    "room": "agt_<uuid>",
    "token": "<HS256 JWT>",
    "participant_identity": "customer-<account-uuid>",
    "expires_at": "<ISO-8601>"
  }
}
```

The `livekit` field is **optional** — auto-populated on the
session-create response when the deployment has at least
one Mac with registered LiveKit credentials, and absent otherwise
(pre-LK deployment, OR no Mac has called
`POST /v1/mac-nodes/register` yet). Clients that need a token in
the absent case use the explicit endpoint at
[Live video (LiveKit)](#live-video-livekit) below.

> **ID-format note.** The agent-sessions resource emits
> `account_id` and `driftstack_session_id` as **bare UUIDs** (no
> `acc_` / `ses_` prefix), unlike `GET /v1/account/me` and
> `GET /v1/account/audit-log` which emit `acc_<uuid>`, and the
> `GET /v1/sessions/:id` resource which emits prefixed `ses_/acc_/
key_` IDs. Customer code comparing `agentSession.account_id`
> against `accountMe.id` must strip the `acc_` prefix from the
> latter first. (The session's own `id` field IS prefixed —
> `agt_<uuid>` — because the agent-session row id is minted with
> the prefix baked in.)

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

## Live video (LiveKit)

`POST /v1/agent-sessions/{id}/livekit-token`

Mint a per-Mac LiveKit JWT for a WebRTC consumer (the customer
dashboard, the desktop GUI client, or any other LiveKit-aware
SDK) to subscribe to the room hosting this session's video
stream. Each Mac in the fleet runs its own LiveKit server; the
server-side mint path looks up the assigned Mac's credentials,
signs a JWT scoped to the session id, and returns the join info.

Response (`200`):

```json
{
  "ws_url": "wss://mac-NNN.driftstack.dev:8443",
  "room": "agt_<uuid>",
  "token": "<HS256 JWT>",
  "participant_identity": "customer-<account-uuid>",
  "expires_at": "<ISO-8601>"
}
```

Token TTL is **24 hours** (matches the `gui_control_key` TTL).
The room name is always the agent session id; the participant
identity is `customer-<account-uuid>` so the SFU deduplicates
joins from the same account.

Customer-side grants on the minted token:

- `canSubscribe: true` — receive the published video stream
- `canPublish: false` — the Mac-side capture process is the
  publisher; the customer is subscriber-only
- `canPublishData: true` (implicit in the room join grant) —
  used for the `gui-client` input-forwarding DataChannel

> **Auto-populated on session-create.** When the deployment has at
> least one Mac with registered LiveKit credentials, `POST
/v1/agent-sessions` returns the same `livekit` shape inline on
> the 201 response. Clients can connect to the room immediately
> after create without the explicit round-trip to this endpoint.
> Pre-LK deployments (no Mac registered) ship the create response
> without the `livekit` field; the explicit endpoint is the
> fallback.

Errors:

| Status | Type                | When                                                             |
| -----: | ------------------- | ---------------------------------------------------------------- |
|    404 | not-found           | session id unknown OR caller doesn't own it (anti-enumeration)   |
|    403 | forbidden           | session is closed (cannot mint a token for a non-active session) |
|    503 | feature-unavailable | no Mac has registered LiveKit credentials yet                    |
|    503 | feature-unavailable | stored Mac secret is unreadable (ops-actionable; rotate key)     |

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
  same shape as the elements of `AgentSession.transcript`:
  - `role` — one of `'user'` (customer-supplied message), `'agent'`
    (decomposer output: plan-executed, clarify, or refuse), or
    `'operator'` (manual-mode pass-through — the customer's
    own UI/script logging directly without invoking the
    decomposer; Arc 2 sub-slice 8.6).
  - `body` — free-text for user / operator turns; serialised
    `DecomposeResult` JSON for agent turns.
  - `at` — ISO 8601 timestamp.
  - `intents?` — present only on `role: 'agent'` + plan-executed
    turns; carries the structured intent list the runtime
    executed (the [recipes route](/api/recipes/) flatMaps these
    into `intent_log` snapshots — see the recipe docs for how a
    snapshotted intent_log replays without re-running the
    decomposer).

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

## Set mode

`POST /v1/agent-sessions/{id}/mode`

```json
{ "mode": "manual" }
```

The top-level operational-mode setter — distinct from the
pair-mode takeover/handback flow below. Use this to switch a
session between `manual` / `ai` / `pair`. Transitioning INTO
`pair` initializes `pair_mode_state` to `{kind: "ai-driving"}`;
transitioning OUT clears it. Idempotent — a no-op transition
returns the existing row with `pair_mode_state` preserved.

Response (200): the full `AgentSession` shape (see
[Resource shape](#resource-shape) above).

Errors:

- `409 conflict` — session is not `active` (closed/paused sessions
  reject the transition).
- `400 validation-failed` — body `mode` isn't one of `'manual' |
'ai' | 'pair'`.
- `404 not-found` — session unknown or cross-account.

## Live input event (manual / pair mode)

`POST /v1/agent-sessions/{id}/input-event`

```json
{
  "event": { "type": "mouseMove", "x": 200, "y": 150 }
}
```

Forwards a raw LK.6 InputEvent to the harness for `mode: 'manual'`
or `mode: 'pair'` sessions. The 7 valid variants:

```json
{ "type": "mouseMove", "x": 200, "y": 150 }
{ "type": "mouseDown", "x": 200, "y": 150, "button": 0 }
{ "type": "mouseUp",   "x": 200, "y": 150, "button": 0 }
{ "type": "keyDown",   "key": "Enter", "modifiers": ["cmd"] }
{ "type": "keyUp",     "key": "Enter" }
{ "type": "wheel",     "x": 200, "y": 150, "deltaX": 0, "deltaY": 100 }
{ "type": "ping",      "timestamp": 1747658400000 }
```

`button` is `0` (left), `1` (middle), or `2` (right). `modifiers`
is an optional array of `cmd / ctrl / shift / option` strings.

Response (200):

```json
{ "ok": true, "duration_ms": 3 }
```

`duration_ms` is server-side dispatch latency, NOT round-trip to
the harness. Use a separate `ping` event to measure end-to-end
latency.

Throttle the client side: the route's rate-limit bucket
(`agent_sessions:input_event`) is sized for ≤120Hz `mouseMove`
streams with burst of ~2 seconds; intent events
(`mouseDown` / `mouseUp` / `wheel`) don't need client throttling.

Errors:

- `409 conflict` — session is in `mode: 'ai'` (input-event requires
  `manual` or `pair`); OR session is not `active`.
- `400 validation-failed` — event body fails the discriminated-union
  schema (unknown `type`, out-of-bounds coords, invalid `button`,
  etc.).
- `503 feature-unavailable` — harness end-to-end not yet wired on
  this deployment. Pre-launch state today; lands with the v1.0
  Mac fleet harness rollout.

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

A second concurrent takeover from a different client (while one is
mid-flight) returns `409 PairModeConflictError` with a
`winner_client_id` extension field naming the client that holds the
in-flight takeover. (Distinct from `PairModeStateInvalidTransitionError`,
which fires when the state machine refuses a transition — e.g. a
`handback` from `ai-driving` — and carries `from` + `transition`.)

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

Six actions land on the customer audit log across the agent-session
lifecycle + state machine (see [Audit log](/api/audit-log/)):

- `agent_session.created` (customer-initiated `POST /v1/agent-sessions`)
- `agent_session.destroyed` (customer-initiated `DELETE /v1/agent-sessions/:id`)
- `agent_session.mode.changed` (customer-initiated `POST /:id/mode`)
- `agent_session.pair_mode.takeover` (customer-initiated)
- `agent_session.pair_mode.handback` (customer-initiated)
- `agent_session.pair_mode.timeout` (system-emitted on
  heartbeat-timeout sweeps)

Lifecycle payloads: `created` carries `{ agent_session_id, initial_mode }`;
`destroyed` carries `{ agent_session_id, reason }` (reason is the
closeWithReason discriminator — `'customer-closed'` on the customer
DELETE route). Payload for the 3 pair-mode rows carries
`{ from, to, client_id? }` for downstream reconstruction of the
state-machine history. `agent_session.mode.changed` payload carries
`{ from, to }` (operational-mode strings: `manual` / `ai` / `pair`).
Filter via
`GET /v1/account/audit-log?action=agent_session.pair_mode.takeover`.

## Errors

| Status | Type                         | When                                                                 |
| -----: | ---------------------------- | -------------------------------------------------------------------- |
|    400 | validation                   | body fails schema (missing `user_message`, etc.)                     |
|    404 | not-found                    | session id unknown to the calling account                            |
|    409 | conflict                     | mode mismatch (e.g. takeover on `mode: 'ai'`)                        |
|    409 | pair-mode-invalid-transition | state-machine refused the transition (carries `from` + `transition`) |
|    409 | pair-mode-conflict           | concurrent takeover lost the lock race (carries `winner_client_id`)  |
|    402 | bundled-llm-budget-exhausted | bundled-LLM monthly cap reached                                      |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but customer hasn't opted in              |
|    502 | byok-anthropic-required      | no BYOK + no consent + no fallback                                   |
|    503 | feature-unavailable          | deployment activation gate is off (no LLM key path wired)            |

The pair-mode state-machine transition errors are typed in all
three SDKs: `PairModeStateInvalidTransitionError`. Branch on
the `from` + `transition` fields to recover (e.g. wait for the
queued transition to settle before retrying).
