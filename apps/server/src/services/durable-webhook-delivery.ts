// V-173 — DurableWebhookDeliveryService: Postgres-backed implementation
// of @driftstack/webhook-delivery's WebhookDeliveryService + DlqManager
// interfaces. Companion to V-164 InMemoryWebhookDelivery.
//
// COEXISTENCE NOTE: apps/server/src/services/webhooks.ts is the existing
// inline implementation (production today). V-173 lands the
// package-interface-conformant Postgres-backed implementation as the
// FORWARD path. The two services CAN coexist (both write to the same
// webhook_endpoints + webhook_deliveries tables) but in practice the
// codebase uses one or the other per delivery — the existing service
// owns deliveries it created, the new service owns deliveries it
// created. Migration to fully replace webhooks.ts is a separate
// future V-NNN once V-173 has soak time + integration tests against
// real DB.
//
// Worker uses SELECT...FOR UPDATE SKIP LOCKED for cross-process
// coordination (the existing webhook-worker.ts already uses this
// pattern via WebhooksRepo.claim; V-173 reuses the same primitive
// inline rather than depending on the existing repo).
//
// The package's DeliveryRecord.attempts array (full history) maps to
// the V-173-introduced webhook_delivery_attempts table (one row per
// attempt). The existing webhook_deliveries.attempts integer column
// stores the count.

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { signWebhookPayload } from '../lib/webhook-signing.js';
import type {
  DlqManager,
  EnqueueDeliveryOpts,
  ListDeliveriesOpts,
  ListDeliveriesPage,
  RequeueDlqOpts,
  WebhookDeliveryService,
} from '@driftstack/webhook-delivery';
import type {
  DeliveryAttempt,
  DeliveryPayload,
  DeliveryRecord,
  DeliveryStatus,
  DlqEntry,
} from '@driftstack/webhook-delivery';
import type { Database } from '../db/client.js';
import { webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints } from '../db/schema.js';
import { METRIC_NAMES } from './metrics-registry.js';

/** Backoff schedule mirroring V-164 InMemoryWebhookDelivery. */
export const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = {
  1: 60_000,
  2: 5 * 60_000,
  3: 15 * 60_000,
  4: 30 * 60_000,
  5: 60 * 60_000,
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 6; // initial + 5 retries (backoff[5] = 60 min); DLQ on the 6th

export interface DurableWebhookDeliveryDeps {
  database: Database;
  /** Test seam — defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test seam — defaults to () => Date.now(). */
  now?: () => number;
  /** Arc 7 obs.14 — optional metrics registry. When wired, the
   *  worker emits attempt + terminal-state counters per delivery. */
  metrics?: {
    inc: (name: string, labels?: Readonly<Record<string, string>>, delta?: number) => void;
  };
}

export interface ProcessTickResult {
  pulled: number;
  delivered: number;
  retried: number;
  dlqed: number;
}

/** Allowed event_type values for the `webhook_event_type` enum (per schema.ts). */
type WebhookEventType =
  | 'session.completed'
  | 'session.failed'
  | 'quota.warning_80pct'
  | 'quota.exceeded'
  | 'api_key.revoked';

/**
 * Construct the durable webhook-delivery system. Returns the
 * WebhookDeliveryService + DlqManager pair plus a `processTick` method
 * that drives the delivery loop one batch at a time using SELECT...
 * FOR UPDATE SKIP LOCKED.
 */
export interface DurableWebhookDeliveryHandles {
  deliveries: DurableWebhookDeliveryService;
  dlq: DurableDlqManager;
  processTick(opts?: { batchSize?: number; leaseDurationMs?: number }): Promise<ProcessTickResult>;
}

export function createDurableWebhookDelivery(
  deps: DurableWebhookDeliveryDeps,
): DurableWebhookDeliveryHandles {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());

  const deliveries = new DurableWebhookDeliveryService(deps.database, now);
  const dlq = new DurableDlqManager(deps.database, now);
  const worker = new DurableWebhookWorker(deps.database, fetchFn, now, deps.metrics);

  return {
    deliveries,
    dlq,
    processTick: (opts) => worker.processTick(opts),
  };
}

