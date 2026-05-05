// In-memory SessionRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  NewSessionInput,
  SessionEventInput,
  SessionListPage,
  SessionRecord,
  SessionRepo,
} from '../../../src/services/sessions.js';

interface StoredEvent extends SessionEventInput {
  id: string;
  createdAt: Date;
}

export class InMemorySessionsRepo implements SessionRepo {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events: StoredEvent[] = [];

  insertSession(input: NewSessionInput): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      apiKeyId: input.apiKeyId,
      driverSessionId: input.driverSessionId,
      status: 'creating',
      archetype: input.archetype,
      purpose: input.purpose,
      label: input.label,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      lastStateAt: null,
      destroyedAt: null,
    };
    this.sessions.set(record.id, record);
    return Promise.resolve(record);
  }

  findSession(id: string, accountId: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    if (!s || s.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(s);
  }

  findSessionUnscoped(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  updateSessionStatus(
    id: string,
    status: SessionRecord['status'],
    extra?: { lastStateAt?: Date; destroyedAt?: Date },
  ): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      const updated: SessionRecord = {
        ...s,
        status,
        updatedAt: new Date(),
        lastStateAt: extra?.lastStateAt ?? s.lastStateAt,
        destroyedAt: extra?.destroyedAt ?? s.destroyedAt,
      };
      this.sessions.set(id, updated);
    }
    return Promise.resolve();
  }

  countActiveSessions(accountId: string): Promise<number> {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId && s.destroyedAt === null) count += 1;
    }
    return Promise.resolve(count);
  }

  listSessions(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<SessionListPage> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const all = Array.from(this.sessions.values())
      .filter((s) => s.accountId === accountId)
      .filter((s) => (cursorDate ? s.createdAt < cursorDate : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    });
  }

  listAllSessions(opts: {
    limit: number;
    cursor?: string;
    status?: SessionRecord['status'];
    accountId?: string;
  }): Promise<SessionListPage> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const all = Array.from(this.sessions.values())
      .filter((s) => (opts.accountId ? s.accountId === opts.accountId : true))
      .filter((s) => (opts.status ? s.status === opts.status : true))
      .filter((s) => (cursorDate ? s.createdAt < cursorDate : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    });
  }

  recordEvent(input: SessionEventInput): Promise<void> {
    this.events.push({
      ...input,
      id: randomUUID(),
      createdAt: new Date(),
    });
    return Promise.resolve();
  }

  /** Test helper: read all events ever recorded. */
  getEvents(): StoredEvent[] {
    return [...this.events];
  }
}
