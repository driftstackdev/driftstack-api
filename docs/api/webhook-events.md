# Webhook events — catalog + payload shapes

V-203 — comprehensive reference for every webhook event type the
Driftstack control plane emits (or will emit). Source-of-truth for
the customer-facing `/api/webhook-events` docs page on the marketing
site (when it lands as a Tier 3 visual surface).

> **Status notation**: events are tagged
> [LIVE] (declared in the enum + fired by a service emitter today),
> [DECLARED] (declared in the enum but no production emitter wired),
> [PLANNED] (not yet in the enum; queued for V-NNN).

## Quick index

| Event                      | Status     | When                                                  |
| -------------------------- | ---------- | ----------------------------------------------------- |
| `session.completed`        | [LIVE]     | Session is destroyed cleanly                          |
| `session.failed`           | [LIVE]     | Session terminates in `errored` state                 |
| `api_key.revoked`          | [LIVE]     | API key revoked (customer or admin)                   |
| `quota.warning_80pct`      | [DECLARED] | Account hits 80% of tier quota                        |
| `quota.exceeded`           | [DECLARED] | Account hits 100% of tier quota                       |
| `session.created`          | [PLANNED]  | Session transitions `creating` → `ready`              |
| `session.destroyed`        | [PLANNED]  | Distinct from `session.completed` (no semantic shift) |
| `profile.created`          | [PLANNED]  | New profile created                                   |
| `profile.deleted`          | [PLANNED]  | Profile deleted                                       |
| `api_key.minted`           | [PLANNED]  | New API key issued                                    |
| `subscription.changed`     | [PLANNED]  | Tier changed via Stripe                               |
| `subscription.cancelled`   | [PLANNED]  | Subscription cancelled                                |
| `trial_pack.purchased`     | [PLANNED]  | $2.99 trial pack purchased                            |
| `trial_pack.expired`       | [PLANNED]  | Trial pack expired (14-day window closed)             |
| `webhook_endpoint.created` | [PLANNED]  | New webhook endpoint registered                       |
| `webhook_endpoint.deleted` | [PLANNED]  | Webhook endpoint deleted                              |

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
expiry job (which doesn't yet exist — see V-202 notes).

### `webhook_endpoint.created` / `webhook_endpoint.deleted` [PLANNED]

Self-meta events: a webhook fires when a webhook endpoint is
registered or deleted. Useful for change-tracking systems. Recursion
risk is low (the endpoint that fires the event is one of multiple
endpoints, not the one being created/deleted).

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

## Related

- Webhook resource: `apps/server/src/routes/webhooks.ts`
- Webhook delivery service:
  `apps/server/src/services/webhooks.ts` +
  `apps/server/src/services/durable-webhook-delivery.ts` (V-173)
- DLQ admin operations: `apps/admin-panel/src/pages/webhook-dlq.astro`
  (V-189)
- Stripe webhook signature (the inverse direction — Stripe → us):
  `apps/server/src/lib/stripe-signing.ts` and
  `docs/deployment/stripe-webhook-testing.md`
