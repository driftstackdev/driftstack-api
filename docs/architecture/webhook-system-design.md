# Webhook System — Design

> Status: design draft, ready for execution. Authored before implementation per the agent-discipline pattern from V-009 / phase-8-e2e-design.md. Will be revised in-flight if implementation surfaces issues; revisions captured as V-log entries.

## Goals

Customers calling the Driftstack API today get synchronous responses. For long-running and asynchronous events — sessions completing on their own, quotas burning through, keys getting revoked by an admin in a separate session — they need push notifications. Webhooks deliver these.

The system the customer sees:

1. Customer creates a webhook subscription via `POST /v1/webhooks`, supplying:
   - `url` (their HTTPS endpoint)
   - `events` (subset of the supported event types)
2. The API returns the new subscription including a generated `secret` (shown once, like API keys).
3. Driftstack-side events fan out to matching subscriptions; each subscription gets an HTTP POST with:
   - `Content-Type: application/json`
   - `X-Driftstack-Signature: t=<unix>,v1=<hex hmac>`
   - JSON body: `{ id, type, created_at, data: { ... } }`
4. Customer's endpoint verifies the signature with `verifyWebhookSignature` from `@driftstack/sdk`, then 2xx-acknowledges within 30 seconds.
5. On non-2xx, timeout, or network error, the delivery retries with exponential backoff up to 5 times over ~30 minutes; failed-after-5 deliveries land in the dead-letter queue.

## Non-goals

- **WebSocket / SSE streams.** That's a separate workstream (real-time session events, file 64 territory).
- **Bidirectional / interactive webhooks.** One-way notifications only.
- **Per-event filtering inside a subscription.** The granularity is `events: string[]` at subscription time. If finer filtering is needed, customers can run their own filter in their endpoint.
- **Customer-side retry orchestration.** The customer endpoint just needs to be 2xx-or-fail. Driftstack handles retries.
- **Encryption beyond HMAC.** Signed, not encrypted. Bodies are JSON over HTTPS. Nothing in the body is highly sensitive (no plaintext API keys, no full session captures).

## Event types (initial set)

All events have shape `{ id: string, type: string, created_at: ISO8601, data: object }`. The `data` shape is event-specific.

| `type`                | Trigger                                                   | `data` shape                                |
| --------------------- | --------------------------------------------------------- | ------------------------------------------- |
| `session.completed`   | DELETE /v1/sessions/:id (clean destroy after operations)  | `{ session_id, duration_ms, ops_count }`    |
| `session.failed`      | Driver throws unrecoverable error during a session op     | `{ session_id, error_kind, error_message }` |
| `quota.warning_80pct` | Account hits 80% of any usage quota in the current period | `{ tier, usage_record_type, total, quota }` |
| `quota.exceeded`      | Account fully exhausts a usage quota                      | `{ tier, usage_record_type, total, quota }` |
| `api_key.revoked`     | DELETE /v1/api-keys/:id                                   | `{ api_key_id, name, revoked_at }`          |

The set is deliberately small for the first release. Adding new event types is non-breaking _at the wire level_ for customers who subscribe with explicit `events: [...]` arrays — the server only emits subscribed types, so a new type only reaches a customer who opted in. For strictly-typed SDK consumers, however, a new server-emitted enum value is still a breaking change at the type-system level; see `docs/architecture/api-versioning.md` (V-220) § "Per-resource versioning notes — `/v1/webhooks/*`" for the breaking-change taxonomy and the SDK passthrough escape hatch. Removing or changing the `data` shape of an existing type IS unconditionally breaking and triggers the deprecation cycle in V-220.

## Subscription model

Stored in a new `webhook_endpoints` table (Drizzle):

