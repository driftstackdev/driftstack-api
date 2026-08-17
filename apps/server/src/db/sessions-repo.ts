// Drizzle-backed implementation of SessionRepo. The shape mirrors
// SessionsService expectations exactly; tests use an in-memory impl from
// `tests/integration/_helpers/in-memory-sessions-repo.ts`.

import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { SessionStatusSchema, type AccountTier } from '@driftstack/api-types';
import { ProfileInUseError } from '../lib/errors.js';
import { projectSessionEventMetadata } from '../lib/session-event-metadata.js';
import type {
  NewSessionInput,
  SessionEventInput,
  SessionListPage,
  SessionRecord,
  SessionRepo,
  SerializedSessionDestroyInput,
  SerializedSessionDestroyResult,
} from '../services/sessions.js';
import type { SessionOperationClaimResult } from '../services/sessions.js';
import type { Database } from './client.js';
import { accounts, agentSessions, sessionEvents, sessions } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';
import { profileSessionAdvisoryLockKey } from './profile-session-lock.js';

// 6.g — non-terminal statuses eligible for the duration auto-destroy sweep.
const ACTIVE_SESSION_STATUSES: SessionRecord['status'][] = ['creating', 'ready', 'busy'];

export class DrizzleSessionRepo implements SessionRepo {
  constructor(private readonly database: Database) {}

  async insertSession(input: NewSessionInput): Promise<SessionRecord> {
    const [row] = await this.database.db
      .insert(sessions)
      .values({
        accountId: input.accountId,
        apiKeyId: input.apiKeyId,
        driverSessionId: input.driverSessionId,
        archetype: input.archetype,
        purpose: input.purpose,
        label: input.label,
        metadata: input.metadata,
      })
      .returning();
    if (!row) throw new Error('insertSession returned no row');
    return toSessionRecord(row);
  }

