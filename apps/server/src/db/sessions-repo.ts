// Drizzle-backed implementation of SessionRepo. The shape mirrors
// SessionsService expectations exactly; tests use an in-memory impl from
// `tests/integration/_helpers/in-memory-sessions-repo.ts`.

import { type SQL, and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { AccountTier } from '@driftstack/api-types';
import type {
  NewSessionInput,
  SessionEventInput,
  SessionListPage,
  SessionRecord,
  SessionRepo,
} from '../services/sessions.js';
import type { Database } from './client.js';
import { accounts, sessionEvents, sessions } from './schema.js';

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
      .where(eq(sessions.id, id));
  }

  async countActiveSessions(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.destroyedAt)));
    return row?.count ?? 0;
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
    if (opts.cursor !== undefined) {
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
    if (opts.cursor !== undefined) {
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