| column                 | type               | notes                                                               |
| ---------------------- | ------------------ | ------------------------------------------------------------------- |
| `id`                   | uuid PK            | `gen_random_uuid()`                                                 |
| `account_id`           | uuid FK accounts   | ON DELETE CASCADE                                                   |
| `url`                  | text               | HTTPS-only enforced at validation                                   |
| `secret`               | text               | versioned AES-256-GCM envelope; plaintext returned ONCE at creation |
| `secret_prefix`        | text               | first 12 chars for log/debug display                                |
| `secret_prev`          | text nullable      | encrypted prior secret during a bounded dual-sign rotation window   |
| `events`               | text[]             | subset of supported types; validated at write                       |
| `description`          | text nullable      | optional human label                                                |
| `active`               | boolean            | default true                                                        |
| `consecutive_failures` | int                | circuit breaker: auto-disable after 50 consecutive 5xx              |
| `last_success_at`      | timestamp nullable |                                                                     |
| `last_failure_at`      | timestamp nullable |                                                                     |
| `created_at`           | timestamp          |                                                                     |
| `disabled_at`          | timestamp nullable |                                                                     |

Public ID prefix: `whk_` (matches the `acc_/key_/ses_` family).

**Customer secret is `whsec_<32 base32 chars>`**, generated like API keys and returned once on `POST /v1/webhooks`. At rest it is a versioned AES-256-GCM envelope; the repository decrypts only for outbound signing. The receiver-side verifier (`verifyWebhookSignature` in the SDK) takes the customer's plaintext directly because verification happens on their machine.

## Delivery model

Stored in a new `webhook_deliveries` table:

| column                  | type                      | notes                                                             |
| ----------------------- | ------------------------- | ----------------------------------------------------------------- |
| `id`                    | uuid PK                   |                                                                   |
| `webhook_id`            | uuid FK webhook_endpoints | ON DELETE CASCADE                                                 |
| `event_id`              | uuid                      | logical event identifier; same id for every delivery of one event |
| `event_type`            | text                      | denormalised for indexing                                         |
| `payload`               | jsonb                     | the full event body that gets POSTed                              |
| `status`                | enum                      | `pending / in_flight / delivered / failed / dlq`                  |
| `attempts`              | int                       | starts at 0, max 5                                                |
| `next_attempt_at`       | timestamp                 | when worker should pick up next                                   |
| `last_response_status`  | int nullable              |                                                                   |
| `last_response_excerpt` | text nullable             | first 4KB of response body                                        |
| `last_error`            | text nullable             | non-HTTP failures (timeout, DNS, etc.)                            |
| `delivered_at`          | timestamp nullable        |                                                                   |
| `created_at`            | timestamp                 |                                                                   |
| `updated_at`            | timestamp                 |                                                                   |

Indexes:

- `(status, next_attempt_at)` for the worker poll
- `(webhook_id, created_at)` for per-endpoint history
- `(account_id, created_at)` if denormalised; or just join through webhook_id

Status enum: `pending` (initial), `in_flight` (worker claimed it), `delivered` (2xx received), `failed` (non-2xx but retries remaining), `dlq` (5 attempts exhausted).

## Retry schedule

Exponential backoff with jitter, attempt-indexed:

- Attempt 0 (initial): immediate
- Attempt 1 (1st retry): now + 1 min
- Attempt 2: now + 5 min
- Attempt 3: now + 15 min
- Attempt 4: now + 30 min
- Attempt 5 (final): now + 60 min
- After attempt 5 fails: status → `dlq`

Total window: ~111 min. ~15% jitter applied to each interval (`Math.random() * 0.15` of the base).

## Worker

A single in-process worker loop (started by `apps/server` on boot when `WEBHOOK_WORKER=enabled`):

```ts
async function loop() {
  while (true) {
    const claimed = await repo.claim({ batchSize: 25, now: new Date() });
    if (claimed.length === 0) {
      await sleep(2000);
      continue;
    }
    await Promise.all(claimed.map(deliver));
  }
}
```

`claim` is an atomic SQL operation:

