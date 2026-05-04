// V-123: Rate-limit token-bucket consume() microbenchmarks.
//
// Every authenticated request hits `MemoryRateLimitStore.consume()`
// (or its Redis equivalent in production). Establishing a baseline
// for the in-process variant lets us spot regressions in the hot path
// math (bucket refill + persistence). Same harness as V-120's auth
// cache bench: vitest's built-in `bench()` over tinybench.

import { bench, describe } from 'vitest';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';

describe('MemoryRateLimitStore.consume — happy path (bucket has tokens)', () => {
  const store = new MemoryRateLimitStore();
  const baseTime = Date.now();

  bench('consume(cost=1) when bucket has capacity', async () => {
    // Use a fresh key per call so we always hit the "first consume on a
    // new bucket" path (bucket initialized at full capacity, immediately
    // serves the request). This is the most common production shape:
    // requests against a key that hasn't been touched in the recent
    // window are essentially first-touch.
    const key = `bench_${Math.random().toString(36).slice(2)}`;
    await store.consume({
      key,
      capacity: 100,
      refillPerSecond: 10,
      cost: 1,
      now: baseTime,
    });
  });
});

describe('MemoryRateLimitStore.consume — refill + consume', () => {
  // Same key across calls so we exercise the refill + persist branch.
  const store = new MemoryRateLimitStore();
  const KEY = 'bench_refill';
  const baseTime = Date.now();
  let tick = 0;

  bench('consume(cost=1) with refill math on existing bucket', async () => {
    tick += 1;
    await store.consume({
      key: KEY,
      capacity: 100,
      refillPerSecond: 10,
      cost: 1,
      // Advance time so refill kicks in. 100ms per tick = 1 token refilled.
      now: baseTime + tick * 100,
    });
  });
});

describe('MemoryRateLimitStore.consume — denied path (over budget)', () => {
  // Pre-drain a bucket so every consume() returns allowed=false. Tests
  // the denial-with-retryAfter computation.
  const store = new MemoryRateLimitStore();
  const KEY = 'bench_denied';
  const baseTime = Date.now();
  // Drain the bucket once so subsequent consumes are over budget.
  void store.consume({
    key: KEY,
    capacity: 1,
    refillPerSecond: 0.001, // ≈ 1 token per 1000s; effectively non-refilling
    cost: 1,
    now: baseTime,
  });

  bench('consume(cost=1) when bucket is empty (allowed=false)', async () => {
    await store.consume({
      key: KEY,
      capacity: 1,
      refillPerSecond: 0.001,
      cost: 1,
      now: baseTime + 1, // 1ms later — no meaningful refill at this rate
    });
  });
});
