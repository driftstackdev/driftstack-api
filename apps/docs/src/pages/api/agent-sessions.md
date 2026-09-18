---
layout: ../../layouts/DocLayout.astro
title: Agent sessions
description: AI-driven + manual + pair-mode browser automation — turn plain-language messages into browser steps, take over interactively, or send input directly.
---

# Agent sessions

An **agent session** lets an AI drive a browser session from
plain-language messages. The customer sends a message (`"open
https://example.com and capture a screenshot"`); Driftstack turns it
into a list of typed **intents** (`navigate`, `interact`, `wait`,
`capture`, plus the behavioural `scroll` and `behavioral_pause`), runs
them, and returns the results in the response.

Three modes:

- `ai` (default) — every customer message is planned and executed by
  the AI. Closed sessions return 409.
- `manual` — `message` is a transcript-only pass-through. The desktop
  app drives the real actions.
- `pair` — interactive takeover. AI drives by default; the customer
  can call `takeover` to take control, then `handback` to return
  control to the AI (handback is not available yet — see below).
  State transitions are audit-logged.

> **Scope note.** Write operations on agent-session endpoints
> (create, send-message, input-event, mode/takeover transitions)
> gate on the broad `write` scope — there is no agent-sessions-specific
> granular scope. Regular session routes accept the
> granular `write:sessions`, but agent sessions do not have a
> granular equivalent. If you mint a narrow CI key, include the
> broad `write` scope to call these endpoints.

## Resource shape

```json
{
  "id": "agt_<uuid>",
  "account_id": "<uuid>",
  "driftstack_session_id": "ses_<uuid> | null",
  "status": "provisioning | active | paused | closed",
  "closed_reason": "<string> | null",
  "provisioning_detail": null,
  "closed_at": "<ISO-8601> | null",
  "token_budget_total": 100000,
  "token_budget_remaining": 99500,
  "transcript_length": 12,
  "created_by_user_id": "<user-uuid> | null",
  "mode": "ai | manual | pair",
  "model": "claude-opus-5 | claude-sonnet-5 | claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5",
  "pair_mode_state": "{ \"kind\": ... } | null",
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "livekit": {
    "ws_url": "wss://<livekit-host>",
    "room": "agt_<uuid>",
    "token": "<HS256 JWT>",
    "participant_identity": "customer-<account-uuid>",
    "expires_at": "<ISO-8601>"
  },
  "error_event": {
    "timestamp": "<ISO-8601>",
    "code": "launch_timeout",
    "severity": "info | warn | error | fatal",
    "summary": "The browser did not become ready in time.",
    "detail": "<string> | null",
    "customer_actionable": false,
    "retryable": true
  }
}
```

The `status` field reports `provisioning` while the session exists and is being
set up — a VPN tunnel connecting, a proxy connecting — but no browser is
serving yet. Treat it as **running but not ready**: do not start work
against the session, and do not treat it as finished. It is already consuming
one of your concurrent-session slots, so a `provisioning` session counts against
your cap exactly as an `active` one does.

`provisioning_detail` names the step it is on (a snake_case token such as
`vpn_egress_bringing_up` or `vpn_egress_active`), and is `null` once the session
is active or closed. It may be absent entirely on older deployments, so
read it defensively rather than assuming the key exists.

The `error_event` field is **optional and nullable** — it carries the most
recent launch or runtime failure recorded for the session, and is
absent or `null` when none has been reported. Branch on its two booleans
rather than on the prose: `customer_actionable` says whether a human can do
anything about the failure, and `retryable` says whether repeating the same
call is worth trying. `detail` is `null` when the server has nothing to add
beyond `summary`, and `severity` is one of `info`, `warn`, `error`, `fatal`.
An `error_event` does not by itself close the session — read `status` for
that.