```sql
UPDATE webhook_deliveries
SET status = 'in_flight', updated_at = now()
WHERE id IN (
  SELECT id FROM webhook_deliveries
  WHERE status = 'pending' AND next_attempt_at <= now()
  ORDER BY next_attempt_at ASC
  LIMIT 25
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`SELECT … FOR UPDATE SKIP LOCKED` is the idiomatic Postgres pattern for safe multi-worker queue claims. We start with one worker; the SQL is multi-worker-ready when scaling becomes necessary.

`deliver(row)` does:

1. Look up the endpoint (with secret hash + URL) by `webhook_id`. Skip if endpoint disabled.
2. Build the request: POST `endpoint.url`, body = `JSON.stringify(row.payload)`, headers including `X-Driftstack-Signature` (see Signing).
3. AbortController timeout = 10 s.
4. Fire via global fetch.
5. Inspect response.

Outcomes:

- 2xx → `status = 'delivered'`, `delivered_at = now()`, increment endpoint.last_success_at, reset endpoint.consecutive_failures.
- non-2xx OR timeout OR network error:
  - record `last_response_status` / `last_error` / `last_response_excerpt`
  - increment `attempts`
  - if `attempts < 5`: schedule `next_attempt_at` per the backoff table, status → `pending`
  - if `attempts === 5`: status → `dlq`, also increment `endpoint.consecutive_failures`
  - if `endpoint.consecutive_failures >= 50`: auto-disable the endpoint (`disabled_at = now()`, `active = false`); future deliveries skip with status `failed` and reason `endpoint disabled`.

## Signing

Header format (Stripe-style; matches the SDK's `verifyWebhookSignature`):

```
X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

`hmac = HMAC-SHA256(`<unix-seconds>.<raw body>`, <secret-plaintext>)`

The receiver verifies with `verifyWebhookSignature({ body: rawBytes, header, secret })`. The verifier is in the SDK and was added in V-013.

**Resolved question — secret storage:** the worker needs the plaintext secret to sign each delivery. Options considered:

- (a) Store the plaintext secret in the `webhook_endpoints` row (same column we currently call `secret_hash`). Risk: a DB dump leaks plaintext webhook secrets. But signing webhooks is not as sensitive as API key auth; a leaked secret lets an attacker forge webhook deliveries to a customer endpoint, which is a phishing-grade concern, not a takeover-grade one.
- (b) Hash at rest, require customer to re-supply the secret on every config change, sign with derived material. Operationally awful.
- (c) Use a KMS-style envelope: encrypt-at-rest with a per-account key. Adds operational complexity (key rotation, KMS dependency) without solving the leak problem (the per-account key is itself stored somewhere).

**Decision (D-023, superseded 2026-07-12):** store a versioned AES-256-GCM envelope in `secret`/`secret_prev`, backed by the platform customer-secret key. The repository authenticates and decrypts only at the delivery-worker boundary. Legacy plaintext rows are readable only for a bounded, compare-and-set bootstrap conversion; new writes fail closed without the key. This preserves one-time plaintext creation responses and dual-sign rotation without making a database snapshot sufficient to forge events.

## API surface

| endpoint                          | scope | purpose                                                                     |
| --------------------------------- | ----- | --------------------------------------------------------------------------- |
| `POST /v1/webhooks`               | admin | Create subscription. Returns the `secret` ONCE.                             |
| `GET /v1/webhooks`                | read  | List subscriptions for the account.                                         |
| `GET /v1/webhooks/:id`            | read  | Get one subscription.                                                       |
| `DELETE /v1/webhooks/:id`         | admin | Soft-delete (disable + set disabled_at). Hard delete is admin-tooling only. |
| `GET /v1/webhooks/:id/deliveries` | read  | Paginated delivery log for one subscription. Useful for customer debugging. |

The dead-letter queue is exposed via the `deliveries` endpoint with `?status=dlq`. We don't add a separate route.

## SDK additions

`@driftstack/sdk` gets a `WebhooksResource`:

