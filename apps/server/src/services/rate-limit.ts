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

import type { AccountTier } from '@driftstack/api-types';
import type { RateLimitOverride } from './auth.js';

// ───────────────────────────────────────────────────────────────────────────
// Tier defaults — coarse limits for Phase 3. Per-bucket overrides come later.
// "RPS" is "tokens per second" if cost=1; for buckets where each request costs
// more, the effective request rate is (rps / cost).
// ───────────────────────────────────────────────────────────────────────────

export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

// Locked pricing model — see D-019. Capacities + refill rates scale roughly
// with $/mo and concurrency limit per tier.
const TIER_DEFAULTS: Record<AccountTier, Record<string, BucketConfig>> = {
  free: {
    global: { capacity: 60, refillPerSecond: 1 },
    'sessions:create': { capacity: 5, refillPerSecond: 1 / 60 }, // 1/min
  },
  starter: {
    global: { capacity: 120, refillPerSecond: 2 },
    'sessions:create': { capacity: 10, refillPerSecond: 1 / 30 }, // 2/min
  },
  solo: {
    global: { capacity: 600, refillPerSecond: 10 },
    'sessions:create': { capacity: 30, refillPerSecond: 1 / 6 }, // 10/min
  },
  builder: {
    global: { capacity: 1_800, refillPerSecond: 30 },
    'sessions:create': { capacity: 60, refillPerSecond: 1 }, // 60/min
  },
  scale: {
    global: { capacity: 6_000, refillPerSecond: 100 },
    'sessions:create': { capacity: 120, refillPerSecond: 2 }, // 120/min
  },
  enterprise: {
    global: { capacity: 60_000, refillPerSecond: 1_000 },
    'sessions:create': { capacity: 600, refillPerSecond: 10 }, // 600/min
  },
};

export function bucketConfigFor(tier: AccountTier, bucketKey: string): BucketConfig {
  const tierConfig = TIER_DEFAULTS[tier];
  const specific = tierConfig[bucketKey];
  if (specific) return specific;
  const fallback = tierConfig.global;
  // Every tier defines a 'global' bucket; this assertion documents that
  // invariant and lets `noUncheckedIndexedAccess` see the type narrow.
  if (!fallback) {
    throw new Error(`tier ${tier} is missing a 'global' bucket — TIER_DEFAULTS is malformed`);
  }
  return fallback;
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
): Promise<ConsumeResult> {
  const cfg = effectiveBucketConfig(input);
  return store.consume({
    key: storeKey(input.accountId, input.bucketKey),
    capacity: cfg.capacity,
    refillPerSecond: cfg.refillPerSecond,
    cost: input.cost ?? 1,
    now: input.now ?? Date.now(),
  });
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
