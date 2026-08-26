// Wave 29-400 §8.1.b — Drizzle implementation of AtlasPriorityEventsRepo
// (migration 0058).
//
// Tracks each Mac-fork-emitted probe signature through its auto-learn
// lifecycle (emitted → queued → bs_in_flight → bs_succeeded →
// atlas_appended; bs_failed / atlas_failed terminal). Backs the
// /v1/internal/atlas-priority/* endpoints (§8.2) and the admin panel
// /atlas-priority-queue page (§8.3).
//
// Dedup: same op_seq_sha + archetype_id within 5 minutes coalesces to
// one row. The DB UNIQUE constraint is on the exact (op_seq_sha,
// archetype_id, emitted_at) triple so the soft 5-min window is enforced
// in this repo's `insertEmittedWithDedup` method rather than at the
// schema level. Cheaper than a generated-column-truncated-bucket and
// lets the dedup window evolve without a migration.
//
// State-transition guard: `updateStatus` validates the next status is
// reachable from the current one. Forward-only:
//   emitted → queued | bs_in_flight | bs_failed
//   queued → bs_in_flight | bs_failed
//   bs_in_flight → bs_succeeded | bs_failed
//   bs_succeeded → atlas_appended | atlas_failed
//   bs_failed / atlas_appended / atlas_failed → (terminal)
// Returns the updated row or throws InvalidStateTransitionError.

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  atlasPriorityEvents,
  type AtlasPriorityEventApi,
  type AtlasPriorityEventRow,
  type AtlasPriorityEventStatus,
} from './schema.js';

