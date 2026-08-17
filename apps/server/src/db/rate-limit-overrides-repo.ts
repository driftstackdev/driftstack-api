// Drizzle-backed RateLimitOverridesRepo. Upsert by (account_id,
// bucket_key) — re-setting the same bucket replaces the prior override.

import { type SQL, and, desc, eq, gt, lt, or } from 'drizzle-orm';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesRepo,
  SetOverrideInput,
} from '../services/rate-limit-overrides.js';
import type { Database } from './client.js';
import { rateLimitOverrides } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';

export class DrizzleRateLimitOverridesRepo implements RateLimitOverridesRepo {
  constructor(private readonly database: Database) {}

  async upsert(input: SetOverrideInput): Promise<RateLimitOverrideRecord> {
    const refillCenti = Math.max(1, Math.round(input.refillPerSecond * 100));
    const [row] = await this.database.db
      .insert(rateLimitOverrides)
      .values({
        accountId: input.accountId,
        bucketKey: input.bucketKey,
        capacity: input.capacity,
        refillPerSecondCenti: refillCenti,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt,
        setByKeyId: input.setByKeyId,
      })
      .onConflictDoUpdate({
        target: [rateLimitOverrides.accountId, rateLimitOverrides.bucketKey],
        set: {
          capacity: input.capacity,
          refillPerSecondCenti: refillCenti,
          reason: input.reason ?? null,
          expiresAt: input.expiresAt,
          setByKeyId: input.setByKeyId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('rate_limit_overrides upsert returned no row');
    return toRecord(row);
  }

  async clear(accountId: string, bucketKey: string): Promise<boolean> {
    const result = await this.database.db
      .delete(rateLimitOverrides)
      .where(
        and(
          eq(rateLimitOverrides.accountId, accountId),
          eq(rateLimitOverrides.bucketKey, bucketKey),
        ),
      )
      .returning({ id: rateLimitOverrides.id });
    return result.length > 0;
  }

  async listAll(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    includeExpired?: boolean;
  }): Promise<{ items: RateLimitOverrideRecord[]; nextCursor: string | null }> {
    // Keyset cursor on (createdAt desc, id desc) — cursor = last row id.
    // Mirrors profiles-repo; avoids dropping same-createdAt rows.
    const filters: SQL[] = [];
    if (opts.cursor !== undefined && parseUuidCursor(opts.cursor) !== undefined) {
      const [c] = await this.database.db
        .select({ createdAt: rateLimitOverrides.createdAt, id: rateLimitOverrides.id })
        .from(rateLimitOverrides)
        .where(
          opts.accountId === undefined
            ? eq(rateLimitOverrides.id, opts.cursor)
            : and(
                eq(rateLimitOverrides.id, opts.cursor),
                eq(rateLimitOverrides.accountId, opts.accountId),
              ),
        )
        .limit(1);
      if (c) {
        const keyset = or(
          lt(rateLimitOverrides.createdAt, c.createdAt),
          and(eq(rateLimitOverrides.createdAt, c.createdAt), lt(rateLimitOverrides.id, c.id)),
        );
        if (keyset) filters.push(keyset);
      }
    }
    if (opts.accountId) filters.push(eq(rateLimitOverrides.accountId, opts.accountId));
    if (!opts.includeExpired) filters.push(gt(rateLimitOverrides.expiresAt, new Date()));
    const whereClause = filters.length === 0 ? undefined : and(...filters);

    const rows = await this.database.db
      .select()
      .from(rateLimitOverrides)
      .where(whereClause)
      .orderBy(desc(rateLimitOverrides.createdAt), desc(rateLimitOverrides.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toRecord),
      nextCursor: hasMore && last ? last.id : null,
    };
  }
}

function toRecord(r: typeof rateLimitOverrides.$inferSelect): RateLimitOverrideRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    bucketKey: r.bucketKey,
    capacity: r.capacity,
    refillPerSecond: r.refillPerSecondCenti / 100,
    reason: r.reason,
    expiresAt: r.expiresAt,
    setByKeyId: r.setByKeyId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
