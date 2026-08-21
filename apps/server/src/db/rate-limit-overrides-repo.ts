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

// V-1241 — `refill_per_second_centi` is an INTEGER column holding hundredths, so a
// requested refill rate does not survive a round-trip unchanged. Exported because the
// in-memory double stored the caller's float verbatim and therefore promised a
// precision the database cannot hold: a test asserting 1.234 passed against the double
// while production served 1.23, and a refill of 0 read back as 0.01 rather than 0.
// One helper, used by the repo, the double, and the contract.
const REFILL_CENTI_SCALE = 100;

/** Hundredths actually written to the column. Floors at 1 — never zero, see below. */
export function toRefillCenti(refillPerSecond: number): number {
  return Math.max(1, Math.round(refillPerSecond * REFILL_CENTI_SCALE));
}

/**
 * What a requested refill rate becomes once stored and read back.
 *
 * Two lossy steps, both deliberate. `Math.round` quantises to hundredths, so 1.234
 * serves as 1.23. `Math.max(1, …)` means a rate below half a centi — including ZERO —
 * becomes 0.01 rather than 0: an override cannot express "never refills", because a
 * bucket that never refills is a permanent lockout rather than a rate limit.
 */
export function quantizeRefillPerSecond(refillPerSecond: number): number {
  return toRefillCenti(refillPerSecond) / REFILL_CENTI_SCALE;
}

export class DrizzleRateLimitOverridesRepo implements RateLimitOverridesRepo {
  constructor(private readonly database: Database) {}

  async upsert(input: SetOverrideInput): Promise<RateLimitOverrideRecord> {
    const refillCenti = toRefillCenti(input.refillPerSecond);
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
    refillPerSecond: r.refillPerSecondCenti / REFILL_CENTI_SCALE,
    reason: r.reason,
    expiresAt: r.expiresAt,
    setByKeyId: r.setByKeyId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
