// Drizzle-backed RateLimitOverridesRepo. Upsert by (account_id,
// bucket_key) — re-setting the same bucket replaces the prior override.

import { and, eq } from 'drizzle-orm';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesRepo,
  SetOverrideInput,
} from '../services/rate-limit-overrides.js';
import type { Database } from './client.js';
import { rateLimitOverrides } from './schema.js';

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
