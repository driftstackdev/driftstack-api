// Durable direct-operation repository (slice 1 of
// docs/internal/durable-direct-operation-design.md). No route consumes this
// yet, by design: the slice is schema + repository + the three fences, and it
// is independently reviewable precisely because nothing is wired to it.
//
// Every fence is enforced by Postgres, never by process memory. A fence held in
// one process is not a fence across a restart, a second instance, or a crash
// between two writes — which is exactly when a credential submission is most
// likely to be replayed.

import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { Database } from './client.js';
import { sessionOperations } from './schema.js';

export type SessionOperationKind = 'login' | 'search';
export type SessionOperationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** Statuses from which a terminal write is legal. Terminal is terminal. */
const LIVE_STATUSES = ['queued', 'running'] as const;

export type SessionOperationRow = typeof sessionOperations.$inferSelect;

export interface AdmitSessionOperationArgs {
  accountId: string;
  sessionId: string;
  driverIncarnationId: string;
  kind: SessionOperationKind;
  /** sha256 of the Idempotency-Key header, or null when the caller sent none. */
  idempotencyKeyHash: string | null;
  /** sha256 over the canonicalised request body. */
  requestFingerprint: string;
  deadlineAt: Date;
}

/**
 * Admission outcomes, each mapping to exactly one HTTP result once slice 2
 * lands. They are distinct cases rather than a boolean because a caller must
 * never conflate "your own retry" with "someone else's operation".
 */
export type AdmitSessionOperationResult =
  /** A new operation now owns the session. → 202 */
  | { kind: 'admitted'; operation: SessionOperationRow }
  /** This exact request already has an operation; do NOT dispatch again. → 200 */
  | { kind: 'replayed'; operation: SessionOperationRow }
  /** Same Idempotency-Key, different body. → 409 */
  | { kind: 'idempotency_key_reused'; operation: SessionOperationRow }
  /** Another live operation owns this session. → 409 */
  | { kind: 'session_busy'; operation: SessionOperationRow };

export interface SettleSessionOperationArgs {
  id: string;
  /** Fence 3: a result from a superseded driver lifetime must not land. */
  driverIncarnationId: string;
  settledAt: Date;
  resultExpiresAt: Date | null;
}

export type SettleSessionOperationResult =
  | { kind: 'settled'; operation: SessionOperationRow }
  /** Already terminal, or the incarnation moved on. Discard — never overwrite. */
  | { kind: 'superseded' };

export class DrizzleSessionOperationsRepo {
  constructor(private readonly database: Database) {}

