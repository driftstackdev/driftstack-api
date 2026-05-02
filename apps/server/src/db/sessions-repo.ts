// Drizzle-backed implementation of SessionRepo. The shape mirrors
// SessionsService expectations exactly; tests use an in-memory impl from
// `tests/integration/_helpers/in-memory-sessions-repo.ts`.

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type {
  NewSessionInput,
  SessionEventInput,
  SessionListPage,
  SessionRecord,
  SessionRepo,
} from '../services/sessions.js';
import type { Database } from './client.js';
import { sessionEvents, sessions } from './schema.js';

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

  async listSessions(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<SessionListPage> {
    // Cursor format: ISO timestamp of the last seen createdAt (descending order).
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const where = cursorDate
      ? and(eq(sessions.accountId, accountId), lt(sessions.createdAt, cursorDate))
      : eq(sessions.accountId, accountId);

    const rows = await this.database.db
      .select()
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.createdAt))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toSessionRecord),
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    };
  }

  async recordEvent(input: SessionEventInput): Promise<void> {
    await this.database.db.insert(sessionEvents).values({
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload,
      durationMs: input.durationMs,
    });
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
    label: r.label,
    metadata: r.metadata ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastStateAt: r.lastStateAt,
    destroyedAt: r.destroyedAt,
  };
}
