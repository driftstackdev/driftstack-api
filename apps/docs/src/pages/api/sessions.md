---
layout: ../../layouts/DocLayout.astro
title: Sessions
description: Create + drive iPhone Safari sessions — navigate, interact, wait, capture, extract, search, login, get-state, destroy. Tier-gated concurrency.
---

# Sessions

A **session** is one running iPhone Safari instance on the modified
WebKit fork, occupying one of your account's concurrent slots from
creation to destruction. Use it to navigate URLs, interact with the
page, capture screenshots / DOM state, and tear it down cleanly.

For the higher-level lifecycle + state diagram, see
[Session lifecycle](/guides/session-lifecycle/). This page is the
endpoint reference.

## Concurrency

Each tier caps simultaneously-active sessions. Values match the
shared `TIER_CONCURRENT_SESSION_LIMITS` constant in
`@driftstack/api-types`:

| Tier            | Concurrent sessions |
| --------------- | ------------------: |
| `free`          |                   1 |
| `solo_manual`   |                   1 |
| `team_manual`   |                   3 |
| `agency_manual` |                   8 |
| `api_starter`   |                   2 |
| `api_builder`   |                   8 |
| `api_scale`     |                  24 |
| `enterprise`    |                  32 |

Hitting the cap on `POST /v1/sessions` returns `429 Too Many
Requests` with `current_sessions` and `limit` in the problem body (no
`Retry-After` header — that header is only sent on rate-limit 429s;
retry once one of your sessions ends). Paid-tier sessions run until
you destroy them; free-tier sessions stop at the 20-minute duration
cap.

## Resource shape

```json
{
  "id": "ses_<uuid>",
  "account_id": "acc_<uuid>",
  "api_key_id": "key_<uuid>",
  "status": "ready",
  "archetype": "iphone17_ios18_7_safari26_4",
  "purpose": "production_customer",
  "label": "login flow",
  "metadata": null,
  "egress_capabilities": null,
  "egress_capability_report": null,
  "created_at": "2026-05-09T22:00:00.000Z",
  "updated_at": "2026-05-09T22:00:30.000Z",
  "last_state_at": "2026-05-09T22:00:30.000Z",
  "destroyed_at": null
}
```

`status` is one of `creating`, `ready`, `busy`, `destroyed`,
`errored`. The SDK's `sessions.create()` blocks until `ready`; any
intermediate `creating` state isn't directly observable.

`purpose` selects the WebKit driver harness configuration .
`production_customer` is the default; the other values
(`cumulative_rig_validation`, `test_domain_probe`) are reserved
for Driftstack-internal ops.

`label` is a free-form short string (max 120 chars) for the
customer's own identification — surfaced in dashboards + the
audit log. `metadata` is an arbitrary JSON object for the
customer's own bookkeeping.

`last_state_at` is the most recent `getState` / `capture` /
`navigate` / `interact` / `wait` ack timestamp. `updated_at`
reflects any server-side state mutation (status changes,
metadata writes).

`egress_capabilities` and `egress_capability_report` are both
`null` until a session routes through a SOCKS5 proxy and the
harness completes its egress handshake (and stay `null` for
non-proxied sessions). When populated, `egress_capabilities` is
the typed view — `{ udp_associate, quic_route, warnings[] }` —
and `egress_capability_report` is the opaque raw harness payload.
Prefer `egress_capabilities` for typed access; treat both as
nullable on every read.

## Create

`POST /v1/sessions`

```json
{
  "archetype": "iphone17_ios18_7_safari26_4",
  "purpose": "production_customer",
  "label": "login flow",
  "metadata": { "ticket": "SUP-42" },
  "profile_id": "prof_01HV...",
  "behavioral_profile": "regular"
}
```

All fields optional. `archetype` defaults to the locked iPhone 17 /
iOS 18.7 / Safari 26.4 archetype when omitted (`LOCKED_ARCHETYPE_ID`
= `iphone17_ios18_7_safari26_4`). `purpose` defaults to
`production_customer`.