export class DurableWebhookDeliveryService implements WebhookDeliveryService {
  constructor(
    private readonly database: Database,
    private readonly now: () => number,
  ) {}

  async enqueue(opts: EnqueueDeliveryOpts): Promise<DeliveryRecord> {
    const nowMs = this.now();
    const [row] = await this.database.db
      .insert(webhookDeliveries)
      .values({
        webhookId: opts.endpoint.id,
        eventId: opts.payload.eventId,
        eventType: opts.payload.eventType as WebhookEventType,
        payload: { body: opts.payload.body, emittedAtSec: opts.payload.emittedAtSec },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(nowMs),
      })
      .returning();
    if (!row) throw new Error('enqueue: insert returned no row');
    return rowToDeliveryRecord(row, []);
  }

  async get(deliveryId: string): Promise<DeliveryRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!row) return null;
    const attempts = await loadAttempts(this.database, deliveryId);
    return rowToDeliveryRecord(row, attempts);
  }

  async list(opts: ListDeliveriesOpts): Promise<ListDeliveriesPage> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions = [eq(webhookDeliveries.webhookId, opts.endpointId)];
    if (opts.status !== undefined) {
      conditions.push(eq(webhookDeliveries.status, opts.status));
    }
    if (opts.cursor !== undefined) {
      // Cursor is the last id from the prior page. With newest-first
      // ordering by (createdAt desc, id desc), "after cursor" is the
      // full keyset comparison: (createdAt < cursor.createdAt) OR
      // (createdAt == cursor.createdAt AND id < cursor.id). The
      // createdAt-only filter used previously silently dropped every
      // row sharing the cursor's createdAt — and deliveries fanned out
      // in one batch share an identical createdAt — so a page boundary
      // landing inside such a batch lost rows. Mirrors the in-memory
      // reference impl (packages/webhook-delivery in-memory.ts), which
      // slices after the cursor on a (createdAt, id)-sorted list.
      const [cursorRow] = await this.database.db
        .select({ createdAt: webhookDeliveries.createdAt })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, opts.cursor))
        .limit(1);
      if (cursorRow) {
        conditions.push(
          or(
            lt(webhookDeliveries.createdAt, cursorRow.createdAt),
            and(
              eq(webhookDeliveries.createdAt, cursorRow.createdAt),
              lt(webhookDeliveries.id, opts.cursor),
            ),
          )!,
        );
      }
    }

    const rows = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const data = await Promise.all(
      page.map(async (r) => rowToDeliveryRecord(r, await loadAttempts(this.database, r.id))),
    );
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
    return { data, nextCursor };
  }

  async replay(deliveryId: string): Promise<DeliveryRecord> {
    const [row] = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!row) throw new Error(`replay: delivery ${deliveryId} not found`);
    const nowMs = this.now();
    await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        nextAttemptAt: new Date(nowMs),
        deliveredAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    const updated = await this.get(deliveryId);
    if (!updated) throw new Error(`replay: re-fetch failed for ${deliveryId}`);
    return updated;
  }
}

export class DurableDlqManager implements DlqManager {
  constructor(
    private readonly database: Database,
    private readonly now: () => number,
  ) {}

