// Algorithm correctness tests for the token-bucket rate limiter, exercised
// against the MemoryRateLimitStore. The Redis store is contract-equivalent
// (verified via integration test once Redis infra is online).

import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { bucketConfigFor, rateLimitConsume } from '../../src/services/rate-limit.js';

describe('MemoryRateLimitStore.consume', () => {
  it('first call against an unknown key returns full capacity minus cost', async () => {
    const store = new MemoryRateLimitStore();
    const r = await store.consume({
      key: 'a',
      capacity: 10,
      refillPerSecond: 1,
      cost: 1,
      now: 1000,
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
    expect(r.retryAfterMs).toBe(0);
  });

  it('exhausting the bucket returns allowed=false with retry-after', async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 5; i++) {
      const r = await store.consume({
        key: 'a',
        capacity: 5,
        refillPerSecond: 0,
        cost: 1,
        now: 1000,
      });
      expect(r.allowed).toBe(true);
    }
    const denied = await store.consume({
      key: 'a',
      capacity: 5,
      refillPerSecond: 0,
      cost: 1,
      now: 1000,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('refills tokens at the configured rate over time', async () => {
    const store = new MemoryRateLimitStore();
    // Drain to 0
    await store.consume({
      key: 'a',
      capacity: 10,
      refillPerSecond: 1,
      cost: 10,
      now: 1000,
    });
    // 5 seconds later: should have 5 tokens refilled
    const r = await store.consume({
      key: 'a',
      capacity: 10,
      refillPerSecond: 1,
      cost: 1,
      now: 6000,
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4); // refilled 5, consumed 1
  });

  it('clamps refilled tokens at capacity (no overshoot)', async () => {
    const store = new MemoryRateLimitStore();
    // First call, leaves 4 tokens at t=1000
    await store.consume({
      key: 'a',
      capacity: 5,
      refillPerSecond: 1,
      cost: 1,
      now: 1000,
    });
    // 1000 seconds later, refill would be 1000 tokens — must clamp to 5.
    const r = await store.consume({
      key: 'a',
      capacity: 5,
      refillPerSecond: 1,
      cost: 1,
      now: 1_001_000,
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it('retryAfter is roughly the time needed to accrue the deficit', async () => {
    const store = new MemoryRateLimitStore();
    // Drain
    await store.consume({
      key: 'a',
      capacity: 10,
      refillPerSecond: 2,
      cost: 10,
      now: 1000,
    });
    // Need 1 token, refilling at 2/sec → 500ms
    const denied = await store.consume({
      key: 'a',
      capacity: 10,
      refillPerSecond: 2,
      cost: 1,
      now: 1000,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
  });

  it('different keys are independent', async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 5; i++) {
      const a = await store.consume({
        key: 'a',
        capacity: 5,
        refillPerSecond: 0,
        cost: 1,
        now: 1000,
      });
      expect(a.allowed).toBe(true);
    }
    const b = await store.consume({
      key: 'b',
      capacity: 5,
      refillPerSecond: 0,
      cost: 1,
      now: 1000,
    });
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBe(4);
  });
});

describe('bucketConfigFor', () => {
  it('returns tier-specific bucket when defined', () => {
    const cfg = bucketConfigFor('api_scale', 'sessions:create');
    expect(cfg.capacity).toBe(120);
    expect(cfg.refillPerSecond).toBeCloseTo(2);
  });

  it('falls back to the tier global bucket for unknown bucket keys', () => {
    const cfg = bucketConfigFor('api_starter', 'unknown:bucket');
    expect(cfg.capacity).toBe(240);
    expect(cfg.refillPerSecond).toBe(4);
  });

  it('tiers scale monotonically along each ladder up to enterprise', () => {
    // Two-ladder per ADR-004 — verify each ladder + trial pack scales
    // monotonically up. Bonus: enterprise is the strict upper bound.
    const orderedAlongLadders = [
      'trial_pack',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'enterprise',
    ] as const;
    let prev = 0;
    for (const t of orderedAlongLadders) {
      const cfg = bucketConfigFor(t, 'global');
      expect(cfg.capacity).toBeGreaterThan(prev);
      prev = cfg.capacity;
    }
    const apiLadder = ['api_starter', 'api_builder', 'api_scale', 'enterprise'] as const;
    let prevApi = 0;
    for (const t of apiLadder) {
      const cfg = bucketConfigFor(t, 'global');
      expect(cfg.capacity).toBeGreaterThan(prevApi);
      prevApi = cfg.capacity;
    }
  });
});

describe('rateLimitConsume (service)', () => {
  it('routes through tier-keyed config', async () => {
    const store = new MemoryRateLimitStore();
    const r = await rateLimitConsume(store, {
      accountId: 'acc-1',
      tier: 'trial_pack',
      bucketKey: 'global',
      now: 1000,
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(59); // free global capacity 60 - cost 1
  });
});
