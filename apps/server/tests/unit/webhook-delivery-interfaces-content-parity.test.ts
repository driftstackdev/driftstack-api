// W451.B — drift guard for packages/webhook-delivery/src/interfaces.ts.
// V-144 webhook delivery system interfaces. Drift here either drops
// the replay() method on WebhookDeliveryService (admin replay route
// loses its server-side seam) or breaks the lease-based pull()
// contract on DeliveryQueue (concurrent workers double-pull pending
// records on lease expiry).
//
//   • V-144 framing pinned + Phase-3 seam rationale.
//   • imports: 5 type-only from ./types.
//   • EnqueueDeliveryOpts: 2 fields (endpoint + payload).
//   • ListDeliveriesOpts: endpointId + optional {limit (default 50,
//     max 200) + cursor + status (DeliveryRecord status filter)}.
//   • ListDeliveriesPage: {data + nextCursor}.
//   • WebhookDeliveryService: 4 methods incl. replay() framing pinned
//     ('Resets attempts + sends back through the queue. Status moves
//     to pending. New attempt rows append to the existing record.').
//   • RequeueDlqOpts: deliveryId + optional reason.
//   • DlqManager: 4 methods (list + get + requeue + discard) with
//     'Hard-delete a DLQ entry. Payload becomes unrecoverable. Audit
//     row required (handled by call site, not this interface).'
//     framing pinned.
//   • DeliveryQueue framing pinned: 'in-memory (testing), Postgres-
//     backed outbox table (current production), Redis Streams +
//     worker pool (future high-volume path).'
//   • DeliveryQueue: 3 methods (push + pull (status='pending' &&
//     nextAttemptAtMs <= now; lease semantics) + recordAttempt).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webhook-delivery/src/interfaces.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W451.B packages/webhook-delivery/src/interfaces.ts content parity', () => {
  const body = read(LIB);

  it("V-144 framing pinned: 'V-144 — webhook delivery system interfaces.' + Phase 3 seam rationale 'so a more sophisticated implementation (multi-region replication, batching, ordering guarantees) can drop in without touching call sites'", () => {
    expect(body).toMatch(/\/\/ V-144 — webhook delivery system interfaces\./);
    expect(body).toMatch(
      /\/\/ Phase 3 \/ future-iteration work fills these in with real\s*\n?\s*\/\/ implementations\. Today, apps\/server\/src\/services\/webhooks\.ts \+\s*\n?\s*\/\/ webhook-worker\.ts together approximate the same surface inline;\s*\n?\s*\/\/ the seam exists so a more sophisticated implementation \(multi-\s*\n?\s*\/\/ region replication, batching, ordering guarantees\) can drop in\s*\n?\s*\/\/ without touching call sites\./,
    );
  });

  it('imports: 5 type-only from ./types (DeliveryAttempt + DeliveryEndpoint + DeliveryPayload + DeliveryRecord + DlqEntry)', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*DeliveryAttempt,\s*\n?\s*DeliveryEndpoint,\s*\n?\s*DeliveryPayload,\s*\n?\s*DeliveryRecord,\s*\n?\s*DlqEntry,\s*\n?\s*\} from '\.\/types\.js';/,
    );
  });

  it('EnqueueDeliveryOpts: 2 fields (endpoint + payload); ListDeliveriesOpts: endpointId + optional limit (default 50, max 200) + cursor + status filter', () => {
    expect(body).toMatch(
      /export interface EnqueueDeliveryOpts \{\s*\n?\s*endpoint: DeliveryEndpoint;\s*\n?\s*payload: DeliveryPayload;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface ListDeliveriesOpts \{\s*\n?\s*endpointId: string;\s*\n?\s*\/\*\* Page size\. Default 50, max 200\. \*\/\s*\n?\s*limit\?: number;[\s\S]*?cursor\?: string;[\s\S]*?status\?: DeliveryRecord\['status'\];/,
    );
    expect(body).toMatch(
      /export interface ListDeliveriesPage \{\s*\n?\s*data: readonly DeliveryRecord\[\];\s*\n?\s*nextCursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it("WebhookDeliveryService framing pinned: 'Top-level delivery service. Customers /v1/webhooks/* reads + the server outbound emit path both go through this interface.' + 4 methods (enqueue + get + list + replay)", () => {
    expect(body).toMatch(
      /\* Top-level delivery service\. Customers' `\/v1\/webhooks\/\*` reads \+ the\s*\n?\s*\*\s*server's outbound emit path both go through this interface\./,
    );
    expect(body).toMatch(/enqueue\(opts: EnqueueDeliveryOpts\): Promise<DeliveryRecord>;/);
    expect(body).toMatch(/get\(deliveryId: string\): Promise<DeliveryRecord \| null>;/);
    expect(body).toMatch(/list\(opts: ListDeliveriesOpts\): Promise<ListDeliveriesPage>;/);
    expect(body).toMatch(/replay\(deliveryId: string\): Promise<DeliveryRecord>;/);
  });

  it("enqueue framing pinned: 'Returns the queued record with status pending + a computed nextAttemptAtMs (immediate by default).'; replay framing pinned: 'Replay a failed or delivered delivery. Resets attempts + sends back through the queue. Status moves to pending. New attempt rows append to the existing record.'", () => {
    expect(body).toMatch(
      /\* Enqueue a delivery\. Returns the queued record with status `'pending'`\s*\n?\s*\*\s*\+ a computed `nextAttemptAtMs` \(immediate by default\)\./,
    );
    expect(body).toMatch(
      /\* Replay a `'failed'` or `'delivered'` delivery\. Resets attempts \+\s*\n?\s*\*\s*sends back through the queue\. Status moves to `'pending'`\. New\s*\n?\s*\*\s*attempt rows append to the existing record\./,
    );
  });

  it("RequeueDlqOpts: deliveryId + optional reason; DlqManager 4 methods (list scoped/unscoped {accountId? + limit? + cursor?} → {data + nextCursor} + get + requeue + discard); discard framing pinned 'Payload becomes unrecoverable. Audit row required (handled by call site, not this interface).'", () => {
    expect(body).toMatch(
      /export interface RequeueDlqOpts \{\s*\n?\s*deliveryId: string;[\s\S]*?reason\?: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /list\(opts: \{ accountId\?: string; limit\?: number; cursor\?: string \}\): Promise<\{\s*\n?\s*data: readonly DlqEntry\[\];\s*\n?\s*nextCursor: string \| null;\s*\n?\s*\}>;/,
    );
    expect(body).toMatch(/get\(deliveryId: string\): Promise<DlqEntry \| null>;/);
    expect(body).toMatch(/requeue\(opts: RequeueDlqOpts\): Promise<DeliveryRecord>;/);
    expect(body).toMatch(/discard\(deliveryId: string\): Promise<void>;/);
    expect(body).toMatch(
      /\* Hard-delete a DLQ entry\. Payload becomes unrecoverable\. Audit\s*\n?\s*\*\s*row required \(handled by call site, not this interface\)\./,
    );
  });

  it("requeue framing pinned: 'Move a DLQ entry back into the active queue. Resets attempt counter; new attempts append to the existing attempt log so postmortem stays intact.'", () => {
    expect(body).toMatch(
      /\* Move a DLQ entry back into the active queue\. Resets attempt\s*\n?\s*\*\s*counter; new attempts append to the existing attempt log so\s*\n?\s*\*\s*postmortem stays intact\./,
    );
  });

  it("DeliveryQueue framing pinned: 'Underlying queue primitive. Implementations: in-memory (testing), Postgres-backed outbox table (current production), Redis Streams + worker pool (future high-volume path).'", () => {
    expect(body).toMatch(
      /\* Underlying queue primitive\. Implementations: in-memory \(testing\),\s*\n?\s*\*\s*Postgres-backed `outbox` table \(current production\), Redis Streams\s*\n?\s*\*\s*\+ worker pool \(future high-volume path\)\./,
    );
  });

  it("DeliveryQueue: 3 methods (push → record id; pull batched with lease semantics 'status === pending && nextAttemptAtMs <= now; Worker leases them for leaseDurationMs; lease expiry returns the record to the available pool'; recordAttempt 'recompute nextAttemptAtMs from the per-endpoint backoff curve, promote to delivered/failed/dlq per the outcome')", () => {
    expect(body).toMatch(/push\(record: DeliveryRecord\): Promise<string>;/);
    expect(body).toMatch(
      /\* Pull the next batch of records due for an attempt\s*\n?\s*\*\s*\(`status === 'pending' && nextAttemptAtMs <= now`\)\. Worker leases\s*\n?\s*\*\s*them for `leaseDurationMs`; lease expiry returns the record to\s*\n?\s*\*\s*the available pool\./,
    );
    expect(body).toMatch(
      /pull\(opts: \{\s*\n?\s*batchSize: number;\s*\n?\s*leaseDurationMs: number;\s*\n?\s*now: number;\s*\n?\s*\}\): Promise<readonly DeliveryRecord\[\]>;/,
    );
    expect(body).toMatch(
      /\* Update a record's state after an attempt completes\. Implementations\s*\n?\s*\*\s*recompute `nextAttemptAtMs` from the per-endpoint backoff curve,\s*\n?\s*\*\s*promote to `delivered` \/ `failed` \/ `dlq` per the outcome\./,
    );
    expect(body).toMatch(
      /recordAttempt\(deliveryId: string, attempt: DeliveryAttempt\): Promise<DeliveryRecord>;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
