# Webhook events — catalog + payload shapes

This is the customer-facing reference for webhook events emitted by the
Driftstack control plane and the synthetic connectivity test event.

## Quick index

| Event                               | When                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| `session.completed`                 | Session is destroyed cleanly                           |
| `session.failed`                    | Session terminates in `errored` state                  |
| `api_key.revoked`                   | API key is revoked by a customer or administrator      |
| `test.ping`                         | Synthetic test event from `POST /v1/webhooks/:id/test` |
| `session.egress_capability_changed` | A session reports a changed SOCKS5 egress capability   |
| `crypto.order.paid`                 | A NowPayments-backed order transitions to `paid`       |
| `crypto.order.failed`               | A crypto order moves to terminal `failed`              |
| `session.challenge_detected`        | The session harness detects a supported bot challenge  |
| `session.profile_save_failed`       | Profile save-back fails to replace the stored profile  |

## Common envelope

Every webhook delivery is a `POST` to the customer's registered URL
with the following envelope:

```json
{
  "id": "<uuid>",
  "type": "<event-type>",
  "created_at": "2026-05-05T12:34:56.789Z",
  "data": {
    /* per-event-type shape, see below */
  }
}
```

Headers:

- `Content-Type: application/json`
- `X-Driftstack-Signature: t=<unix-seconds>,v1=<hex>` —
  HMAC-SHA256(`<t>.<raw body>`) keyed by the endpoint signing
  secret, where `<t>` is the `t=<unix-seconds>` value from this
  same header (NOT a body field). Verification reference:
  `packages/sdk-typescript/src/webhook-signature.ts` (TS),
  `packages/sdk-go/webhook_signature.go` (Go),
  `packages/sdk-python/src/driftstack/webhook_signature.py` (Py).
- `X-Driftstack-Event-Id: <uuid>` — duplicate of the top-level
  `id`, surfaces in HTTP logs without parsing the body.
- `X-Driftstack-Event-Type: <event-type>` — the delivered event
  type (e.g. `session.completed`), so handlers can route without
  parsing the body.

Retry policy: 6 attempts (the initial delivery plus 5 retries) with
exponential backoff at 1m, 5m, 15m, 30m, 60m. Final failures land in DLQ
(see `docs/api/webhooks.md` and the admin /webhook-dlq page).

Idempotency: every delivery includes the same `<uuid>` id. Customers
should dedup on this id — the same event may be re-delivered after a
manual replay (admin tooling) or DLQ requeue.

Ordering: deliveries are **not** ordered, and your handler must not
assume they are. A failed delivery is rescheduled onto the backoff
above, so it lands after events your account generated later — an event
that first fails and succeeds on its 15m retry arrives well behind
everything created in between. Delivery is also fair across endpoints
rather than strictly oldest-first, so one endpoint with a backlog cannot
hold up another's events. If ordering matters to your integration, use
the `created_at` timestamp in the payload rather than arrival order, and
treat an older event arriving after a newer one as normal.

## Event payloads

### `session.completed`

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

### `session.failed`

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

### `api_key.revoked`

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

### `test.ping`

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

### `session.egress_capability_changed`

Fires when the WebKit-fork harness emits an
`egress.capability_report` event for a SOCKS5 session and the
control plane ingests it. Carries the same shape as the
`egress_capabilities` field on `GET /v1/sessions/{id}` —
subscribers can branch on `udp_associate`, `dns_remote_resolve`,
`quic_route`, or `warnings` without a follow-up GET.

Subscribable — add it to your webhook endpoint's `events` array
to wire proxy-health visibility into your own observability
surface.

