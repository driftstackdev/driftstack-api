---
layout: ../../layouts/DocLayout.astro
title: Webhook endpoints
description: Subscribe to events, list / patch / delete endpoints, send test deliveries, and rotate signing secrets — the /v1/webhooks resource.
---

# Webhook endpoints

A **webhook endpoint** is a customer-controlled HTTPS URL that
Driftstack POSTs event payloads to. Each endpoint subscribes to one
or more event types (see the [event catalog](/webhooks/events/))
and ships with a signing secret your handler verifies on every
inbound delivery.

## Resource shape

```json
{
  "id": "whk_<uuid>",
  "url": "https://example.com/driftstack-webhook",
  "secret_prefix": "whsec_a1b2c3",
  "prev_secret_prefix": null,
  "rotation_grace_expires_at": null,
  "events": ["session.completed", "session.failed"],
  "description": "prod scrape pipeline",
  "active": true,
  "consecutive_failures": 0,
  "last_success_at": "2026-05-09T22:00:00.000Z",
  "last_failure_at": null,
  "disabled_at": null,
  "delivery_counts": { "delivered": 12345, "failed": 12, "dlq": 0 },
  "created_at": "2026-04-15T11:30:00.000Z"
}
```

- `secret_prefix` is the first 12 chars of the plaintext secret.
  Safe to log + display; the full secret is shown ONCE at create
  / rotate time.
- `prev_secret_prefix` + `rotation_grace_expires_at` are null
  except during the 24-hour grace period after a secret rotation
  . When non-null, Driftstack is dual-signing every outbound
  delivery: the single `x-driftstack-signature` header carries
  BOTH HMACs as two comma-separated `v1=` entries
  (`t=<sec>,v1=<new>,v1=<old>`), so customers can roll the new
  secret across their verifier infrastructure without dropped
  deliveries. There is no separate header — one signature header
  carries both signatures.
- `consecutive_failures` increments on each failed delivery + zeros
  on the next success. After enough consecutive failures, the
  endpoint auto-disables (`disabled_at` set) — you'll need to
  re-create the endpoint to re-enable.
- `events` is the subscription list. Only subscribable event types
  count here; `test.ping` is delivery-side-only and is rejected if
  passed in the events array .

## Subscribe (create)

`POST /v1/webhooks`

```json
{
  "url": "https://example.com/driftstack-webhook",
  "events": ["session.completed", "session.failed"],
  "description": "prod scrape pipeline"
}
```

URL must use `https://`. Returns the endpoint shape PLUS the full
plaintext signing secret in `secret`:

```json
{
  "id": "whk_<uuid>",
  "secret": "whsec_<32 chars base32>",
  ...
}
```

> **Save the secret now.** It's shown ONCE; Driftstack stores a versioned
> AES-256-GCM envelope and decrypts it only in the delivery worker while
> signing. Subsequent reads return the prefix, never the plaintext secret.

Errors:

- `400 ValidationFailed` — URL not https://, or events array empty
  / >10 entries / contains `test.ping`.
- `403 Forbidden` — `account_owner` scope missing on the calling key.
- `409 Conflict` — max 10 active endpoints.

## List + get

`GET /v1/webhooks` — list every endpoint owned by the calling
account. No pagination yet; sorted newest-first.

`GET /v1/webhooks/:id` — single endpoint. 404 if not found / not
owned.

## Update

`PATCH /v1/webhooks/:id`

```json
{
  "url": "https://example.com/driftstack-webhook-v2",
  "events": ["session.completed"],
  "description": "after migration",
  "active": false
}
```

All fields optional; pass any subset. Empty body is rejected (400).

`active: false` pauses delivery without deleting the endpoint;
useful for maintenance windows or post-incident cooldowns. Resume
with `active: true`.

`409 Conflict` if the endpoint is soft-deleted (`disabled_at` is
set); the row is a tombstone, mint a fresh endpoint instead.

## Delete

`DELETE /v1/webhooks/:id`

Soft-deletes the endpoint by setting `disabled_at`. Pending
deliveries fail terminally (no retry); historical deliveries stay
queryable for the standard retention window. Idempotent — re-
deletes return 204 no-op.

## Send test

`POST /v1/webhooks/:id/test`

Enqueues a synthetic `test.ping` delivery to the endpoint
regardless of subscription. Lets you verify your handler is
reachable + signature-verifies before relying on the endpoint for
real events.

Returns `202 Accepted`:

```json
{
  "delivery_id": "wdl_<uuid>",
  "event_id": "<uuid>",
  "event_type": "test.ping"
}
```

The delivery flows through the same dispatcher as production events:
HMAC-signed, retried on failure per the standard backoff, audit-
logged as `webhook_delivery.replayed` with `payload.via:
send_test_event`.

`400 BadRequest` if the endpoint is paused (`active: false` OR
`disabled_at` set) — re-enable before testing.

## Rotate signing secret

`POST /v1/webhooks/:id/rotate-secret`

```json
{
  "id": "whk_<uuid>",
  "secret": "whsec_<32 chars new base32>",
  "secret_prefix": "whsec_d4e5f6",
  "prev_secret_prefix": "whsec_a1b2c3",
  "grace_expires_at": "2026-05-10T22:30:00.000Z"
}
```

The new plaintext is shown ONCE. The OLD secret stays valid for
24 hours (the `grace_expires_at` window). During that window
Driftstack dual-signs every outbound delivery: the single
`x-driftstack-signature` header carries BOTH HMACs as two
comma-separated `v1=` entries — `t=<sec>,v1=<new>,v1=<old>`
(new-secret HMAC first, old-secret HMAC second). There is no
separate `x-driftstack-signature-prev` header. The SDK helpers in
TypeScript / Python / Go already iterate every `v1=` entry in the
one header and accept a delivery if any of them matches, so they
verify rotation deliveries correctly from `x-driftstack-signature`
alone.

Steps to roll:

1. Call rotate-secret. Save the new plaintext.
2. Update your verifier to use the new secret. Both HMACs arrive
   in the single `x-driftstack-signature` header, so a verifier
   that checks every `v1=` entry needs no other change.
3. Deploy the verifier change across your fleet within 24 hours.
4. The old secret stops working at `grace_expires_at`; subsequent
   deliveries carry only the new-secret `v1=` entry.

`409 Conflict` if the endpoint is disabled. `403 Forbidden` if
`account_owner` scope is missing.

## Delivery introspection

`GET /v1/webhooks/:id/deliveries?limit=50&cursor=<...>&status=<...>`

Returns the most recent deliveries for the endpoint (every status,
not just failures). `status` filter accepts `pending`, `in_flight`,
`delivered`, `failed`, or `dlq`. Use this to debug a misbehaving
handler — the response includes `last_response_status`,
`last_response_excerpt` (up to ~4096-char preview of the response body),
and `last_error` (timeout / connection-refused / etc).

For replay see [/webhooks/replay](/webhooks/replay/).

## Auth + scoping

Read endpoints (GET) accept any valid bearer with `read` scope.
Write endpoints (POST, PATCH, DELETE, send-test, rotate-secret)
require `account_owner` scope (the dashboard scope; a broad `admin`
key also satisfies it via the V-174 alias). Team RBAC
(`X-Driftstack-Account` header) is honored: member roles can read
the owner's endpoints; admin members can also write.
