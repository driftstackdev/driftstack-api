// Bounded in-process token-bucket store — the per-instance FALLBACK the
// rate-limit middlewares degrade to when their primary (Redis) store
// throws.
//
// The plain MemoryRateLimitStore (used by tests) has an unbounded map. As
// a degradation fallback that an attacker could feed unbounded distinct
// keys (one bucket per source IP), it MUST be bounded — otherwise the
// "graceful degradation" path is itself a memory-exhaustion vector. This
// variant FIFO-evicts the oldest bucket on overflow. Eviction is safe for
// a limiter: an evicted bucket simply starts full again (coarser than
// Redis, but still per-instance limiting — far better than the prior
// unconditional fail-OPEN that removed ALL limiting platform-wide on a
// Redis blip).

import type { ConsumeOpts, ConsumeResult, RateLimitStore } from '../services/rate-limit.js';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class BoundedMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();
  private readonly maxBuckets: number;

  constructor(maxBuckets = 100_000) {
    if (maxBuckets < 1) throw new Error('maxBuckets must be >= 1');
    this.maxBuckets = maxBuckets;
  }

  consume(opts: ConsumeOpts): Promise<ConsumeResult> {
    const { key, capacity, refillPerSecond, cost, now } = opts;
    const existing = this.buckets.get(key);

    // Re-inserting an existing key moves it to the most-recent slot (Map
    // preserves insertion order) so the FIFO eviction below targets the
    // least-recently-touched bucket. Delete-then-set achieves that.
    if (existing !== undefined) {
      this.buckets.delete(key);
    } else if (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }

    const state = existing ?? { tokens: capacity, lastRefillMs: now };
    const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
    const refill = elapsedSec * refillPerSecond;
    const refilled = Math.min(capacity, state.tokens + refill);

    if (refilled >= cost) {
      const remaining = refilled - cost;
      this.buckets.set(key, { tokens: remaining, lastRefillMs: now });
      return Promise.resolve({ allowed: true, remaining, retryAfterMs: 0 });
    }

    const deficit = cost - refilled;
    const retryAfterMs = Math.ceil((deficit / Math.max(refillPerSecond, 0.0001)) * 1000);
    // Persist refilled tokens but don't consume.
    this.buckets.set(key, { tokens: refilled, lastRefillMs: now });
    return Promise.resolve({ allowed: false, remaining: refilled, retryAfterMs });
  }

  /** Test helper: current bucket count. */
  size(): number {
    return this.buckets.size;
  }
}
