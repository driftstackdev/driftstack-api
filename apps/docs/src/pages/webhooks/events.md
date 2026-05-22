---
layout: ../../layouts/DocLayout.astro
title: Webhook events catalog
description: Reference for every webhook event type the Driftstack API emits — payload shapes, signature verification, retry policy.
---

# Webhook events — catalog + payload shapes

— comprehensive reference for every webhook event type the
Driftstack control plane emits (or will emit). Source-of-truth for
the customer-facing `/api/webhook-events` docs page on the marketing
site (when it lands as a Tier 3 visual surface).

> **Status notation**: events are tagged
> [LIVE] (declared in the enum + fired by a service emitter today),
> [DECLARED] (declared in the enum but no production emitter wired),
> [PLANNED] (not yet in the enum; queued for V-NNN).

## Quick index

| Event                               | Status     | When                                                             |
| ----------------------------------- | ---------- | ---------------------------------------------------------------- |
| `session.completed`                 | [LIVE]     | Session is destroyed cleanly                                     |
| `session.failed`                    | [LIVE]     | Session terminates in `errored` state                            |
| `api_key.revoked`                   | [LIVE]     | API key revoked (customer or admin)                              |
| `quota.warning_80pct`               | [DECLARED] | Account hits 80% of tier quota                                   |
| `quota.exceeded`                    | [DECLARED] | Account hits 100% of tier quota                                  |
| `test.ping`                         | [LIVE]     | Synthetic test event from POST /v1/webhooks/:id/test             |
| `session.egress_capability_changed` | [DECLARED] | Harness emitted an egress.capability_report for a SOCKS5 session |
| `crypto.order.paid`                 | [LIVE]     | NowPayments-backed order transitioned to `paid` (V-666)          |
| `crypto.order.failed`               | [LIVE]     | Crypto order moved to terminal `failed` (timeout/refund/expired) |
| `session.created`                   | [PLANNED]  | Session transitions `creating` → `ready`                         |
| `session.destroyed`                 | [PLANNED]  | Distinct from `session.completed` (no semantic shift)            |
| `profile.created`                   | [PLANNED]  | New profile created                                              |
| `profile.deleted`                   | [PLANNED]  | Profile deleted                                                  |
| `api_key.minted`                    | [PLANNED]  | New API key issued                                               |
| `subscription.changed`              | [PLANNED]  | Tier changed via Stripe                                          |
| `subscription.cancelled`            | [PLANNED]  | Subscription cancelled                                           |
| `trial_pack.purchased`              | [PLANNED]  | $2.99 trial pack purchased                                       |
| `trial_pack.expired`                | [PLANNED]  | Trial pack expired (14-day window closed)                        |
| `webhook_endpoint.created`          | [PLANNED]  | New webhook endpoint registered                                  |
| `webhook_endpoint.deleted`          | [PLANNED]  | Webhook endpoint deleted                                         |

## Common envelope

Every webhook delivery is a `POST` to the customer's registered URL
with the following envelope:

```json
{
  "id": "evt_<uuid>",
  "type": "<event-type>",
  "account_id": "acc_<uuid>",
  "emitted_at": "2026-05-05T12:34:56.789Z",
  "data": {
    /* per-event-type shape, see below */
  }
}
```

Headers:

- `Content-Type: application/json`
- `Driftstack-Signature: t=<unix-seconds>,v1=<hex>` —
  HMAC-SHA256(`<emitted_at_seconds>.<raw body>`) keyed by the
  endpoint signing secret. Verification reference:
  `packages/sdk-typescript/src/webhook-signature.ts` (TS),
  `packages/sdk-go/webhook_signature.go` (Go),
  `packages/sdk-python/src/driftstack/webhook_signature.py` (Py).
- `Driftstack-Event-Id: evt_<uuid>` — duplicate of `data.id`,
  surfaces in HTTP logs without parsing the body.
- `Driftstack-Delivery-Attempt: <n>` — increments on each retry.

Retry policy: 5 attempts with exponential backoff at 1m, 5m, 30m,
2h, 12h. Final failures land in DLQ
(see `docs/api/webhooks.md` and the admin /webhook-dlq page).

Idempotency: every delivery includes the same `evt_<uuid>`. Customers
should dedup on this id — the same event may be re-delivered after a
manual replay (admin tooling) or DLQ requeue.

