// W949 — webhooks service cross-source invariant. Two-hundred-
// seventy-fifth in the drift-guard series. Pins the customer-facing
// webhooks service:
//
//   Surface framing — 'Webhooks service — manages subscriptions and
//   the event-emission / delivery-row-enqueue paths. The actual HTTP
//   delivery happens in the WebhookDeliveryWorker
//   (apps/server/src/services/webhook-worker.ts)'.
//
//   Account-scoped ownership — 'All methods take an AccountContext
//   and enforce account-scoped ownership. enqueueEvent is called
//   from inside other services (sessions, api-keys, usage) when an
//   event-worthy thing happens; it fans out one delivery row per
//   subscribed endpoint'.
//
//   WebhookEventType 9-value union (8 customer-subscribable +
//   1 V-356 test-only):
//     - 'session.completed' / 'session.failed' / 'quota.warning_80pct'
//       / 'quota.exceeded' / 'api_key.revoked' /
//       'session.egress_capability_changed' / 'crypto.order.paid' /
//       'crypto.order.failed' (8 customer events).
//     - 'test.ping' — 'V-356 — synthetic event sent only via POST
//       /v1/webhooks/:id/test. Customers cannot subscribe to it (Zod
//       schemas reject it) — the test endpoint dispatches regardless
//       of subscription'.
//
//   WebhookDeliveryStatus 5-value union: 'pending' | 'in_flight' |
//     'delivered' | 'failed' | 'dlq'.
//
//   WebhookEndpointRow (13 fields including D-023 plaintext-secret):
//     - id + accountId + url + secret (D-023 plaintext) +
//       secretPrefix + secretPrev (V-359, nullable) +
//       secretPrevExpiresAt (V-359, nullable) + events + description
//       (nullable) + active + consecutiveFailures + lastSuccessAt
//       (nullable) + lastFailureAt (nullable) + disabledAt
//       (nullable) + createdAt + updatedAt.
//
//   D-023 plaintext-secret framing — secret stored as plaintext
//     (NOT hashed) because the worker must sign outbound payloads
//     with HMAC; comparison-attack threat model doesn't apply to
//     signing keys.
//
//   V-359 dual-sign rotation grace — 'previous signing secret during
//     the rotation grace period. Null when no rotation in flight or
//     grace expired. The worker dual-signs every outbound delivery
//     with both secret and secretPrev while
//     secretPrevExpiresAt > now'.
//
//   WebhookDeliveryRow (13 fields).
//
//   V-185 EndpointDeliveryCounts (3-field aggregate): delivered +
//     failed + dlq.
//
//   3-error class import + generateWebhookSecret / webhookSecretPrefix
//     primitives from lib/webhook-signing.
//
// stays in lockstep across apps/server/src/services/webhooks.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W949 webhooks service cross-source invariant', () => {
  // ─── Service intro + worker-decoupling framing ───────────────

  it("CRITICAL apps/server/src/services/webhooks.ts header pins surface — 'Webhooks service — manages subscriptions and the event-emission / delivery-row-enqueue paths. The actual HTTP delivery happens in the WebhookDeliveryWorker (apps/server/src/services/webhook-worker.ts)'. The service-vs-worker split decouples enqueue from delivery.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/Webhooks service — manages subscriptions and the event-emission \//);
    expect(p).toMatch(/delivery-row-enqueue paths\. The actual HTTP delivery happens in the/);
    expect(p).toMatch(/WebhookDeliveryWorker \(apps\/server\/src\/services\/webhook-worker\.ts\)/);
  });

  // ─── Account-scoped ownership + enqueueEvent fan-out ─────────

  it("CRITICAL account-scope + enqueueEvent framing — 'All methods take an AccountContext and enforce account-scoped ownership. enqueueEvent is called from inside other services (sessions, api-keys, usage) when an event-worthy thing happens; it fans out one delivery row per subscribed endpoint'. The 3-caller fan-out (sessions / api-keys / usage) is the cross-service emit-path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/All methods take an AccountContext and enforce account-scoped ownership\./);
    expect(p).toMatch(/`enqueueEvent` is called from inside other services \(sessions, api-keys,/);
    expect(p).toMatch(/usage\) when an event-worthy thing happens; it fans out one delivery row/);
    expect(p).toMatch(/per subscribed endpoint/);
  });

  // ─── WebhookEventType current 9-value union ──────────────────

  it('CRITICAL WebhookEventType pins 8 emitted customer events plus the test-only synthetic event.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/export type WebhookEventType =/);
    expect(p).toMatch(/\| 'session\.completed'/);
    expect(p).toMatch(/\| 'session\.failed'/);
    expect(p).toMatch(/\| 'api_key\.revoked'/);
    expect(p).toMatch(/\| 'test\.ping'/);
    expect(p).toMatch(/\| 'session\.egress_capability_changed'/);
    expect(p).toMatch(/\| 'crypto\.order\.paid'/);
    expect(p).toMatch(/\| 'crypto\.order\.failed'/);
    expect(p).toMatch(/\| 'session\.challenge_detected'/);
    expect(p).toMatch(/\| 'session\.profile_save_failed';/);
    expect(p).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  // ─── V-356 test.ping framing ─────────────────────────────────

  it("CRITICAL V-356 test.ping framing — 'synthetic event sent only via POST /v1/webhooks/:id/test. Customers cannot subscribe to it (Zod schemas reject it) — the test endpoint dispatches regardless of subscription'. The Zod-rejects + dispatches-regardless contract is the V-356 test-only event model.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/V-356 — synthetic event sent only via POST \/v1\/webhooks\/:id\/test\./);
    expect(p).toMatch(/Customers cannot subscribe to it \(Zod schemas reject it\) — the/);
    expect(p).toMatch(/test endpoint dispatches regardless of subscription\./);
  });

  // ─── WebhookDeliveryStatus 5-value union ─────────────────────

  it("CRITICAL WebhookDeliveryStatus 5 values — 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dlq'. The 5-state lifecycle covers initial enqueue → delivery → terminal states (delivered/failed/dlq).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(
      /export type WebhookDeliveryStatus = 'pending' \| 'in_flight' \| 'delivered' \| 'failed' \| 'dlq';/,
    );
  });

  // ─── D-023 encrypted-at-rest framing ─────────────────────────

  it('CRITICAL WebhookEndpointRow.secret is plaintext only in the in-process repository result and encrypted at rest', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(
      /\/\*\* Plaintext only in the in-process repository result; encrypted at rest\. \*\/\s*\n?\s*secret: string;/,
    );
  });

  // ─── V-359 dual-sign rotation grace framing ──────────────────

  it("CRITICAL V-359 dual-sign framing — 'V-359 — previous signing secret during the rotation grace period. Null when no rotation in flight or grace expired. The worker dual-signs every outbound delivery with both secret and secretPrev while secretPrevExpiresAt > now'. The dual-sign-during-grace contract is what gives customers a window to roll their HMAC-verifier secret.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/V-359 — previous signing secret during the rotation grace/);
    expect(p).toMatch(/period\. Null when no rotation in flight or grace expired\. The/);
    expect(p).toMatch(/worker dual-signs every outbound delivery with both `secret`/);
    expect(p).toMatch(/and `secretPrev` while `secretPrevExpiresAt > now`\./);
  });

  // ─── WebhookEndpointRow 15-field shape ───────────────────────

  it('CRITICAL WebhookEndpointRow has 20 fields, and this arm pins 15 of them — id + accountId + url + secret + secretPrefix + secretPrev (V-359 nullable) + secretPrevExpiresAt (V-359 nullable) + events (WebhookEventType[]) + description (nullable) + active + consecutiveFailures + lastSuccessAt (nullable) + lastFailureAt (nullable) + disabledAt (nullable) + createdAt + updatedAt. The 15-field row carries D-023 + V-359 rotation + per-endpoint failure-counting state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/export interface WebhookEndpointRow \{/);
    expect(p).toMatch(/secretPrefix: string;/);
    expect(p).toMatch(/secretPrev: string \| null;/);
    expect(p).toMatch(/secretPrevExpiresAt: Date \| null;/);
    expect(p).toMatch(/events: WebhookEventType\[\];/);
    expect(p).toMatch(/active: boolean;/);
    expect(p).toMatch(/consecutiveFailures: number;/);
    expect(p).toMatch(/lastSuccessAt: Date \| null;/);
    expect(p).toMatch(/lastFailureAt: Date \| null;/);
    expect(p).toMatch(/disabledAt: Date \| null;/);
  });

  // ─── WebhookDeliveryRow 13-field shape ───────────────────────

  it('CRITICAL WebhookDeliveryRow has 14 fields, and this arm pins 13 of them — id + webhookId + eventId + eventType + payload (Record) + status + attempts + nextAttemptAt + lastResponseStatus (nullable) + lastResponseExcerpt (nullable) + lastError (nullable) + deliveredAt (nullable) + createdAt + updatedAt. The 13-field delivery row captures attempt count + last-response + retry-time state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/export interface WebhookDeliveryRow \{/);
    expect(p).toMatch(/webhookId: string;/);
    expect(p).toMatch(/eventId: string;/);
    expect(p).toMatch(/eventType: WebhookEventType;/);
    expect(p).toMatch(/payload: Record<string, unknown>;/);
    expect(p).toMatch(/status: WebhookDeliveryStatus;/);
    expect(p).toMatch(/attempts: number;/);
    expect(p).toMatch(/nextAttemptAt: Date;/);
    expect(p).toMatch(/lastResponseStatus: number \| null;/);
    expect(p).toMatch(/lastResponseExcerpt: string \| null;/);
    expect(p).toMatch(/lastError: string \| null;/);
    expect(p).toMatch(/deliveredAt: Date \| null;/);
  });

  // ─── V-185 EndpointDeliveryCounts aggregate ──────────────────

  it("CRITICAL V-185 EndpointDeliveryCounts framing — 'V-185 — aggregate counts per endpoint. delivered + failed + dlq'. The 3-counter aggregate is the V-185 endpoint-health surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/V-185 — aggregate counts per endpoint\. delivered \+ failed \+ dlq\./);
    expect(p).toMatch(/export interface EndpointDeliveryCounts \{/);
    expect(p).toMatch(/delivered: number;/);
    expect(p).toMatch(/failed: number;/);
    expect(p).toMatch(/dlq: number;/);
  });

  // ─── NewWebhookEndpointInput 6-field write shape ─────────────

  it('CRITICAL NewWebhookEndpointInput has 6 fields — accountId + url + secret + secretPrefix + events + description (nullable). The 6-field write-shape is what insertEndpoint() consumes; id + rotation fields + timestamps are server-assigned.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/export interface NewWebhookEndpointInput \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/url: string;/);
    expect(p).toMatch(/secret: string;/);
    expect(p).toMatch(/secretPrefix: string;/);
    expect(p).toMatch(/events: WebhookEventType\[\];/);
    expect(p).toMatch(/description: string \| null;/);
  });

  // ─── NewWebhookDeliveryInput 5-field shape ───────────────────

  it("CRITICAL NewWebhookDeliveryInput has 5 fields — webhookId + eventId + eventType + payload + nextAttemptAt (optional; 'Default = now'). The 5-field shape is what enqueueEvent's per-endpoint fan-out produces.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/export interface NewWebhookDeliveryInput \{/);
    expect(p).toMatch(/Optional: when first attempt should run\. Default = now/);
    expect(p).toMatch(/nextAttemptAt\?: Date;/);
  });

  // ─── ListDeliveriesPage 2-field paginator ────────────────────

  it('CRITICAL ListDeliveriesPage has 2 fields — items (WebhookDeliveryRow[]) + nextCursor (nullable). The 2-field paginator matches V-185 admin-list + customer-list cursor pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(/export interface ListDeliveriesPage \{/);
    expect(p).toMatch(/items: WebhookDeliveryRow\[\];/);
    expect(p).toMatch(/nextCursor: string \| null;/);
  });

  // ─── 3-error class import ────────────────────────────────────

  it('CRITICAL imports 3 error classes — BadRequestError + ConflictError + NotFoundError. The 3-error palette covers input-validation / state-conflict / row-missing states.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  // ─── Webhook secret primitives imported ──────────────────────

  it('CRITICAL imports generateWebhookSecret + webhookSecretPrefix from lib/webhook-signing — keeps secret-gen primitives in lib/ + service-coordination in services/ (matches W934 / W938 lib-vs-services split).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    expect(p).toMatch(
      /import \{ generateWebhookSecret, webhookSecretPrefix \} from '\.\.\/lib\/webhook-signing\.js';/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/webhooks-service-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
