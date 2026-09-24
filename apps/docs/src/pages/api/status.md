---
layout: ../../layouts/DocLayout.astro
title: Status page API
description: Public status surface — overall health, component breakdown, incident feed (REST + SSE stream), 30-day SLA report, and double-opt-in email subscriptions.
---

# Status page API

The `/v1/status/*` surface backs the public Driftstack status site. It
is intentionally **unauthenticated** — visitors don't have accounts —
and rate-limited per IP. Snapshot and incident responses are cacheable
for 30 seconds (see the `Cache-Control` headers below).

## Snapshot

`GET /v1/status`

Returns the current health snapshot — overall status, per-component
breakdown, and the last 5 public incidents from the past 30 days.

Response (`200`):

```json
{
  "overall_status": "operational",
  "components": [
    { "name": "postgres", "status": "operational", "last_checked_at": "<ISO-8601>" },
    { "name": "redis", "status": "operational", "last_checked_at": "<ISO-8601>" },
    { "name": "r2", "status": "operational", "last_checked_at": "<ISO-8601>" }
  ],
  "recent_incidents": [
    {
      "id": "inc_<uuid>",
      "title": "Elevated session-create latency",
      "severity": "minor",
      "status": "monitoring",
      "started_at": "<ISO-8601>",
      "resolved_at": null
    }
  ]
}
```

`overall_status` and per-component `status` are one of:

- `operational` — the health check succeeded within its timeout
- `degraded` — the health check failed (transient error or timeout)
- `major_outage` — a service-wide outage affecting multiple components

Aggregation: any `major_outage` → overall `major_outage`; otherwise
any `degraded` → overall `degraded`; otherwise `operational`.

`Cache-Control: public, max-age=30` — the snapshot may be served from
cache for up to 30 seconds.

## Incident feed

`GET /v1/status/incidents`

Lists public incidents from the last 30 days (default), most-recent
first. The status site renders this as the incident timeline.

Query parameters:

| Parameter | Required | Notes                                    |
| --------- | -------- | ---------------------------------------- |
| `since`   | optional | ISO-8601 cutoff; defaults to 30 days ago |
| `limit`   | optional | 1–100; defaults to 50                    |

Response (`200`):

```json
{
  "data": [
    {
      "id": "inc_<uuid>",
      "title": "<string>",
      "description": "<string>",
      "severity": "minor | major | outage",
      "status": "investigating | identified | monitoring | resolved",
      "affected_components": ["postgres", "redis"],
      "public": true,
      "started_at": "<ISO-8601>",
      "resolved_at": "<ISO-8601> | null",
      "created_at": "<ISO-8601>",
      "updated_at": "<ISO-8601>"
    }
  ]
}
```

`Cache-Control: public, max-age=30`.

## Incident detail

`GET /v1/status/incidents/{id}`

Returns the incident plus the full update timeline (investigation
posted → identified → monitoring → resolved).

Response (`200`):

```json
{
  "incident": {
    /* same shape as the list entry */
  },
  "updates": [
    {
      "id": "incu_<uuid>",
      "incident_id": "inc_<uuid>",
      "message": "<string>",
      "status": "investigating | identified | monitoring | resolved",
      "posted_at": "<ISO-8601>"
    }
  ]
}
```

Non-public incidents return `404` — the route deliberately returns the
same shape as "incident doesn't exist" so nobody can enumerate
private incidents.

## Live stream

`GET /v1/status/stream`

Server-Sent Events stream. Visitors with the status page open receive
every `incident.created` and `incident.resolved` event in real time
without needing to poll.

Event types emitted:

- `event: incident.created` — fires when a new public incident is
  opened
- `event: incident.resolved` — fires when a public incident transitions
  to `resolved`

`data:` payload (JSON) is the full event envelope:
`{ event, generated_at, incident, update }`, where `event` repeats the
SSE event name (`incident.created` / `incident.resolved`),
`generated_at` is an ISO timestamp, `incident` is the public incident
object (same shape as `GET /v1/status/incidents`), and `update` is the
incident update that triggered the event.

Heartbeat: a comment line is emitted every 30 seconds to keep the
connection alive through proxies. Comments start with `:` and are
ignored by EventSource clients per the SSE spec.

Example (TypeScript browser):