## Event payloads

### `session.completed` [LIVE]

Fires when `DELETE /v1/sessions/:id` lands on a session in a
non-terminal state. The destroy path is idempotent; this event fires
exactly once per logical destroy.

```json
{
  "session_id": "ses_<uuid>",
  "duration_ms": 245000
}
```

Emitter: `apps/server/src/services/sessions.ts` `destroy()`.

### `session.failed` [LIVE]

Fires when a session transitions to `errored` (driver failure,
unrecoverable error during navigate / interact / capture / etc.).
The session's `destroyed_at` is set; subsequent ops on the session
return 410.

```json
{
  "session_id": "ses_<uuid>",
  "duration_ms": 12300,
  "operation": "navigate",
  "error_name": "DriverTimeoutError",
  "error_message": "Page load exceeded 30000ms"
}
```

Emitter: `runWithFailureCapture()` in `services/sessions.ts`.

### `api_key.revoked` [LIVE]

Fires whenever an API key is revoked, regardless of who initiated
the revocation (account_owner via `DELETE /v1/api-keys/:id` OR
driftstack_internal_admin via `POST /v1/admin/api-keys/:id/revoke`).
The revoking party is **not** carried in this event — refer to the
audit log for full provenance.

```json
{
  "api_key_id": "key_<uuid>",
  "name": "production",
  "revoked_at": "2026-05-05T12:34:56.789Z"
}
```

Emitter: `apps/server/src/services/api-keys.ts` `revoke()`.

### `quota.warning_80pct` [DECLARED]

**Will** fire when an account's metered usage hits 80% of the tier's
quota. Currently declared in the enum but not wired to a usage-
threshold check — see V-NNN follow-up.

Planned shape:

```json
{
  "tier": "api_builder",
  "metric": "session_minutes",
  "used": 4000,
  "limit": 5000,
  "percentage": 80,
  "period_start": "2026-05-01T00:00:00.000Z",
  "period_end": "2026-06-01T00:00:00.000Z"
}
```

### `quota.exceeded` [DECLARED]

**Will** fire when an account hits 100% of the tier quota. Same wiring
gap as `quota.warning_80pct`.

Planned shape:

```json
{
  "tier": "api_builder",
  "metric": "session_minutes",
  "used": 5000,
  "limit": 5000,
  "percentage": 100,
  "period_start": "2026-05-01T00:00:00.000Z",
  "period_end": "2026-06-01T00:00:00.000Z"
}
```

### `test.ping` [LIVE]

Synthetic test event emitted by `POST /v1/webhooks/:id/test`
. Fires REGARDLESS of subscription so customers can verify
their handler signature-checks correctly without subscribing to it.
Customers cannot subscribe to `test.ping` (the create / update Zod
schemas reject it); the test endpoint dispatches once per call.

Payload:

```json
{
  "id": "<uuid>",
  "type": "test.ping",
  "created_at": "2026-05-09T22:30:00.000Z",
  "data": {
    "message": "Test event from the Driftstack dashboard.",
    "endpoint_id": "whk_<endpoint-uuid>",
    "triggered_by_account_id": "acc_<caller-account-uuid>"
  }
}
```

Sent over the same delivery infrastructure as production events:
HMAC-signed, retried on failure per the standard backoff schedule,
audit-logged as `webhook_delivery.replayed` with
`payload.via: send_test_event`.

### `session.egress_capability_changed` [DECLARED]

Fires when the WebKit-fork harness emits an
`egress.capability_report` event for a SOCKS5 session and the
control plane ingests it. Carries the same shape as the
`egress_capabilities` field on `GET /v1/sessions/{id}` —
subscribers can branch on `udp_associate`, `dns_remote_resolve`,
`quic_route`, or `warnings` without a follow-up GET.

Subscribable — add it to your webhook endpoint's `events` array
to wire proxy-health visibility into your own observability
surface.

`[DECLARED]` because the schema + pgEnum + emitter plumbing is in
place but the harness side (Agent 1 scope per planning 133) has
not yet shipped the event source. Once the harness emits, this
moves to `[LIVE]`.