const ALLOWED_TRANSITIONS: Record<AtlasPriorityEventStatus, AtlasPriorityEventStatus[]> = {
  emitted: ['queued', 'bs_in_flight', 'bs_failed'],
  queued: ['bs_in_flight', 'bs_failed'],
  bs_in_flight: ['bs_succeeded', 'bs_failed'],
  bs_succeeded: ['atlas_appended', 'atlas_failed'],
  bs_failed: [],
  atlas_appended: [],
  atlas_failed: [],
};

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly fromStatus: AtlasPriorityEventStatus,
    public readonly toStatus: AtlasPriorityEventStatus,
  ) {
    super(
      `invalid atlas-priority-event state transition: ${fromStatus} → ${toStatus}. ` +
        `Allowed from ${fromStatus}: [${ALLOWED_TRANSITIONS[fromStatus].join(', ') || '(terminal)'}]`,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class EventNotFoundError extends Error {
  constructor(public readonly eventId: string) {
    super(`atlas-priority-event ${eventId} not found`);
    this.name = 'EventNotFoundError';
  }
}

export interface InsertEmittedArgs {
  opSeqSha: string;
  opSeqBytesB64: string;
  canvasW: number;
  canvasH: number;
  /** Nullable post-migration 0059 — raw-pixel readback APIs
   *  (getImageData / readPixels) have no MIME. §2 toBlob path still
   *  populates it. */
  mime: string | null;
  archetypeId: string;
  lastFillText: string | null;
  macLen: number | null;
  sessionId: string;
  customerId: string;
  pageUrl: string;
  /** §10 forward-compat — discriminates the 8 canvas-readback APIs.
   *  Defaults to 'toBlob' (§2 starting hook) when omitted by the
   *  caller; harvester pre-§10 callers don't need to populate. */
  api?: AtlasPriorityEventApi;
  now: Date;
  /** 5-minute soft dedup window. If an existing event with the same
   *  (opSeqSha, archetypeId) was emitted within this window, return its
   *  id instead of inserting a new row. Default 5 min. */
  dedupWindowMs?: number;
}

export interface InsertEmittedResult {
  eventId: string;
  deduped: boolean;
  status: AtlasPriorityEventStatus;
}

export interface UpdateStatusArgs {
  eventId: string;
  newStatus: AtlasPriorityEventStatus;
  bsAutomateSessionId?: string;
  bsErrorReason?: string;
  atlasEntryHash?: string;
  atlasVersion?: string;
  atlasErrorReason?: string;
  now: Date;
}

export interface ListRecentArgs {
  status?: AtlasPriorityEventStatus;
  customerId?: string;
  since?: Date;
  limit?: number;
}

export interface QueueStats {
  queueDepth: number;
  bsSuccess24h: number;
  bsFailed24h: number;
  atlasAppended24h: number;
  atlasFailed24h: number;
  avgEmittedToAppendedMs24h: number | null;
}

export class DrizzleAtlasPriorityEventsRepo {
  constructor(private readonly database: Database) {}

  /** Soft-dedup insert. If an event with the same (opSeqSha, archetypeId)
   *  was emitted within dedupWindowMs (default 5 min), returns its id +
   *  deduped=true without inserting. Otherwise inserts a new row with
   *  status='emitted' and returns its id + deduped=false. */
  async insertEmittedWithDedup(args: InsertEmittedArgs): Promise<InsertEmittedResult> {
    const dedupWindow = args.dedupWindowMs ?? 5 * 60 * 1000;
    const sinceIso = new Date(args.now.getTime() - dedupWindow).toISOString();
    const existing = await this.database.db
      .select({
        id: atlasPriorityEvents.id,
        status: atlasPriorityEvents.status,
      })
      .from(atlasPriorityEvents)
      .where(
        and(
          eq(atlasPriorityEvents.opSeqSha, args.opSeqSha),
          eq(atlasPriorityEvents.archetypeId, args.archetypeId),
          gte(atlasPriorityEvents.emittedAt, sql`${sinceIso}::timestamptz`),
        ),
      )
      .orderBy(desc(atlasPriorityEvents.emittedAt))
      .limit(1);
    if (existing.length > 0 && existing[0]) {
      return {
        eventId: existing[0].id,
        deduped: true,
        status: existing[0].status,
      };
    }
    const inserted = await this.database.db
      .insert(atlasPriorityEvents)
      .values({
        opSeqSha: args.opSeqSha,
        opSeqBytesB64: args.opSeqBytesB64,
        canvasW: args.canvasW,
        canvasH: args.canvasH,
        mime: args.mime,
        archetypeId: args.archetypeId,
        lastFillText: args.lastFillText,
        macLen: args.macLen,
        sessionId: args.sessionId,
        customerId: args.customerId,
        pageUrl: args.pageUrl,
        api: args.api ?? 'toBlob',
        status: 'emitted',
        emittedAt: args.now,
        updatedAt: args.now,
      })
      .returning({ id: atlasPriorityEvents.id });
    if (!inserted[0]) {
      throw new Error('atlas-priority-event INSERT returned zero rows');
    }
    return { eventId: inserted[0].id, deduped: false, status: 'emitted' };
  }

  /** Forward-only state transition with allowed-edge enforcement. Sets
   *  per-status outcome columns (bs_*, atlas_*) based on which target
   *  state requested. Throws InvalidStateTransitionError if the edge
   *  isn't in ALLOWED_TRANSITIONS, EventNotFoundError if eventId
   *  doesn't exist. */
  async updateStatus(args: UpdateStatusArgs): Promise<AtlasPriorityEventRow> {
    const current = await this.findById(args.eventId);
    if (!current) {
      throw new EventNotFoundError(args.eventId);
    }
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(args.newStatus)) {
      throw new InvalidStateTransitionError(current.status, args.newStatus);
    }
    // Build the SET payload conditionally. Status-specific columns only
    // get touched when their respective transition fires (e.g. bs_started_at
    // on emitted/queued → bs_in_flight).
    const set: Partial<AtlasPriorityEventRow> = {
      status: args.newStatus,
      updatedAt: args.now,
    };
    if (args.newStatus === 'bs_in_flight') {
      set.bsStartedAt = args.now;
      if (args.bsAutomateSessionId !== undefined) {
        set.bsAutomateSessionId = args.bsAutomateSessionId;
      }
    } else if (args.newStatus === 'bs_succeeded') {
      set.bsCompletedAt = args.now;
    } else if (args.newStatus === 'bs_failed') {
      set.bsCompletedAt = args.now;
      if (args.bsErrorReason !== undefined) set.bsErrorReason = args.bsErrorReason;
    } else if (args.newStatus === 'atlas_appended') {
      set.atlasAppendedAt = args.now;
      if (args.atlasEntryHash !== undefined) set.atlasEntryHash = args.atlasEntryHash;
      if (args.atlasVersion !== undefined) set.atlasVersion = args.atlasVersion;
    } else if (args.newStatus === 'atlas_failed') {
      set.atlasAppendedAt = args.now;
      if (args.atlasErrorReason !== undefined) set.atlasErrorReason = args.atlasErrorReason;
    }
    // V-1815 — CAS on the status we validated, not on the id alone. The read
    // above and this write are separate round-trips, so without `status` in the
    // predicate two concurrent reports both validate against the same `emitted`
    // row and both commit: measured at SIX of six concurrent transitions
    // succeeding. `bs_failed` is terminal (`ALLOWED_TRANSITIONS.bs_failed === []`),
    // so that let a row LEAVE a terminal state and let a loser's timestamp columns
    // overwrite the winner's. Mirrors `oauth-links-repo.markConsumedAt`, which is
    // the same conditional-update shape.
    const updated = await this.database.db
      .update(atlasPriorityEvents)
      .set(set)
      .where(
        and(
          eq(atlasPriorityEvents.id, args.eventId),
          eq(atlasPriorityEvents.status, current.status),
        ),
      )
      .returning();
    if (!updated[0]) {
      // Zero rows means the row still exists but no longer holds the status this
      // call validated against — a lost race, not a missing event. Re-read so the
      // caller is told the SAME thing a sequential late report would be told.
      const now = await this.findById(args.eventId);
      if (!now) throw new EventNotFoundError(args.eventId);
      throw new InvalidStateTransitionError(now.status, args.newStatus);
    }
    return updated[0];
  }

  async findById(eventId: string): Promise<AtlasPriorityEventRow | null> {
    const rows = await this.database.db
      .select()
      .from(atlasPriorityEvents)
      .where(eq(atlasPriorityEvents.id, eventId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Recent events ordered emitted_at DESC. status / customerId / since
   *  filters are AND-composed; omit any to match all. limit defaults to
   *  100, hard cap 1000 (caller responsibility to enforce or the route
   *  layer clamps). */
  async listRecent(args: ListRecentArgs = {}): Promise<AtlasPriorityEventRow[]> {
    const conditions = [];
    if (args.status) conditions.push(eq(atlasPriorityEvents.status, args.status));
    if (args.customerId) conditions.push(eq(atlasPriorityEvents.customerId, args.customerId));
    if (args.since) conditions.push(gte(atlasPriorityEvents.emittedAt, args.since));
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 1000);
    const q = this.database.db.select().from(atlasPriorityEvents);
    const filtered =
      conditions.length > 0
        ? q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
        : q;
    return filtered.orderBy(desc(atlasPriorityEvents.emittedAt)).limit(limit);
  }

  /** Summary stats card data for the admin dashboard. 24h window is
   *  `now - 24h` half-open. Avg emitted→appended is computed across
   *  atlas_appended events only. */
  async getStats(now: Date): Promise<QueueStats> {
    const since24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    // Single raw-SQL query for aggregate counts — cheaper than 5 separate
    // round-trips for the dashboard poll path. Date params pre-serialized
    // to ISO strings per the §1b2001c8 drizzle transparentParser
    // workaround (raw sql template + Date == crash).
    const result = await this.database.db.execute<{
      queue_depth: string;
      bs_success_24h: string;
      bs_failed_24h: string;
      atlas_appended_24h: string;
      atlas_failed_24h: string;
      avg_emit_to_append_ms: string | null;
    }>(sql`
      SELECT
        (SELECT count(*) FROM atlas_priority_events
         WHERE status IN ('emitted','queued'))::text AS queue_depth,
        (SELECT count(*) FROM atlas_priority_events
         WHERE status = 'bs_succeeded' AND updated_at >= ${since24hIso}::timestamptz)::text
         AS bs_success_24h,
        (SELECT count(*) FROM atlas_priority_events
         WHERE status = 'bs_failed' AND updated_at >= ${since24hIso}::timestamptz)::text
         AS bs_failed_24h,
        (SELECT count(*) FROM atlas_priority_events
         WHERE status = 'atlas_appended' AND atlas_appended_at >= ${since24hIso}::timestamptz)::text
         AS atlas_appended_24h,
        (SELECT count(*) FROM atlas_priority_events
         WHERE status = 'atlas_failed' AND updated_at >= ${since24hIso}::timestamptz)::text
         AS atlas_failed_24h,
        (SELECT round(avg(extract(epoch FROM (atlas_appended_at - emitted_at)) * 1000))::text
         FROM atlas_priority_events
         WHERE status = 'atlas_appended' AND atlas_appended_at >= ${since24hIso}::timestamptz)
         AS avg_emit_to_append_ms;
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown[]);
    const r = (rows as Array<Record<string, string | null>>)[0];
    if (!r) {
      return {
        queueDepth: 0,
        bsSuccess24h: 0,
        bsFailed24h: 0,
        atlasAppended24h: 0,
        atlasFailed24h: 0,
        avgEmittedToAppendedMs24h: null,
      };
    }
    return {
      queueDepth: Number(r.queue_depth ?? '0'),
      bsSuccess24h: Number(r.bs_success_24h ?? '0'),
      bsFailed24h: Number(r.bs_failed_24h ?? '0'),
      atlasAppended24h: Number(r.atlas_appended_24h ?? '0'),
      atlasFailed24h: Number(r.atlas_failed_24h ?? '0'),
      avgEmittedToAppendedMs24h: r.avg_emit_to_append_ms ? Number(r.avg_emit_to_append_ms) : null,
    };
  }
}
