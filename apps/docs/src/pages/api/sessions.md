---
layout: ../../layouts/DocLayout.astro
title: Sessions
description: Create + drive iPhone Safari sessions — navigate, interact, wait, capture, get-state, destroy. Tier-gated concurrency.
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
| `trial_pack`    |                   1 |
| `solo_manual`   |                   1 |
| `team_manual`   |                   3 |
| `agency_manual` |                   8 |
| `api_starter`   |                   2 |
| `api_builder`   |                   8 |
| `api_scale`     |                  24 |
| `enterprise`    |                  32 |

Hitting the cap on `POST /v1/sessions` returns `429 Too Many
Requests` with a `Retry-After` header. Sessions auto-destroy after
their tier-default idle timeout (driver-managed).

## Resource shape

```json
{
  "id": "ses_<uuid>",
  "account_id": "acc_<uuid>",
  "api_key_id": "key_<uuid>",
  "status": "ready",
  "archetype": "iphone16pro_ios18_7_safari26_4",
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
  "archetype": "iphone16pro_ios18_7_safari26_4",
  "purpose": "production_customer",
  "label": "login flow",
  "metadata": { "ticket": "SUP-42" },
  "profile_id": "prof_01HV..."
}
```

All fields optional. `archetype` defaults to the locked iPhone-16
Pro / iOS / Safari archetype when omitted (LOCKED_ARCHETYPE_ID).
`purpose` defaults to `production_customer`.

When `profile_id` is supplied (2026-05-20, commit `fa8cb83a`) the
server inherits the profile's `archetype` as the default, stamps
`{profile_id, profile_name}` into the session's `metadata`, and
bumps the profile's `last_used_at` fire-and-forget. Cross-account
`profile_id` returns `404` (anti-enumeration — indistinguishable
from a missing one). See also `POST /v1/profiles/:id/launch` for
the one-round-trip launch helper.

Returns the created session (200).

Errors:

- `429 ConcurrencyLimit` — concurrent-session cap hit.
- `404 NotFound` — `profile_id` refers to a profile that doesn't
  exist OR belongs to a different account.

## List

`GET /v1/sessions?limit=50&cursor=<...>&status=<...>`

Cursor-paginated, newest-first. Optional `status` filter.

## Get one

`GET /v1/sessions/:id/state` — single session's current state. There
is no separate metadata-only path today; session metadata travels
alongside the live state response. See [Get state](#get-state) below
for the response shape.

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
  `delay_ms` (0-500ms between keystrokes; mock driver honours
  bounds, real driver clamps).
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

## Destroy

`DELETE /v1/sessions/:id`

Cleanly tears down the session. Returns `204 No Content`. Idempotent
on already-destroyed sessions. Frees the concurrent slot. Any
`session.completed` webhook subscriptions fire after the row
flips to `destroyed`.

## Auth + scoping

Read endpoints (GET) accept any valid bearer with `read` scope.
Write endpoints (POST navigate / interact / wait / capture; DELETE)
require `write`. Team RBAC: `X-Driftstack-Account` is honored — a
`member` can read the owner's sessions, but writes require the `admin`
role (a `member` write returns 403).

## Errors common to every endpoint

| Status | Type                    | When                                                            |
| ------ | ----------------------- | --------------------------------------------------------------- |
| 401    | `unauthorized`          | Missing / invalid bearer                                        |
| 403    | `forbidden`             | Scope missing (write on a read-only key)                        |
| 404    | `not-found`             | Session not found / not owned                                   |
| 410    | `session-destroyed`     | Session is `destroyed`; recreate                                |
| 504    | `session-timeout`       | Idle timeout reached mid-call                                   |
| 502    | `driver-error`          | Driver-level failure (network, crash)                           |
| 503    | `driver-not-integrated` | Real WebKit driver unavailable; the server is configured for it |