When supplied directly, `archetype` must be an `id` returned by the current
[`GET /v1/archetypes`](/api/archetypes/) catalog. Any id absent from that
response returns `400 ValidationFailed` on the `archetype` field before the
server creates a session row or asks the driver to allocate a browser. Fetch
the catalog at runtime or use its `default_archetype_id`; do not synthesize an
id from device/version strings.

When `profile_id` is supplied (2026-05-20, commit `fa8cb83a`) the
server inherits the profile's `archetype` as the default, stamps
`{profile_id, profile_name}` into the session's `metadata`, and
bumps the profile's `last_used_at` fire-and-forget. Cross-account
`profile_id` returns `404` (anti-enumeration — indistinguishable
from a missing one). See also `POST /v1/profiles/:id/launch` for
the one-round-trip launch helper.

Profile-backed launches inherit the already-stored profile archetype. This is a
compatibility path: an existing profile remains launchable if its pinned id is
no longer offered for new direct creates. The exception cannot be requested by
putting a retired id directly in a create-session body.

A profile can have only **one live session at a time**. If the
`profile_id` already has a non-terminal session, the create is
refused with `409 profile-in-use` (the body's `active_session_id`
names the live session) — this prevents two sessions on the same
profile from overwriting each other's saved cookies and logins.
End the named session (or wait for it to finish), then launch
again. Sessions without a `profile_id` are never affected.

`behavioral_profile` (2026-06-05) selects the per-session behavioural
persona the harness drives touch / scroll / typing cadence with — one
of `casual`, `regular`, or `power_user`. Defaults to `regular` when
omitted; set once for the session's lifetime.

Returns the created session (201).

The direct create endpoint does not accept a raw `proxy` field. Supplying one
returns `400` before a profile is looked up or a browser/session is created; it
is never silently stripped or treated as an egress safeguard. For
customer-controlled egress, create an agent session through
`POST /v1/agent-sessions` with the `proxy_id` of an owned saved
`/v1/account/me/proxies` configuration.

If deployment policy requires customer egress (`SESSION_PROXY_REQUIRED=true`,
or the inferred backend-present posture), this direct endpoint and
`POST /v1/profiles/:id/launch` fail closed for every body because neither has a
typed, consumed egress authority. Setting the flag to `false` preserves
proxy-free direct creation; it does not make a raw proxy object supported.

Errors:

- `400 ValidationFailed` — a directly supplied `archetype` is not present in
  the current selectable catalog.
- `400 Bad Request` — an explicit raw `proxy` field was rejected, or required
  egress policy has disabled this direct create surface.
- `429 ConcurrencyLimit` — concurrent-session cap hit.
- `404 NotFound` — `profile_id` refers to a profile that doesn't
  exist OR belongs to a different account.