```json
{
  "id": "wev_<uuid>",
  "type": "session.egress_capability_changed",
  "created_at": "2026-05-18T12:00:00Z",
  "data": {
    "session_id": "ses_<uuid>",
    "egress_capabilities": {
      "udp_associate": true,
      "quic_route": "proxy",
      "dns_remote_resolve": false,
      "warnings": []
    }
  }
}
```

### `crypto.order.paid` / `crypto.order.failed` [LIVE]

V-666 — fires when a NowPayments-backed crypto checkout order
transitions to a terminal state. Wired end-to-end 2026-05-22
(migration 0064 + bootstrap WebhooksService emitter sink).

`crypto.order.paid`:

```json
{
  "event_type": "crypto.order.paid",
  "data": {
    "order_id": "ord_a1b2c3d4e5f6",
    "product": "solo_manual",
    "price_cents": 7900,
    "price_currency": "USD",
    "payment_id": "12345678",
    "paid_at": "2026-05-22T10:30:00Z"
  }
}
```

`crypto.order.failed`:

```json
{
  "event_type": "crypto.order.failed",
  "data": {
    "order_id": "ord_a1b2c3d4e5f6",
    "product": "solo_manual",
    "price_cents": 7900,
    "price_currency": "USD",
    "payment_id": "12345678",
    "failed_at": "2026-05-22T10:35:00Z",
    "reason": "expired"
  }
}
```

`reason` is one of: `expired` (20-min payment window elapsed),
`timeout` (NowPayments returned a terminal timeout), `refunded`
(NowPayments marked the order refunded — full refunds map to
`failed`; partial refunds stay `partial`), `cancelled`
(customer-initiated abandonment), `swept` (admin cleanup of
stuck pending orders past the staleness threshold).

See [Crypto checkout API](../api/billing-crypto) for the full
order lifecycle + status state machine. The webhook event mirrors
the same `events[]` log shape returned by `GET /v1/billing/crypto-
orders`.

## Planned events (not yet in enum)

The following events are queued for future V-NNN entries. Adding a
new event type is a Class A schema migration (additive enum value)
plus an emitter in the relevant service plus an SDK type bump
across TS / Python / Go.

### `session.created` [PLANNED]

Fires when a session transitions `creating` → `ready`. Useful for
async-job customers who want to know "the session is now usable"
without polling. Distinct from the API-call response on
`POST /v1/sessions` (which returns at the `creating` state).

### `session.destroyed` [PLANNED]

A more general counterpart to `session.completed`. Where
`session.completed` semantically means "successful end-of-life",
`session.destroyed` would mean "any end-of-life including
admin-forced destroy". Worth landing if customers want the
super-set; today the existing pair (`completed` for happy path,
`failed` for error path) covers admin-destroy as `failed`. Defer.

### `profile.created` / `profile.deleted` [PLANNED]

Mirror of `api_key.revoked` for profile lifecycle. Useful when
profiles are managed programmatically via the SDK and a separate
system tracks them.

### `api_key.minted` [PLANNED]

Counterpart to `api_key.revoked`. Useful for SOC2-adjacent customer
auditing where the customer wants every key issuance recorded
externally.

### `subscription.changed` / `subscription.cancelled` [PLANNED]

Stripe webhook handler-driven. When the customer changes tier or
cancels via the Stripe customer portal, a Driftstack-side webhook
fires so the customer's own systems can react (e.g. update billing
dashboards).

### `trial_pack.purchased` / `trial_pack.expired` [PLANNED]

