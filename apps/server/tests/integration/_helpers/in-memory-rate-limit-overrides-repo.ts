// In-memory RateLimitOverridesRepo for integration tests. Mirrors
// writes into the InMemoryAuthRepo so the auth path sees the override.
// Same pattern as InMemoryApiKeysRepo (V-012).

import { randomUUID } from 'node:crypto';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesRepo,
  SetOverrideInput,
} from '../../../src/services/rate-limit-overrides.js';
import { quantizeRefillPerSecond } from '../../../src/db/rate-limit-overrides-repo.js';
import { parseUuidCursor } from '../../../src/lib/keyset-cursor.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

/**
 * Ascending `(createdAt, id)`. The sort negates it for the createdAt DESC, id DESC page
 * order and the cursor clause reuses it, so the boundary can never disagree with the
 * ordering it is a boundary in.
 */
function compareKey(a: RateLimitOverrideRecord, b: RateLimitOverrideRecord): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class InMemoryRateLimitOverridesRepo implements RateLimitOverridesRepo {
  // Keyed by `${accountId}:${bucketKey}` — the unique key on the table.
  private readonly rows = new Map<string, RateLimitOverrideRecord>();

  constructor(private readonly authRepo: InMemoryAuthRepo) {}

  upsert(input: SetOverrideInput): Promise<RateLimitOverrideRecord> {
    const key = `${input.accountId}:${input.bucketKey}`;
    const now = new Date();
    const existing = this.rows.get(key);
    // V-1241 — quantise exactly as the column does. `refill_per_second_centi` is an
    // INTEGER of hundredths, so the caller's float does not survive a round-trip: this
    // used to store it verbatim, which let a test assert 1.234 while production served
    // 1.23, and let a refill of 0 read back as 0 where the database floors it at 0.01.
    const refillPerSecond = quantizeRefillPerSecond(input.refillPerSecond);
    const record: RateLimitOverrideRecord = {
      id: existing?.id ?? randomUUID(),
      accountId: input.accountId,
      bucketKey: input.bucketKey,
      capacity: input.capacity,
      refillPerSecond,
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
      refillPerSecond,
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
      .sort((a, b) => -compareKey(a, b));
    // V-1241 — KEYSET, mirroring DrizzleRateLimitOverridesRepo: the cursor row is
    // resolved by id (scoped to accountId when one was given, exactly as the repo scopes
    // its lookup) and the page continues at `(createdAt, id) < cursor`.
    //
    // This was an offset — findIndex inside the already-filtered array, slice from
    // index + 1 — which agrees with the keyset query only while the cursor row still
    // passes the filter. It stops passing as soon as the override EXPIRES, which is the
    // one thing every row here does on its own and without anyone touching it: page one
    // at 10:00, page two at 10:01 after the boundary override lapsed, and `findIndex`
    // returns -1, which the slice read as "start from the top". Same defect and same
    // shape as V-1237's account paging.
    if (opts.cursor !== undefined && parseUuidCursor(opts.cursor) !== undefined) {
      const cursorRow = Array.from(this.rows.values()).find(
        (r) =>
          r.id === opts.cursor && (opts.accountId === undefined || r.accountId === opts.accountId),
      );
      if (cursorRow !== undefined) all = all.filter((r) => compareKey(r, cursorRow) < 0);
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