  async list(opts: {
    accountId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ data: readonly DlqEntry[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions = [eq(webhookDeliveries.status, 'dlq' as DeliveryStatus)];
    if (opts.cursor !== undefined) {
      // Full keyset comparison against (updatedAt desc, id desc) — see
      // DurableWebhookDeliveryService.list. An updatedAt-only filter
      // drops DLQ rows sharing the cursor's updatedAt (common when a
      // batch enters the DLQ together) at the page boundary.
      const [cursorRow] = await this.database.db
        .select({ updatedAt: webhookDeliveries.updatedAt })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, opts.cursor))
        .limit(1);
      if (cursorRow) {
        conditions.push(
          or(
            lt(webhookDeliveries.updatedAt, cursorRow.updatedAt),
            and(
              eq(webhookDeliveries.updatedAt, cursorRow.updatedAt),
              lt(webhookDeliveries.id, opts.cursor),
            ),
          )!,
        );
      }
    }

    // accountId filter requires a JOIN to webhook_endpoints.
    const rows = opts.accountId
      ? await this.database.db
          .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
          .from(webhookDeliveries)
          .innerJoin(webhookEndpoints, eq(webhookDeliveries.webhookId, webhookEndpoints.id))
          .where(and(...conditions, eq(webhookEndpoints.accountId, opts.accountId)))
          .orderBy(desc(webhookDeliveries.updatedAt), desc(webhookDeliveries.id))
          .limit(limit + 1)
      : await this.database.db
          .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
          .from(webhookDeliveries)
          .innerJoin(webhookEndpoints, eq(webhookDeliveries.webhookId, webhookEndpoints.id))
          .where(and(...conditions))
          .orderBy(desc(webhookDeliveries.updatedAt), desc(webhookDeliveries.id))
          .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const data: DlqEntry[] = await Promise.all(
      page.map(async (r) => {
        const attempts = await loadAttempts(this.database, r.delivery.id);
        return rowToDlqEntry(r.delivery, r.endpoint.accountId, attempts);
      }),
    );
    const nextCursor = hasMore ? (page[page.length - 1]?.delivery.id ?? null) : null;
    return { data, nextCursor };
  }

  async get(deliveryId: string): Promise<DlqEntry | null> {
    const [row] = await this.database.db
      .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookDeliveries.webhookId, webhookEndpoints.id))
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.status, 'dlq' as DeliveryStatus),
        ),
      )
      .limit(1);
    if (!row) return null;
    const attempts = await loadAttempts(this.database, deliveryId);
    return rowToDlqEntry(row.delivery, row.endpoint.accountId, attempts);
  }

  async requeue(opts: RequeueDlqOpts): Promise<DeliveryRecord> {
    const nowMs = this.now();
    const [row] = await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        nextAttemptAt: new Date(nowMs),
        deliveredAt: null,
      })
      .where(eq(webhookDeliveries.id, opts.deliveryId))
      .returning();
    if (!row) throw new Error(`requeue: delivery ${opts.deliveryId} not found`);
    const attempts = await loadAttempts(this.database, opts.deliveryId);
    return rowToDeliveryRecord(row, attempts);
  }

  async discard(deliveryId: string): Promise<void> {
    // FK CASCADE on webhook_delivery_attempts.delivery_id cleans up the
    // attempt log automatically.
    await this.database.db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  }
}

export class DurableWebhookWorker {
  constructor(
    private readonly database: Database,
    private readonly fetchFn: typeof fetch,
    private readonly now: () => number,
    private readonly metrics?: {
      inc: (name: string, labels?: Readonly<Record<string, string>>, delta?: number) => void;
    },
  ) {}

  /**
   * Process up to `batchSize` due deliveries. Uses SELECT...FOR
   * UPDATE SKIP LOCKED so multiple worker instances can run
   * concurrently without claiming the same delivery twice.
   */
  async processTick(
    opts: { batchSize?: number; leaseDurationMs?: number } = {},
  ): Promise<ProcessTickResult> {
    const batchSize = opts.batchSize ?? 25;
    const nowMs = this.now();
    const nowDate = new Date(nowMs);
    // Pre-serialize the Date param per the drizzle-orm 0.38.4
    // transparentParser swap workaround (see
    // docs/internal/drizzle-date-param-workaround.md). Drizzle replaces
    // postgres-js's OID 1184 serializer with a no-op identity, so a
    // raw `sql\`\`` template literal interpolating a Date crashes at
    // postgres-js's Bind step with Buffer.byteLength(date). Same
    // class of bug that fired the 2026-05-19 scheduled-jobs incident.
    const nowIso = nowDate.toISOString();

    // Atomic claim: SELECT due rows + flip to in_flight in one txn.
    // FOR UPDATE SKIP LOCKED ensures concurrent workers each get a
    // disjoint slice.
    const claimed = await this.database.db.transaction(async (tx) => {
      const candidates = await tx.execute(sql`
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${nowIso}
        ORDER BY next_attempt_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `);
      const ids = (candidates as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
      if (ids.length === 0) return [] as string[];
      await tx
        .update(webhookDeliveries)
        .set({ status: 'in_flight' })
        .where(inArray(webhookDeliveries.id, ids));
      return ids;
    });

    if (claimed.length === 0) {
      return { pulled: 0, delivered: 0, retried: 0, dlqed: 0 };
    }

    const claimedRows = await this.database.db
      .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookDeliveries.webhookId, webhookEndpoints.id))
      .where(inArray(webhookDeliveries.id, claimed));

