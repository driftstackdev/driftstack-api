// `RedisMfaChallengeStore` against a real Redis — the production MFA
// step-up challenge store.
//
// Measured before writing this. Replacing `consume()`'s GETDEL with a plain
// `get` — a TYPE-VALID change, so the compile guards cannot answer in the
// behaviour's place — makes an MFA challenge REUSABLE, and the only test that
// reds is `services-mfa-challenge-store-content-parity`: a regex over the source
// text. Nothing behavioural noticed that a challenge stopped being single-use.
//
// The other two operations are Lua, and their comments state properties no
// source-text pin can check: `incrAttempts` must attach the expiry in the SAME
// step (a separate INCR then EXPIRE strands an immortal counter if the
// connection dies between them, permanently locking step-up for that account),
// and `releaseAttempt` must neither go negative nor RESURRECT an expired key as
// -1.
//
// Keys are per-test UUIDs, so this never flushes and cannot disturb another
// agent's index.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisMfaChallengeStore } from '../../src/services/mfa-challenge-store.js';

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
  'redis MFA challenge store (production, real Redis)',
  () => {
    const store = (): RedisMfaChallengeStore => {
      if (!redis) throw new Error('no redis');
      return new RedisMfaChallengeStore(redis);
    };
    const key = (): string => `zz-test-mfa:${randomUUID()}`;

    it('CRITICAL redis is reachable, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.REDIS_URL) return;
      expect(reachable, `redis unreachable at ${REDIS_URL}`).toBe(true);
    });

    it('CRITICAL a challenge is SINGLE-USE — consuming it twice yields nothing', async () => {
      if (!reachable) return;
      const k = key();
      const s = store();
      await s.set(k, 'payload', 60);
      expect(await s.consume(k), 'the first consume returns the payload').toBe('payload');
      expect(await s.consume(k), 'a replayed challenge token is inert').toBeNull();
    });

    it('CRITICAL two concurrent consumes: exactly one gets the payload', async () => {
      if (!reachable) return;
      // This is what GETDEL buys over GET-then-DEL. Under the split version both
      // callers read the value before either deletes, and a captured challenge
      // could be verified twice.
      const k = key();
      const s = store();
      await s.set(k, 'payload', 60);
      const [a, b] = await Promise.all([s.consume(k), s.consume(k)]);
      expect(
        [a, b].filter((v) => v === 'payload'),
        'exactly one winner',
      ).toHaveLength(1);
      expect(
        [a, b].filter((v) => v === null),
        'and exactly one loser',
      ).toHaveLength(1);
    });

    it('peek reads without consuming, so an IP-mismatch refusal leaves the customer able to retry', async () => {
      if (!reachable) return;
      const k = key();
      const s = store();
      await s.set(k, 'payload', 60);
      expect(await s.peek(k)).toBe('payload');
      expect(await s.peek(k), 'peeking twice is still non-destructive').toBe('payload');
      expect(await s.consume(k), 'and the challenge is still there to consume').toBe('payload');
    });

    it('CRITICAL the attempt counter gets its TTL in the SAME step as the increment', async () => {
      if (!reachable || !redis) return;
      // A separate INCR then EXPIRE strands an immortal counter when the
      // connection dies between the two commands, which permanently locks
      // step-up for that account. Only a real Redis can show the TTL landed.
      const k = key();
      expect(await store().incrAttempts(k, 30), 'first attempt').toBe(1);
      const ttl = await redis.ttl(k);
      expect(ttl, 'the counter expires with the challenge').toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
      expect(await store().incrAttempts(k, 30), 'second attempt').toBe(2);
    });

    it('CRITICAL an existing TTL is not extended by later increments', async () => {
      if (!reachable || !redis) return;
      const k = key();
      const s = store();
      await s.incrAttempts(k, 30);
      await redis.expire(k, 5);
      await s.incrAttempts(k, 30);
      expect(
        await redis.ttl(k),
        'a later attempt must not push the expiry back out to 30',
      ).toBeLessThanOrEqual(5);
    });

    it('CRITICAL releasing never leaves a negative counter, and never resurrects an absent key', async () => {
      if (!reachable || !redis) return;
      const s = store();

      // Releasing an ABSENT key must not create it. A bare DECR would write -1,
      // and that key would then outlive the challenge it was counting for.
      const missing = key();
      await s.releaseAttempt(missing);
      expect(await redis.exists(missing), 'no key was resurrected').toBe(0);

      // Releasing the last attempt removes the counter rather than storing 0.
      const k = key();
      await s.incrAttempts(k, 30);
      await s.releaseAttempt(k);
      expect(await redis.exists(k), 'the last release deletes the counter').toBe(0);

      // And an ordinary release decrements.
      const k2 = key();
      await s.incrAttempts(k2, 30);
      await s.incrAttempts(k2, 30);
      await s.releaseAttempt(k2);
      expect(await redis.get(k2)).toBe('1');
    });
  },
);
