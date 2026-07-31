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
import type { WebhookEventType } from '@driftstack/api-types';
import type { Database } from '../db/client.js';
import { webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints } from '../db/schema.js';
import { METRIC_NAMES } from './metrics-registry.js';
import { ssrfGuardedFetch } from '../lib/ssrf-guarded-fetch.js';
import { redactText } from '../lib/redact-url.js';

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
const RESPONSE_READ_MAX_BYTES = 64 * 1024;
const RESPONSE_EXCERPT_MAX_CHARS = 200;
const TRANSPORT_ERROR_MAX_CHARS = 500;

// V-173.R — reclaim STALE in_flight rows. A worker that crashed / was deployed
// mid-batch leaves a row stuck `in_flight` forever (it's never re-selected → the
// webhook is silently lost, skipping all remaining retries). The claim sets
// `updated_at = NOW()`, so an in_flight row whose `updated_at` is older than this
// threshold has no live worker on it — re-claim it. The threshold is ≫ the
// per-attempt DEFAULT_TIMEOUT_MS so a merely-slow (not crashed) delivery isn't
// reclaimed out from under a live worker; a re-delivery is acceptable anyway
// (webhooks are at-least-once, event-id-dedupable). Mirrors the live
// DrizzleWebhooksRepo.claim (webhooks-repo.ts).
export const RECLAIM_STALE_IN_FLIGHT_MS = 5 * 60 * 1000;

