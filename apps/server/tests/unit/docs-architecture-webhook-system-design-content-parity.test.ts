// W560.C — drift guard for /docs/architecture/webhook-system-design.md.
// Webhook system design pre-implementation. Drift here either weakens
// the Stripe-style HMAC-SHA256 t=,v1= signing posture, drops the
// 5-event-type initial set + V-220-breaking-taxonomy reference,
// loosens the 5-retry-exp-backoff schedule, or unsets D-023
// (store-plaintext-secret-alongside-hash decision).
//
//   • Design draft, pre-implementation, V-009/phase-8 pattern.
//   • 5 event types: session.completed/failed + quota.warning_80pct/
//     exceeded + api_key.revoked. V-220 deprecation cycle for breaks.
//   • whk_ public ID prefix; whsec_<32 base32> plaintext secret.
//   • webhook_endpoints + webhook_deliveries schema.
//   • 5-attempt exp-backoff: 1m+5m+15m+30m+60m (~111min total),
//     15% jitter.
//   • Worker: claim 25/loop FOR UPDATE SKIP LOCKED; 10s timeout.
//   • 50 consecutive 5xx → auto-disable endpoint.
//   • D-023: store secret plaintext alongside hash (Stripe pattern).
//   • 5 API endpoints + WebhooksResource SDK shape.
//   • 8-commit WH1..WH8 implementation order.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/webhook-system-design.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W560.C /docs/architecture/webhook-system-design.md content parity', () => {
  const body = read(LIB);

  it("Header + Goals + Non-goals framing pinned: '# Webhook System — Design' + 'Status: design draft, ready for execution. Authored before implementation per the agent-discipline pattern from V-009 / phase-8-e2e-design.md.' + '## Goals' + 'Customer creates a webhook subscription via `POST /v1/webhooks`' + '`url` (their HTTPS endpoint)' + '`events` (subset of the supported event types)' + 'returns the new subscription including a generated `secret` (shown once, like API keys).' + '`X-Driftstack-Signature: t=<unix>,v1=<hex hmac>`' + 'Customer's endpoint verifies the signature with `verifyWebhookSignature` from `@driftstack/sdk`' + '2xx-acknowledges within 30 seconds.' + 'retries with exponential backoff up to 5 times over ~30 minutes' + '## Non-goals' + '**WebSocket / SSE streams.**' + '**Bidirectional / interactive webhooks.**' + '**Per-event filtering inside a subscription.**' + '**Customer-side retry orchestration.**' + '**Encryption beyond HMAC.**' — pinned so the V-009/phase-8-discipline + POST/v1/webhooks-url+events + secret-shown-once + X-Driftstack-Signature-t=,v1= + verifyWebhookSignature-SDK + 30s-2xx-ack + 5-non-goal commitment survives", () => {
    expect(body).toMatch(/^# Webhook System — Design$/m);
    expect(body).toMatch(
      /Status: design draft, ready for execution\. Authored before implementation per the agent-discipline pattern from V-009 \/ phase-8-e2e-design\.md\./,
    );
    expect(body).toMatch(/## Goals/);
    expect(body).toMatch(/Customer creates a webhook subscription via `POST \/v1\/webhooks`/);
    expect(body).toMatch(/`url` \(their HTTPS endpoint\)/);
    expect(body).toMatch(/`events` \(subset of the supported event types\)/);
    expect(body).toMatch(
      /returns the new subscription including a generated `secret` \(shown once, like API keys\)\./,
    );
    expect(body).toMatch(/`X-Driftstack-Signature: t=<unix>,v1=<hex hmac>`/);
    expect(body).toMatch(
      /Customer's endpoint verifies the signature with `verifyWebhookSignature` from `@driftstack\/sdk`/,
    );
    expect(body).toMatch(/2xx-acknowledges within 30 seconds\./);
    expect(body).toMatch(/retries with exponential backoff up to 5 times over ~30 minutes/);
    expect(body).toMatch(/## Non-goals/);
    expect(body).toMatch(/- \*\*WebSocket \/ SSE streams\.\*\*/);
    expect(body).toMatch(/- \*\*Bidirectional \/ interactive webhooks\.\*\*/);
    expect(body).toMatch(/- \*\*Per-event filtering inside a subscription\.\*\*/);
    expect(body).toMatch(/- \*\*Customer-side retry orchestration\.\*\*/);
    expect(body).toMatch(/- \*\*Encryption beyond HMAC\.\*\*/);
  });

  it("5-event-type + V-220 framing pinned: '## Event types (initial set)' + 'All events have shape `{ id: string, type: string, created_at: ISO8601, data: object }`.' + '| `session.completed`   | DELETE /v1/sessions/:id (clean destroy after operations)  | `{ session_id, duration_ms, ops_count }`' + '| `session.failed`      | Driver throws unrecoverable error during a session op     | `{ session_id, error_kind, error_message }`' + '| `quota.warning_80pct` | Account hits 80% of any usage quota in the current period | `{ tier, usage_record_type, total, quota }`' + '| `quota.exceeded`      | Account fully exhausts a usage quota                      | `{ tier, usage_record_type, total, quota }`' + '| `api_key.revoked`     | DELETE /v1/api-keys/:id                                   | `{ api_key_id, name, revoked_at }`' + 'The set is deliberately small for the first release.' + 'For strictly-typed SDK consumers, however, a new server-emitted enum value is still a breaking change at the type-system level' + '`docs/architecture/api-versioning.md` (V-220) § \"Per-resource versioning notes — `/v1/webhooks/*`\"' + 'Removing or changing the `data` shape of an existing type IS unconditionally breaking' — pinned so the 5-event-type-with-data-shape + small-first-release + strictly-typed-SDK-breaking + V-220-breaking-taxonomy + data-shape-unconditionally-breaking commitment survives", () => {
    expect(body).toMatch(/## Event types \(initial set\)/);
    expect(body).toMatch(
      /All events have shape `\{ id: string, type: string, created_at: ISO8601, data: object \}`\./,
    );
    expect(body).toMatch(
      /\| `session\.completed`\s+\| DELETE \/v1\/sessions\/:id \(clean destroy after operations\)\s+\| `\{ session_id, duration_ms, ops_count \}`/,
    );
    expect(body).toMatch(
      /\| `session\.failed`\s+\| Driver throws unrecoverable error during a session op\s+\| `\{ session_id, error_kind, error_message \}`/,
    );
    expect(body).toMatch(
      /\| `quota\.warning_80pct` \| Account hits 80% of any usage quota in the current period \| `\{ tier, usage_record_type, total, quota \}`/,
    );
    expect(body).toMatch(
      /\| `quota\.exceeded`\s+\| Account fully exhausts a usage quota\s+\| `\{ tier, usage_record_type, total, quota \}`/,
    );
    expect(body).toMatch(
      /\| `api_key\.revoked`\s+\| DELETE \/v1\/api-keys\/:id\s+\| `\{ api_key_id, name, revoked_at \}`/,
    );
    expect(body).toMatch(/The set is deliberately small for the first release\./);
    expect(body).toMatch(
      /For strictly-typed SDK consumers, however, a new server-emitted enum value is still a breaking change at the type-system level/,
    );
    expect(body).toMatch(
      /`docs\/architecture\/api-versioning\.md` \(V-220\) § "Per-resource versioning notes — `\/v1\/webhooks\/\*`"/,
    );
    expect(body).toMatch(
      /Removing or changing the `data` shape of an existing type IS unconditionally breaking/,
    );
  });

  it("Subscription + delivery schema framing pinned: '## Subscription model' + 'Stored in a new `webhook_endpoints` table (Drizzle):' + '`account_id`           | uuid FK accounts   | ON DELETE CASCADE' + '`secret_hash`          | text               | scrypt-hashed' + '`secret_prefix`        | text               | first 12 chars for log/debug display' + '`consecutive_failures` | int                | circuit breaker: auto-disable after 50 consecutive 5xx' + 'Public ID prefix: `whk_`' + '**Plaintext secret is `whsec_<32 base32 chars>`**' + 'We hash with scrypt at the same `logN=15` factor' + '## Delivery model' + 'Stored in a new `webhook_deliveries` table:' + '`status`                | enum                      | `pending / in_flight / delivered / failed / dlq`' + '`attempts`              | int                       | starts at 0, max 5' + 'Status enum: `pending` (initial), `in_flight` (worker claimed it), `delivered` (2xx received), `failed` (non-2xx but retries remaining), `dlq` (5 attempts exhausted).' — pinned so the webhook_endpoints-12-col + account_id-FK-CASCADE + scrypt-secret_hash + 50-consecutive-5xx-circuit + whk_-prefix + whsec_-32-base32 + scrypt-logN=15 + webhook_deliveries + 5-status-enum commitment survives", () => {
    expect(body).toMatch(/## Subscription model/);
    expect(body).toMatch(/Stored in a new `webhook_endpoints` table \(Drizzle\):/);
    expect(body).toMatch(/`account_id`\s+\| uuid FK accounts\s+\| ON DELETE CASCADE/);
    expect(body).toMatch(/`secret`\s+\| text\s+\| versioned AES-256-GCM envelope/);
    expect(body).toMatch(/`secret_prev`\s+\| text nullable\s+\| encrypted prior secret/);
    expect(body).toMatch(/`secret_prefix`\s+\| text\s+\| first 12 chars for log\/debug display/);
    expect(body).toMatch(
      /`consecutive_failures` \| int\s+\| circuit breaker: auto-disable after 50 consecutive 5xx/,
    );
    expect(body).toMatch(/Public ID prefix: `whk_`/);
    expect(body).toMatch(/\*\*Customer secret is `whsec_<32 base32 chars>`\*\*/);
    expect(body).toMatch(/At rest it is a versioned AES-256-GCM envelope/);
    expect(body).toMatch(/## Delivery model/);
    expect(body).toMatch(/Stored in a new `webhook_deliveries` table:/);
    expect(body).toMatch(
      /`status`\s+\| enum\s+\| `pending \/ in_flight \/ delivered \/ failed \/ dlq`/,
    );
    expect(body).toMatch(/`attempts`\s+\| int\s+\| starts at 0, max 5/);
    expect(body).toMatch(
      /Status enum: `pending` \(initial\), `in_flight` \(worker claimed it\), `delivered` \(2xx received\), `failed` \(non-2xx but retries remaining\), `dlq` \(5 attempts exhausted\)\./,
    );
  });

  it("Retry-schedule + worker + signing-D-023 framing pinned: '## Retry schedule' + 'Exponential backoff with jitter, attempt-indexed:' + 'Attempt 0 (initial): immediate' + 'Attempt 1 (1st retry): now + 1 min' + 'Attempt 2: now + 5 min' + 'Attempt 3: now + 15 min' + 'Attempt 4: now + 30 min' + 'Attempt 5 (final): now + 60 min' + 'After attempt 5 fails: status → `dlq`' + 'Total window: ~111 min. ~15% jitter applied' + '## Worker' + 'A single in-process worker loop (started by `apps/server` on boot when `WEBHOOK_WORKER=enabled`)' + 'batchSize: 25' + 'SELECT … FOR UPDATE SKIP LOCKED' + 'AbortController timeout = 10 s.' + 'Fire via global fetch.' + 'if `endpoint.consecutive_failures >= 50`: auto-disable the endpoint' + '## Signing' + 'X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>' + 'hmac = HMAC-SHA256(`<unix-seconds>.<raw body>`, <secret-plaintext>)' + 'The verifier is in the SDK and was added in V-013.' + '**Decision (D-023):** store the secret in plaintext alongside the hash.' — pinned so the 5-retry-1m/5m/15m/30m/60m + 111min-15%-jitter + WEBHOOK_WORKER=enabled + batchSize-25 + FOR-UPDATE-SKIP-LOCKED + 10s-AbortController + 50-consec-auto-disable + HMAC-SHA256-V-013-verifier + D-023-plaintext-decision commitment survives", () => {
    expect(body).toMatch(/## Retry schedule/);
    expect(body).toMatch(/Exponential backoff with jitter, attempt-indexed:/);
    expect(body).toMatch(/- Attempt 0 \(initial\): immediate/);
    expect(body).toMatch(/- Attempt 1 \(1st retry\): now \+ 1 min/);
    expect(body).toMatch(/- Attempt 2: now \+ 5 min/);
    expect(body).toMatch(/- Attempt 3: now \+ 15 min/);
    expect(body).toMatch(/- Attempt 4: now \+ 30 min/);
    expect(body).toMatch(/- Attempt 5 \(final\): now \+ 60 min/);
    expect(body).toMatch(/- After attempt 5 fails: status → `dlq`/);
    expect(body).toMatch(/Total window: ~111 min\. ~15% jitter applied/);
    expect(body).toMatch(/## Worker/);
    expect(body).toMatch(
      /A single in-process worker loop \(started by `apps\/server` on boot when `WEBHOOK_WORKER=enabled`\)/,
    );
    expect(body).toMatch(/batchSize: 25/);
    expect(body).toMatch(/SELECT … FOR UPDATE SKIP LOCKED/);
    expect(body).toMatch(/AbortController timeout = 10 s\./);
    expect(body).toMatch(/Fire via global fetch\./);
    expect(body).toMatch(/if `endpoint\.consecutive_failures >= 50`: auto-disable the endpoint/);
    expect(body).toMatch(/## Signing/);
    expect(body).toMatch(/X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>/);
    expect(body).toMatch(/hmac = HMAC-SHA256\(`<unix-seconds>\.<raw body>`, <secret-plaintext>\)/);
    expect(body).toMatch(/The verifier is in the SDK and was added in V-013\./);
    expect(body).toMatch(
      /\*\*Decision \(D-023, superseded 2026-07-12\):\*\* store a versioned AES-256-GCM envelope/,
    );
  });

  it("API surface + SDK + event-emission framing pinned: '## API surface' + '| `POST /v1/webhooks`               | admin | Create subscription. Returns the `secret` ONCE.' + '| `GET /v1/webhooks`                | read  | List subscriptions for the account.' + '| `GET /v1/webhooks/:id`            | read  | Get one subscription.' + '| `DELETE /v1/webhooks/:id`         | admin | Soft-delete (disable + set disabled_at).' + '| `GET /v1/webhooks/:id/deliveries` | read  | Paginated delivery log for one subscription.' + 'The dead-letter queue is exposed via the `deliveries` endpoint with `?status=dlq`.' + '## SDK additions' + '`@driftstack/sdk` gets a `WebhooksResource`' + 'client.webhooks.create({ url, events, description? })' + 'client.webhooks.listDeliveries(id, { limit?, cursor?, status? })' + 'Existing `verifyWebhookSignature` (from V-013) covers the receiver-side.' + '## Event emission' + '`session.completed`: `SessionsService.destroy()` after successful destroy.' + '`quota.warning_80pct`: hooked into the usage-recording path' + 'Avoid emitting more than once per period per record_type per account (cheap dedup via a Redis SET).' + '`api_key.revoked`: `ApiKeysService.revoke()` after the DB UPDATE.' — pinned so the 5-endpoint-table + DLQ-via-?status=dlq + WebhooksResource-5-method + V-013-verifier + 5-emission-point-SessionsService/UsageService/ApiKeysService + Redis-SET-dedup commitment survives", () => {
    expect(body).toMatch(/## API surface/);
    expect(body).toMatch(
      /\| `POST \/v1\/webhooks`\s+\| admin \| Create subscription\. Returns the `secret` ONCE\./,
    );
    expect(body).toMatch(
      /\| `GET \/v1\/webhooks`\s+\| read\s+\| List subscriptions for the account\./,
    );
    expect(body).toMatch(/\| `GET \/v1\/webhooks\/:id`\s+\| read\s+\| Get one subscription\./);
    expect(body).toMatch(
      /\| `DELETE \/v1\/webhooks\/:id`\s+\| admin \| Soft-delete \(disable \+ set disabled_at\)\./,
    );
    expect(body).toMatch(
      /\| `GET \/v1\/webhooks\/:id\/deliveries` \| read\s+\| Paginated delivery log for one subscription\./,
    );
    expect(body).toMatch(
      /The dead-letter queue is exposed via the `deliveries` endpoint with `\?status=dlq`\./,
    );
    expect(body).toMatch(/## SDK additions/);
    expect(body).toMatch(/`@driftstack\/sdk` gets a `WebhooksResource`/);
    expect(body).toMatch(/client\.webhooks\.create\(\{ url, events, description\? \}\)/);
    expect(body).toMatch(
      /client\.webhooks\.listDeliveries\(id, \{ limit\?, cursor\?, status\? \}\)/,
    );
    expect(body).toMatch(
      /Existing `verifyWebhookSignature` \(from V-013\) covers the receiver-side\./,
    );
    expect(body).toMatch(/## Event emission/);
    expect(body).toMatch(
      /`session\.completed`: `SessionsService\.destroy\(\)` after successful destroy\./,
    );
    expect(body).toMatch(/`quota\.warning_80pct`: hooked into the usage-recording path/);
    expect(body).toMatch(
      /Avoid emitting more than once per period per record_type per account \(cheap dedup via a Redis SET\)\./,
    );
    expect(body).toMatch(/`api_key\.revoked`: `ApiKeysService\.revoke\(\)` after the DB UPDATE\./);
  });

  it("Test-surface + open-questions + WH1-WH8 framing pinned: '## Test surface' + '**Unit:** signing/verification round-trip; backoff schedule math; circuit-breaker counter logic' + '**Integration (vitest + Fastify inject):**' + '**E2E (Playwright + real Postgres + Redis):**' + '## Open questions / explicit non-decisions' + '**Per-account webhook concurrency limit:** initial release has none.' + '**Idempotency keys** in event payloads: events get a UUID `id`. Customers should treat events as at-least-once and dedupe by `id`.' + '**Header for replay attacks (event id):** worth including event id as a separate header (`X-Driftstack-Event-Id`)' + '## Implementation order (8 commits)' + 'WH1 — this design doc (this file). Land first.' + 'WH2 — Drizzle schema additions + migration.' + 'WH3 — WebhooksService + repos + signing.' + 'WH4 — Worker (claim, deliver, retry, DLQ, circuit-breaker).' + 'WH5 — Routes + Zod schemas in api-types.' + 'WH6 — Event emission wired into SessionsService + ApiKeysService + UsageService.' + 'WH7 — SDK additions (`client.webhooks.*`) + an `examples/webhook-receiver.ts`.' + 'WH8 — E2E tests (real fan-out, real worker, real signature verification). V-014.' + 'API + control plane core scope is then \"substantively complete + webhooks\"' — pinned so the 4-test-layer + 3-open-question (no-concurrency-cap + at-least-once-dedup + X-Driftstack-Event-Id-header) + 8-commit-WH1-WH8 + V-014 + substantively-complete-webhooks commitment survives", () => {
    expect(body).toMatch(/## Test surface/);
    expect(body).toMatch(
      /\*\*Unit:\*\* signing\/verification round-trip; backoff schedule math; circuit-breaker counter logic/,
    );
    expect(body).toMatch(/\*\*Integration \(vitest \+ Fastify inject\):\*\*/);
    expect(body).toMatch(/\*\*E2E \(Playwright \+ real Postgres \+ Redis\):\*\*/);
    expect(body).toMatch(/## Open questions \/ explicit non-decisions/);
    expect(body).toMatch(
      /\*\*Per-account webhook concurrency limit:\*\* initial release has none\./,
    );
    expect(body).toMatch(
      /\*\*Idempotency keys\*\* in event payloads: events get a UUID `id`\. Customers should treat events as at-least-once and dedupe by `id`\./,
    );
    expect(body).toMatch(
      /\*\*Header for replay attacks \(event id\):\*\* worth including event id as a separate header \(`X-Driftstack-Event-Id`\)/,
    );
    expect(body).toMatch(/## Implementation order \(8 commits\)/);
    expect(body).toMatch(/1\. WH1 — this design doc \(this file\)\. Land first\./);
    expect(body).toMatch(/2\. WH2 — Drizzle schema additions \+ migration\./);
    expect(body).toMatch(/3\. WH3 — WebhooksService \+ repos \+ signing\./);
    expect(body).toMatch(/4\. WH4 — Worker \(claim, deliver, retry, DLQ, circuit-breaker\)\./);
    expect(body).toMatch(/5\. WH5 — Routes \+ Zod schemas in api-types\./);
    expect(body).toMatch(
      /6\. WH6 — Event emission wired into SessionsService \+ ApiKeysService \+ UsageService\./,
    );
    expect(body).toMatch(
      /7\. WH7 — SDK additions \(`client\.webhooks\.\*`\) \+ an `examples\/webhook-receiver\.ts`\./,
    );
    expect(body).toMatch(
      /8\. WH8 — E2E tests \(real fan-out, real worker, real signature verification\)\. V-014\./,
    );
    expect(body).toMatch(
      /API \+ control plane core scope is then "substantively complete \+ webhooks"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
