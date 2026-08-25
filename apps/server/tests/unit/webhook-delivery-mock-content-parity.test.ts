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
      /\/\/ Deterministic outputs so tests can assert exact shape without\s*\/\/ timing flakiness\. Same inputs always produce the same DeliveryRecord\s*\/\/ shapes \(matches the mock-driver discipline used elsewhere in the repo\)\./,
    );
    expect(body).toMatch(
      /\/\/ Real production implementation in apps\/server\/src\/services\/webhooks\.ts\s*\/\/ \+ webhook-worker\.ts\. Mock here lets future-system consumers exercise\s*\/\/ the seam without standing up the real worker pool\./,
    );
  });

  it('SUCCESS_ATTEMPT_DURATION_MS = 50 constant', () => {
    expect(body).toMatch(/const SUCCESS_ATTEMPT_DURATION_MS = 50;/);
  });

  it("MockWebhookDeliveryService framing pinned: 'Mock delivery service backed by an in-memory map. Every enqueue resolves immediately to a delivered record; the mock isn't meant to model retry behavior, only the shape contract. Tests that need retry mechanics use MockDlqManager.'", () => {
    expect(body).toMatch(
      /\* Mock delivery service backed by an in-memory map\. Every enqueue\s*\*\s*resolves immediately to a `delivered` record; the mock isn't meant\s*\*\s*to model retry behavior, only the shape contract\. Tests that need\s*\*\s*retry mechanics use `MockDlqManager`\./,
    );
    expect(body).toMatch(
      /export class MockWebhookDeliveryService implements WebhookDeliveryService \{\s*private readonly records = new Map<string, DeliveryRecord>\(\);\s*private nextSeq = 1;/,
    );
  });

  it("enqueue: id format mock_del_ + padStart(8, '0'); nextSeq increment; fixed now=1714867200000 (2024-05-04T00:00:00Z deterministic-across-test-runs framing pinned); attempt 1 + responseStatus 200 + 'OK' excerpt; status:'delivered' + nextAttemptAtMs:null + completedAtMs = now + SUCCESS_ATTEMPT_DURATION_MS", () => {
    expect(body).toMatch(
      /const id = `mock_del_\$\{this\.nextSeq\.toString\(\)\.padStart\(8, '0'\)\}`;\s*this\.nextSeq \+= 1;\s*const now = 1714867200000;[\s\S]*?\/\/ Fixed: 2024-05-04T00:00:00Z\. Deterministic across test runs\./,
    );
    expect(body).toMatch(
      /const attempt: DeliveryAttempt = \{\s*attempt: 1,\s*completedAtMs: now \+ SUCCESS_ATTEMPT_DURATION_MS,\s*responseStatus: 200,\s*responseExcerpt: 'OK',\s*durationMs: SUCCESS_ATTEMPT_DURATION_MS,\s*outcome: 'success',\s*errorMessage: null,\s*\};/,
    );
    expect(body).toMatch(
      /const record: DeliveryRecord = \{\s*id,\s*endpointId: opts\.endpoint\.id,\s*payload: opts\.payload,\s*status: 'delivered',\s*attempts: \[attempt\],\s*nextAttemptAtMs: null,\s*createdAtMs: now,\s*completedAtMs: now \+ SUCCESS_ATTEMPT_DURATION_MS,\s*\};/,
    );
  });

  it('get: Promise.resolve(map.get(id) ?? null); list: filter by endpointId + optional status + limit ?? 50; nextCursor = `cursor_${limit}` when filtered.length > limit', () => {
    expect(body).toMatch(
      /get\(deliveryId: string\): Promise<DeliveryRecord \| null> \{\s*return Promise\.resolve\(this\.records\.get\(deliveryId\) \?\? null\);\s*\}/,
    );
    expect(body).toMatch(
      /const all = \[\.\.\.this\.records\.values\(\)\]\.filter\(\(r\) => r\.endpointId === opts\.endpointId\);\s*const filtered = opts\.status === undefined \? all : all\.filter\(\(r\) => r\.status === opts\.status\);\s*const limit = opts\.limit \?\? 50;/,
    );
    expect(body).toMatch(
      /data: filtered\.slice\(0, limit\),\s*nextCursor: filtered\.length > limit \? `cursor_\$\{limit\.toString\(\)\}` : null,/,
    );
  });

  it("replay: rejects 'delivery not found: ${id}' on missing; fixed now=1714867260000 (60s after enqueue); appends replayAttempt with attempt = existing.attempts.length + 1; preserves existing fields via spread + appends to attempts + nextAttemptAtMs:null", () => {
    expect(body).toMatch(
      /return Promise\.reject\(new Error\(`delivery not found: \$\{deliveryId\}`\)\);/,
    );
    expect(body).toMatch(/const now = 1714867260000;/);
    expect(body).toMatch(
      /const replayAttempt: DeliveryAttempt = \{\s*attempt: existing\.attempts\.length \+ 1,/,
    );
    expect(body).toMatch(
      /const updated: DeliveryRecord = \{\s*\.\.\.existing,\s*status: 'delivered',\s*attempts: \[\.\.\.existing\.attempts, replayAttempt\],\s*nextAttemptAtMs: null,\s*completedAtMs: now \+ SUCCESS_ATTEMPT_DURATION_MS,\s*\};/,
    );
  });

  it("MockDlqManager seedEntry framing pinned: 'Test seam: insert a DLQ entry directly.'", () => {
    expect(body).toMatch(
      /\/\*\* Test seam: insert a DLQ entry directly\. \*\/\s*seedEntry\(entry: DlqEntry\): void \{\s*this\.entries\.set\(entry\.deliveryId, entry\);\s*\}/,
    );
  });

  it("MockDlqManager.requeue: rejects 'dlq entry not found' on missing; fixed now=1714867320000 (120s after enqueue); deletes entry from map; produces DeliveryRecord status:'pending' + nextAttemptAtMs:now + completedAtMs:null + createdAtMs = entry.enteredDlqAtMs", () => {
    expect(body).toMatch(
      /return Promise\.reject\(new Error\(`dlq entry not found: \$\{opts\.deliveryId\}`\)\);/,
    );
    expect(body).toMatch(
      /this\.entries\.delete\(opts\.deliveryId\);\s*const now = 1714867320000;\s*const record: DeliveryRecord = \{\s*id: entry\.deliveryId,\s*endpointId: entry\.endpointId,\s*payload: entry\.payload,\s*status: 'pending',\s*attempts: entry\.attempts,\s*nextAttemptAtMs: now,\s*createdAtMs: entry\.enteredDlqAtMs,\s*completedAtMs: null,\s*\};/,
    );
  });

  it('MockDlqManager.discard: entries.delete + Promise.resolve()', () => {
    expect(body).toMatch(
      /discard\(deliveryId: string\): Promise<void> \{\s*this\.entries\.delete\(deliveryId\);\s*return Promise\.resolve\(\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