- `409 profile-in-use` — the `profile_id` already has a live
  session (the body's `active_session_id` names it). End it first.

## List

`GET /v1/sessions?limit=50&cursor=<...>`

Cursor-paginated, newest-first.

## Get one

`GET /v1/sessions/:id` — fetch a single session resource. Returns
the full session record in the [Resource shape](#resource-shape)
above (`id`, `status`, `archetype`, `purpose`, `label`, `metadata`,
`egress_capabilities`, timestamps, etc.). Backs the SDK's
`sessions.get(id)`.

Returns `404` if the session id is unknown or belongs to a
different account (anti-enumeration — cross-account ids are
indistinguishable from missing ones).

For the live page state (`url`, `page_state`, cookies, screenshot
payload) rather than the resource record, use
[`GET /v1/sessions/:id/state`](#get-state) below.

## Navigate

`POST /v1/sessions/:id/navigate`

```json
{
  "url": "https://example.com/page",
  "wait_until": "load"
}
```

`wait_until`: `'load'` (default), `'domcontentloaded'`, or
`'networkidle'`. Returns `{ url, status, final_url, duration_ms }`
on success — `url` is the originally requested URL, `final_url`
reflects any HTTP redirects.

`502 DriverError` for navigation-time failures (DNS, TLS, network);
the session itself stays `ready` for a retry.

## Interact

`POST /v1/sessions/:id/interact`

The body wraps the typed action under `action` plus an optional
top-level `timeout_ms`:

```json
{
  "action": {
    "kind": "tap",
    "selector": "button#submit"
  },
  "timeout_ms": 5000
}
```

Supported discriminator values on `action.kind`:

- `tap` — `selector` (required).
- `type` — `selector` + `text` (max 10,000 chars) + optional
  `delay_ms` (requested inter-key delay, integer 0-500ms) + optional `sensitive` (boolean —
  mark card numbers / OTPs / PINs so the typing simulation makes
  no visible corrections; password fields get this automatically).
- `scroll` — optional `selector` + `delta_x` (default 0) + `delta_y`
  (default 0). Both integers; positive scrolls down/right.
- `press` — `key` (1-20 chars; e.g. `Enter`, `Tab`, `a`).

## Wait

`POST /v1/sessions/:id/wait`

The body wraps the typed condition under `condition` plus an
optional top-level `timeout_ms` (100ms – 120s):

```json
{
  "condition": {
    "kind": "selector",
    "selector": "div.results"
  },
  "timeout_ms": 5000
}
```

Supported `condition.kind` values per the WaitCondition
discriminated union in `packages/api-types/src/sessions.ts`:

- `selector` — wait for `selector` to appear in the DOM.
- `selector_hidden` — wait for `selector` to disappear from the
  DOM (or to be `display:none` / `visibility:hidden` / detached).
- `url_matches` — wait for the navigation URL to match the regex
  `pattern` (anchored at `^` is recommended).
- `time` — sleep for `ms` milliseconds (max 60,000). The
  `time` form counts toward your minute-meter.

## Get state

`GET /v1/sessions/:id/state` — returns the session's current `url`,
`title`, `cookies`, and `local_storage`, plus a `captured_at`
timestamp (subject to a payload-size cap). Useful for checkpoint-like
reads without a full screenshot.

Also includes `page_state` — the page lifecycle as the browser sees
it: `{ state: 'loading' | 'loaded' | 'errored' }`, with an `error`
object (`kind`: `http` / `tls` / `dns` / `net` / `timeout`, plus
`http_status` and `message`) when a navigation failed. `null` when
the session hasn't reported a lifecycle event yet (e.g. before the
first navigation).

A typical `page_state` after a failed navigation:

```json
{
  "url": "https://unreachable.example",
  "title": null,
  "page_state": {
    "state": "errored",
    "error": { "kind": "dns", "message": "Could not resolve host" }
  },
  "captured_at": "2026-06-11T18:00:00Z"
}
```

Use it to confirm a navigation succeeded before acting on the page —
poll `GET /v1/sessions/:id/state` after `navigate` until `page_state`
is `loaded` (proceed) or `errored` (branch on `error.kind`), rather
than guessing from a screenshot:

```js
await client.sessions.navigate(id, { url });
let state;
do {
  state = await client.sessions.getState(id);
} while (state.page_state?.state === 'loading');

if (state.page_state?.state === 'errored') {
  // e.g. 'dns' → bad host, 'http' → check error.http_status, 'tls' → cert
  throw new Error(`Navigation failed: ${state.page_state.error.kind}`);
}
```

## Capture

`POST /v1/sessions/:id/capture`

```json
{
  "kind": "screenshot",
  "full_page": false
}
```

`kind` is one of: `'screenshot'` (PNG, base64-encoded in
response), `'dom_snapshot'` (the serialised DOM as raw text), or
`'pdf'`. Screenshots cap at 4 MiB; PDFs at 8 MiB. The response
carries `encoding`: `'base64'` for screenshot+pdf, `'utf8'` for
`dom_snapshot`.

## Extract

`POST /v1/sessions/:id/extract`

```json
{
  "extractions": [
    { "name": "title", "selector": "h1", "type": "text" },
    { "name": "price", "selector": ".price", "type": "text", "transform": "number" },
    {
      "name": "products",
      "selector": "li.product",
      "type": "list",
      "extract": {
        "name": { "type": "text", "selector": ".name" },
        "href": { "type": "attribute", "attribute": "href", "selector": "a" }
      }
    }
  ]
}
```

Reads structured data from the page in one round trip: a batch of up to
100 named extractions, each a `selector` plus how to read it. `type` is
`'text'` (trimmed text content; add `"transform": "number"` to parse the
numeric part), `'attribute'` (reads the named `attribute`), or `'list'`
(every matched element — with an optional per-field `extract` map to pull
sub-fields from each one). Selectors are passed safely (never interpolated
into a script), so they can't inject. The response is `{ "value": { … } }`
keyed by each extraction's `name`:

```json
{ "value": { "title": "Example", "price": 19.99, "products": [{ "name": "A", "href": "/a" }] } }
```

## Search

`POST /v1/sessions/:id/search`

```json
{
  "query": "wireless headphones",
  "wait_for_results_selector": ".results"
}
```

Finds the search field, types `query` realistically (the behavioural
send-keys path), and submits. `search_selector` is optional — omit it and
the field is detected heuristically. `submit` defaults to `true` (set it
`false` to type without submitting). When `wait_for_results_selector` is
given, the call waits for that selector after submit and reports whether it
appeared (a timeout is `results_visible: false`, not an error). `timeout_seconds`
(1–120, default 10) caps that wait. The response:

```json
{ "submitted": true, "results_visible": true }
```

## Login

`POST /v1/sessions/:id/login`

```json
{
  "username": "user@example.com",
  "password": "••••••••",
  "success_selector": ".dashboard"
}
```

Heuristic credential login: types `username` then `password` realistically
and submits. The `password` is sent to the harness but **never logged**.
`username_selector` / `password_selector` / `submit_selector` are optional —
omit them and the fields are detected heuristically (submit falls back to
Return on the password field). `logged_in` is the post-submit assessment and
is **never a false positive** — a captcha / 2FA / login-required landing
yields `false`. Give `success_selector` for a robust signal on known or
multi-step logins (its post-submit presence means success); omit it and the
password-field-gone + URL heuristic is used. `timeout_seconds` (1–120, default 10) caps the post-submit success wait. `post_login_url` lets you drive a
challenge/pause flow when login didn't complete. Recipe-based login for a known
site is the separate `execute_recipe` surface, not this intent. The response:

```json
{ "logged_in": true, "post_login_url": "https://example.com/account" }
```

## Destroy

`DELETE /v1/sessions/:id`

Cleanly tears down the session. Returns `204 No Content`. Idempotent
on already-destroyed sessions. Frees the concurrent slot. Any
`session.completed` webhook subscriptions fire after the row
flips to `destroyed`.

## Auth + scoping

Read endpoints (GET) accept any valid bearer with `read` scope.
Write endpoints (POST navigate / interact / wait / capture / extract / search / login; DELETE)
require the `write:sessions` scope (a broad `write` key also satisfies
it). Team RBAC: `X-Driftstack-Account` is honored — a `member` can read
the owner's sessions, but writes require the `admin` role (a `member`
write returns 403).

## Errors common to every endpoint

| Status | Type                    | When                                                            |
| ------ | ----------------------- | --------------------------------------------------------------- |
| 401    | `unauthorized`          | Missing / invalid bearer                                        |
| 403    | `forbidden`             | Scope missing (write on a read-only key)                        |
| 404    | `not-found`             | Session not found / not owned                                   |
| 410    | `session-destroyed`     | Session is `destroyed`; recreate                                |
| 504    | `session-timeout`       | An operation exceeded its time budget mid-call                  |
| 502    | `driver-error`          | Driver-level failure (network, crash)                           |
| 503    | `driver-not-integrated` | Real WebKit driver unavailable; the server is configured for it |