```json
{
  "id": "<uuid>",
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

### `crypto.order.paid`

### `crypto.order.failed`

Fires when a NowPayments-backed crypto checkout order
transitions to a terminal state. Wired end-to-end 2026-05-22
(migration 0064 + bootstrap WebhooksService emitter sink).

`crypto.order.paid`:

```json
{
  "type": "crypto.order.paid",
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
  "type": "crypto.order.failed",
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

`reason` is one of: `ipn` (a NowPayments IPN reported a terminal
non-paid status — a failed, refunded, or timed-out payment all surface
here), `expired` (the payment window — 60 minutes at checkout — elapsed
before payment landed and an operator expired the order), or `swept` (admin / cron cleanup of a stuck pending order past
the staleness threshold). These are the three values
`CryptoOrdersService` emits; the underlying NowPayments sub-status
(timeout / refunded / cancelled) is collapsed into `ipn`.

See [Crypto checkout API](/api/billing-crypto/) for the full
order lifecycle + status state machine. The webhook event mirrors
the same `events[]` log shape returned by `GET /v1/billing/crypto-
orders`.

### `session.challenge_detected`

Fires when the in-session harness ChallengeDetector flags a
bot-check (DataDome / Arkose / PerimeterX / AWS-WAF / GeeTest / … —
14 types) on the page the session is navigating. The harness
auto-pauses the session (no further action intents run) and surfaces
the challenge; resolve it (e.g. in the live view) and the session
resumes. Subscribable so you can route challenge alerts into your own
ops/notification surface. The relay resolves the owning account and
enqueues the webhook when the session harness reports the challenge.

```json
{
  "type": "session.challenge_detected",
  "data": {
    "session_id": "ses_a1b2c3d4e5f6",
    "challenge_id": "chl_9f8e7d6c",
    "challenge": {
      "type": "datadome",
      "confidence": 0.94,
      "detail": "interstitial captcha"
    }
  }
}
```

### `session.profile_save_failed`

Fires when a profile-backed session's save-back does not replace the
stored profile at teardown. The browsing session itself **succeeded**.
For failure reasons, the updated store (cookies / logins / browser
state from this run) could not be persisted, so the **next restore of
this profile will be stale**; the harness's internal upload retry is
already exhausted and there is no later retry path. `reason` is one of `serialize_failed`, `seal_failed`,
`too_large` (the sealed store exceeded the 256 MiB cap),
`upload_failed`, or `degenerate_dump` (the dump was empty/malformed
and would have clobbered a known-good prior store — the prior is
preserved, so this one is reassuring rather than data loss), or
`superseded` (a newer profile write won and the stale conditional save
was safely refused; the next restore uses the newer state, so this is
benign and not data loss). An unrecognized harness reason is folded into
`upload_failed` rather than dropping the event. Customers relying on
persisted profile state can subscribe and alert on it.

```json
{
  "type": "session.profile_save_failed",
  "data": {
    "session_id": "ses_a1b2c3d4e5f6",
    "profile_id": "prof_1f2e3d4c",
    "reason": "upload_failed",
    "detail": "presigned PUT returned 503"
  }
}
```

## Subscribing to events

Customers register webhook endpoints via
`POST /v1/webhooks { url, events: [...], description? }`. The
`events` array is a closed enum subset — the response 400s if any
unknown event type is supplied. Adding or removing events on an
existing endpoint is an in-place `PATCH /v1/webhooks/:id` with the new
`events` array — no delete/re-create needed.

The plaintext signing secret is returned **once** in the create
response. Store it server-side; the Driftstack API never returns it
again. To rotate without downtime, call
`POST /v1/webhooks/:id/rotate-secret` — Driftstack dual-signs every
delivery for a 24-hour grace window so you can roll the new secret out
before the old one stops working.

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

### Verifying without an SDK

If you integrate from a language without a Driftstack SDK, the scheme
is small enough to implement directly. Three rules matter:

1. **Sign the RAW request body** — recompute the HMAC over the exact
   bytes you received, _before_ any JSON parse/re-serialize. A
   re-serialized body almost never matches byte-for-byte and is the
   single most common verification failure.
2. **Reject stale timestamps** — if `now - t` exceeds your tolerance
   (the SDKs default to 300 seconds), treat the delivery as a possible
   replay and reject it.
3. **Constant-time compare**, and accept if _any_ `v1=` matches — the
   header carries two during the 24-hour secret-rotation grace window.

Node.js, no SDK:

```js
const crypto = require('node:crypto');

function verifyWebhook(secret, header, rawBody, toleranceSec = 300) {
  // header: "t=<unix-seconds>,v1=<hex>[,v1=<hex>]"
  const fields = header.split(',').map((p) => p.trim());
  const t = Number(fields.find((p) => p.startsWith('t='))?.slice(2));
  if (!Number.isFinite(t)) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // replay guard

  // Recompute over the RAW body — not a re-serialized JSON object.
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');

  // Accept if ANY v1= matches (two are present during a rotation grace window).
  return fields
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3))
    .some(
      (sig) =>
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)),
    );
}
```

## Failure modes

A delivery is considered "successful" only if your endpoint returns
HTTP 2xx within the 10s timeout. Any other outcome (5xx, timeout,
connection refused, DNS failure) marks the attempt failed; the
delivery scheduler picks it up at the next retry slot.

After 6 failed attempts (the initial delivery plus 5 retries) the
delivery lands in DLQ. DLQ deliveries
are visible in the admin panel
(`admin.driftstack.dev/webhook-dlq`) — staff can manually requeue
them after investigating the failure.

The endpoint **is** auto-disabled after 50 consecutive failed
deliveries. When `consecutive_failures` crosses 50 the worker sets
`disabled_at` and stops delivering to it. A disabled endpoint is a
sticky tombstone — it is **not** automatically re-enabled by a later
success; you mint a new endpoint to resume delivery. Monitor the
`consecutive_failures` field on `GET /v1/webhooks` to catch a
drifting endpoint before it trips the auto-disable threshold.

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
subscription stay delivered/failed/DLQ as they were; only events created
after the update use the new selection.

### Subscribing to every (subscribable) event

Pass the full subscribable enum:

```json
POST /v1/webhooks
{
  "url": "https://your-app.example/driftstack-hook",
  "events": [
    "session.completed",
    "session.failed",
    "api_key.revoked",
    "session.egress_capability_changed",
    "crypto.order.paid",
    "crypto.order.failed",
    "session.challenge_detected",
    "session.profile_save_failed"
  ]
}
```

There's no shorthand for "subscribe to all" — the explicit list is the
only way. An endpoint receives only the event types it selected.

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
