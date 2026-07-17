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
intents (`navigate`, `interact`, `wait`, `capture`, plus the
behavioural `scroll` and `behavioral_pause`); the runtime executes
them; results stream back in the response.

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

> **Scope note.** Write operations on agent-session endpoints
> (create, send-message, input-event, mode/takeover transitions)
> gate on the broad `write` scope — there is no agent-sessions-specific
> granular scope. Driver-session routes accept the
> granular `write:sessions`, but agent sessions do not have a
> granular equivalent. If you mint a narrow CI key, include the
> broad `write` scope to call these endpoints.

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
  "model": "claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5",
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
  "model": "claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5",
  "driftstack_session_id": "ses_<uuid>",
  "token_budget": 100000,
  "profile_id": "prof_<uuid>",
  "proxy_id": "a1b2c3d4-...",
  "initial_url": "https://driftstack.dev",
  "geolocation": { "latitude": 48.8566, "longitude": 2.3522, "accuracy": 20 }
}
```

Headers:

- `Idempotency-Key: <string>` (optional, Stripe-pattern) — retries
  with the same key replay the original 201 instead of minting a
  duplicate row.

Response `201 Created` returns the resource above.

> **Tier availability.** AI-driven sessions (`mode: "ai"` — the
> default when `mode` is omitted — and `mode: "pair"`) require a
> tier with the AI-agent feature: Team, Agency, and every API-ladder
> tier (API Starter and up). On Free and Personal the create is
> refused with a 403 `forbidden` tier error. `mode: "manual"`
> sessions are available on every tier. The same rule applies to
> [`POST /{id}/mode`](#set-mode): flipping an existing session into
> `ai` or `pair` requires the AI-agent tier too. Team-scoped creates
> (`X-Driftstack-Account`) gate on the **owner** account's tier —
> the account the session runs and bills against.

If `mode` is omitted the server defaults to `ai`. If `model` is
omitted it defaults to `claude-opus-4-8` (`claude-opus-4-7` stays
accepted for back-compat) — the `model` selects which
Claude 4.x model the AI agent runs, and applies in `ai` and `pair`
mode. `token_budget` defaults to the deployment-configured value
(typically 100,000 tokens). The optional `driftstack_session_id` ties the agent
session to a pre-existing driver session; without it the runtime
spawns one on the first executed intent.

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

The optional `proxy_id` routes the session's egress through one of your saved
**account proxies** (manage them at `/v1/account/me/proxies`); pass the bare
proxy uuid. It must reference a proxy your account owns — an unknown or
not-owned id returns `404`. Omit it for the default egress.

The optional `initial_url` sets the start URL the remote browser opens on
launch, overriding the operator-default start URL. It must be an absolute
`http(s)` URL; `file:`, `javascript:`, and `data:` schemes are rejected
(`400`). Omit it to use the operator default.

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

- `Idempotency-Key: <UUID>` (strongly recommended) — identifies this
  logical turn. If the heartbeat stream or final response is lost, retry the
  exact same session/message/approval request with the same key; the server
  replays the durable terminal status and body without running the browser task
  again. Changing the message, session, approvals, or explicit BYOK key requires
  a new key. Reuse while the original outcome is still unknown returns `409`
  and does not dispatch another turn.
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
```

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
action succeeded or failed. This fail-closed rule applies to `navigate`,
`interact`, `scroll`, and `behavioral_pause` when a coarse WebDriver or
dispatch failure cannot prove that the browser action or pacing did not run. Read-only
`capture` remains eligible for bounded automatic replay.

