// Rate-limit override service (admin-only).
//
// Sets / clears per-account, per-bucket overrides of the rate-limit
// config. Override storage is a separate table (rate_limit_overrides);
// the consume path picks them up via AccountContext, which is loaded
// at auth time and cached. Set / clear invalidate the auth cache so
// the next auth read picks up the change.
//
// Centi-rate quantization: the schema stores refill_per_second as 100×
// the actual rate (centi-rate) to avoid float drift. The service
// accepts a float at the API boundary and converts at write time.
// V-016 documented the quantization caveat (1/60 → 2 → 1/50 effective).
// Acceptable for overrides because they're more permissive than tier
// defaults; if exact tier matching is ever required, migrate the column
// to numeric(10,4).

import type { AuthCache } from './auth-cache.js';
import type { AccountContext } from './auth.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

export interface RateLimitOverrideRecord {
  id: string;
  accountId: string;
  bucketKey: string;
  capacity: number;
  refillPerSecond: number;
  reason: string | null;
  expiresAt: Date;
  setByKeyId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetOverrideInput {
  accountId: string;
  bucketKey: string;
  capacity: number;
  refillPerSecond: number;
  expiresAt: Date;
  reason?: string;
  setByKeyId: string;
}

export interface RateLimitOverridesRepo {
  /** Upsert by (account_id, bucket_key). */
  upsert(input: SetOverrideInput): Promise<RateLimitOverrideRecord>;
  /** Returns true if a row was deleted, false if no override existed. */
  clear(accountId: string, bucketKey: string): Promise<boolean>;
  /**
   * Cross-account list for admin tooling. Filters by accountId
   * optionally; supports cursor pagination by createdAt DESC. Optional
   * `includeExpired` (default false) — when false, only overrides
   * whose expiresAt is in the future are returned.
   */
  listAll(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    includeExpired?: boolean;
  }): Promise<{ items: RateLimitOverrideRecord[]; nextCursor: string | null }>;
}

const MIN_REFILL = 0.01; // matches centi quantum
const MAX_REFILL = 100_000; // sanity cap; enterprise tier global is 1000/s

export class RateLimitOverridesService {
  constructor(
    private readonly repo: RateLimitOverridesRepo,
    private readonly authCache: AuthCache | null = null,
  ) {}

  async set(
    ctx: AccountContext,
    input: {
      accountId: string;
      bucketKey: string;
      capacity: number;
      refillPerSecond: number;
      expiresAt: Date;
      reason?: string;
    },
  ): Promise<RateLimitOverrideRecord> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');

    if (input.capacity < 1 || !Number.isFinite(input.capacity)) {
      throw new ConflictError('capacity must be a positive integer.');
    }
    if (
      !Number.isFinite(input.refillPerSecond) ||
      input.refillPerSecond < MIN_REFILL ||
      input.refillPerSecond > MAX_REFILL
    ) {
      throw new ConflictError(
        `refill_per_second must be between ${MIN_REFILL.toString()} and ${MAX_REFILL.toString()}.`,
      );
    }
    const expiresAtMs = input.expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new ConflictError('expires_at must be in the future.');
    }

    const record = await this.repo.upsert({
      accountId: input.accountId,
      bucketKey: input.bucketKey,
      capacity: Math.floor(input.capacity),
      refillPerSecond: input.refillPerSecond,
      expiresAt: input.expiresAt,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      setByKeyId: ctx.apiKey.id,
    });

    await this.invalidateCache(input.accountId);
    return record;
  }

  async clear(ctx: AccountContext, accountId: string, bucketKey: string): Promise<void> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const removed = await this.repo.clear(accountId, bucketKey);
    if (!removed) {
      throw new NotFoundError(
        `No active override for account "${accountId}" bucket "${bucketKey}".`,
      );
    }
    await this.invalidateCache(accountId);
  }

  async listAll(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string; accountId?: string; includeExpired?: boolean },
  ): Promise<{ items: RateLimitOverrideRecord[]; nextCursor: string | null }> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.listAll(opts);
  }

  private async invalidateCache(accountId: string): Promise<void> {
    if (!this.authCache) return;
    try {
      await this.authCache.invalidateAccount(accountId);
    } catch {
      // Cache failure must not propagate as admin-action failure —
      // override is committed; cache TTLs out within 30s in worst case.
    }
  }
}