Trial-pack-specific lifecycle events. `purchased` fires on the Stripe
checkout completion event; `expired` fires from the trial-pack
expiry job (which doesn't yet exist — see notes).

### `webhook_endpoint.created` / `webhook_endpoint.deleted` / `webhook_endpoint.secret_rotated` [PLANNED]

Self-meta events: a webhook fires when a webhook endpoint is
registered, deleted, or its signing secret rotated .
Useful for change-tracking systems. Recursion risk is low (the
endpoint that fires the event is one of multiple endpoints, not
the one being created/deleted/rotated).

For now these events land in the audit log
(`webhook_endpoint.created` / `.deleted` / `.updated` /
`.secret_rotated`) but are not delivered as webhooks. If you want
to react programmatically to webhook config changes today, poll
the `GET /v1/account/audit-log?action=webhook_endpoint.created`
filter.

## Subscribing to events

Customers register webhook endpoints via
`POST /v1/webhooks { url, events: [...], description? }`. The
`events` array is a closed enum subset — the response 400s if any
unknown event type is supplied. Adding a new event to your existing
endpoint requires deleting + re-creating the endpoint (V-NNN follow-
up: in-place `events` update).

The plaintext signing secret is returned **once** in the create
response. Store it server-side; the Driftstack API never returns it
again. To rotate, delete + re-create the endpoint.

## Verification

Every SDK ships a verification helper:

- TS: `verifyWebhookSignature({ secret, header, body, toleranceSec })`
  in `packages/sdk-typescript/src/webhook-signature.ts`.
- Go: `VerifyWebhookSignature` in `packages/sdk-go/webhook_signature.go`.
- Python: `verify_webhook_signature` in
  `packages/sdk-python/src/driftstack/webhook_signature.py`.

All three follow the same Stripe-adjacent pattern: parse `t=` and
`v1=` from the header, recompute HMAC-SHA256(`<t>.<body>`), constant-
time compare.

## Failure modes

A delivery is considered "successful" only if your endpoint returns
HTTP 2xx within the 10s timeout. Any other outcome (5xx, timeout,
connection refused, DNS failure) marks the attempt failed; the
delivery scheduler picks it up at the next retry slot.

After 5 failed attempts the delivery lands in DLQ. DLQ deliveries
are visible in the admin panel
(`admin.driftstack.dev/webhook-dlq`) — staff can manually requeue
them after investigating the failure.

The endpoint is **not** auto-disabled on consecutive failures today.
Auto-disable after N consecutive failures is a planned safety net
(V-NNN); until it lands, customers should monitor the
`consecutive_failures` field on `GET /v1/webhooks` to detect a
drifting endpoint.

## Subscription model

Two related but distinct enums in `packages/api-types/src/webhooks.ts`:

- **`WebhookEventType`** — every event the server CAN emit.
  Includes `test.ping`.
- **`SubscribableWebhookEventType`** — events a customer can
  subscribe to via `POST /v1/webhooks` or update via
  `PATCH /v1/webhooks/:id`. Excludes `test.ping`.

The distinction matters because `test.ping` only fires from the
explicit `POST /v1/webhooks/:id/test` endpoint regardless of
subscription — subscribing to it would be meaningless. The
update-subscription validator rejects `test.ping` with a 400
`validation-failed` problem detail.

### Subscribing to a subset

```json
POST /v1/webhooks
{
  "url": "https://your-app.example/driftstack-hook",
  "events": ["session.completed", "session.failed"]
}
```

The endpoint receives ONLY events whose type matches the
subscription set. Adding more events later via PATCH is a no-
historical-replay operation — past deliveries against the old
subscription stay delivered/failed/DLQ as they were; only future
events count.

### Subscribing to every (subscribable) event

Pass the full subscribable enum:

```json
POST /v1/webhooks
{
  "url": "https://your-app.example/driftstack-hook",
  "events": [
    "session.completed",
    "session.failed",
    "quota.warning_80pct",
    "quota.exceeded",
    "api_key.revoked",
    "session.egress_capability_changed",
    "crypto.order.paid",
    "crypto.order.failed"
  ]
}
```

There's no shorthand for "subscribe to all" — the explicit list
is the only way. This is intentional: when we add a new
subscribable event in the future (per the [PLANNED] queue
above), existing endpoints don't auto-subscribe and start
receiving deliveries the customer didn't expect. Customers
opt-in to new events explicitly.

### `test.ping` separately

```json
POST /v1/webhooks/:id/test
```

No request body. The endpoint dispatches a one-off
`test.ping` event with a short stub payload through the same
delivery infrastructure (HMAC-signed, retried on failure,
audit-logged). Lets customers verify their handler signature-
checks correctly before relying on it for production events.

## Related

- Webhook resource: `apps/server/src/routes/webhooks.ts`
- Webhook delivery service:
  `apps/server/src/services/webhooks.ts` +
  `apps/server/src/services/durable-webhook-delivery.ts`
- DLQ admin operations: `apps/admin-panel/src/pages/webhook-dlq.astro`
  — adds the `endpoint_id` drill-down filter
- Stripe webhook signature (the inverse direction — Stripe → us):
  `apps/server/src/lib/stripe-signing.ts` and
  `docs/deployment/stripe-webhook-testing.md`
