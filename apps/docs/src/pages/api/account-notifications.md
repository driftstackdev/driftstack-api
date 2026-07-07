---
layout: ../../layouts/DocLayout.astro
title: Account notifications (SSE)
description: Real-time per-account event stream — cost-threshold alerts, incident broadcasts, high-severity audit events, and session errors.
---

# Account notifications

A single Server-Sent Events stream for every notification scoped to
the calling account. Use it to power a "what's happening on my
account right now" panel without N poll-loops.

The stream is a v0 surface (2026-05-20) and is read-only — it doesn't
replace the durable audit log or the email channel. It's an
additive, low-latency notification path.

## Stream notifications

`GET /v1/account/me/notifications`

Auth: bearer token via `Authorization: Bearer <token>` header OR
`?ds_token=<token>` query-string fallback. The browser `EventSource`
API can't set custom headers, so the query-string fallback exists for
that case (the same contract as the [transcript stream](/api/agent-sessions/));
the header still wins when both are supplied. Server-side runtimes that
can set headers (Tauri's invoke bridge, Node's `eventsource` package,
etc.) should prefer the header.

## Frame shape

Each event in the stream uses the SSE `event:` header as a
discriminator and the `data:` line as a JSON-encoded payload.

```text
event: cost.threshold_alert
data: {"kind":"cost.threshold_alert","accountId":"acc_...","severity":"warn",…}

event: session.errored
data: {"kind":"session.errored","accountId":"acc_...","errorClass":"driver_error",…}
```

Subscribers can either:

- Use one `EventSource.addEventListener('cost.threshold_alert', …)`
  per kind (recommended — the native router does the dispatch), or
- Subscribe via `EventSource.onmessage` and switch on `payload.kind`
  from the parsed JSON.

A `: heartbeat <ISO8601>\n\n` comment frame fires every ~25 seconds
to keep load-balancers from closing idle connections. Ignore these.

## Event kinds (v0)

### `cost.threshold_alert`

Fires when an account crosses a tier-spend threshold (soft or hard,
in either direction).

| field                | type                                                             | notes                                      |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `kind`               | `"cost.threshold_alert"`                                         | discriminator                              |
| `accountId`          | `string`                                                         | calling account                            |
| `severity`           | `"warn" \| "critical" \| "resolved"`                             | `resolved` = spend dropped back below soft |
| `billingCycle`       | `string`                                                         | `YYYY-MM` UTC                              |
| `previousState`      | `"under-soft" \| "between-soft-and-hard" \| "over-hard" \| null` | `null` on first-ever evaluation            |
| `currentState`       | same enum                                                        |                                            |
| `totalCents`         | `number`                                                         | spend in the current cycle                 |
| `thresholdSoftCents` | `number`                                                         | soft cap                                   |
| `thresholdHardCents` | `number`                                                         | hard cap                                   |
| `at`                 | `string`                                                         | ISO8601 server publish time                |

### `incident.broadcast`

Fires when a public incident is posted, updated, or resolved.
(Live since 2026-07-07 — this kind was previously declared in the
type union with no publisher; the status-page incident lifecycle
now publishes it.) Incident frames are a platform-wide broadcast:
every account with an open stream receives the same incident,
stamped with its own `accountId`. The frame carries the incident's
current severity and title — for full detail (affected components,
update history, resolution state), query the
[status endpoints](/api/status/).

| field        | type                             | notes                       |
| ------------ | -------------------------------- | --------------------------- |
| `kind`       | `"incident.broadcast"`           |                             |
| `accountId`  | `string`                         | calling account             |
| `incidentId` | `string`                         | `inc_…`                     |
| `severity`   | `"minor" \| "major" \| "outage"` |                             |
| `title`      | `string`                         | short headline              |
| `at`         | `string`                         | ISO8601 server publish time |

### `audit.high_severity`

Selective republish from the audit log for high-severity actions
(e.g. `api_key.revoked`, `account.byok_anthropic_key_set`, `team.member_removed`).
Low-severity events stay in the audit log only — query
`GET /v1/account/audit-log` for the full ledger.

| field              | type                                | notes                       |
| ------------------ | ----------------------------------- | --------------------------- |
| `kind`             | `"audit.high_severity"`             |                             |
| `accountId`        | `string`                            |                             |
| `action`           | `string`                            | canonical audit action enum |
| `actorType`        | `"customer" \| "admin" \| "system"` |                             |
| `targetResourceId` | `string \| null`                    | e.g. `key_…`                |
| `at`               | `string`                            | ISO8601                     |

### `session.errored`

Fires when a session's driver hits a terminal error before the
customer-initiated destroy.

| field        | type                | notes                          |
| ------------ | ------------------- | ------------------------------ |
| `kind`       | `"session.errored"` |                                |
| `accountId`  | `string`            |                                |
| `sessionId`  | `string`            | `ses_…`                        |
| `errorClass` | `string`            | e.g. `driver_error`, `timeout` |
| `at`         | `string`            | ISO8601                        |

## Reconnect + persistence

The bus is in-memory only — events with no live subscribers are
dropped on the floor. `EventSource`'s native auto-reconnect (default
3s backoff) is the v0.1 reconnect story; transient drops resume
without any app-level glue.

There is no `Last-Event-ID` resume in v0.1; the next v0.2 slice will
add a small per-account ring buffer once a customer concretely asks
for one. For the durable trail of any event covered by
`audit.high_severity`, query `GET /v1/account/audit-log`.

## Quotas + rate-limit

One concurrent subscriber per account is plenty in v0; the SSE
route shares the same `global` rate-limit bucket as every other
authenticated read. Opening additional subscribers on the same
account works but offers no benefit (every subscriber sees every
event).

## Customer example (TypeScript)

The stream is plain SSE — no SDK helper is needed. In a browser (or
any runtime with `EventSource`), pass the token via `?ds_token=`
since `EventSource` can't set headers:

```ts
const es = new EventSource(
  `https://api.driftstack.dev/v1/account/me/notifications?ds_token=${KEY}`,
);

es.addEventListener('cost.threshold_alert', (e) => {
  const event = JSON.parse(e.data);
  showToast(`Cost ${event.severity}: $${event.totalCents / 100}`);
});

es.addEventListener('session.errored', (e) => {
  const event = JSON.parse(e.data);
  showBanner(`Session ${event.sessionId} errored: ${event.errorClass}`);
});

// later, on app teardown:
es.close();
```

Server-side runtimes that can set headers should send
`Authorization: Bearer <token>` instead of the query-string token.

Full design notes live at
`docs/internal/driftstack-telemetry-event-schema-for-gui-panel.md`
in the source repo.
