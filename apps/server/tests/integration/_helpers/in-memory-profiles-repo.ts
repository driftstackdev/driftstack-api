// In-memory ProfilesRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  ListProfilesArgs,
  ListProfilesPage,
  NewProfileInput,
  ProfileRecord,
  ProfileUpdates,
  ProfilesRepo,
} from '../../../src/services/profiles.js';

export class InMemoryProfilesRepo implements ProfilesRepo {
  private readonly rows = new Map<string, ProfileRecord>();

  insert(input: NewProfileInput): Promise<ProfileRecord> {
    const now = new Date();
    const row: ProfileRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      name: input.name,
      archetype: input.archetype,
      description: input.description,
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  countByAccount(accountId: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) if (r.accountId === accountId) n += 1;
    return Promise.resolve(n);
  }

  // V-714 — atomic limit-check + insert. The prod Drizzle repo serialises this
  // via a `FOR UPDATE` lock on the accounts row; here the count + insert run
  // synchronously (JS single-thread → no interleave), which models the same
  // "loser sees the post-insert count and is refused" outcome.
  insertWithLimit(
    input: NewProfileInput,
    limit: number | null,
  ): Promise<{ record: ProfileRecord } | { limitExceeded: true; current: number }> {
    if (limit !== null) {
      let current = 0;
      for (const r of this.rows.values()) if (r.accountId === input.accountId) current += 1;
      if (current >= limit) {
        return Promise.resolve({ limitExceeded: true as const, current });
      }
    }
    const now = new Date();
    const row: ProfileRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      name: input.name,
      archetype: input.archetype,
      description: input.description,
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve({ record: row });
  }

  findById(args: { id: string; accountId: string }): Promise<ProfileRecord | null> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(null);
    return Promise.resolve(r);
  }

  // In-memory repo doesn't track per-profile DEKs (DEK dispatch is exercised by
  // the unit test's dedicated mock); null keeps the interface satisfied.
  getWrappedDek(_args: { id: string; accountId: string }): Promise<string | null> {
    return Promise.resolve(null);
  }

  findByAccountAndName(args: { accountId: string; name: string }): Promise<ProfileRecord | null> {
    for (const r of this.rows.values()) {
      if (r.accountId === args.accountId && r.name === args.name) return Promise.resolve(r);
    }
    return Promise.resolve(null);
  }

  list(args: ListProfilesArgs): Promise<ListProfilesPage> {
    const limit = Math.min(args.limit ?? 50, 100);
    const all = Array.from(this.rows.values())
      .filter((r) => r.accountId === args.accountId)
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        return t !== 0 ? t : b.id.localeCompare(a.id);
      });

    let startIdx = 0;
    if (args.cursor !== undefined) {
      const i = all.findIndex((r) => r.id === args.cursor);
      startIdx = i >= 0 ? i + 1 : 0;
    }

    const slice = all.slice(startIdx, startIdx + limit + 1);
    const hasMore = slice.length > limit;
    const data = slice.slice(0, limit);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return Promise.resolve({ data, hasMore, nextCursor });
  }

  update(args: { id: string; accountId: string; updates: ProfileUpdates }): Promise<ProfileRecord> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) {
      return Promise.reject(new Error('update: row not found / wrong account'));
    }
    const next: ProfileRecord = {
      ...r,
      name: args.updates.name ?? r.name,
      description:
        args.updates.description !== undefined ? args.updates.description : r.description,
      folder: args.updates.folder !== undefined ? args.updates.folder : r.folder,
      tags: args.updates.tags !== undefined ? args.updates.tags : r.tags,
      updatedAt: new Date(),
    };
    this.rows.set(r.id, next);
    return Promise.resolve(next);
  }

  delete(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(false);
    this.rows.delete(args.id);
    return Promise.resolve(true);
  }

  touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve();
    this.rows.set(r.id, { ...r, lastUsedAt: args.at });
    return Promise.resolve();
  }
}