  // Atomic "insert only if under the concurrent-session cap" — closes the
  // count-then-insert TOCTOU in SessionsService.create (a bare
  // countActiveSessions + insertSession lets N concurrent creates all pass a
  // stale count and exceed the tier cap). A per-account advisory lock
  // (xact-scoped → auto-released on commit/rollback) serialises concurrent
  // creates for the SAME account so the count + insert are atomic; it wraps
  // ONLY this fast count+insert, never the slow driver.createSession that runs
  // before this call, so it adds no create-path latency and no cross-account
  // contention (different accounts hash to different lock keys). Returns null
  // when already at/over the limit — the caller tears down the driver session
  // it just spun + surfaces ConcurrencyLimitError. Mirrors the FOR-UPDATE
  // atomic-transaction pattern proven for debitTokens/appendTranscript.
  async insertSessionIfUnderLimit(
    input: NewSessionInput,
    limit: number,
    opts: { profileId?: string } = {},
  ): Promise<SessionRecord | null> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`session-create:${input.accountId}`}))`,
      );
      // A3 finding #7 (W2979/W2980) — global single-active-session-per-profile
      // guard. When a profile_id rode the create, take the canonical cross-surface
      // advisory lock + check BOTH legacy sessions (profile_id lives in metadata
      // jsonb) and agent_sessions (dedicated profile_id column). The agent create
      // path takes the exact same lock and checks the same two tables, so a mixed
      // /v1/sessions ↔ /v1/agent-sessions race has exactly one winner. Throw
      // ProfileInUseError with the competing public session id before inserting so
      // two sessions never restore + clobber the same sealed blob.
      // Locked AFTER the account lock (stable accountId-then-profileId acquisition
      // order — no opposite-order deadlock between two concurrent creates). NULL/
      // absent profileId → no lock, no check (fail-safe). This atomic reserve runs
      // BEFORE driver.createSession (the DoS-hardening reserve-then-dispatch order),
      // so a ProfileInUseError throw here blocks the launch with ZERO worker spun —
      // nothing to tear down (the row was never inserted).
      if (opts.profileId !== undefined) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${profileSessionAdvisoryLockKey(opts.profileId)}))`,
        );
        const [liveLegacy] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.accountId, input.accountId),
              sql`${sessions.metadata}->>'profile_id' = ${opts.profileId}`,
              // Non-terminal = not destroyed/errored AND destroyed_at unset. The
              // legacy table has no NULL-status rows; both clauses guard belt-and-
              // suspenders (an errored row stamps destroyedAt, but check status too).
              notInArray(sessions.status, ['destroyed', 'errored']),
              isNull(sessions.destroyedAt),
            ),
          )
          .limit(1);
        if (liveLegacy) {
          throw new ProfileInUseError(`ses_${liveLegacy.id}`);
        }
        const [liveAgent] = await tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.accountId, input.accountId),
              eq(agentSessions.profileId, opts.profileId),
              notInArray(agentSessions.status, ['closed']),
            ),
          )
          .limit(1);
        if (liveAgent) {
          throw new ProfileInUseError(liveAgent.id);
        }
      }
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.accountId, input.accountId), isNull(sessions.destroyedAt)));
      if ((countRow?.count ?? 0) >= limit) return null;
      const [row] = await tx
        .insert(sessions)
        .values({
          accountId: input.accountId,
          apiKeyId: input.apiKeyId,
          driverSessionId: input.driverSessionId,
          archetype: input.archetype,
          purpose: input.purpose,
          label: input.label,
          metadata: input.metadata,
        })
        .returning();
      if (!row) throw new Error('insertSessionIfUnderLimit returned no row');
      return toSessionRecord(row);
    });
  }

  // Atomically claim the exact still-live reservation after slow external
  // dispatch. A destroy may terminalize the visible `creating` row while the
  // driver starts; matching id alone would then overwrite its placeholder and
  // let the service return a stale synthetic `ready`. The complete CAS makes
  // driver id + ready one transition and reports a lost race as null.
  async activateSessionReservation(input: {
    id: string;
    reservationDriverSessionId: string;
    driverSessionId: string;
  }): Promise<SessionRecord | null> {
    const [row] = await this.database.db
      .update(sessions)
      .set({ driverSessionId: input.driverSessionId, status: 'ready', updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, input.id),
          eq(sessions.driverSessionId, input.reservationDriverSessionId),
          eq(sessions.status, 'creating'),
          isNull(sessions.destroyedAt),
        ),
      )
      .returning();
    return row ? toSessionRecord(row) : null;
  }

  async claimSessionOperation(id: string, accountId: string): Promise<SessionOperationClaimResult> {
    return this.database.db.transaction(async (tx) => {
      const scope = and(eq(sessions.id, id), eq(sessions.accountId, accountId));
      const [locked] = await tx.select().from(sessions).where(scope).limit(1).for('update');
      if (!locked) return { kind: 'not_found' };

      const current = toSessionRecord(locked);
      if (
        current.status === 'destroyed' ||
        current.status === 'errored' ||
        current.destroyedAt !== null
      ) {
        return { kind: 'terminal', session: current };
      }
      if (current.status === 'creating' || current.status === 'busy') {
        return { kind: 'conflict', status: current.status };
      }

      const [claimed] = await tx
        .update(sessions)
        .set({ status: 'busy', updatedAt: new Date() })
        .where(and(scope, eq(sessions.status, 'ready'), isNull(sessions.destroyedAt)))
        .returning();
      if (!claimed) throw new Error('claimSessionOperation lost a locked ready row');
      return { kind: 'claimed', session: toSessionRecord(claimed) };
    });
  }

  async settleSessionOperation(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
  }): Promise<boolean> {
    const [settled] = await this.database.db
      .update(sessions)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, input.id),
          eq(sessions.accountId, input.accountId),
          eq(sessions.driverSessionId, input.driverSessionId),
          eq(sessions.status, 'busy'),
          isNull(sessions.destroyedAt),
        ),
      )
      .returning({ id: sessions.id });
    return settled !== undefined;
  }

  async failSessionOperation(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
    erroredAt: Date;
  }): Promise<SessionRecord | null> {
    const [failed] = await this.database.db
      .update(sessions)
      .set({ status: 'errored', destroyedAt: input.erroredAt, updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, input.id),
          eq(sessions.accountId, input.accountId),
          eq(sessions.driverSessionId, input.driverSessionId),
          eq(sessions.status, 'busy'),
          isNull(sessions.destroyedAt),
        ),
      )
      .returning();
    return failed ? toSessionRecord(failed) : null;
  }

  async touchSessionLastStateAt(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
    lastStateAt: Date;
  }): Promise<void> {
    const lastStateAt = input.lastStateAt.toISOString();
    await this.database.db
      .update(sessions)
      .set({
        lastStateAt: sql<Date>`GREATEST(COALESCE(${sessions.lastStateAt}, ${lastStateAt}::timestamptz), ${lastStateAt}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessions.id, input.id),
          eq(sessions.accountId, input.accountId),
          eq(sessions.driverSessionId, input.driverSessionId),
          notInArray(sessions.status, ['destroyed', 'errored']),
          isNull(sessions.destroyedAt),
        ),
      );
  }

  async findSession(id: string, accountId: string): Promise<SessionRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)))
      .limit(1);
    return row ? toSessionRecord(row) : null;
  }

  async findSessionUnscoped(id: string): Promise<SessionRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row ? toSessionRecord(row) : null;
  }

  async destroySessionSerialized(
    input: SerializedSessionDestroyInput,
    destroyDriverSession: (session: SessionRecord) => Promise<void>,
  ): Promise<SerializedSessionDestroyResult> {
    // Project before the transaction and external driver side effect. A future
    // unknown event type must fail before browser teardown; malformed known
    // payloads collapse to closed metadata without rolling back the terminal row.
    const event = projectSessionEventMetadata(input.event);
    return this.database.db.transaction(async (tx) => {
      const scope = and(
        eq(sessions.id, input.id),
        input.accountId === null ? undefined : eq(sessions.accountId, input.accountId),
      );
      const [locked] = await tx.select().from(sessions).where(scope).limit(1).for('update');
      if (!locked) return { kind: 'not_found' };

      const current = toSessionRecord(locked);
      if (current.status === 'destroyed' || current.status === 'errored') {
        return { kind: 'already_terminal', session: current };
      }
      if (current.destroyedAt !== null) {
        throw new Error('destroySessionSerialized found a non-terminal row with destroyedAt');
      }

      let driverFailed = false;
      let driverError: unknown;
      try {
        await destroyDriverSession(current);
      } catch (err) {
        driverFailed = true;
        driverError = err;
      }

      const [updated] = await tx
        .update(sessions)
        .set({ status: 'destroyed', destroyedAt: input.destroyedAt, updatedAt: new Date() })
        .where(and(scope, notInArray(sessions.status, ['destroyed', 'errored'])))
        .returning();
      if (!updated) throw new Error('destroySessionSerialized terminal update returned no row');
      const session = toSessionRecord(updated);

      if (driverFailed) return { kind: 'driver_error', session, error: driverError };
      await tx.insert(sessionEvents).values({
        sessionId: session.id,
        type: event.type,
        payload: event.payload,
        durationMs: event.durationMs,
      });
      return { kind: 'destroyed', session };
    });
  }

  // Legacy lifecycle helper for create-reservation cleanup and test/admin
  // seeding. Terminal rows are sticky, and a `busy` row is excluded entirely:
  // only settleSessionOperation/failSessionOperation or serialized destroy may
  // release/terminalize a live operation owner. State capture uses the separate
  // status-neutral timestamp touch, so no delayed generic write can free a
  // successor's slot.
  async updateSessionStatus(
    id: string,
    status: SessionRecord['status'],
    extra?: { lastStateAt?: Date; destroyedAt?: Date },
  ): Promise<void> {
    await this.database.db
      .update(sessions)
      .set({
        status,
        updatedAt: new Date(),
        ...(extra?.lastStateAt ? { lastStateAt: extra.lastStateAt } : {}),
        ...(extra?.destroyedAt ? { destroyedAt: extra.destroyedAt } : {}),
      })
      .where(
        and(eq(sessions.id, id), notInArray(sessions.status, ['busy', 'destroyed', 'errored'])),
      );
  }

  async countActiveSessions(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.destroyedAt)));
    return row?.count ?? 0;
  }

  // Cross-account count grouped by status — one GROUP BY, zero-filled from
  // SessionStatusSchema.options so every status is present (no hardcoded
  // list to drift from the enum). Powers the admin session-stats tile.
  async countAllByStatus(): Promise<Record<SessionRecord['status'], number>> {
    const rows = await this.database.db
      .select({ status: sessions.status, count: sql<number>`count(*)::int` })
      .from(sessions)
      .groupBy(sessions.status);
    const out = emptySessionStatusCounts();
    for (const row of rows) out[row.status] = row.count;
    return out;
  }

  async listActiveByAccount(accountId: string): Promise<SessionRecord[]> {
    const rows = await this.database.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.accountId, accountId), inArray(sessions.status, ACTIVE_SESSION_STATUSES)),
      );
    return rows.map(toSessionRecord);
  }

  async listSessions(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<SessionListPage> {
    // Keyset cursor on (createdAt desc, id desc). Cursor = last row id;
    // look up its (createdAt, id) and select strictly-after rows so
    // same-createdAt rows aren't dropped at a page boundary. Mirrors the
    // profiles-repo keyset pattern.
    const conds: SQL[] = [eq(sessions.accountId, accountId)];
    if (opts.cursor !== undefined && parseUuidCursor(opts.cursor) !== undefined) {
      const [c] = await this.database.db
        .select({ createdAt: sessions.createdAt, id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, opts.cursor), eq(sessions.accountId, accountId)))
        .limit(1);
      if (c) {
        const keyset = or(
          lt(sessions.createdAt, c.createdAt),
          and(eq(sessions.createdAt, c.createdAt), lt(sessions.id, c.id)),
        );
        if (keyset) conds.push(keyset);
      }
    }

    const rows = await this.database.db
      .select()
      .from(sessions)
      .where(and(...conds))
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toSessionRecord),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  async listExpiredForAutoDestroy(opts: {
    tierCutoffs: ReadonlyArray<{ tier: AccountTier; expiredBefore: Date }>;
    limit: number;
  }): Promise<SessionRecord[]> {
    // JOIN sessions → accounts to resolve tier (the cap source-of-truth
    // lives in the SERVICE, which passes per-tier cutoffs here). For each
    // capped tier: (accounts.tier = T AND sessions.created_at < cutoff_T).
    // OR the per-tier clauses; AND restrict to non-terminal statuses.
    // Oldest-first, capped at `limit` so a tick is bounded.
    if (opts.tierCutoffs.length === 0) return [];
    const perTier = opts.tierCutoffs.map((c) =>
      and(eq(accounts.tier, c.tier), lt(sessions.createdAt, c.expiredBefore)),
    );
    const tierClause = or(...perTier);
    const rows = await this.database.db
      .select({ session: sessions })
      .from(sessions)
      .innerJoin(accounts, eq(sessions.accountId, accounts.id))
      .where(and(inArray(sessions.status, ACTIVE_SESSION_STATUSES), tierClause))
      .orderBy(asc(sessions.createdAt))
      .limit(opts.limit);
    return rows.map((r) => toSessionRecord(r.session));
  }

  async recordEvent(input: SessionEventInput): Promise<void> {
    const event = projectSessionEventMetadata(input);
    await this.database.db.insert(sessionEvents).values({
      sessionId: input.sessionId,
      type: event.type,
      payload: event.payload,
      durationMs: event.durationMs,
    });
  }

  async setEgressCapabilityReport(args: {
    sessionId: string;
    derived: {
      udp_associate: boolean;
      quic_route: 'proxy' | 'direct' | 'disabled';
      dns_remote_resolve: boolean;
      warnings: string[];
    };
    raw: Record<string, unknown>;
  }): Promise<SessionRecord | null> {
    const [row] = await this.database.db
      .update(sessions)
      .set({
        egressCapabilities: args.derived,
        egressCapabilityReport: args.raw,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, args.sessionId))
      .returning();
    return row ? toSessionRecord(row) : null;
  }

  async listAllSessions(opts: {
    limit: number;
    cursor?: string;
    status?: SessionRecord['status'];
    accountId?: string;
  }): Promise<SessionListPage> {
    // Keyset cursor on (createdAt desc, id desc) — see listSessions.
    const filters: SQL[] = [];
    if (opts.cursor !== undefined && parseUuidCursor(opts.cursor) !== undefined) {
      const [c] = await this.database.db
        .select({ createdAt: sessions.createdAt, id: sessions.id })
        .from(sessions)
        .where(
          opts.accountId === undefined
            ? eq(sessions.id, opts.cursor)
            : and(eq(sessions.id, opts.cursor), eq(sessions.accountId, opts.accountId)),
        )
        .limit(1);
      if (c) {
        const keyset = or(
          lt(sessions.createdAt, c.createdAt),
          and(eq(sessions.createdAt, c.createdAt), lt(sessions.id, c.id)),
        );
        if (keyset) filters.push(keyset);
      }
    }
    if (opts.status) filters.push(eq(sessions.status, opts.status));
    if (opts.accountId) filters.push(eq(sessions.accountId, opts.accountId));
    const whereClause = filters.length === 0 ? undefined : and(...filters);

    const rows = await this.database.db
      .select()
      .from(sessions)
      .where(whereClause)
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toSessionRecord),
      nextCursor: hasMore && last ? last.id : null,
    };
  }
}

function toSessionRecord(r: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    apiKeyId: r.apiKeyId,
    driverSessionId: r.driverSessionId,
    status: r.status,
    archetype: r.archetype,
    purpose: r.purpose,
    label: r.label,
    metadata: r.metadata ?? null,
    egressCapabilities: r.egressCapabilities ?? null,
    egressCapabilityReport: r.egressCapabilityReport ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastStateAt: r.lastStateAt,
    destroyedAt: r.destroyedAt,
  };
}

/** Zero-filled count record over every SessionStatus (canonical enum). */
function emptySessionStatusCounts(): Record<SessionRecord['status'], number> {
  const out = {} as Record<SessionRecord['status'], number>;
  for (const status of SessionStatusSchema.options) out[status] = 0;
  return out;
}
