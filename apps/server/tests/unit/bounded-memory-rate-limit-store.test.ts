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

  // V-1446 — a mutation sweep of this store killed the eviction branch and the
  // `maxBuckets >= 1` guard, and left three things standing: the `Math.min(capacity,
  // …)` burst cap, the `Math.max(0, …)` clock clamp, and the delete-then-set that
  // makes eviction least-recently-TOUCHED rather than oldest-inserted. The refill arm
  // above advances one second and proves a token comes back, which no more reaches a
  // ceiling here than it did on the fleet bucket.
  //
  // This is the store the rate-limit middlewares degrade to when Redis throws, so
  // these are the semantics that carry limiting during exactly the outage where
  // limiting is the only thing left.
  it('CRITICAL an idle key cannot bank tokens past capacity', async () => {
    const store = new BoundedMemoryRateLimitStore();
    const base = { key: 'idle', capacity: 2, refillPerSecond: 1, cost: 1 };
    expect((await store.consume({ ...base, now: 0 })).allowed).toBe(true);
    expect((await store.consume({ ...base, now: 0 })).allowed).toBe(true);
    expect((await store.consume({ ...base, now: 0 })).allowed).toBe(false);

    // 1000 seconds of silence is 1000 tokens of refill against a capacity of 2.
    expect((await store.consume({ ...base, now: 1_000_000 })).allowed).toBe(true);
    expect((await store.consume({ ...base, now: 1_000_000 })).allowed).toBe(true);
    expect(
      (await store.consume({ ...base, now: 1_000_000 })).allowed,
      'the bucket refilled past capacity — an idle key banked its whole quiet period and spent it at once',
    ).toBe(false);
  });

  it('CRITICAL a clock that steps BACKWARDS does not drain a bucket. Asserted on the ADMITTING side: once a bucket is empty a backwards step denies either way, so only a key with tokens in hand separates the clamp from its absence — unclamped, a ten-second step back subtracts ten tokens from a bucket holding four and the next call is denied.', async () => {
    const store = new BoundedMemoryRateLimitStore();
    const base = { key: 'clock', capacity: 5, refillPerSecond: 1, cost: 1 };
    expect((await store.consume({ ...base, now: 10_000_000 })).allowed).toBe(true);
    expect(
      (await store.consume({ ...base, now: 9_990_000 })).allowed,
      'a backwards clock step drained a bucket that still held four tokens',
    ).toBe(true);
  });

  it('CRITICAL eviction targets the least-recently-TOUCHED key, not the oldest inserted. Without the delete-then-set, a key under sustained load keeps its original slot and is evicted first while idle keys survive — and an evicted bucket starts FULL, so the heaviest talker is the one whose limit resets. That is the exact traffic shape this store exists to bound.', async () => {
    const store = new BoundedMemoryRateLimitStore(2);
    const mk = (key: string) => ({ key, capacity: 1, refillPerSecond: 0, cost: 1, now: 0 });

    expect((await store.consume(mk('a'))).allowed).toBe(true); // 'a' now empty
    expect((await store.consume(mk('b'))).allowed).toBe(true); // 'b' now empty
    expect((await store.consume(mk('a'))).allowed).toBe(false); // denied, and touches 'a'

    // A third key evicts one bucket. Touched-order evicts 'b'; insertion-order 'a'.
    await store.consume(mk('c'));
    expect(store.size()).toBe(2);

    expect(
      (await store.consume(mk('a'))).allowed,
      "'a' was evicted despite being the most recently used key, and came back with a full bucket",
    ).toBe(false);
  });
});