```ts
client.webhooks.create({ url, events, description? }) → WebhookEndpoint & { secret: string }
client.webhooks.list() → { data: WebhookEndpoint[] }
client.webhooks.get(id) → WebhookEndpoint
client.webhooks.delete(id) → void
client.webhooks.listDeliveries(id, { limit?, cursor?, status? }) → PaginatedDeliveries
```

Existing `verifyWebhookSignature` (from V-013) covers the receiver-side.

## Event emission

Where in the codebase events fire:

- `session.completed`: `SessionsService.destroy()` after successful destroy. Skip emission if the session was destroyed before any operations happened (no point notifying for an immediately-killed session).
- `session.failed`: any catch path in SessionsService that surfaces a 5xx-class error to the route. Capture the error kind.
- `quota.warning_80pct`: hooked into the usage-recording path; when crossing the 80% boundary for any record_type. Avoid emitting more than once per period per record_type per account (cheap dedup via a Redis SET).
- `quota.exceeded`: same path, fires when crossing 100%.
- `api_key.revoked`: `ApiKeysService.revoke()` after the DB UPDATE.

Event creation = INSERT into `webhook_deliveries` for each subscription matching `event_type IN events`. The worker picks up from there.

For the warning/exceeded events, the threshold-crossing detection is the only non-trivial part. Implementation: in `usageService.recordUsage(...)`, after writing the row, query the new period total, compute the previous-period total (current minus the just-written quantity), and if either pre-write < threshold and post-write >= threshold for any threshold (80% or 100%), emit the event.

## Test surface

- **Unit:** signing/verification round-trip; backoff schedule math; circuit-breaker counter logic; threshold-crossing detection.
- **Integration (vitest + Fastify inject):** all 5 routes happy + every documented error; subscription validation (URL must be HTTPS, events must be a known subset); event-fan-out via SessionsService.destroy() actually inserts deliveries.
- **E2E (Playwright + real Postgres + Redis):** customer journey — create subscription, run a session, destroy it, observe a delivery row marked delivered. Use a small in-test HTTP server to receive the actual webhook POST and assert on the signature header + body. Worker exercised end-to-end.
- **Worker unit:** simulate 2xx, 4xx, 5xx, network error, timeout responses against a mock fetch; assert state transitions match the table.
- **Retry timing:** unit test of the next_attempt_at calculation per attempt index.

## Open questions / explicit non-decisions

- **Per-account webhook concurrency limit:** initial release has none. If a customer has 1000 endpoints, we'll happily attempt all 1000 deliveries per event. Add a tier-keyed cap if needed.
- **Idempotency keys** in event payloads: events get a UUID `id`. Customers should treat events as at-least-once and dedupe by `id`. Documented in the README.
- **Header for replay attacks (event id):** worth including event id as a separate header (`X-Driftstack-Event-Id`) so customers don't need to parse the body to dedupe. Will add.

## Implementation order (8 commits)

1. WH1 — this design doc (this file). Land first.
2. WH2 — Drizzle schema additions + migration. Verify against real Postgres.
3. WH3 — WebhooksService + repos + signing. Unit tests. No worker yet.
4. WH4 — Worker (claim, deliver, retry, DLQ, circuit-breaker). Unit tests + integration tests against a fake fetch.
5. WH5 — Routes + Zod schemas in api-types. Integration tests for the 5 endpoints.
6. WH6 — Event emission wired into SessionsService + ApiKeysService + UsageService. Integration tests verifying fan-out.
7. WH7 — SDK additions (`client.webhooks.*`) + an `examples/webhook-receiver.ts`.
8. WH8 — E2E tests (real fan-out, real worker, real signature verification). V-014.

After WH8: Webhook System landed. API + control plane core scope is then "substantively complete + webhooks", awaiting WebKit-fork driver swap and the next-batch direction (customer dashboard, admin UI, billing scaffolding, operational tooling).
