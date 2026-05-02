// In-process token bucket store. Used by tests; do NOT use in production
// (no persistence, doesn't work across multiple server instances).

import type { ConsumeOpts, ConsumeResult, RateLimitStore } from '../services/rate-limit.js';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  async consume(opts: ConsumeOpts): Promise<ConsumeResult> {
    const { key, capacity, refillPerSecond, cost, now } = opts;
    const existing = this.buckets.get(key) ?? { tokens: capacity, lastRefillMs: now };

    const elapsedSec = Math.max(0, (now - existing.lastRefillMs) / 1000);
    const refill = elapsedSec * refillPerSecond;
    const refilled = Math.min(capacity, existing.tokens + refill);

    if (refilled >= cost) {
      const remaining = refilled - cost;
      this.buckets.set(key, { tokens: remaining, lastRefillMs: now });
      return Promise.resolve({ allowed: true, remaining, retryAfterMs: 0 });
    }

    const deficit = cost - refilled;
    const retryAfterMs = Math.ceil((deficit / refillPerSecond) * 1000);

    // Persist refilled tokens but don't consume.
    this.buckets.set(key, { tokens: refilled, lastRefillMs: now });

    return Promise.resolve({ allowed: false, remaining: refilled, retryAfterMs });
  }

  reset(): void {
    this.buckets.clear();
  }
}
