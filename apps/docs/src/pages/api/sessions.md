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

Each tier caps simultaneously-active sessions:

| Tier          | Concurrent sessions |
| ------------- | ------------------: |
| Trial pack    |                   1 |
| Solo manual   |                   1 |
| Team manual   |                   3 |
| Agency manual |                  10 |
| API starter   |                   2 |
| API builder   |                   5 |
| API scale     |                  20 |
| Enterprise    |              custom |

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
  "created_at": "2026-05-09T22:00:00.000Z",
  "updated_at": "2026-05-09T22:00:30.000Z",
  "last_state_at": "2026-05-09T22:00:30.000Z",
  "destroyed_at": null
}
```

`status` is one of `creating`, `ready`, `busy`, `destroyed`,
`errored`. The SDK's `sessions.create()` blocks until `ready`; any
intermediate `creating` state isn't directly observable.

`purpose` selects the WebKit driver harness configuration (V-169).
`production_customer` is the default; the other values
(`cumulative_rig_validation`, `test_domain_probe`,
`fingerprint_probe`, `behavioural_capture`) are reserved for
Driftstack-internal ops.

`label` is a free-form short string (max 120 chars) for the
customer's own identification — surfaced in dashboards + the
audit log. `metadata` is an arbitrary JSON object for the
customer's own bookkeeping.

`last_state_at` is the most recent `getState` / `capture` /
`navigate` / `interact` / `wait` ack timestamp. `updated_at`
reflects any server-side state mutation (status changes,
metadata writes).

## Create

`POST /v1/sessions`

```json
{
  "archetype": "iphone16pro_ios18_7_safari26_4",
  "purpose": "production_customer",
  "label": "login flow",
  "metadata": { "ticket": "SUP-42" }
}
```

All fields optional. `archetype` defaults to the locked iPhone-16
Pro / iOS / Safari archetype when omitted (V-136 LOCKED_ARCHETYPE_ID).
`purpose` defaults to `production_customer`.

Returns the created session (200).

Errors:

- `429 ConcurrencyLimit` — concurrent-session cap hit.

> **Profile binding is planned (V-294 catalog), not yet wired.** A
> future addition lets `POST /v1/sessions` accept `profile_id` to
> bind the session to a persistent profile (V-081), with the
> profile's `last_used_at` updated on session destroy + the
> profile's underlying browser state restored on session start.
> Today's API surface is profile-less; the binding lives in the
> driver layer for the dashboard's GUI client only. Customers
> using profiles via the SDK currently can't bind a session to a
> profile programmatically.

## List

`GET /v1/sessions?limit=50&cursor=<...>&status=<...>`

Cursor-paginated, newest-first. Optional `status` filter.

## Get one

`GET /v1/sessions/:id` — single session.

## Navigate

`POST /v1/sessions/:id/navigate`

```json
{
  "url": "https://example.com/page",
  "wait_for": "load"
}
```

`wait_for`: `'load'` (default), `'domcontentloaded'`, or
`'networkidle'`. Returns `{ status, current_url, title }` on success.

`502 DriverError` for navigation-time failures (DNS, TLS, network);
the session itself stays `ready` for a retry.

## Interact

`POST /v1/sessions/:id/interact`

```json
{
  "type": "tap",
  "selector": "button#submit"
}
```

Supported types: `tap`, `type`, `scroll`, `press`. Each carries
type-specific fields (`text` for `type`; `direction` + `pixels`
for `scroll`; `key` for `press`).

## Wait

`POST /v1/sessions/:id/wait`

```json
{
  "kind": "selector",
  "selector": "div.results",
  "timeout_ms": 5000
}
```

`kind`: `'selector'` (DOM appears), `'navigation'` (next nav
completes), or `'duration'` (just sleep). The `duration` form
counts toward your minute-meter.

## Get state

`GET /v1/sessions/:id/state` — returns the current DOM HTML +
viewport size + URL + cookies (subject to a payload-size cap).
Useful for checkpoint-like reads without a full screenshot.

## Capture

`POST /v1/sessions/:id/capture`

```json
{
  "kind": "screenshot",
  "full_page": false
}
```

`kind`: `'screenshot'` (PNG, base64-encoded in response) or
`'pdf'`. Screenshots cap at 4 MiB; PDFs at 8 MiB.

## Destroy

`DELETE /v1/sessions/:id`

Cleanly tears down the session. Returns `204 No Content`. Idempotent
on already-destroyed sessions. Frees the concurrent slot. Any
`session.completed` webhook subscriptions fire after the row
flips to `destroyed`.

## Auth + scoping

Read endpoints (GET) accept any valid bearer with `read` scope.
Write endpoints (POST navigate / interact / wait / capture; DELETE)
require `write`. Team RBAC: `X-Driftstack-Account` is honored —
member roles can read + write on the owner's sessions.

## Errors common to every endpoint

| Status | Type                    | When                                                            |
| ------ | ----------------------- | --------------------------------------------------------------- |
| 401    | `unauthorized`          | Missing / invalid bearer                                        |
| 403    | `forbidden`             | Scope missing (write on a read-only key)                        |
| 404    | `not-found`             | Session not found / not owned                                   |
| 410    | `session-destroyed`     | Session is `destroyed`; recreate                                |
| 408    | `session-timeout`       | Idle timeout reached mid-call                                   |
| 502    | `driver-error`          | Driver-level failure (network, crash)                           |
| 503    | `driver-not-integrated` | Real WebKit driver unavailable; the server is configured for it |
