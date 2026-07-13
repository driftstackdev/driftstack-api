// Token-bucket rate limiter.
//
// One "bucket" per (account, bucket-key). Buckets refill at a steady rate up
// to a capacity. Each call consumes some cost; if the bucket has at least
// `cost` tokens, the call is allowed; otherwise it's denied with a retry
// hint (ms until enough tokens have accrued).
//
// The algorithm is implemented over a `RateLimitStore` interface so we have:
//   - RedisRateLimitStore (production: atomic Lua script)
//   - MemoryRateLimitStore (tests: in-process map)
//
// Both implementations follow the same semantics, validated by the shared
// test suite in tests/unit/rate-limit.test.ts.

import { TIER_RATE_LIMIT_DEFAULTS, type AccountTier } from '@driftstack/api-types';
import type { RateLimitOverride } from './auth.js';

// ───────────────────────────────────────────────────────────────────────────
// Tier defaults — V-219 sources from `@driftstack/api-types`
// `TIER_RATE_LIMIT_DEFAULTS` so SDK consumers can read the same
// constants the server enforces. "RPS" is "tokens per second" if
// cost=1; for buckets where each request costs more, the effective
// request rate is (rps / cost).
// ───────────────────────────────────────────────────────────────────────────

export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export function bucketConfigFor(tier: AccountTier, bucketKey: string): BucketConfig {
  const tierConfig = TIER_RATE_LIMIT_DEFAULTS[tier];
  const specific = (tierConfig as Record<string, { capacity: number; refill_per_second: number }>)[
    bucketKey
  ];
  if (specific) {
    return { capacity: specific.capacity, refillPerSecond: specific.refill_per_second };
  }
  const fallback = tierConfig.global;
  if (!fallback) {
    throw new Error(
      `tier ${tier} is missing a 'global' bucket — TIER_RATE_LIMIT_DEFAULTS is malformed`,
    );
  }
  return { capacity: fallback.capacity, refillPerSecond: fallback.refill_per_second };
}

// ───────────────────────────────────────────────────────────────────────────
// Store interface
// ───────────────────────────────────────────────────────────────────────────

export interface ConsumeOpts {
  key: string;
  capacity: number;
  refillPerSecond: number;
  cost: number;
  now: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Tokens left in the bucket after this call. */
  remaining: number;
  /** ms until the bucket is full enough to satisfy this cost; 0 when allowed. */
  retryAfterMs: number;
}

/** Exact rolling-window input for low-frequency absolute ceilings. Unlike a
 * token bucket, this primitive never replenishes capacity before the oldest
 * accepted event leaves the full window. */
export interface SlidingWindowConsumeOpts {
  key: string;
  limit: number;
  windowMs: number;
  now: number;
}

export interface SlidingWindowConsumeResult extends ConsumeResult {
  /** Epoch milliseconds when every currently retained event has expired. */
  resetAtMs: number;
}

/** Optional exact-window capability implemented by the distributed Redis
 * store and its deterministic memory test counterpart. Callers that require
 * an absolute ceiling must detect its absence and fail closed. */
export interface SlidingWindowRateLimitStore {
  consumeSlidingWindow(opts: SlidingWindowConsumeOpts): Promise<SlidingWindowConsumeResult>;
}

// W199 — capacity + reset hints surfaced to the middleware so customer
// rate-limit headers (`x-ratelimit-limit`, `x-ratelimit-reset`,
// `x-ratelimit-bucket`) match the contract documented at
// `/docs/rate-limits`. ConsumeResult stays minimal so the
// RateLimitStore interface doesn't grow; the middleware composes the
// extra fields here from the cached bucket config.
export interface ConsumeResultWithBucket extends ConsumeResult {
  /** Maximum bucket size (capacity). The bucket can never hold more than this. */
  capacity: number;
  /** Refill rate used for this consume call (tokens/sec). */
  refillPerSecond: number;
}

export interface RateLimitStore {
  consume(opts: ConsumeOpts): Promise<ConsumeResult>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service entry
// ───────────────────────────────────────────────────────────────────────────

export interface RateLimitInput {
  accountId: string;
  tier: AccountTier;
  bucketKey: string;
  cost?: number;
  now?: number;
  /**
   * Active overrides keyed by bucketKey, loaded from AccountContext.
   * Override is consulted first; expired or missing → tier default.
   */
  overrides?: Record<string, RateLimitOverride>;
}

export async function rateLimitConsume(
  store: RateLimitStore,
  input: RateLimitInput,
): Promise<ConsumeResultWithBucket> {
  const cfg = effectiveBucketConfig(input);
  const result = await store.consume({
    key: storeKey(input.accountId, input.bucketKey),
    capacity: cfg.capacity,
    refillPerSecond: cfg.refillPerSecond,
    cost: input.cost ?? 1,
    now: input.now ?? Date.now(),
  });
  return { ...result, capacity: cfg.capacity, refillPerSecond: cfg.refillPerSecond };
}

/**
 * Resolve the bucket config: override (when present + unexpired) wins
 * over the tier default. Lazy expiry — an expired override row in the
 * cached context falls through to the tier default without requiring
 * the cache to have been re-loaded.
 */
function effectiveBucketConfig(input: RateLimitInput): BucketConfig {
  const now = input.now ?? Date.now();
  const override = input.overrides?.[input.bucketKey];
  if (override && override.expiresAt.getTime() > now) {
    return { capacity: override.capacity, refillPerSecond: override.refillPerSecond };
  }
  return bucketConfigFor(input.tier, input.bucketKey);
}

function storeKey(accountId: string, bucketKey: string): string {
  return `rl:${accountId}:${bucketKey}`;
}
