// W451.A — drift guard for packages/webhook-delivery/src/types.ts.
// V-144 stub: internal delivery mechanics types. Drift here either
// loses the public-vs-internal distinction (the package starts
// re-exporting customer-facing `WebhookEndpoint`/`WebhookDelivery`
// from `@driftstack/api-types` and the internal seam dissolves) or
// breaks the DeliveryStatus 5-state machine (consumer worker would
// fail to enumerate a status, silently dropping deliveries).
//
//   • V-144 header framing pinned + 'INTERNAL delivery mechanics'
//     rationale.
//   • DeliveryEndpoint: 7 fields (id + accountId + url + eventTypes
//     + signingSecret + active + optional config); 'https:// only;
//     http:// rejected at registration time' guard pinned.
//   • DeliveryConfig: 2 optional fields pinned (timeoutMs 10_000,
//     maxAttempts 6 = initial + 5 retries; backoff is the fixed
//     BACKOFF_MS_BY_ATTEMPT table 1m/5m/15m/30m/60m, not configurable).
//     Dead backoffBaseMs field removed 2026-05-29.
//   • DeliveryPayload: 4 fields (eventId + eventType + emittedAtSec
//     + body); 'NOT when delivery is attempted' caveat pinned.
//   • DeliveryAttempt: 7 fields incl. outcome 4-state union
//     ('success' | 'http_error' | 'transport_error' | 'timeout');
//     transport_error description pinned.
//   • DeliveryStatus: 5-state machine ('pending' | 'in_flight' |
//     'delivered' | 'failed' | 'dlq').
//   • DeliveryRecord: 8 fields incl. nextAttemptAtMs nullability
//     'null when terminal' pinned.
//   • DlqEntry: 8 fields incl. 'DLQ + active queue share the id
//     space' rationale; reason example '5× transport_error:
//     ECONNREFUSED' pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webhook-delivery/src/types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W451.A packages/webhook-delivery/src/types.ts content parity', () => {
  const body = read(LIB);

  it("V-144 framing pinned: 'Webhook delivery system types — V-144 stub.' + 'INTERNAL delivery mechanics' distinction from @driftstack/api-types public-facing wire types", () => {
    expect(body).toMatch(/\/\/ Webhook delivery system types — V-144 stub\./);
    expect(body).toMatch(
      /\/\/ Distinct from `@driftstack\/api-types` `WebhookEndpoint` \/\s*\/\/ `WebhookDelivery` shapes \(which are the public-facing wire types\s*\/\/ that customers see in `\/v1\/webhooks\/\*` responses\)\. This package\s*\/\/ models the INTERNAL delivery mechanics — queue, retry curve, DLQ\s*\/\/ management, signature payload — that the production system uses\s*\/\/ to actually push events out\./,
    );
  });

  it('seam rationale framing pinned: \'V-144 lands the seam so a future "more sophisticated delivery system" (multi-region, batching, ordering guarantees, etc.) can drop in behind the same interface without touching the call sites.\'', () => {
    expect(body).toMatch(
      /\/\/ V-144 lands the seam so a future "more sophisticated delivery\s*\/\/ system" \(multi-region, batching, ordering guarantees, etc\.\) can\s*\/\/ drop in behind the same interface without touching the call sites\./,
    );
  });

  it("DeliveryEndpoint: 7 fields (id stable + accountId + url + eventTypes + signingSecret + active + optional config); 'https:// only; http:// rejected at registration time' guard pinned", () => {
    expect(body).toMatch(
      /export interface DeliveryEndpoint \{[\s\S]*?id: string;[\s\S]*?accountId: string;[\s\S]*?\/\*\* Target URL\. https:\/\/ only; http:\/\/ rejected at registration time\. \*\/\s*url: string;[\s\S]*?eventTypes: readonly string\[\];[\s\S]*?signingSecret: string;[\s\S]*?active: boolean;[\s\S]*?config\?: DeliveryConfig;/,
    );
  });

  it('DeliveryConfig: 2 optional fields pinned — timeoutMs default 10_000, maxAttempts default 6 (initial + 5 retries; backoff is the fixed BACKOFF_MS_BY_ATTEMPT table, not configurable). The dead backoffBaseMs field was removed 2026-05-29.', () => {
    expect(body).toMatch(
      /\/\*\* Per-attempt HTTP timeout in ms\. Default 10_000\. \*\/\s*timeoutMs\?: number;/,
    );
    expect(body).toMatch(/Max attempts before DLQ\. Default 6 \(the initial delivery \+ 5/);
    expect(body).toMatch(/retries; see DEFAULT_MAX_ATTEMPTS\)\./);
    expect(body).toMatch(/BACKOFF_MS_BY_ATTEMPT table \(1m \/ 5m \/ 15m \/ 30m \/ 60m\)/);
    // backoffBaseMs was a dead (never-read) field — removed 2026-05-29.
    expect(body).not.toMatch(/backoffBaseMs/);
  });

  it("DeliveryPayload: 4 fields (eventId + eventType + emittedAtSec + body); 'UNIX timestamp seconds when the event was emitted (NOT when delivery is attempted)' caveat pinned", () => {
    expect(body).toMatch(
      /export interface DeliveryPayload \{[\s\S]*?\/\*\* Stable event id for dedupe across retries\. \*\/\s*eventId: string;[\s\S]*?eventType: string;[\s\S]*?\/\*\* UNIX timestamp seconds when the event was emitted \(NOT when delivery is attempted\)\. \*\/\s*emittedAtSec: number;[\s\S]*?\/\*\* Serialized payload — the customer receives this body verbatim\. \*\/\s*body: string;/,
    );
  });

  it("DeliveryAttempt: 7 fields incl. 4-state outcome union ('success'|'http_error'|'transport_error'|'timeout'); 'transport_error = couldn't reach endpoint at all' framing pinned", () => {
    expect(body).toMatch(
      /export interface DeliveryAttempt \{[\s\S]*?attempt: number;[\s\S]*?completedAtMs: number;[\s\S]*?responseStatus: number \| null;[\s\S]*?responseExcerpt: string \| null;[\s\S]*?durationMs: number;[\s\S]*?\/\*\* Surface-level outcome\. `'transport_error'` = couldn't reach endpoint at all\. \*\/\s*outcome: 'success' \| 'http_error' \| 'transport_error' \| 'timeout';[\s\S]*?errorMessage: string \| null;/,
    );
  });

  it("DeliveryStatus: 5-state union ('pending'|'in_flight'|'delivered'|'failed'|'dlq') framing pinned 'Queued delivery state machine.'", () => {
    expect(body).toMatch(
      /\/\*\* Queued delivery state machine\. \*\/\s*export type DeliveryStatus = 'pending' \| 'in_flight' \| 'delivered' \| 'failed' \| 'dlq';/,
    );
  });

  it("DeliveryRecord: 8 fields (id + endpointId + payload + status + attempts + nextAttemptAtMs nullability with 'null when status === delivered/failed/dlq' framing + createdAtMs + completedAtMs nullable)", () => {
    expect(body).toMatch(
      /export interface DeliveryRecord \{\s*id: string;\s*endpointId: string;\s*payload: DeliveryPayload;\s*status: DeliveryStatus;\s*attempts: readonly DeliveryAttempt\[\];[\s\S]*?\/\*\* When the next attempt fires\. null when status === 'delivered' \/ 'failed' \/ 'dlq'\. \*\/\s*nextAttemptAtMs: number \| null;[\s\S]*?createdAtMs: number;[\s\S]*?completedAtMs: number \| null;/,
    );
  });

  it("DlqEntry: 8 fields; 'Same id as the originating DeliveryRecord. DLQ + active queue share the id space.' rationale pinned; reason example '5× transport_error: ECONNREFUSED' pinned", () => {
    expect(body).toMatch(
      /\/\*\* Same id as the originating DeliveryRecord\. DLQ \+ active queue share the id space\. \*\/\s*deliveryId: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Free-text reason for DLQ\. Concise: e\.g\. `'5× transport_error: ECONNREFUSED'`\. \*\/\s*reason: string;/,
    );
    expect(body).toMatch(
      /export interface DlqEntry \{[\s\S]*?deliveryId: string;\s*endpointId: string;\s*accountId: string;\s*payload: DeliveryPayload;[\s\S]*?totalAttempts: number;[\s\S]*?attempts: readonly DeliveryAttempt\[\];[\s\S]*?enteredDlqAtMs: number;[\s\S]*?reason: string;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
