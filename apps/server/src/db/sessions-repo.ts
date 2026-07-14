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
import type {
  NewSessionInput,
  SessionEventInput,
  SessionListPage,
  SessionRecord,
  SessionRepo,
} from '../services/sessions.js';
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

  // DoS hardening — bind the real driver session id onto a row inserted with
  // a placeholder id to reserve its concurrency slot before the slow worker
  // dispatch. Touches only the driver_session_id (+ updatedAt); status is
  // advanced separately by the create flow.
  async setSessionDriverSessionId(id: string, driverSessionId: string): Promise<void> {
    await this.database.db
      .update(sessions)
      .set({ driverSessionId, updatedAt: new Date() })
      .where(eq(sessions.id, id));
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

  // Terminal statuses ('destroyed', 'errored') are STICKY: once a row reaches
  // either, this write is a silent no-op (the WHERE excludes terminal rows).
  // This closes a concurrent-destroy resurrection race — a caller can read a
  // non-terminal status, await a slow box round-trip, then write the STALE
  // status back onto a row that a concurrent destroy()/runWithFailureCapture
  // marked terminal in between. Without this guard the row flips back to
  // non-terminal (destroyedAt left set) → use-after-destroy (requireOwned only
  // rejects destroyed/errored, so navigate/interact/capture get dispatched to a
  // dead box) + re-inclusion in the active/expiry sweeps (double driver.destroy
  // + duplicate session.completed webhook). Every LEGITIMATE transition still
  // applies: non-terminal→terminal (normal destroy/error), non-terminal→
  // non-terminal (create 'ready', getState write-back). Nothing legitimately
  // transitions OUT of a terminal state (they are sinks), and a terminal→
  // terminal write (e.g. destroyed→errored) must NOT reorder teardown, so the
  // no-op is correct for every caller — none inspects the result.
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
      .where(and(eq(sessions.id, id), notInArray(sessions.status, ['destroyed', 'errored'])));
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
    await this.database.db.insert(sessionEvents).values({
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload,
      durationMs: input.durationMs,
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
        .where(eq(sessions.id, opts.cursor))
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
