// DoS hardening — bounded in-process token-bucket store. The fail-OPEN
// degradation fallback for the rate-limiters MUST be bounded so the
// "graceful degradation" path isn't itself a memory-exhaustion vector
// (an attacker can feed unbounded distinct IP keys during a Redis
// outage). It FIFO-evicts the oldest bucket on overflow.

import { describe, expect, it } from 'vitest';
import { BoundedMemoryRateLimitStore } from '../../src/lib/bounded-memory-rate-limit-store.js';

describe('BoundedMemoryRateLimitStore', () => {
  it('enforces the token bucket (admits capacity, then denies)', async () => {
    const store = new BoundedMemoryRateLimitStore();
    const opts = { key: 'k', capacity: 2, refillPerSecond: 0, cost: 1, now: 1000 };
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(true);
    const denied = await store.consume(opts);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over elapsed time', async () => {
    const store = new BoundedMemoryRateLimitStore();
    const base = { key: 'k', capacity: 1, refillPerSecond: 1, cost: 1 };
    expect((await store.consume({ ...base, now: 0 })).allowed).toBe(true);
    // Immediately after, the bucket is empty.
    expect((await store.consume({ ...base, now: 0 })).allowed).toBe(false);
    // One second later, one token has refilled.
    expect((await store.consume({ ...base, now: 1000 })).allowed).toBe(true);
  });

  it('bounds the bucket map by FIFO-evicting the oldest key on overflow', async () => {
    const store = new BoundedMemoryRateLimitStore(2);
    const mk = (key: string) => ({ key, capacity: 5, refillPerSecond: 0, cost: 1, now: 0 });
    await store.consume(mk('a'));
    await store.consume(mk('b'));
    expect(store.size()).toBe(2);
    // 3rd distinct key evicts the oldest ('a'); size stays bounded.
    await store.consume(mk('c'));
    expect(store.size()).toBe(2);
  });

  it('does not grow unbounded under many distinct keys (the memory-exhaustion guard)', async () => {
    const store = new BoundedMemoryRateLimitStore(50);
    for (let i = 0; i < 1000; i++) {
      await store.consume({
        key: `ip-${i.toString()}`,
        capacity: 5,
        refillPerSecond: 0,
        cost: 1,
        now: 0,
      });
    }
    expect(store.size()).toBeLessThanOrEqual(50);
  });

  it('rejects an invalid bound', () => {
    expect(() => new BoundedMemoryRateLimitStore(0)).toThrow();
  });
});
