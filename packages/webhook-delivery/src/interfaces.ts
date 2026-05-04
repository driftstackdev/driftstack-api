// V-144 — webhook delivery system interfaces.
//
// Phase 3 / future-iteration work fills these in with real
// implementations. Today, apps/server/src/services/webhooks.ts +
// webhook-worker.ts together approximate the same surface inline;
// the seam exists so a more sophisticated implementation (multi-
// region replication, batching, ordering guarantees) can drop in
// without touching call sites.

import type {
  DeliveryAttempt,
  DeliveryEndpoint,
  DeliveryPayload,
  DeliveryRecord,
  DlqEntry,
} from './types.js';

export interface EnqueueDeliveryOpts {
  endpoint: DeliveryEndpoint;
  payload: DeliveryPayload;
}

export interface ListDeliveriesOpts {
  endpointId: string;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Cursor from a prior response. */
  cursor?: string;
  /** Filter to a single status. Omit for all. */
  status?: DeliveryRecord['status'];
}

export interface ListDeliveriesPage {
  data: readonly DeliveryRecord[];
  nextCursor: string | null;
}

/**
 * Top-level delivery service. Customers' `/v1/webhooks/*` reads + the
 * server's outbound emit path both go through this interface.
 */
export interface WebhookDeliveryService {
  /**
   * Enqueue a delivery. Returns the queued record with status `'pending'`
   * + a computed `nextAttemptAtMs` (immediate by default).
   */
  enqueue(opts: EnqueueDeliveryOpts): Promise<DeliveryRecord>;

  /** Look up a single delivery. */
  get(deliveryId: string): Promise<DeliveryRecord | null>;

  /** Paginated listing scoped to an endpoint. */
  list(opts: ListDeliveriesOpts): Promise<ListDeliveriesPage>;

  /**
   * Replay a `'failed'` or `'delivered'` delivery. Resets attempts +
   * sends back through the queue. Status moves to `'pending'`. New
   * attempt rows append to the existing record.
   */
  replay(deliveryId: string): Promise<DeliveryRecord>;
}

export interface RequeueDlqOpts {
  deliveryId: string;
  /** Optional human-readable reason recorded on the audit row. */
  reason?: string;
}

/**
 * Dead-letter queue management. Admin-side surface (`/v1/admin/webhook-dlq*`)
 * + (future) automated cleanup workflows both go through this.
 */
export interface DlqManager {
  /** Page through DLQ entries, scoped or unscoped. */
  list(opts: { accountId?: string; limit?: number; cursor?: string }): Promise<{
    data: readonly DlqEntry[];
    nextCursor: string | null;
  }>;

  /** Look up a single DLQ entry. */
  get(deliveryId: string): Promise<DlqEntry | null>;

  /**
   * Move a DLQ entry back into the active queue. Resets attempt
   * counter; new attempts append to the existing attempt log so
   * postmortem stays intact.
   */
  requeue(opts: RequeueDlqOpts): Promise<DeliveryRecord>;

  /**
   * Hard-delete a DLQ entry. Payload becomes unrecoverable. Audit
   * row required (handled by call site, not this interface).
   */
  discard(deliveryId: string): Promise<void>;
}

/**
 * Underlying queue primitive. Implementations: in-memory (testing),
 * Postgres-backed `outbox` table (current production), Redis Streams
 * + worker pool (future high-volume path).
 */
export interface DeliveryQueue {
  /** Append a record to the queue. Returns the assigned record id. */
  push(record: DeliveryRecord): Promise<string>;

  /**
   * Pull the next batch of records due for an attempt
   * (`status === 'pending' && nextAttemptAtMs <= now`). Worker leases
   * them for `leaseDurationMs`; lease expiry returns the record to
   * the available pool.
   */
  pull(opts: {
    batchSize: number;
    leaseDurationMs: number;
    now: number;
  }): Promise<readonly DeliveryRecord[]>;

  /**
   * Update a record's state after an attempt completes. Implementations
   * recompute `nextAttemptAtMs` from the per-endpoint backoff curve,
   * promote to `delivered` / `failed` / `dlq` per the outcome.
   */
  recordAttempt(deliveryId: string, attempt: DeliveryAttempt): Promise<DeliveryRecord>;
}
