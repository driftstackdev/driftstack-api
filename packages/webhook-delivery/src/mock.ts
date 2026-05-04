// V-144 — mock webhook delivery service.
//
// Deterministic outputs so tests can assert exact shape without
// timing flakiness. Same inputs always produce the same DeliveryRecord
// shapes (matches CLAUDE.md mock-driver discipline).
//
// Real production implementation in apps/server/src/services/webhooks.ts
// + webhook-worker.ts. Mock here lets future-system consumers exercise
// the seam without standing up the real worker pool.

import type {
  DlqManager,
  EnqueueDeliveryOpts,
  ListDeliveriesOpts,
  ListDeliveriesPage,
  RequeueDlqOpts,
  WebhookDeliveryService,
} from './interfaces.js';
import type { DeliveryAttempt, DeliveryRecord, DlqEntry } from './types.js';

const SUCCESS_ATTEMPT_DURATION_MS = 50;

/**
 * Mock delivery service backed by an in-memory map. Every enqueue
 * resolves immediately to a `delivered` record; the mock isn't meant
 * to model retry behavior, only the shape contract. Tests that need
 * retry mechanics use `MockDlqManager`.
 */
export class MockWebhookDeliveryService implements WebhookDeliveryService {
  private readonly records = new Map<string, DeliveryRecord>();
  private nextSeq = 1;

  enqueue(opts: EnqueueDeliveryOpts): Promise<DeliveryRecord> {
    const id = `mock_del_${this.nextSeq.toString().padStart(8, '0')}`;
    this.nextSeq += 1;
    const now = 1714867200000; // Fixed: 2024-05-04T00:00:00Z. Deterministic across test runs.
    const attempt: DeliveryAttempt = {
      attempt: 1,
      completedAtMs: now + SUCCESS_ATTEMPT_DURATION_MS,
      responseStatus: 200,
      responseExcerpt: 'OK',
      durationMs: SUCCESS_ATTEMPT_DURATION_MS,
      outcome: 'success',
      errorMessage: null,
    };
    const record: DeliveryRecord = {
      id,
      endpointId: opts.endpoint.id,
      payload: opts.payload,
      status: 'delivered',
      attempts: [attempt],
      nextAttemptAtMs: null,
      createdAtMs: now,
      completedAtMs: now + SUCCESS_ATTEMPT_DURATION_MS,
    };
    this.records.set(id, record);
    return Promise.resolve(record);
  }

  get(deliveryId: string): Promise<DeliveryRecord | null> {
    return Promise.resolve(this.records.get(deliveryId) ?? null);
  }

  list(opts: ListDeliveriesOpts): Promise<ListDeliveriesPage> {
    const all = [...this.records.values()].filter((r) => r.endpointId === opts.endpointId);
    const filtered = opts.status === undefined ? all : all.filter((r) => r.status === opts.status);
    const limit = opts.limit ?? 50;
    return Promise.resolve({
      data: filtered.slice(0, limit),
      nextCursor: filtered.length > limit ? `cursor_${limit.toString()}` : null,
    });
  }

  replay(deliveryId: string): Promise<DeliveryRecord> {
    const existing = this.records.get(deliveryId);
    if (!existing) {
      return Promise.reject(new Error(`delivery not found: ${deliveryId}`));
    }
    const now = 1714867260000;
    const replayAttempt: DeliveryAttempt = {
      attempt: existing.attempts.length + 1,
      completedAtMs: now + SUCCESS_ATTEMPT_DURATION_MS,
      responseStatus: 200,
      responseExcerpt: 'OK',
      durationMs: SUCCESS_ATTEMPT_DURATION_MS,
      outcome: 'success',
      errorMessage: null,
    };
    const updated: DeliveryRecord = {
      ...existing,
      status: 'delivered',
      attempts: [...existing.attempts, replayAttempt],
      nextAttemptAtMs: null,
      completedAtMs: now + SUCCESS_ATTEMPT_DURATION_MS,
    };
    this.records.set(deliveryId, updated);
    return Promise.resolve(updated);
  }
}

export class MockDlqManager implements DlqManager {
  private readonly entries = new Map<string, DlqEntry>();

  /** Test seam: insert a DLQ entry directly. */
  seedEntry(entry: DlqEntry): void {
    this.entries.set(entry.deliveryId, entry);
  }

  list(opts: {
    accountId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ data: readonly DlqEntry[]; nextCursor: string | null }> {
    const all = [...this.entries.values()];
    const filtered =
      opts.accountId === undefined ? all : all.filter((e) => e.accountId === opts.accountId);
    const limit = opts.limit ?? 50;
    return Promise.resolve({
      data: filtered.slice(0, limit),
      nextCursor: filtered.length > limit ? `cursor_${limit.toString()}` : null,
    });
  }

  get(deliveryId: string): Promise<DlqEntry | null> {
    return Promise.resolve(this.entries.get(deliveryId) ?? null);
  }

  requeue(opts: RequeueDlqOpts): Promise<DeliveryRecord> {
    const entry = this.entries.get(opts.deliveryId);
    if (!entry) {
      return Promise.reject(new Error(`dlq entry not found: ${opts.deliveryId}`));
    }
    this.entries.delete(opts.deliveryId);
    const now = 1714867320000;
    const record: DeliveryRecord = {
      id: entry.deliveryId,
      endpointId: entry.endpointId,
      payload: entry.payload,
      status: 'pending',
      attempts: entry.attempts,
      nextAttemptAtMs: now,
      createdAtMs: entry.enteredDlqAtMs,
      completedAtMs: null,
    };
    return Promise.resolve(record);
  }

  discard(deliveryId: string): Promise<void> {
    this.entries.delete(deliveryId);
    return Promise.resolve();
  }
}
