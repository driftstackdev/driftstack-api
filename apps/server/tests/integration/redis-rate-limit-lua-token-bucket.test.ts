// The PRODUCTION rate limiter's Lua token bucket, against a real Redis.
//
// `RedisRateLimitStore` implements the whole bucket as a Lua script run under
// EVAL, which is what makes it atomic across concurrent requests. Measured
// before writing this: setting the allow-branch to `if true then` — turning the
// limiter completely OFF — reds exactly three tests in the vitest gate, and all
// three are CONTENT-PARITY pins over the script's source text. The same mutation
// fails all four `tests/e2e/rate-limit.spec.ts` cases.
//
// So the behavioural coverage was real and good, and lived ENTIRELY outside the
// gate that runs on every commit: e2e is a separate Playwright suite, excluded
// from every vitest config, and until recently could not even be run without
// Docker. Anyone seeing `verify-suite: OK` had not exercised the limiter.
//
// This brings that coverage into the main gate. CI's build-test job already
// provisions a redis service which no integration test was using.
//
// `now` is injected, so refill is exercised by arithmetic rather than sleeping —
// no timing assumptions and no flake. Keys are per-test UUIDs, so this never
// flushes and cannot disturb another agent's index.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStore } from '../../src/lib/redis-rate-limit-store.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redis: Redis | null = null;
let reachable = false;

beforeAll(async () => {
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    await client.ping();
    redis = client;
    reachable = true;
  } catch {
    await client.quit().catch(() => {});
  }
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.REDIS_URL)(
  'redis token bucket (the production limiter, real Lua)',
  () => {
    const store = (): RedisRateLimitStore => {
      if (!redis) throw new Error('no redis');
      return new RedisRateLimitStore(redis);
    };
    const key = (): string => `zz-test-rl:${randomUUID()}`;

    it('CRITICAL redis is reachable, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.REDIS_URL) return;
      expect(reachable, `redis unreachable at ${REDIS_URL}`).toBe(true);
    });

    it('a fresh key starts FULL and spends one token', async () => {
      if (!reachable) return;
      const r = await store().consume({
        key: key(),
        capacity: 10,
        refillPerSecond: 1,
        cost: 1,
        now: 1_000,
      });
      expect(r).toEqual({ allowed: true, remaining: 9, retryAfterMs: 0 });
    });

    it('CRITICAL drains to exactly capacity, then refuses with a retry hint', async () => {
      if (!reachable) return;
      const k = key();
      const s = store();
      for (let i = 0; i < 10; i += 1) {
        const r = await s.consume({
          key: k,
          capacity: 10,
          refillPerSecond: 1,
          cost: 1,
          now: 1_000,
        });
        expect(r.allowed, `call ${i + 1} of 10 must be allowed`).toBe(true);
      }
      const refused = await s.consume({
        key: k,
        capacity: 10,
        refillPerSecond: 1,
        cost: 1,
        now: 1_000,
      });
      expect(refused.allowed, 'the 11th call exceeds capacity').toBe(false);
      expect(refused.retryAfterMs, 'a refusal must say when to come back').toBeGreaterThan(0);
    });

    it('CRITICAL spends the LAST token — the allow branch is >= cost, not > cost', async () => {
      if (!reachable) return;
      // The off-by-one that matters: with exactly `cost` tokens left the request
      // is affordable. `>` would refuse it and every bucket would be one token
      // smaller than its advertised capacity.
      const k = key();
      const s = store();
      await s.consume({ key: k, capacity: 3, refillPerSecond: 1, cost: 2, now: 1_000 });
      const last = await s.consume({
        key: k,
        capacity: 3,
        refillPerSecond: 1,
        cost: 1,
        now: 1_000,
      });
      expect(last, 'exactly enough must be enough').toEqual({
        allowed: true,
        remaining: 0,
        retryAfterMs: 0,
      });
    });

    it('CRITICAL refills in proportion to elapsed time, and never past capacity', async () => {
      if (!reachable) return;
      const k = key();
      const s = store();
      for (let i = 0; i < 5; i += 1) {
        await s.consume({ key: k, capacity: 5, refillPerSecond: 2, cost: 1, now: 10_000 });
      }
      // 500ms at 2 tokens/sec == exactly one token back.
      const afterHalfSecond = await s.consume({
        key: k,
        capacity: 5,
        refillPerSecond: 2,
        cost: 1,
        now: 10_500,
      });
      expect(afterHalfSecond.allowed, 'one token refilled in 500ms at 2/sec').toBe(true);

      // An hour later the bucket is full, not overflowing.
      const muchLater = await s.consume({
        key: k,
        capacity: 5,
        refillPerSecond: 2,
        cost: 1,
        now: 10_500 + 3_600_000,
      });
      expect(muchLater.remaining, 'a bucket never holds more than its capacity').toBe(4);
    });

    it('CRITICAL refills at the STATED rate — too little time is still a refusal', async () => {
      if (!reachable) return;
      // Added after a mutation went unnoticed: making refill 10x too fast left
      // every other arm green, because both of them land where the capacity cap
      // absorbs the excess. Rate is only observable BELOW the cap — drain the
      // bucket, then ask again after too little time has passed.
      const k = key();
      const s = store();
      for (let i = 0; i < 5; i += 1) {
        await s.consume({ key: k, capacity: 5, refillPerSecond: 2, cost: 1, now: 10_000 });
      }
      // 100ms at 2 tokens/sec is 0.2 tokens — not enough for a cost of 1.
      const tooSoon = await s.consume({
        key: k,
        capacity: 5,
        refillPerSecond: 2,
        cost: 1,
        now: 10_100,
      });
      expect(tooSoon.allowed, '0.2 tokens cannot pay for 1').toBe(false);
      expect(tooSoon.retryAfterMs, 'and it says how long the remaining 0.8 takes').toBe(400);
    });

    it('CRITICAL 100 concurrent consumes on one key yield EXACTLY capacity successes', async () => {
      if (!reachable) return;
      // This is why the bucket is Lua rather than read-modify-write in TypeScript.
      const k = key();
      const s = store();
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          s.consume({ key: k, capacity: 60, refillPerSecond: 0.0001, cost: 1, now: 5_000 }),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(60);
      expect(results.filter((r) => !r.allowed)).toHaveLength(40);
    });

    it('CRITICAL fails SAFE on a partial hash rather than erroring every request', async () => {
      if (!reachable || !redis) return;
      // The script guards `last_ms` as well as `tokens`. A hash holding only one
      // of them — an external write, a truncated value — would otherwise make
      // `now_ms - last_ms` an arithmetic error, and EVAL would fail EVERY request
      // for that key until the TTL healed it. A limiter must not error requests
      // open or closed on a malformed key.
      const k = key();
      await redis.hset(k, 'tokens', '3');
      const r = await store().consume({
        key: k,
        capacity: 10,
        refillPerSecond: 1,
        cost: 1,
        now: 2_000,
      });
      expect(r.allowed, 'a corrupt bucket must still serve').toBe(true);
      expect(r.remaining, 'and reset to a full bucket rather than trusting half of it').toBe(9);
    });
  },
);