export interface DurableWebhookDeliveryDeps {
  database: Database;
  /** Test seam — defaults to the SSRF-guarded fetch (connection-time DNS pin). */
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

/**
 * Construct the durable webhook-delivery system. Returns the
 * WebhookDeliveryService + DlqManager pair plus a `processTick` method
 * that drives the delivery loop one batch at a time using SELECT...
 * FOR UPDATE SKIP LOCKED.
 */
export interface DurableWebhookDeliveryHandles {
  deliveries: DurableWebhookDeliveryService;
  dlq: DurableDlqManager;
  processTick(opts?: {
    batchSize?: number;
    leaseDurationMs?: number;
    perEndpointCap?: number;
  }): Promise<ProcessTickResult>;
}

export function createDurableWebhookDelivery(
  deps: DurableWebhookDeliveryDeps,
): DurableWebhookDeliveryHandles {
  // SSRF-safe by default: the V-173 durable sender is the documented FORWARD
  // path (header note). Defaulting to ssrfGuardedFetch — same as the live
  // webhook-worker.ts poller — means a future cutover keeps the connection-time
  // DNS-rebind pin without the wirer having to remember to inject it. A
  // create/update-time guard (lib/webhook-target-guard) can't stop rebind; this
  // is the connection-time layer. Tests inject deps.fetch and bypass it.
  const fetchFn = deps.fetch ?? ssrfGuardedFetch;
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

  // Audit fix (2026-07-01) — TOCTOU race: this used to be a plain
  // read-then-write (SELECT to confirm existence, then an UNCONDITIONAL
  // UPDATE ... SET status='pending'). That let replay() land on a delivery
  // that's CURRENTLY 'in_flight' — a live worker (processTick, which claims
  // rows transactionally with FOR UPDATE SKIP LOCKED) may be mid-attempt on
  // it right now. Clobbering the row to 'pending'/nextAttemptAt=now while
  // that attempt is still running means the very next processTick() claims
  // it again (its `status = 'pending' AND next_attempt_at <= now` predicate
  // matches) and fires a SECOND concurrent POST to the customer's real
  // endpoint — a genuine double-delivery, exactly the race this package's
  // own in-memory reference implementation had (see in-memory.ts's WD-1 fix,
  // same audit). Fixed the same way: a single guarded UPDATE ... WHERE
  // status IN ('delivered','failed') RETURNING *, matching this interface's
  // documented contract ("Replay a 'failed' or 'delivered' delivery").
  // A 0-row result means the row wasn't in an eligible status (or never
  // existed) — re-fetch to tell those two cases apart for the error message.
  async replay(deliveryId: string): Promise<DeliveryRecord> {
    const nowMs = this.now();
    const [updatedRow] = await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        nextAttemptAt: new Date(nowMs),
        deliveredAt: null,
      })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          inArray(webhookDeliveries.status, ['delivered', 'failed']),
        ),
      )
      .returning();
    if (updatedRow) {
      const attempts = await loadAttempts(this.database, deliveryId);
      return rowToDeliveryRecord(updatedRow, attempts);
    }
    const [existing] = await this.database.db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!existing) throw new Error(`replay: delivery ${deliveryId} not found`);
    throw new Error(
      `replay: delivery ${deliveryId} has status '${existing.status}' — replay is only ` +
        `allowed for 'delivered' or 'failed' deliveries ('in_flight' has a live attempt lease; ` +
        `'pending' is already queued)`,
    );
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

  // Audit fix (2026-07-01) — same TOCTOU race as
  // DurableWebhookDeliveryService.replay (see that method's comment for the
  // full mechanism): this had NO status guard at all — it would clobber a
  // row regardless of whether it was 'in_flight', 'pending', or anything
  // else, not just 'dlq' entries. Fixed with a guarded UPDATE ... WHERE
  // status = 'dlq' RETURNING *, matching this interface's documented
  // contract ("Move a DLQ entry back into the active queue").
  async requeue(opts: RequeueDlqOpts): Promise<DeliveryRecord> {
    const nowMs = this.now();
    const [row] = await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        nextAttemptAt: new Date(nowMs),
        deliveredAt: null,
      })
      .where(and(eq(webhookDeliveries.id, opts.deliveryId), eq(webhookDeliveries.status, 'dlq')))
      .returning();
    if (!row) {
      const [existing] = await this.database.db
        .select({ status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, opts.deliveryId))
        .limit(1);
      if (!existing) throw new Error(`requeue: delivery ${opts.deliveryId} not found`);
      throw new Error(
        `requeue: delivery ${opts.deliveryId} has status '${existing.status}' — requeue is ` +
          `only allowed for 'dlq' deliveries; use replay() for a 'delivered' or 'failed' one`,
      );
    }
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
    opts: { batchSize?: number; leaseDurationMs?: number; perEndpointCap?: number } = {},
  ): Promise<ProcessTickResult> {
    const batchSize = opts.batchSize ?? 25;
    const perEndpointCap = opts.perEndpointCap ?? 5;
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
    // V-173.R — staleness anchor for in_flight reclaim. An in_flight row whose
    // updated_at is older than this has no live worker on it (the claim below
    // sets updated_at to nowDate) → re-claim it.
    const staleBeforeIso = new Date(nowMs - RECLAIM_STALE_IN_FLIGHT_MS).toISOString();

    // Atomic claim: SELECT due rows + flip to in_flight in one txn.
    // FOR UPDATE SKIP LOCKED ensures concurrent workers each get a
    // disjoint slice. Picks up both due pending rows AND stale in_flight
    // rows (V-173.R — a crashed/redeployed worker's stranded row) so a
    // delivery is never silently lost.
    const claimed = await this.database.db.transaction(async (tx) => {
      // FAIRNESS — must match DrizzleWebhooksRepo.claim, which is the
      // implementation production runs today. A plain FIFO
      // ORDER BY next_attempt_at LIMIT n lets a DOWN endpoint fill every batch
      // (its retries carry the oldest timestamps), and since the loop below
      // delivers serially those rows also consume the tick timing out — other
      // customers' webhooks are then not delayed but never attempted.
      //
      // This file is the documented FORWARD path awaiting cutover, so the fix
      // has to live here too: cutting over to a version without it would
      // silently reintroduce the starvation. `webhook-claim-fairness-parity`
      // fails if the two implementations drift apart on this.
      const candidates = await tx.execute(sql`
        WITH due AS (
          SELECT id,
                 row_number() OVER (PARTITION BY webhook_id ORDER BY next_attempt_at ASC) AS rn,
                 next_attempt_at
          FROM webhook_deliveries
          WHERE (status = 'pending' AND next_attempt_at <= ${nowIso})
             OR (status = 'in_flight' AND updated_at <= ${staleBeforeIso})
        ),
        fair AS (
          SELECT id FROM due
          WHERE rn <= ${perEndpointCap}
          ORDER BY next_attempt_at ASC
          LIMIT ${batchSize}
        )
        SELECT id FROM webhook_deliveries
        WHERE id IN (SELECT id FROM fair)
        FOR UPDATE SKIP LOCKED
      `);
      // The postgres-js driver returns the RowList directly (array-like); the
      // pg/neon drivers wrap it as { rows }. Handle both — matching the
      // established idiom in scheduled-jobs-repo.ts / atlas-priority-events-repo.ts.
      const candidateRows =
        (candidates as unknown as { rows?: Array<{ id: string }> }).rows ??
        (candidates as unknown as Array<{ id: string }>);
      const ids = candidateRows.map((r) => r.id);
      if (ids.length === 0) return [] as string[];
      // Set updated_at = now so the reclaim staleness anchor advances; without
      // it a reclaimed row would still read as stale on the next tick.
      await tx
        .update(webhookDeliveries)
        .set({ status: 'in_flight', updatedAt: nowDate })
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
      // Sign with the ATTEMPT-TIME timestamp (no timestamp override →
      // signWebhookPayload uses now). The previous code pinned the signed
      // timestamp to the enqueue time, but retries back off up to 60min and
      // every SDK verifier rejects |now - t| > 300s — a delayed/retried
      // delivery would have failed customer verification. The live worker
      // (webhook-worker.ts) already re-signs per attempt with t=now; this
      // path now matches.
      const sigHeader = signWebhookPayload({
        body,
        secret: endpoint.secret,
        ...(prevInGrace ? { secretPrev: endpoint.secretPrev as string } : {}),
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
          // SSRF hardening — do NOT follow redirects to a customer-controlled
          // endpoint (create-time validation only enforces https://; a 3xx to
          // an internal target like http://169.254.169.254 would bypass it).
          // A 30x surfaces as a failed attempt. See
          // docs/internal/2026-05-31-webhook-ssrf-outbound-target.md.
          redirect: 'error',
        });
        const successful = response.status >= 200 && response.status < 300;
        const suppressResponseDiagnostics = successful || delivery.eventType === 'session.failed';
        const responseExcerpt = suppressResponseDiagnostics
          ? null
          : await readResponseExcerpt(response);
        if (suppressResponseDiagnostics) {
          // Success responses are status-only. session.failed responses are
          // also body-free because a customer endpoint can echo the signed
          // request, turning a response excerpt into a second retention path.
          // Dispose either body while the attempt timer is still armed.
          await response.body?.cancel().catch(() => undefined);
        }
        const durationMs = this.now() - startedMs;
        attempt = {
          attemptNumber,
          completedAtMs: this.now(),
          responseStatus: response.status,
          responseExcerpt,
          durationMs,
          outcome: successful ? 'success' : 'http_error',
          errorMessage: successful ? null : `HTTP ${response.status.toString()}`,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const durationMs = this.now() - startedMs;
      const error = err instanceof Error ? err : new Error(String(err));
      const isTimeout = error.name === 'AbortError' || error.name === 'TimeoutError';
      attempt = {
        attemptNumber,
        completedAtMs: this.now(),
        responseStatus: null,
        responseExcerpt: null,
        durationMs,
        outcome: isTimeout ? 'timeout' : 'transport_error',
        errorMessage: safeTransportError(error),
      };
    }

    if (delivery.eventType === 'session.failed') {
      // Keep delivery truth (status/outcome/duration/retry count), but never
      // retain endpoint-controlled diagnostics for a failure event. This also
      // covers transport and timeout paths, not only HTTP response bodies.
      attempt = { ...attempt, responseExcerpt: null, errorMessage: null };
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
      const [updated] = await this.database.db
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          attempts: attemptNumber,
          deliveredAt: new Date(attempt.completedAtMs),
          nextAttemptAt: new Date(attempt.completedAtMs),
          lastResponseStatus: attempt.responseStatus,
          lastResponseExcerpt: attempt.responseExcerpt,
          lastError: null,
          updatedAt: new Date(this.now()),
        })
        // Fence on in_flight (review wjf04whfl #1): the worker only finalizes a
        // row it claimed in_flight. If a >RECLAIM_STALE_IN_FLIGHT_MS-stalled
        // worker's write lands after another tick reclaimed + finalized the row,
        // this matches 0 rows → the no-op below skips it. Without the fence the
        // stale write would resurrect a finalized delivery + corrupt its state.
        .where(
          and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'in_flight')),
        )
        .returning({ id: webhookDeliveries.id });
      if (!updated) return 'delivered';
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
      const [updated] = await this.database.db
        .update(webhookDeliveries)
        .set({
          status: 'dlq',
          attempts: attemptNumber,
          lastResponseStatus: attempt.responseStatus,
          lastResponseExcerpt: attempt.responseExcerpt,
          lastError: attempt.errorMessage,
          updatedAt: new Date(this.now()),
        })
        // Fence on in_flight (review wjf04whfl #1): only the current owner of an
        // in_flight row may finalize it; a stale-worker write matches 0 rows.
        .where(
          and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'in_flight')),
        )
        .returning({ id: webhookDeliveries.id });
      if (!updated) return 'dlqed';
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
        updatedAt: new Date(this.now()),
      })
      // Fence on in_flight (review wjf04whfl #1): only the current owner of an
      // in_flight row may re-arm it for retry; a stale-worker write matches 0
      // rows and is a no-op, so it can't resurrect a finalized delivery.
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'in_flight')))
      .returning({ id: webhookDeliveries.id });
    return 'retried';
  }
}