```json
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

Closed sessions return `409 Conflict`. When the caller is on the
bundled-LLM rail and the account has reached its monthly bundled-LLM
spend cap (`bundled_llm_monthly_cap_usd_cents`), the turn returns
`402 Payment Required` (BundledLlmBudgetExhausted) with `spent_cents`
and `cap_cents` extensions. (The separate per-session `token_budget`
is not a 402: when a session exhausts its token budget the turn is
refused and the session is auto-closed with
`closed_reason='budget-exhausted'`.)

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

| Status | Type                | When                                                                             |
| -----: | ------------------- | -------------------------------------------------------------------------------- |
|    404 | not-found           | session id unknown OR caller doesn't own it (anti-enumeration)                   |
|    403 | forbidden           | session is not active (closed or paused) — only active sessions can mint a token |
|    503 | feature-unavailable | no Mac has registered LiveKit credentials yet                                    |
|    503 | feature-unavailable | stored Mac secret is unreadable (ops-actionable; rotate key)                     |

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
are omitted from SSE; the encrypted server-side copy remains available
only to the runtime for exact plan resume.

Event types emitted:

- `transcript.entry` — fires for each transcript append. The
  `id:` SSE field is the entry's monotonic index; the `data:`
  field is JSON with `{ index, entry }` where `entry` has the
  same shape as the elements of `AgentSession.transcript`:
  - `role` — one of `'user'` (customer-supplied message), `'agent'`
    (decomposer output: plan-executed, clarify, or refuse), or
    `'operator'` (manual-mode pass-through — the customer's
    own UI/script logging directly without invoking the
    decomposer).
  - `body` — free-text for user / operator turns; serialised
    `DecomposeResult` JSON for agent turns.
  - `at` — ISO 8601 timestamp.
  - `intents?` — present only on `role: 'agent'` + plan-executed
    turns; carries the structured intent list the runtime
    executed (the [recipes route](/api/recipes/) flatMaps these
    into `intent_log` snapshots — see the recipe docs for how a
    snapshotted intent_log replays without re-running the
    decomposer). Sensitive type intents retain their selector,
    ordering, and `sensitive: true` marker but omit `value`.

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
  "event": { "type": "mouseMove", "x": 200, "y": 150 }
}
```

Forwards a raw LK.6 InputEvent to the harness for `mode: 'manual'`
or `mode: 'pair'` sessions. The 12 valid variants:

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
iPhone Safari surface, so the harness injects touch via genuine WebKit
events (`pointerType: touch`; no mouse cursor). Coordinates are
device-CSS pixels; `touchId` (0–9) drives concurrent fingers for
multi-touch; `swipe` carries endpoints + `durationMs` (≤60000) and the
harness interpolates the eased path. The `mouse*` variants remain for
desktop-style tooling. `button` is `0` (left), `1` (middle), or `2`
(right). `modifiers` is an optional array of `cmd / ctrl / shift / option`
strings.

Response (200): a discriminated union on `kind`. Only
`pair-mode-takeover-fired` is reachable today — see the callout
below `forwarded`.

When the first input-event in a pair-mode `ai-driving` session fires
the takeover-request transition instead of forwarding:

```json
{ "kind": "pair-mode-takeover-fired", "pair_mode_state": { "kind": "takeover-pending" } }
```

For a straight forward-to-harness dispatch (manual mode, or pair
mode after takeover-grant), the eventual response shape is:

```json
{ "kind": "forwarded", "duration_ms": 3 }
```

**HTTP manual-input dispatch is unavailable.** Manual-mode and
pair-mode-after-takeover input-events return `503 feature-unavailable`;
the HTTP route does not forward input to the harness. For live manual
or pair-mode control, use the desktop Simulator or publish input through
the LiveKit DataChannel documented in the
[Live video guide](/guides/live-video/)
(`room.localParticipant.publishData(...)`).
`duration_ms` is server-side dispatch latency, not round-trip latency to the
session harness.

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
  etc.).
- `503 feature-unavailable` — this deployment does not expose HTTP
  manual-input dispatch. Use the desktop Simulator's live control channel for
  hands-on input.

## Pair-mode takeover + handback

The takeover + handback endpoints below are for `mode: 'pair'`
sessions only — they return 409 on non-pair sessions.

## Request takeover

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

## Request handback

`POST /v1/agent-sessions/{id}/handback`

Body: `{}` (empty).

State machine: `human-driving → handback-pending`, or
`handback-queued` if mid-decompose.

Response (200):

```json
{ "pair_mode_state": { "kind": "handback-pending", "requestedAt": "<ISO-8601>" } }
```

## Heartbeat-timeout auto-handback

If a `human-driving` session goes 30s without a client heartbeat,
the harness auto-handbacks the session to `ai-driving`. The
transition emits an `agent_session.pair_mode.timeout` audit row.

## Resume a challenge-paused session

`POST /v1/agent-sessions/{id}/resume`

When the in-session harness detects a bot-challenge (DataDome /
Arkose / PerimeterX / AWS-WAF / GeeTest / …) it auto-pauses the
session and emits a [`session.challenge_detected`](/webhooks/events/)
webhook. After you resolve the challenge (e.g. in the live view),
call this to resume the agent.

Body: `{ "challenge_id"?: "<id-from-the-event>" }`

`challenge_id` (optional) correlates to the
`session.challenge_detected` you are responding to — when present, the
harness validates it against the active challenge (a stale id leaves
the session paused); when absent, it is a manual override resume.

Response `202`:

