// W452.B — drift guard for packages/webhook-delivery/src/mock.ts.
// V-144 mock webhook delivery service. Drift here either drops the
// fixed-timestamp determinism (1714867200000 = 2024-05-04T00:00:00Z)
// — tests that assert exact DeliveryRecord shapes flake under
// Date.now() — or loses the MockDlqManager.seedEntry test seam
// (consumer tests can't construct a DLQ scenario, lose coverage of
// the dlq→requeue path).
//
//   • V-144 framing pinned + 'Real production implementation in
//     apps/server/src/services/webhooks.ts + webhook-worker.ts'.
//   • SUCCESS_ATTEMPT_DURATION_MS = 50.
//   • MockWebhookDeliveryService framing pinned: 'in-memory map.
//     Every enqueue resolves immediately to a delivered record;
//     the mock isn't meant to model retry behavior, only the shape
//     contract. Tests that need retry mechanics use MockDlqManager.'
//   • enqueue: id format `mock_del_${padStart(8, '0')}`; nextSeq +=
//     1; fixed now = 1714867200000 with deterministic-across-test-
//     runs framing; attempt 1 + responseStatus 200 + 'OK' excerpt;
//     status: 'delivered'; nextAttemptAtMs:null; completedAtMs =
//     now + 50.
//   • get + list filters by endpointId + optional status; nextCursor
//     = `cursor_${limit}` when filtered.length > limit.
//   • replay: rejects on missing; fixed now = 1714867260000 (60s
//     after enqueue); appends attempt with attempt = existing.length + 1.
//   • MockDlqManager seedEntry test seam framing pinned.
//   • requeue: fixed now = 1714867320000 (120s after enqueue);
//     deletes entry from map; produces DeliveryRecord with status
//     'pending' + nextAttemptAtMs:now + completedAtMs:null +
//     createdAtMs = entry.enteredDlqAtMs.
//   • discard: deletes only.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webhook-delivery/src/mock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W452.B packages/webhook-delivery/src/mock.ts content parity', () => {
  const body = read(LIB);

  it("V-144 framing pinned: 'V-144 — mock webhook delivery service.' + 'Deterministic outputs so tests can assert exact shape without timing flakiness' + 'Real production implementation in apps/server/src/services/webhooks.ts + webhook-worker.ts'", () => {
    expect(body).toMatch(/\/\/ V-144 — mock webhook delivery service\./);
    expect(body).toMatch(
      /\/\/ Deterministic outputs so tests can assert exact shape without\s*\n?\s*\/\/ timing flakiness\. Same inputs always produce the same DeliveryRecord\s*\n?\s*\/\/ shapes \(matches the mock-driver discipline used elsewhere in the repo\)\./,
    );
    expect(body).toMatch(
      /\/\/ Real production implementation in apps\/server\/src\/services\/webhooks\.ts\s*\n?\s*\/\/ \+ webhook-worker\.ts\. Mock here lets future-system consumers exercise\s*\n?\s*\/\/ the seam without standing up the real worker pool\./,
    );
  });

  it('SUCCESS_ATTEMPT_DURATION_MS = 50 constant', () => {
    expect(body).toMatch(/const SUCCESS_ATTEMPT_DURATION_MS = 50;/);
  });

  it("MockWebhookDeliveryService framing pinned: 'Mock delivery service backed by an in-memory map. Every enqueue resolves immediately to a delivered record; the mock isn't meant to model retry behavior, only the shape contract. Tests that need retry mechanics use MockDlqManager.'", () => {
    expect(body).toMatch(
      /\* Mock delivery service backed by an in-memory map\. Every enqueue\s*\n?\s*\*\s*resolves immediately to a `delivered` record; the mock isn't meant\s*\n?\s*\*\s*to model retry behavior, only the shape contract\. Tests that need\s*\n?\s*\*\s*retry mechanics use `MockDlqManager`\./,
    );
    expect(body).toMatch(
      /export class MockWebhookDeliveryService implements WebhookDeliveryService \{\s*\n?\s*private readonly records = new Map<string, DeliveryRecord>\(\);\s*\n?\s*private nextSeq = 1;/,
    );
  });

  it("enqueue: id format mock_del_ + padStart(8, '0'); nextSeq increment; fixed now=1714867200000 (2024-05-04T00:00:00Z deterministic-across-test-runs framing pinned); attempt 1 + responseStatus 200 + 'OK' excerpt; status:'delivered' + nextAttemptAtMs:null + completedAtMs = now + SUCCESS_ATTEMPT_DURATION_MS", () => {
    expect(body).toMatch(
      /const id = `mock_del_\$\{this\.nextSeq\.toString\(\)\.padStart\(8, '0'\)\}`;\s*\n?\s*this\.nextSeq \+= 1;\s*\n?\s*const now = 1714867200000;[\s\S]*?\/\/ Fixed: 2024-05-04T00:00:00Z\. Deterministic across test runs\./,
    );
    expect(body).toMatch(
      /const attempt: DeliveryAttempt = \{\s*\n?\s*attempt: 1,\s*\n?\s*completedAtMs: now \+ SUCCESS_ATTEMPT_DURATION_MS,\s*\n?\s*responseStatus: 200,\s*\n?\s*responseExcerpt: 'OK',\s*\n?\s*durationMs: SUCCESS_ATTEMPT_DURATION_MS,\s*\n?\s*outcome: 'success',\s*\n?\s*errorMessage: null,\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const record: DeliveryRecord = \{\s*\n?\s*id,\s*\n?\s*endpointId: opts\.endpoint\.id,\s*\n?\s*payload: opts\.payload,\s*\n?\s*status: 'delivered',\s*\n?\s*attempts: \[attempt\],\s*\n?\s*nextAttemptAtMs: null,\s*\n?\s*createdAtMs: now,\s*\n?\s*completedAtMs: now \+ SUCCESS_ATTEMPT_DURATION_MS,\s*\n?\s*\};/,
    );
  });

  it('get: Promise.resolve(map.get(id) ?? null); list: filter by endpointId + optional status + limit ?? 50; nextCursor = `cursor_${limit}` when filtered.length > limit', () => {
    expect(body).toMatch(
      /get\(deliveryId: string\): Promise<DeliveryRecord \| null> \{\s*\n?\s*return Promise\.resolve\(this\.records\.get\(deliveryId\) \?\? null\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const all = \[\.\.\.this\.records\.values\(\)\]\.filter\(\(r\) => r\.endpointId === opts\.endpointId\);\s*\n?\s*const filtered = opts\.status === undefined \? all : all\.filter\(\(r\) => r\.status === opts\.status\);\s*\n?\s*const limit = opts\.limit \?\? 50;/,
    );
    expect(body).toMatch(
      /data: filtered\.slice\(0, limit\),\s*\n?\s*nextCursor: filtered\.length > limit \? `cursor_\$\{limit\.toString\(\)\}` : null,/,
    );
  });

  it("replay: rejects 'delivery not found: ${id}' on missing; fixed now=1714867260000 (60s after enqueue); appends replayAttempt with attempt = existing.attempts.length + 1; preserves existing fields via spread + appends to attempts + nextAttemptAtMs:null", () => {
    expect(body).toMatch(
      /return Promise\.reject\(new Error\(`delivery not found: \$\{deliveryId\}`\)\);/,
    );
    expect(body).toMatch(/const now = 1714867260000;/);
    expect(body).toMatch(
      /const replayAttempt: DeliveryAttempt = \{\s*\n?\s*attempt: existing\.attempts\.length \+ 1,/,
    );
    expect(body).toMatch(
      /const updated: DeliveryRecord = \{\s*\n?\s*\.\.\.existing,\s*\n?\s*status: 'delivered',\s*\n?\s*attempts: \[\.\.\.existing\.attempts, replayAttempt\],\s*\n?\s*nextAttemptAtMs: null,\s*\n?\s*completedAtMs: now \+ SUCCESS_ATTEMPT_DURATION_MS,\s*\n?\s*\};/,
    );
  });

  it("MockDlqManager seedEntry framing pinned: 'Test seam: insert a DLQ entry directly.'", () => {
    expect(body).toMatch(
      /\/\*\* Test seam: insert a DLQ entry directly\. \*\/\s*\n?\s*seedEntry\(entry: DlqEntry\): void \{\s*\n?\s*this\.entries\.set\(entry\.deliveryId, entry\);\s*\n?\s*\}/,
    );
  });

  it("MockDlqManager.requeue: rejects 'dlq entry not found' on missing; fixed now=1714867320000 (120s after enqueue); deletes entry from map; produces DeliveryRecord status:'pending' + nextAttemptAtMs:now + completedAtMs:null + createdAtMs = entry.enteredDlqAtMs", () => {
    expect(body).toMatch(
      /return Promise\.reject\(new Error\(`dlq entry not found: \$\{opts\.deliveryId\}`\)\);/,
    );
    expect(body).toMatch(
      /this\.entries\.delete\(opts\.deliveryId\);\s*\n?\s*const now = 1714867320000;\s*\n?\s*const record: DeliveryRecord = \{\s*\n?\s*id: entry\.deliveryId,\s*\n?\s*endpointId: entry\.endpointId,\s*\n?\s*payload: entry\.payload,\s*\n?\s*status: 'pending',\s*\n?\s*attempts: entry\.attempts,\s*\n?\s*nextAttemptAtMs: now,\s*\n?\s*createdAtMs: entry\.enteredDlqAtMs,\s*\n?\s*completedAtMs: null,\s*\n?\s*\};/,
    );
  });

  it('MockDlqManager.discard: entries.delete + Promise.resolve()', () => {
    expect(body).toMatch(
      /discard\(deliveryId: string\): Promise<void> \{\s*\n?\s*this\.entries\.delete\(deliveryId\);\s*\n?\s*return Promise\.resolve\(\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