  /**
   * FENCE 1 + FENCE 2. One INSERT carries both: it can conflict on the
   * one-live-per-session partial unique index or on the account-scoped
   * idempotency index, and `ON CONFLICT DO NOTHING` covers either.
   *
   * The disambiguation afterwards matters and is not cosmetic. An idempotent
   * replay and a busy session are both "zero rows inserted", but one means
   * "here is your operation, we did not submit anything twice" and the other
   * means "someone else's operation owns this session". Reporting the wrong one
   * would either hide a conflict or invite a duplicate credential submission.
   */
  async admit(args: AdmitSessionOperationArgs): Promise<AdmitSessionOperationResult> {
    const [inserted] = await this.database.db
      .insert(sessionOperations)
      .values({
        accountId: args.accountId,
        sessionId: args.sessionId,
        driverIncarnationId: args.driverIncarnationId,
        kind: args.kind,
        status: 'queued',
        idempotencyKeyHash: args.idempotencyKeyHash,
        requestFingerprint: args.requestFingerprint,
        deadlineAt: args.deadlineAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted !== undefined) return { kind: 'admitted', operation: inserted };

    // Idempotency is checked FIRST. A caller retrying after a disconnect is
    // holding the same key AND the session is still busy with their own
    // operation, so the session-busy branch would otherwise shadow the replay
    // and turn a safe retry into a 409.
    if (args.idempotencyKeyHash !== null) {
      const [byKey] = await this.database.db
        .select()
        .from(sessionOperations)
        .where(
          and(
            eq(sessionOperations.accountId, args.accountId),
            eq(sessionOperations.idempotencyKeyHash, args.idempotencyKeyHash),
          ),
        )
        .limit(1);
      if (byKey !== undefined) {
        return byKey.requestFingerprint === args.requestFingerprint
          ? { kind: 'replayed', operation: byKey }
          : { kind: 'idempotency_key_reused', operation: byKey };
      }
    }

    const live = await this.findLiveForSession(args.sessionId);
    if (live !== null) return { kind: 'session_busy', operation: live };

    // Both fences reported clear after the conflict, which can only mean the
    // blocking row settled in between. Surfacing this as a distinct failure
    // beats a retry loop that could submit credentials twice.
    throw new Error('session operation insert conflicted but no blocking row was found');
  }

  /** The live operation owning a session, if any. Fence 1 guarantees at most one. */
  async findLiveForSession(sessionId: string): Promise<SessionOperationRow | null> {
    const [row] = await this.database.db
      .select()
      .from(sessionOperations)
      .where(
        and(
          eq(sessionOperations.sessionId, sessionId),
          inArray(sessionOperations.status, [...LIVE_STATUSES]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Ownership is part of the query, not a check afterwards: a caller who does
   * not own the operation gets the same empty result as one asking for an id
   * that never existed. Slice 2 renders both as 404 — a 403 would confirm the
   * operation exists.
   */
  async getForAccount(accountId: string, id: string): Promise<SessionOperationRow | null> {
    const [row] = await this.database.db
      .select()
      .from(sessionOperations)
      .where(and(eq(sessionOperations.id, id), eq(sessionOperations.accountId, accountId)))
      .limit(1);
    return row ?? null;
  }

  /** queued → running, fenced on the incarnation like every other transition. */
  async markRunning(id: string, driverIncarnationId: string): Promise<boolean> {
    const updated = await this.database.db
      .update(sessionOperations)
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        and(
          eq(sessionOperations.id, id),
          eq(sessionOperations.status, 'queued'),
          eq(sessionOperations.driverIncarnationId, driverIncarnationId),
        ),
      )
      .returning({ id: sessionOperations.id });
    return updated.length === 1;
  }

  /**
   * FENCE 3 — terminal compare-and-set. Zero rows updated means another writer
   * already settled this operation, or the driver incarnation moved on; either
   * way the result is discarded rather than applied. This is what stops a late
   * worker from mutating a successor session that reused the driver id.
   *
   * The CAS admits any LIVE status, not `running` alone. The design doc
   * originally said `running`, which cannot expire an operation that never
   * started — a queued operation past its deadline would have been unsettleable
   * forever. Exactly-once is preserved either way, because what guarantees it is
   * excluding the TERMINAL statuses, not naming a single live one.
   */
  async settle(
    args: SettleSessionOperationArgs &
      (
        | { status: 'succeeded'; result: Record<string, unknown> }
        | { status: 'failed'; error: Record<string, unknown> }
        | { status: 'cancelled' | 'expired' }
      ),
  ): Promise<SettleSessionOperationResult> {
    const payload =
      args.status === 'succeeded'
        ? { result: args.result, error: null }
        : args.status === 'failed'
          ? { result: null, error: args.error }
          : { result: null, error: null };

    const [updated] = await this.database.db
      .update(sessionOperations)
      .set({
        status: args.status,
        ...payload,
        settledAt: args.settledAt,
        resultExpiresAt: args.resultExpiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionOperations.id, args.id),
          inArray(sessionOperations.status, [...LIVE_STATUSES]),
          eq(sessionOperations.driverIncarnationId, args.driverIncarnationId),
        ),
      )
      .returning();
    return updated === undefined ? { kind: 'superseded' } : { kind: 'settled', operation: updated };
  }

  /**
   * Retention (§7): drop the payloads, keep the status. A customer can still
   * learn that an operation succeeded long after its result is gone, which is
   * the point of keeping the row.
   */
  async purgeExpiredResults(now: Date): Promise<number> {
    const purged = await this.database.db
      .update(sessionOperations)
      .set({ result: null, error: null, resultExpiresAt: null, updatedAt: new Date() })
      .where(
        and(
          isNotNull(sessionOperations.resultExpiresAt),
          lte(sessionOperations.resultExpiresAt, now),
        ),
      )
      .returning({ id: sessionOperations.id });
    return purged.length;
  }
}