The `livekit` field is **optional** — auto-populated on the
session-create response when live video is available on the
deployment, and absent otherwise. Clients that need a token in
the absent case use the explicit endpoint at
[Live video (LiveKit)](#live-video-livekit) below.

> **ID-format note.** The agent-sessions resource emits
> `account_id` as a **bare UUID** (no `acc_` prefix), unlike
> `GET /v1/account/me` and
> `GET /v1/account/audit-log` which emit `acc_<uuid>`, and the
> `GET /v1/sessions/:id` resource which emits prefixed `ses_/acc_/
key_` IDs. Customer code comparing `agentSession.account_id`
> against `accountMe.id` must strip the `acc_` prefix from the
> latter first. (`id` and `driftstack_session_id` are prefixed —
> `agt_<uuid>` and `ses_<uuid>`. Only `account_id` is bare here.)

## Create

`POST /v1/agent-sessions`

Request body (all fields optional):

```json
{
  "mode": "ai | manual | pair",
  "model": "claude-opus-5 | claude-sonnet-5 | claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5",
  "driftstack_session_id": "ses_<uuid>",
  "token_budget": 100000,
  "profile_id": "prof_<uuid>",
  "proxy_id": "a1b2c3d4-...",
  "initial_url": "https://driftstack.io",
  "geolocation": { "latitude": 48.8566, "longitude": 2.3522, "accuracy": 20 }
}
```

Headers:

- `Idempotency-Key: <string>` (optional) — retries
  with the same key replay the original 201 instead of minting a
  duplicate row. This endpoint is one of the four that honour the
  header; see [Idempotency keys](/reference/idempotency/) for the full
  list and the endpoints that ignore it.

Response `201 Created` returns the resource above.

> **Tier availability.** AI-driven sessions (`mode: "ai"` — the
> default when `mode` is omitted — and `mode: "pair"`) require a
> tier with the AI-agent feature: Team, Agency, and every API plan
> (API Starter and up). On Free and Personal the create is
> refused with a 403 `forbidden` tier error. `mode: "manual"`
> sessions are available on every tier. The same rule applies to
> [`POST /{id}/mode`](#set-mode): flipping an existing session into
> `ai` or `pair` requires the AI-agent tier too. Team-scoped creates
> (`X-Driftstack-Account`) gate on the **owner** account's tier —
> the account the session runs and bills against.

If `mode` is omitted the server defaults to `ai`. If `model` is
omitted it defaults to `claude-sonnet-5` (every earlier id stays
accepted for back-compat) — the `model` selects which
Claude model the AI agent runs, and applies in `ai` and `pair`
mode. `token_budget` defaults to the deployment-configured value
(typically 100,000 tokens). The optional `driftstack_session_id` attaches the
agent session to an existing browser session; without it, one is started
automatically on the first executed intent.

The optional `profile_id` attaches one of your saved **profiles** (a
persistent browser identity — cookies, localStorage, etc.) to the session,
so the run resumes that profile's stored state and saves changes back when it
ends. Pass the `prof_<uuid>` id from the profiles API (a bare uuid is also
accepted). It must reference a profile your account owns; an unknown or
not-owned id returns `404`. Omit it for a stateless (fresh) session.

A profile can have only **one live session at a time**. If the profile already
has a non-terminal session, the create is refused with `409 profile-in-use`
(the body's `active_session_id` names the live session). This prevents two
sessions on the same profile from overwriting each other's saved cookies and
logins. End the named session — or wait for it to finish — before launching
another. Sessions without a `profile_id` are never affected.

The optional `proxy_id` routes the session's traffic through one of your saved
**account proxies** (manage them at `/v1/account/me/proxies`); pass the bare
proxy uuid. It must reference a proxy your account owns — an unknown or
not-owned id returns `404`. Omit it for the default connection.

The optional `initial_url` sets the start URL the remote browser opens on
launch, overriding the default start URL. It must be an absolute
`http(s)` URL; `file:`, `javascript:`, and `data:` schemes are rejected
(`400`). Omit it to use the default.

The optional `geolocation` explicitly overrides the location reported by the
session's `navigator.geolocation`. **By default you should not set this** — when
omitted, the device's location is derived from the proxy exit IP, so the
reported location is automatically coherent with the session's apparent network
location. Supply explicit coordinates only when you know the proxy's true
physical location better than IP geolocation does; coordinates that diverge
from the proxy's exit country make the session's fingerprint internally
inconsistent (a detectable signal). `latitude` is `-90..90`, `longitude` is
`-180..180`, and the optional `accuracy` is in meters (omit for the device
default). Out-of-range values are rejected (`400`).

## List

`GET /v1/agent-sessions`

Your agent sessions, newest first, cursor-paginated. Returns the standard
envelope: `{ data, has_more, next_cursor }`. `limit` defaults to 50 and
caps at 100 — that is the page size, not a ceiling on what you can reach;
pass the prior page's `next_cursor` to continue. All three SDKs wrap this
as `list()`, with `iterate()` to walk every page.

Requires `read:sessions`, broad `read`, or `account_owner`.

**Team members need the `admin` role here**, unlike the plain session
list. An agent session carries the model transcript and live control
state, so the collection is not widened to read-only members — a `member`
acting on an owner gets `403`. See
[Team RBAC](/guides/team-rbac/).

## Get

`GET /v1/agent-sessions/{id}`

Returns the resource above. Cross-account lookups return 404 (no
existence disclosure).

## Message

`POST /v1/agent-sessions/{id}/message`

Run one AI turn — plan and execute — (or, in `manual` mode, log the
message and return without executing).

Request body:

```json
{ "user_message": "open https://example.com and capture a screenshot" }
```

Headers:

- `Idempotency-Key: <UUID>` (strongly recommended) — identifies this
  logical turn. If the heartbeat stream or final response is lost, retry the
  exact same session/message/approval request with the same key; the server
  replays the recorded final status and body without running the browser task
  again. Changing the message, session, or approvals requires a new key. The
  BYOK header is deliberately outside receipt identity: reusing a key after
  changing that credential still replays the original terminal result and never
  executes a second browser turn. Use a new idempotency key for an intentionally
  new AI turn. A manual transcript turn never reads or hashes the irrelevant
  BYOK header. Reuse while the original outcome is still unknown returns `409`
  and does not start another turn.
- `x-byok-anthropic-api-key: sk-ant-...` (optional) — supply a
  per-request BYOK key that overrides any account-stored key for
  this turn. Useful for users who don't want to persist a key but
  do want each request authenticated against their own Anthropic
  account. Never logged.

Each message runs in the mode the session was in when it arrived. A `manual`
message is transcript-only and never touches BYOK, bundled-LLM, or the
browser. An `ai` message (or a `pair` message while AI is driving) keeps that
mode for the whole turn; a takeover, handback, mode change, pause, or close
cancels the turn even if the session later returns to the same mode.

If control changes while a turn is still running, the request returns
`409 conflict` with `ai_control_unavailable: true` and a `phase`, and no
further work is started. Work already completed is still reported:
consumed model usage can include `tokens_consumed` and `usage`, and
settled browser steps can appear as redacted `partial_results`.
Do not replay those partial steps automatically; inspect the current
session under its new controller first.

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
```

AI responses can include `usage`:

```json
{
  "decomposer_kind": "claude | deterministic",
  "model": "<string>",
  "anthropic_input_tokens": 1200,
  "anthropic_output_tokens": 340,
  "cost_usd_cents": 10
}
```

Only `decomposer_kind` is always present. The token counts and `model`
appear when the model reports them, so a `deterministic` turn carries
neither. Read them as evidence for the turn you made, not as an account
total.

When you use the bundled LLM, `usage.cost_usd_cents` is the flat 10 cents
charged for the turn, not the model's measured cost. It is the whole charge
for that turn, and a per-turn figure rather than a running total — use cost
monitoring for the account total. Explicit or stored BYOK responses can
instead report measured provider cost when available.

A failed step (`"kind": "failure"`) carries a human-readable `reason`
plus a structured `diagnosis` your automation can branch on without
string-matching the prose:

```json
{
  "kind": "failure",
  "intent": { "kind": "interact", "action": "tap", "selector": "#buy" },
  "reason": "the browser action or pacing may have taken effect even though its result was not confirmed — inspect the current page before deciding whether to try another action",
  "diagnosis": { "category": "unknown", "retryable": false }
}
```

`diagnosis.category` is one of `element_not_found`, `page_load_failed`,
`condition_not_met`, `capture_failed`, `scroll_failed`, `session_error`,
`invalid_request`, `result_too_large`, `unknown`. `retryable: true`
means automatic replay of the same step is considered safe. `false` means
never replay automatically: an invalid request must change, while an
outcome-unknown action or pacing may already have taken effect and requires state
inspection before any deliberate next action. It does not prove that the
action succeeded or failed. This rule applies to `navigate`,
`interact`, `scroll`, and `behavioral_pause` whenever Driftstack cannot
confirm whether the action ran.
Read-only `capture` remains eligible for bounded automatic replay.

```json
// "clarify" — the AI needs more info
{
  "kind": "clarify",
  "session": { ...AgentSession },
  "clarifying_question": "Which page should I capture — the home page or the pricing page?"
}

// "refuse" — the AI judged the request out of scope / unsafe
{
  "kind": "refuse",
  "session": { ...AgentSession },
  "refuse_reason": "This site's terms of service explicitly forbid automated scraping."
}

// "logged-manual" — mode='manual' pass-through; nothing planned or executed
{
  "kind": "logged-manual",
  "session": { ...AgentSession }
}

// "stopped" — the turn was stopped with POST /v1/agent-sessions/{id}/stop
{
  "kind": "stopped",
  "session": { ...AgentSession },
  "intents": [ { "kind": "navigate", "url": "https://example.com" } ],
  "results": [ { "kind": "success", "intent": { ... }, "summary": "navigated" } ],
  "ok": false,
  "notice": "Stopped after step 1 of 3, as you asked. The steps above are what ran; nothing after them was sent, and the task is not finished.",
  "stopped_during": "executing"
}
```

A `stopped` turn lists only the steps that **ran** — `intents` never includes a
step that was still to come. See [Stop the running turn](#stop-the-running-turn).

Paused and closed sessions return `409 Conflict`; resume a paused session, but
replace a closed one. If close or pause wins after model or
browser work has already settled, that terminal 409 retains the same consumed
`tokens_consumed`, `usage`, and redacted `partial_results` evidence described
above. Treat it as outcome-known evidence for those listed steps, never as an
invitation to replay them in a replacement session.

When the caller is using the
bundled LLM and the account has reached its monthly bundled-LLM
spend cap (`bundled_llm_monthly_cap_usd_cents`), the turn returns
`402 Payment Required` (BundledLlmBudgetExhausted) with `spent_cents`
and `cap_cents` extensions. (The separate per-session `token_budget`
is not a 402: when a session exhausts its token budget the turn is
refused and the session is auto-closed with
`closed_reason='budget-exhausted'`.)

## Close

`DELETE /v1/agent-sessions/{id}`

Sets `status='closed'` with `closed_at` stamped. Idempotent.

## Stop the running turn

`POST /v1/agent-sessions/{id}/stop`

Stops the turn a `POST /message` started, without closing the session. Anyone
who may send a message to the session may stop its turn; a session you cannot
access answers `404`, as it does everywhere else. The request body is empty
(`{}`).

It **requests** the stop and returns at once — it does not wait for the turn to
wind down:

```json
// 202 — a turn was running and has been asked to stop
{ "status": "stop_requested", "session_id": "<id>" }

// 200 — nothing was running, so there was nothing to stop
{ "status": "no_turn_running", "session_id": "<id>" }
```

Stopping is idempotent: calling it again, or calling it when nothing is
running, is always safe.

A stop sent right after the message is covered too: the turn counts as running
from the moment the message is accepted, before any planning starts. If you get
`200 no_turn_running` while your own `POST /message` is still waiting for its
answer, either the turn has just finished (its response is on its way) or the
message has not reached the turn yet; asking again a second later is safe and
settles which. A `503` means we could not confirm the stop; try again.

The turn itself ends on **its own** `POST /message` response, which comes back
as `kind: "stopped"` with the steps that ran and a `notice` saying how far it
got (or, if the turn was already finishing, as its ordinary result). That
response — not the `202` — is your signal that the session will accept the next
message; send it after the response arrives. On the streaming lane the terminal
`response` frame carries the `stopped` body, preceded by a `notice` frame with
the same sentence.

What happens to the work in progress:

- **Nothing new starts.** No further step is sent to the browser and no further
  planning call is made once the stop is observed.
- **A step already running is not abandoned blind.** If a tap, a typed value or
  a navigation was already on its way to the browser, the turn waits a short,
  bounded time (about fifteen seconds) for its result and reports it. If it does
  not answer in time, the step is reported as a failure with
  `diagnosis.category: "unknown"`: it may have happened. Check the page before
  doing it again. A step that only reads or waits is cut short at once.
- **A model call in progress is ended**, and what it used is still counted in
  `usage` and against the session's token budget.
- **The read-back is skipped.** If every step had already run, the turn ends
  without answering the question; the `notice` says so.

## Live video (LiveKit)

`POST /v1/agent-sessions/{id}/livekit-token`

Get a LiveKit token for a WebRTC client (the dashboard, the desktop
app, or any LiveKit-aware SDK) to subscribe to this session's video
stream.

Response (`200`):

```json
{
  "ws_url": "wss://<livekit-host>",
  "room": "agt_<uuid>",
  "token": "<HS256 JWT>",
  "participant_identity": "customer-<account-uuid>",
  "expires_at": "<ISO-8601>"
}
```

Tokens are valid for **24 hours**. The room name is always the agent
session id; the participant identity is `customer-<account-uuid>`, so
joins from the same account are deduplicated.

Customer-side grants on the minted token:

- `canSubscribe: true` — receive the published video stream
- `canPublish: false` — Driftstack publishes the video; you are
  subscriber-only
- `canPublishData: true` — used to send input events to the session

> **Auto-populated on session-create.** When live video is available on
> the deployment, `POST /v1/agent-sessions` returns the same `livekit` shape inline
> on the 201 response, so clients can connect immediately after create
> without the explicit round-trip to this endpoint. Deployments without
> live video omit the field; the explicit endpoint is the fallback.

Errors:

| Status | Type                | When                                                                                                           |
| -----: | ------------------- | -------------------------------------------------------------------------------------------------------------- |
|    404 | not-found           | session id unknown OR caller doesn't own it (anti-enumeration)                                                 |
|    403 | forbidden           | session is not active (closed or paused) — only active sessions can mint a token                               |
|    503 | feature-unavailable | live video is not available on this deployment, or is temporarily unavailable — contact support if it persists |

### Streaming the turn (SSE)

Send `Accept: text/event-stream` on the message request and the turn
streams instead of blocking. It differs from the JSON response in ways
worth writing a client around:

- **Heartbeats are SSE comments, not events.** The stream opens with
  `: stream open` and emits `: heartbeat <ISO-8601>` periodically. Lines
  beginning `:` carry no event name and no data — a client waiting on
  named events correctly sees nothing until the turn finishes, which for
  a browser task is normal rather than a stall.
- **One terminal frame, always named `response`.** The stream ends with
  `event: response` whose `data:` is JSON `{ status, body }` — the HTTP
  status the JSON lane would have returned, and the same body.
- **Errors arrive inside that frame, not as a status code.** An invalid
  body or an unknown session answers `200` at the HTTP layer and reports
  the failure as the `status` field of the terminal envelope. Branching on
  the response status alone will read every one of those as success; read
  `status` from the payload.
- **Rate-limit denial is the one exception.** A `429` is still a hard HTTP
  status with no stream, because the bucket is decided before any body
  exists.

## Live transcript stream (SSE)

`GET /v1/agent-sessions/{id}/transcript`

Server-Sent Events stream that publishes every transcript append
in real time. Customers building their own UIs (dashboard,
desktop apps) can subscribe instead of polling.

Auth: bearer token via `Authorization: Bearer <token>` header
OR `?ds_token=<token>` query-string fallback (`EventSource` API
in browsers doesn't support custom headers; the query-string
fallback exists for that use case). Account API keys require the
`read:sessions` scope; broad `read` and `account_owner` credentials
satisfy that floor. A key scoped only to another resource cannot open
the stream.

Treat this as a sensitive session-history stream. Free-text user and
operator `body` fields are returned verbatim to authorized readers.
For structured `interact:type` intents, password/OTP/PIN/card/API-key
values marked `sensitive: true` (or inferred from a sensitive selector)
are omitted from SSE; the encrypted server-side copy is used only by
Driftstack to resume the plan exactly.

Event types emitted:

- `transcript.entry` — fires for each transcript append. The
  `id:` SSE field is the entry's monotonic index; the `data:`
  field is JSON with `{ index, entry }` where `entry` has the
  same shape as the elements of `AgentSession.transcript`:
  - `role` — one of `'user'` (customer-supplied message), `'agent'`
    (the AI's output: plan-executed, clarify, or refuse), or
    `'operator'` (manual-mode pass-through — the customer's
    own UI/script logging directly without involving the AI).
  - `body` — always human-readable text, never JSON. For user and
    operator turns it is what was supplied. For agent turns it is a
    prose rendering of the AI's outcome: `refused: <reason>`,
    `clarify: <question>`, a newline-joined plan summary for
    plan-executed turns (which may end `(plan halted on failure)`),
    or the answer text for a transcript question. Do **not**
    `JSON.parse` it — the structured form of a plan-executed turn is
    `intents?` below, not `body`.
  - `at` — ISO 8601 timestamp.
  - `intents?` — present only on `role: 'agent'` + plan-executed
    turns; carries the structured intent list that was executed
    (the [recipes route](/api/recipes/) gathers these into
    `intent_log` snapshots — see the recipe docs).
    Sensitive type intents retain their selector, ordering, and
    `sensitive: true` marker but omit `value`.

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
responsibility. There is no per-session subscriber cap, but there IS
an account-wide one: **at most 10 concurrent transcript streams per
account**. The eleventh is refused with `429` and a `Retry-After` of
30 seconds, so a dashboard that opens a stream per visible session
will start shedding them once it crosses ten — across all sessions,
not per session. Each subscriber also holds a long-lived
connection.

## Set mode

`POST /v1/agent-sessions/{id}/mode`

```json
{ "mode": "manual" }
```

The top-level mode setter — distinct from the
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
- `403 forbidden` — flipping into `ai` or `pair` on a tier without
  the AI-agent feature (Free / Personal). The same tier rule as
  session create; switching to `manual` is never tier-refused.
- `400 validation-failed` — body `mode` isn't one of `'manual' |
'ai' | 'pair'`.
- `404 not-found` — session unknown or cross-account.

## Live input event (manual / pair mode)

`POST /v1/agent-sessions/{id}/input-event`

```json
{
  "event": { "type": "mouseMove", "x": 200, "y": 150 },
  "client_id": "dashboard-tab-a"
}
```

`client_id` is **required for every pair-mode session**, on both legs: the
first event (which requests takeover) rejects without it,
and every subsequent event must carry the SAME `client_id` that owns
`human-driving` — the lock exists to scope contention to one tab. It is
optional in the schema only because manual-mode sessions do not need it.
Omitting it in pair mode returns `400 validation-failed` with a
`client_id` field error, and sending a _different_ value once human-driving is
held returns `409 pair-mode-conflict`. Reuse one stable id per tab or window.

Sends an input event to a `mode: 'manual'` or `mode: 'pair'` session.
The 12 valid variants:

```json
{ "type": "mouseMove", "x": 200, "y": 150 }
{ "type": "mouseDown", "x": 200, "y": 150, "button": 0 }
{ "type": "mouseUp",   "x": 200, "y": 150, "button": 0 }
{ "type": "keyDown",   "key": "Enter", "modifiers": ["cmd"] }
{ "type": "keyUp",     "key": "Enter" }
{ "type": "wheel",     "x": 200, "y": 150, "deltaX": 0, "deltaY": 100 }
{ "type": "tap",        "x": 200, "y": 430 }
{ "type": "touchStart", "x": 200, "y": 430, "touchId": 0 }
{ "type": "touchMove",  "x": 210, "y": 435, "touchId": 0 }
{ "type": "touchEnd",   "x": 212, "y": 436, "touchId": 0 }
{ "type": "swipe",      "x1": 200, "y1": 700, "x2": 200, "y2": 200, "durationMs": 350 }
{ "type": "ping",      "timestamp": 1747658400000 }
```

**Touch is the iPhone-native, preferred input** — the session is a real
iPhone Safari surface, so touch is delivered as real touch events (no
mouse cursor). Coordinates are device-CSS pixels; `touchId` (0–9) lets
you use several fingers for multi-touch; `swipe` carries endpoints +
`durationMs` (≤60000) and Driftstack smooths the path. The `mouse*`
variants remain for
desktop-style tooling. `button` is `0` (left), `1` (middle), or `2`
(right). `modifiers` is an optional array of `cmd / ctrl / shift / option`
strings.

Response (200): a discriminated union on `kind`. Only
`pair-mode-takeover-fired` is reachable today — see the callout
below `forwarded`.

When the first input-event in a pair-mode `ai-driving` session requests
takeover instead of forwarding:

```json
{ "kind": "pair-mode-takeover-fired", "pair_mode_state": { "kind": "takeover-pending" } }
```

For a plain forwarded event (manual mode, or pair mode after takeover is
granted), the eventual response shape is:

```json
{ "kind": "forwarded", "duration_ms": 3 }
```

**HTTP manual input is unavailable.** Manual-mode and
pair-mode-after-takeover input-events return `503 feature-unavailable`;
the HTTP route does not accept them. For live manual or pair-mode
control, use the desktop app or send input over the LiveKit data channel
documented in the [Live video guide](/guides/live-video/).
`duration_ms` is server-side processing time, not round-trip time to the
session.

Throttle the client side: the route's rate-limit bucket
(`agent_sessions:input_event`) is sized for ≤120Hz `mouseMove` /
`touchMove` streams with burst of ~2 seconds; discrete events
(`tap` / `mouseDown` / `mouseUp` / `wheel` / `swipe`) don't need
client throttling.

Errors:

- `409 conflict` — session is in `mode: 'ai'` (input-event requires
  `manual` or `pair`); OR session is not `active`.
- `400 validation-failed` — event body fails the discriminated-union
  schema (unknown `type`, out-of-bounds coords, invalid `button`,
  etc.), OR `client_id` is missing on a pair-mode session (the field
  error names `client_id`; check that before debugging coordinates).
- `409 pair-mode-conflict` — a pair-mode `client_id` that differs from
  the one currently holding `human-driving`.
- `503 feature-unavailable` — this deployment does not accept manual
  input over HTTP. Use the desktop app for hands-on input.

## Pair-mode takeover + handback

The takeover + handback endpoints below are for `mode: 'pair'`
sessions only — they return 409 on non-pair sessions.

## Request takeover

`POST /v1/agent-sessions/{id}/takeover`

```json
{ "client_id": "<your-internal-client-id>" }
```

Transition: `ai-driving → takeover-pending`, or `takeover-queued` if
the AI is still working on a turn (it becomes `takeover-pending` when
that turn finishes).

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
which fires when a transition is not allowed from the current state — e.g.
a `handback` from `ai-driving` — and carries `from` + `transition`.)

## Request handback

`POST /v1/agent-sessions/{id}/handback`

Body: `{}` (empty).

Transition: `human-driving → handback-pending`, or `handback-queued` if
the AI is still working on a turn.

**This transition is unreachable today.** `human-driving` is produced only by the
`takeover-grant` transition, which is not available yet, so this endpoint returns
**409 `pair-mode-conflict`** on every call and the 200 shape below is not currently
observable. A parked `takeover-pending` session returns to `ai-driving` after 30s without
a client heartbeat.

Response (200):

```json
{ "pair_mode_state": { "kind": "handback-pending", "requestedAt": "<ISO-8601>" } }
```

## Heartbeat-timeout auto-handback

If a `human-driving` session goes 30s without a client heartbeat,
the session automatically returns to `ai-driving`. The
transition emits an `agent_session.pair_mode.timeout` audit row.

## Resume a challenge-paused session

`POST /v1/agent-sessions/{id}/resume`

When the session detects a bot-challenge (DataDome /
Arkose / PerimeterX / AWS-WAF / GeeTest / …) it auto-pauses the
session and emits a [`session.challenge_detected`](/webhooks/events/)
webhook. After you resolve the challenge (e.g. in the live view),
call this to resume the agent.

Body: `{ "challenge_id"?: "<id-from-the-event>" }`

`challenge_id` (optional) correlates to the
`session.challenge_detected` you are responding to — when present,
Driftstack checks it against the active challenge (a stale id leaves
the session paused); when absent, it is a manual override resume.

Response `202`:

```json
{ "status": "resume_requested", "session_id": "<id>" }
```

`404` if the session is not found or not owned by your account; `409`
if the session is in a terminal state (resume requires an active
session). Not available on every deployment.

The seven endpoints below operate on the **live, running session**
(they are what the desktop app's page overlay, Cookies drawer,
back/forward buttons, file picker, and download bar call). Reads
accept any bearer with the `read` scope; writes gate on the broad
`write` scope (see the scope note at the top of this page). Apart
from the page-state poll, each returns a **discriminated `200` body**
in every case — `status` is one of `ok`, `unavailable` (the session
is not running, cannot be reached right now, or live control is not
enabled on this deployment), `timeout` (the session did not reply in
time), or `error` (the session reported a failure; `reason` says why)
— so expected-inert states surface as data, not HTTP errors. A
malformed body or query is a `400`; an unknown or cross-account
session id is a `404`.

## Page state

`GET /v1/agent-sessions/{id}/page-state`

The latest page state the session reported — polled by the desktop
app's loading bar and error overlay, and available to your own UIs
the same way.

Response (200):

```json
{
  "page_state": {
    "state": "loading | loaded | errored | stalled",
    "url": "https://example.com | null",
    "title": "Example Domain | null",
    "tabId": "<tab id> | null",
    "input_focused": true,
    "error": { "kind": "net", "message": "<human-readable>" }
  }
}
```

`state: "stalled"` means the page is frozen but the session is still
alive (for example, hung JavaScript) — distinct from `errored`
(a hard page error) and `loading` (a navigation in flight). `error`
is `null` except on `errored` states. `input_focused` is `true` while
an editable field on the page holds focus and `false` on blur (`null`
until the session reports one) — a UI can use it to show or hide an
on-screen keyboard. `page_state` is `null` when
nothing has been reported yet, the last report is older than the
freshness bound, the session is closed, or live session state is
unavailable on this deployment.

## Read the cookie jar

`GET /v1/agent-sessions/{id}/cookies`

Pulls the running session's **full live cookie jar** — including
`httpOnly` cookies — from the device.

Response (200), discriminated:

```json
{
  "cookies": [
    {
      "domain": "example.com",
      "name": "session",
      "value": "…",
      "path": "/",
      "expires": 1780000000000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "status": "ok"
}
```

`domain`, `name`, and `value` are always present; `path`, `expires`
(unix milliseconds; `null` or omitted for session cookies),
`httpOnly`, `secure`,
and `sameSite` (`Strict | Lax | None`) appear when the store reports
them. On `unavailable` / `timeout` / `error`, `cookies` is `null`.
The jar shape round-trips 1:1 into [Import cookies](#import-cookies)
below — you can save the `cookies` array to a file and re-import it
into a later session.

## Import cookies

`POST /v1/agent-sessions/{id}/cookies/set`

```json
{ "cookies": [{ "domain": "example.com", "name": "session", "value": "…" }] }
```

The write-twin of the read above: relays a cookie jar (the exact
shape the read emits, 1 to 2000 cookies per request) into the
running session's cookie store. Response (200) is the discriminated
`{ "status": …, "reason"?: … }` shape — `ok` means the write was
applied; on any other status nothing was written.

## Change the session's proxy

`POST /v1/agent-sessions/{id}/egress`

```json
{ "proxy_id": "prx_…", "apply_point": "next_navigation" }
```

> **Not available yet.** Devices cannot change the proxy on a running
> session, so this endpoint currently answers
> `{"status":"unavailable"}` for every call. Create a new session with
> the `proxy_id` you want instead. This note goes away when device
> support lands; the request and response shapes below are stable and
> will not change.

Moves a **running** session onto one of your stored proxies without
restarting it — the page keeps its tabs, cookies and scroll position.

`proxy_id` must be a proxy on your own account that has been tested at
least once. The swap carries the exit's measured identity (IP, country,
timezone) to the device so the page keeps seeing a consistent origin,
and an untested proxy has no measured identity to carry — that case
answers `unavailable` rather than guessing one. Test a proxy with
`POST /v1/account/me/proxies/{id}/test`.

`apply_point` defaults to `"next_navigation"`, which swaps on the next
page load and leaves connections in flight alone. `"immediate"` swaps
at once and may reset connections mid-page.

Response (200) is the discriminated `{ "status": …, "reason"?: … }`
shape, plus `apply_point` when the swap was accepted — `"immediate"`,
`"next_navigation"`, or `null` when the device accepted it but did not
confirm when it applies (treat `null` as possibly-immediate). On any
status other than `ok`, the proxy was **not** changed.

## Step browser history

`POST /v1/agent-sessions/{id}/history`

```json
{ "direction": "back" }
```

Steps the running session's back-forward list one entry in
`direction` (`"back"` or `"forward"`) — what the desktop app's
back/forward buttons call. The session's **current** tab is stepped.

> **`tabId` is not supported yet.** Devices step the current tab only,
> so sending `tabId` is rejected with a `422` rather than silently
> stepping a different tab than you asked for. To step a specific
> tab, activate it first.
> Response (200) is the discriminated `{ "status": …, "reason"?: … }`
> shape.

## Upload a file

`POST /v1/agent-sessions/{id}/files`

```json
{ "name": "invoice.pdf", "mime": "application/pdf", "dataB64": "<base64 bytes>" }
```

Uploads a file into the running session's **isolated upload area**
so it can be attached to a page's `<input type="file">`. The decoded
size is capped at **64 MiB** per file (larger, or an empty file, is
a `400`); per-account concurrent upload volume (512 MiB) and
per-session lifetime totals (2 GiB) are also capped — an over-cap
request returns `status: "error"` with the cap named in `reason`.

Response (200), discriminated:

```json
{
  "handle": { "id": "<opaque>", "name": "invoice.pdf", "mime": "application/pdf", "size": 182044 },
  "status": "ok"
}
```

`handle` is an **opaque reference** — file paths on the device are
never exposed. On any non-`ok` status, `handle` is `null`.

## List downloads

`GET /v1/agent-sessions/{id}/downloads`

Lists the files pages have downloaded inside the running session
(downloads land in a per-session isolated area on the device, never
a shared folder). Response (200), discriminated:

```json
{
  "files": [{ "name": "report.csv", "size": 51234, "mime": "text/csv" }],
  "status": "ok"
}
```

`files: []` with `status: "ok"` means no downloads yet. `name` is
always a bare basename, never a path; `mime` appears when the device
reports one. On any non-`ok` status, `files` is `null`.

## Fetch a download

`GET /v1/agent-sessions/{id}/downloads/content?name=report.csv`

Fetches one downloaded file's bytes by `name` (a basename from the
list above; the server re-sanitizes it and confines the read to the
session's download area). Fetches are capped at 64 MiB. Response
(200), discriminated:

```json
{
  "file": { "name": "report.csv", "mime": "text/csv", "dataB64": "<base64 bytes>" },
  "status": "ok"
}
```

`mime` falls back to `application/octet-stream` when the device did
not report one. A missing or too-large file is `status: "error"`
with the cause in `reason`; on any non-`ok` status, `file` is
`null`.

## Audit log

Six actions land on the customer audit log across the agent-session
lifecycle + pair-mode transitions (see [Audit log](/api/audit-log/)):

- `agent_session.created` (customer-initiated `POST /v1/agent-sessions`)
- `agent_session.destroyed` (customer-initiated `DELETE /v1/agent-sessions/:id`)
- `agent_session.mode.changed` (customer-initiated `POST /:id/mode`)
- `agent_session.pair_mode.takeover` (customer-initiated)
- `agent_session.pair_mode.handback` (customer-initiated)
- `agent_session.pair_mode.timeout` (system-emitted on
  heartbeat-timeout sweeps)

Lifecycle payloads: `created` carries `{ agent_session_id, initial_mode }`;
`destroyed` carries `{ agent_session_id, reason }` (`'customer-closed'`
when closed via DELETE). Payload for the 3 pair-mode rows carries
`{ from, to, client_id? }` so you can reconstruct the pair-mode
history. `agent_session.mode.changed` payload carries
`{ from, to }` (mode strings: `manual` / `ai` / `pair`).
Filter via
`GET /v1/account/audit-log?action=agent_session.pair_mode.takeover`.

## Errors

| Status | Type                         | When                                                                                                                                                                                                                                                                     |
| -----: | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    400 | validation-failed            | body fails schema (missing `user_message`, etc.)                                                                                                                                                                                                                         |
|    403 | forbidden                    | create with — or mode-flip into — `mode: ai`/`pair` on a tier without the AI-agent feature (Free / Personal)                                                                                                                                                             |
|    404 | not-found                    | session id you cannot access (not your own, and not a team you hold admin on)                                                                                                                                                                                            |
|    409 | conflict                     | mode mismatch, or `ai_control_unavailable: true` when control of the session changes while a message is running; the latter includes `phase` and can include consumed `tokens_consumed`, `usage`, and redacted `partial_results` that must not be replayed automatically |
|    409 | profile-in-use               | create's `profile_id` already has a live session (carries `active_session_id`)                                                                                                                                                                                           |
|    409 | pair-mode-invalid-transition | the transition is not allowed from the current state (carries `from` + `transition`)                                                                                                                                                                                     |
|    409 | pair-mode-conflict           | concurrent takeover lost the lock race (carries `winner_client_id`)                                                                                                                                                                                                      |
|    402 | bundled-llm-budget-exhausted | bundled-LLM monthly cap reached                                                                                                                                                                                                                                          |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but customer hasn't opted in                                                                                                                                                                                                                  |
|    502 | byok-anthropic-required      | no BYOK + no consent + no fallback                                                                                                                                                                                                                                       |
|    503 | feature-unavailable          | no BYOK or bundled-LLM provider is available in the deployment; on Stop, also when the stop could not be confirmed just now (try again)                                                                                                                                  |

The pair-mode transition errors are typed in all
three SDKs: `PairModeStateInvalidTransitionError`. Branch on
the `from` + `transition` fields to recover (e.g. wait for the
queued takeover to complete before retrying).