```json
{ "status": "resume_requested", "session_id": "<id>" }
```

`404` if the session is not found or not owned by your account; `409`
if the session is in a terminal state (resume requires an active
session). Available when the fleet control plane is enabled on the
deployment.

The seven endpoints below operate on the **live, running session**
(they are what the desktop GUI's page overlay, Cookies drawer,
back/forward buttons, file picker, and download bar call). Reads
accept any bearer with the `read` scope; writes gate on the broad
`write` scope (see the scope note at the top of this page). Apart
from the page-state poll, each returns a **discriminated `200` body**
in every case — `status` is one of `ok`, `unavailable` (the session
is not live on a node, the fleet control plane is not enabled, or
the session's node is offline), `timeout` (the node did not reply),
or `error` (the node reported a failure; `reason` says why) — so
expected-inert states surface as data, not HTTP errors. A
malformed body or query is a `400`; an unknown or cross-account
session id is a `404`.

## Page state

`GET /v1/agent-sessions/{id}/page-state`

The latest page state the session's harness reported — polled by the
GUI's loading bar and error overlay, and available to your own UIs
the same way.

Response (200):

```json
{
  "page_state": {
    "state": "loading | loaded | errored | stalled",
    "url": "https://example.com | null",
    "title": "Example Domain | null",
    "tabId": "<tab id> | null",
    "error": { "kind": "net", "message": "<human-readable>" }
  }
}
```

`state: "stalled"` means the harness detected a frozen-but-alive
renderer (hung JS / compositor deadlock) — distinct from `errored`
(a hard page error) and `loading` (a navigation in flight). `error`
is `null` except on `errored` states. `page_state` is `null` when
nothing has been reported yet, the last report is older than the
freshness bound, the session is closed, or live fleet state is
unavailable in the deployment.

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

## Step browser history

`POST /v1/agent-sessions/{id}/history`

```json
{ "direction": "back" }
```

Steps the running session's back-forward list one entry in
`direction` (`"back"` or `"forward"`) — what the GUI's back/forward
buttons call. The optional `tabId` targets a specific tab's
back-forward list; omitted, the session's current tab is stepped.
Response (200) is the discriminated `{ "status": …, "reason"?: … }`
shape.

## Upload a file

`POST /v1/agent-sessions/{id}/files`

```json
{ "name": "invoice.pdf", "mime": "application/pdf", "dataB64": "<base64 bytes>" }
```

Uploads a file into the running session's **isolated upload area**
so it can be attached to a page's `<input type="file">`. The decoded
size is capped at **64 MiB** per file (larger, or an empty file, is
a `400`); per-account concurrent upload volume (512 MB) and
per-session lifetime totals (2 GiB) are also capped — an over-cap
request returns `status: "error"` with the cap named in `reason`.

Response (200), discriminated:

```json
{
  "handle": { "id": "<opaque>", "name": "invoice.pdf", "mime": "application/pdf", "size": 182044 },
  "status": "ok"
}
```

`handle` is an **opaque reference** — the mapping to an on-device
path stays inside the harness, so a worker filesystem path is never
exposed. On any non-`ok` status, `handle` is `null`.

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

| Status | Type                         | When                                                                                                         |
| -----: | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
|    400 | validation                   | body fails schema (missing `user_message`, etc.)                                                             |
|    403 | forbidden                    | create with — or mode-flip into — `mode: ai`/`pair` on a tier without the AI-agent feature (Free / Personal) |
|    404 | not-found                    | session id unknown to the calling account                                                                    |
|    409 | conflict                     | mode mismatch (e.g. takeover on `mode: 'ai'`)                                                                |
|    409 | profile-in-use               | create's `profile_id` already has a live session (carries `active_session_id`)                               |
|    409 | pair-mode-invalid-transition | state-machine refused the transition (carries `from` + `transition`)                                         |
|    409 | pair-mode-conflict           | concurrent takeover lost the lock race (carries `winner_client_id`)                                          |
|    402 | bundled-llm-budget-exhausted | bundled-LLM monthly cap reached                                                                              |
|    402 | bundled-llm-consent-required | deployment has bundled-LLM but customer hasn't opted in                                                      |
|    502 | byok-anthropic-required      | no BYOK + no consent + no fallback                                                                           |
|    503 | feature-unavailable          | no BYOK or bundled-LLM provider is available in the deployment                                               |

The pair-mode state-machine transition errors are typed in all
three SDKs: `PairModeStateInvalidTransitionError`. Branch on
the `from` + `transition` fields to recover (e.g. wait for the
queued transition to settle before retrying).