```ts
const stream = new EventSource('https://api.driftstack.dev/v1/status/stream');
stream.addEventListener('incident.created', (ev) => {
  const { generated_at, incident } = JSON.parse(ev.data);
  console.log(`[${generated_at}] new incident: ${incident.id} — ${incident.title}`);
});
stream.addEventListener('incident.resolved', (ev) => {
  const { incident } = JSON.parse(ev.data);
  console.log(`incident ${incident.id} resolved`);
});
```

Connection caps: the stream is public and unauthenticated, so it is
bounded — **10 concurrent connections per IP** and **500 in total**.
Past either, the request is refused with `503 feature-unavailable`
(`Status stream at capacity; retry shortly.`) and a `Retry-After: 30`
header, before the stream starts.

The per-IP figure is the one worth designing around: browsers open one
connection per tab, and everyone behind a single office NAT or corporate
proxy shares an address. `EventSource` reconnects on its own and will
keep retrying into the refusal, so a client that watches for the `error`
event and backs off for the advertised 30 seconds recovers cleanly, while
one that does not will loop.

## SLA report

`GET /v1/status/sla`

Rolling 30-day uptime per monitored target, computed from
Driftstack's automated health checks.

Response (`200`):

```json
{
  "data": [
    {
      "target": "<probe-target-name>",
      "uptimePct": 99.972,
      "totalProbes": 43200,
      "okCount": 43188,
      "failCount": 12,
      "lastProbeAt": "2026-08-11T14:59:00.000Z",
      "lastFailureAt": "2026-08-03T02:17:00.000Z",
      "windowStart": "2026-07-12T15:00:00.000Z",
      "windowEnd": "2026-08-11T15:00:00.000Z"
    }
  ]
}
```

Each target is checked every 60 seconds, so the 30-day window holds
~43,200 checks. `uptimePct` is `okCount / totalProbes * 100` rounded to
three decimal places, and is `100` for a target with no checks yet.
`lastFailureAt` is `null` when the target has not failed inside the
window. The window itself is reported as the `windowStart`/`windowEnd`
timestamps rather than a day count.

## Email subscriptions

Visitors can subscribe to email notifications for every public
incident. Double-opt-in — a confirmation email is sent before the
address is recorded as subscribed.

IP rate-limit: 3 requests per minute per IP on all three subscription
routes (subscribe / confirm / unsubscribe).

Per-address limit: at most 5 confirmation emails an hour and 10 in any
24 hours to one address, whoever asks. Past that `POST /v1/status/subscribe`
is refused `429` with `Retry-After` and a detail saying how long to wait
("Too many confirmation emails have been requested for this address. Try
again in 42 minutes.").

## Start subscription

`POST /v1/status/subscribe`

Body:

```json
{ "email": "alice@example.com" }
```

Response (`202`):

```json
{ "message": "Confirmation email sent. Click the link to finish subscribing." }
```

A token-bearing link is emailed to the address. The token is opaque
and expires after 24 hours.

## Confirm subscription

`GET /v1/status/subscribe/confirm?token=<opaque>`

Response (`200`):

```json
{ "message": "Subscription confirmed. You will receive incident notifications by email." }
```

After confirmation, the address receives an email for every
`incident.created` and `incident.resolved` event going forward.

## Unsubscribe

`GET /v1/status/subscribe/unsubscribe?token=<opaque>`

Response (`200`):

```json
{ "message": "Unsubscribed." }
```

Every status-incident email includes a one-click unsubscribe link
with a long-lived token; the same endpoint accepts that token.

## Errors

| Status | Type              | When                                                    |
| -----: | ----------------- | ------------------------------------------------------- |
|    400 | validation-failed | body / query failed schema                              |
|    404 | not-found         | non-public incident id, OR malformed `inc_<uuid>` value |
|    429 | rate-limited      | subscription rate-limit (3/min per IP) tripped          |

Subscriber-token errors (expired token, already-used confirm token)
also return `404` — surfacing them as distinct codes would let an
attacker probe whether a given token had been issued.

## Notes

- **Caching.** `/v1/status`, `/v1/status/incidents`, and the detail
  route all send `Cache-Control: public, max-age=30`; the status site
  polls at that interval.
- **Stream auth.** The stream endpoint is unauthenticated by design —
  there's no per-customer access concept on the status page — and
  capped per IP as described above.
- **Component checks.** Each component check runs with a 1.5 second
  timeout. A timeout counts as `degraded`, not `major_outage`.