async function readResponseExcerpt(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let retainedBytes = 0;
  try {
    while (retainedBytes < RESPONSE_READ_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = RESPONSE_READ_MAX_BYTES - retainedBytes;
      const bytesToKeep = Math.min(value.byteLength, remaining);
      if (bytesToKeep > 0) {
        // Decode only the bounded prefix. A subarray is safe here because it is
        // consumed immediately and never retained after this iteration.
        parts.push(decoder.decode(value.subarray(0, bytesToKeep), { stream: true }));
        retainedBytes += bytesToKeep;
      }
    }
    parts.push(decoder.decode());
    return parts.join('').slice(0, RESPONSE_EXCERPT_MAX_CHARS);
  } catch {
    return null;
  } finally {
    // Stop downloading once the prefix is complete (or a read fails). The
    // enclosing attempt timeout stays armed until cancellation settles.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function safeTransportError(error: Error): string {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
  // Attempt history and the DLQ reason are customer-visible persisted data.
  // Bound before redaction so an attacker-sized exception cannot turn the
  // diagnostic path into a second resource-exhaustion surface.
  const bounded = error.message.slice(0, TRANSPORT_ERROR_MAX_CHARS);
  return (redactText(bounded) || 'transport failure').slice(0, TRANSPORT_ERROR_MAX_CHARS);
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