    let delivered = 0;
    let retried = 0;
    let dlqed = 0;

    for (const { delivery, endpoint } of claimedRows) {
      const outcome = await this.deliver(delivery, endpoint);
      if (outcome === 'delivered') delivered++;
      else if (outcome === 'dlqed') dlqed++;
      else retried++;
    }

    return { pulled: claimedRows.length, delivered, retried, dlqed };
  }

  private async deliver(
    delivery: typeof webhookDeliveries.$inferSelect,
    endpoint: typeof webhookEndpoints.$inferSelect,
  ): Promise<'delivered' | 'retried' | 'dlqed'> {
    const startedMs = this.now();
    const attemptNumber = delivery.attempts + 1;
    const payloadShape = delivery.payload as { body: string; emittedAtSec: number };
    const body = payloadShape.body;
    const emittedAtSec = payloadShape.emittedAtSec;

    let attempt: Omit<DeliveryAttempt, 'attempt' | 'completedAtMs'> & {
      attemptNumber: number;
      completedAtMs: number;
    };

    try {
      // V-359 — dual-sign during the rotation grace period. The
      // canonical signer emits a SINGLE `x-driftstack-signature`
      // header in Stripe-style `t=<sec>,v1=<curr>[,v1=<prev>]` form;
      // the SDK verifier parses the `t=` + every `v1=` from that one
      // header and accepts if ANY matches, so a customer holding
      // EITHER the current or the previous secret passes while they
      // roll the new secret across their infra. The second `v1=` is
      // included only when prev is non-null and still in grace.
      const prevInGrace =
        endpoint.secretPrev !== null &&
        endpoint.secretPrevExpiresAt !== null &&
        endpoint.secretPrevExpiresAt.getTime() > this.now();
      const sigHeader = signWebhookPayload({
        body,
        secret: endpoint.secret,
        ...(prevInGrace ? { secretPrev: endpoint.secretPrev as string } : {}),
        timestampSec: emittedAtSec,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const response = await this.fetchFn(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-driftstack-event-id': delivery.eventId,
            'x-driftstack-event-type': delivery.eventType,
            'x-driftstack-signature': sigHeader,
          },
          body,
          signal: controller.signal,
        });
        const text = await response.text().catch(() => '');
        const durationMs = this.now() - startedMs;
        attempt = {
          attemptNumber,
          completedAtMs: this.now(),
          responseStatus: response.status,
          responseExcerpt: text.slice(0, 200),
          durationMs,
          outcome: response.status >= 200 && response.status < 300 ? 'success' : 'http_error',
          errorMessage:
            response.status >= 200 && response.status < 300
              ? null
              : `HTTP ${response.status.toString()}`,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const durationMs = this.now() - startedMs;
      const e = err as { name?: string; message?: string };
      const isTimeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      attempt = {
        attemptNumber,
        completedAtMs: this.now(),
        responseStatus: null,
        responseExcerpt: null,
        durationMs,
        outcome: isTimeout ? 'timeout' : 'transport_error',
        errorMessage: e?.message ?? 'unknown error',
      };
    }

    // Persist the attempt row.
    await this.database.db.insert(webhookDeliveryAttempts).values({
      deliveryId: delivery.id,
      attemptNumber: attempt.attemptNumber,
      completedAtMs: attempt.completedAtMs,
      responseStatus: attempt.responseStatus,
      responseExcerpt: attempt.responseExcerpt,
      durationMs: attempt.durationMs,
      outcome: attempt.outcome,
      errorMessage: attempt.errorMessage,
    });

    // Arc 7 obs.14 — per-attempt outcome counter. Best-effort.
    try {
      this.metrics?.inc(METRIC_NAMES.webhookDeliveryAttemptTotal, { outcome: attempt.outcome });
    } catch {
      // Swallow.
    }

    if (attempt.outcome === 'success') {
      await this.database.db
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          attempts: attemptNumber,
          deliveredAt: new Date(attempt.completedAtMs),
          nextAttemptAt: new Date(attempt.completedAtMs),
          lastResponseStatus: attempt.responseStatus,
          lastResponseExcerpt: attempt.responseExcerpt,
          lastError: null,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      try {
        this.metrics?.inc(METRIC_NAMES.webhookDeliveryTerminalTotal, {
          terminal_state: 'delivered',
        });
      } catch {
        // Swallow.
      }
      return 'delivered';
    }

    if (attemptNumber >= DEFAULT_MAX_ATTEMPTS) {
      await this.database.db
        .update(webhookDeliveries)
        .set({
          status: 'dlq',
          attempts: attemptNumber,
          lastResponseStatus: attempt.responseStatus,
          lastResponseExcerpt: attempt.responseExcerpt,
          lastError: attempt.errorMessage,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      try {
        this.metrics?.inc(METRIC_NAMES.webhookDeliveryTerminalTotal, { terminal_state: 'dlq' });
      } catch {
        // Swallow.
      }
      return 'dlqed';
    }

    const backoffMs = BACKOFF_MS_BY_ATTEMPT[attemptNumber] ?? 60 * 60_000;
    await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        attempts: attemptNumber,
        nextAttemptAt: new Date(this.now() + backoffMs),
        lastResponseStatus: attempt.responseStatus,
        lastResponseExcerpt: attempt.responseExcerpt,
        lastError: attempt.errorMessage,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return 'retried';
  }
}

async function loadAttempts(database: Database, deliveryId: string): Promise<DeliveryAttempt[]> {
  const rows = await database.db
    .select()
    .from(webhookDeliveryAttempts)
    .where(eq(webhookDeliveryAttempts.deliveryId, deliveryId))
    .orderBy(asc(webhookDeliveryAttempts.attemptNumber));
  return rows.map((r) => ({
    attempt: r.attemptNumber,
    completedAtMs: r.completedAtMs,
    responseStatus: r.responseStatus,
    responseExcerpt: r.responseExcerpt,
    durationMs: r.durationMs,
    outcome: r.outcome as DeliveryAttempt['outcome'],
    errorMessage: r.errorMessage,
  }));
}

function rowToDeliveryRecord(
  row: typeof webhookDeliveries.$inferSelect,
  attempts: readonly DeliveryAttempt[],
): DeliveryRecord {
  const payloadShape = row.payload as { body: string; emittedAtSec: number };
  const payload: DeliveryPayload = {
    eventId: row.eventId,
    eventType: row.eventType,
    emittedAtSec: payloadShape.emittedAtSec,
    body: payloadShape.body,
  };
  return {
    id: row.id,
    endpointId: row.webhookId,
    payload,
    status: row.status,
    attempts,
    nextAttemptAtMs:
      row.status === 'delivered' || row.status === 'failed' || row.status === 'dlq'
        ? null
        : row.nextAttemptAt.getTime(),
    createdAtMs: row.createdAt.getTime(),
    completedAtMs: row.deliveredAt ? row.deliveredAt.getTime() : null,
  };
}

function rowToDlqEntry(
  row: typeof webhookDeliveries.$inferSelect,
  accountId: string,
  attempts: readonly DeliveryAttempt[],
): DlqEntry {
  const payloadShape = row.payload as { body: string; emittedAtSec: number };
  const payload: DeliveryPayload = {
    eventId: row.eventId,
    eventType: row.eventType,
    emittedAtSec: payloadShape.emittedAtSec,
    body: payloadShape.body,
  };
  const lastAttempt = attempts[attempts.length - 1];
  return {
    deliveryId: row.id,
    endpointId: row.webhookId,
    accountId,
    payload,
    totalAttempts: row.attempts,
    attempts,
    enteredDlqAtMs: row.updatedAt.getTime(),
    reason: lastAttempt
      ? `${row.attempts.toString()}× ${lastAttempt.outcome}: ${lastAttempt.errorMessage ?? '(no message)'}`
      : `${row.attempts.toString()}× (no attempt log)`,
  };
}
