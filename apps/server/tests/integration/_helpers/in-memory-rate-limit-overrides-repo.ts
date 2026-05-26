// In-memory RateLimitOverridesRepo for integration tests. Mirrors
// writes into the InMemoryAuthRepo so the auth path sees the override.
// Same pattern as InMemoryApiKeysRepo (V-012).

import { randomUUID } from 'node:crypto';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesRepo,
  SetOverrideInput,
} from '../../../src/services/rate-limit-overrides.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

export class InMemoryRateLimitOverridesRepo implements RateLimitOverridesRepo {
  // Keyed by `${accountId}:${bucketKey}` — the unique key on the table.
  private readonly rows = new Map<string, RateLimitOverrideRecord>();

  constructor(private readonly authRepo: InMemoryAuthRepo) {}

  upsert(input: SetOverrideInput): Promise<RateLimitOverrideRecord> {
    const key = `${input.accountId}:${input.bucketKey}`;
    const now = new Date();
    const existing = this.rows.get(key);
    const record: RateLimitOverrideRecord = {
      id: existing?.id ?? randomUUID(),
      accountId: input.accountId,
      bucketKey: input.bucketKey,
      capacity: input.capacity,
      refillPerSecond: input.refillPerSecond,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt,
      setByKeyId: input.setByKeyId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(key, record);
    // Mirror into the auth repo so AccountContext loads see it.
    this.authRepo.setRateLimitOverride(input.accountId, {
      bucketKey: input.bucketKey,
      capacity: input.capacity,
      refillPerSecond: input.refillPerSecond,
      expiresAt: input.expiresAt,
    });
    return Promise.resolve(record);
  }

  clear(accountId: string, bucketKey: string): Promise<boolean> {
    const key = `${accountId}:${bucketKey}`;
    const existed = this.rows.delete(key);
    if (existed) this.authRepo.clearRateLimitOverride(accountId, bucketKey);
    return Promise.resolve(existed);
  }

  /** Test helper: enumerate all stored override records. */
  getAll(): RateLimitOverrideRecord[] {
    return Array.from(this.rows.values());
  }

  listAll(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    includeExpired?: boolean;
  }): Promise<{ items: RateLimitOverrideRecord[]; nextCursor: string | null }> {
    const now = new Date();
    // Keyset (createdAt desc, id desc) — stable sort + resume after the
    // cursor row's position; mirrors the Drizzle repo.
    let all = Array.from(this.rows.values())
      .filter((r) => (opts.accountId ? r.accountId === opts.accountId : true))
      .filter((r) => (opts.includeExpired ? true : r.expiresAt > now))
      .sort((a, b) => {
        const dt = b.createdAt.getTime() - a.createdAt.getTime();
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    if (opts.cursor !== undefined) {
      const idx = all.findIndex((r) => r.id === opts.cursor);
      if (idx >= 0) all = all.slice(idx + 1);
    }
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.id : null,
    });
  }
}
