// `RedisPairModeTakeoverLock` against a real Redis — including its release Lua.
//
// The unit test drives a hand-written fake whose `eval` is, by its own comment,
// "a tiny interpreter just for the release CAS-DEL script". It recognises the
// script by comparing it against a LITERAL COPY re-declared inside the test
// (the source constant is module-private), then substitutes its own JavaScript
// model of what the Lua does.
//
// That is a duplicated-literal tripwire, and a good one: changing the source Lua
// reds three tests because the fake stops recognising it. But it is not semantic
// validation. Update both copies — which is exactly what a refactor does — and
// the fake's JS model passes whether or not the new Lua is valid, or correct, in
// the real evaluator. Measured: replacing the script with an unconditional DELETE
// and with syntactically invalid Lua both red the SAME three tests, which is the
// tell that the reds are about the text changing rather than about behaviour.
//
// So the actual script has never been run by Redis. This runs it. The property
// that matters is the CAS: releasing must be a no-op when another client holds
// the lock, or one client could free another's pair-mode session and a third
// party could take it over.
//
// Keys are per-test UUIDs, so this never flushes and cannot disturb another
// agent's index.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedisPairModeTakeoverLock,
  type RedisLikeClient,
} from '../../src/services/agent-pair-mode-lock.js';

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
  'redis pair-mode takeover lock (production, real Lua)',
  () => {
    const lock = (): RedisPairModeTakeoverLock => {
      if (!redis) throw new Error('no redis');
      return new RedisPairModeTakeoverLock(redis as unknown as RedisLikeClient);
    };
    const sessionId = (): string => `zz-test-pair-${randomUUID()}`;

    it('CRITICAL redis is reachable, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.REDIS_URL) return;
      expect(reachable, `redis unreachable at ${REDIS_URL}`).toBe(true);
    });

    it('the first client acquires and the second is told who won', async () => {
      if (!reachable) return;
      const s = sessionId();
      const l = lock();
      expect(await l.tryAcquire({ sessionId: s, clientId: 'client-a', ttlSeconds: 30 })).toEqual({
        acquired: true,
        winnerClientId: 'client-a',
      });
      expect(
        await l.tryAcquire({ sessionId: s, clientId: 'client-b', ttlSeconds: 30 }),
        'the loser learns the winner so the SDK can surface a 409 with the holder',
      ).toEqual({ acquired: false, winnerClientId: 'client-a' });
    });

    it('CRITICAL releasing is a NO-OP when another client holds the lock', async () => {
      if (!reachable) return;
      // The whole point of the CAS-DEL. A plain DEL here would let any client
      // free the holder's pair-mode session, and a third party could take it
      // over. Only the real Lua evaluator can show the script does this.
      const s = sessionId();
      const l = lock();
      await l.tryAcquire({ sessionId: s, clientId: 'holder', ttlSeconds: 30 });
      await l.release({ sessionId: s, clientId: 'not-the-holder' });
      expect(
        await l.tryAcquire({ sessionId: s, clientId: 'opportunist', ttlSeconds: 30 }),
        'the lock is still held by the original client',
      ).toEqual({ acquired: false, winnerClientId: 'holder' });
    });

    it('CRITICAL the holder can release, and the next client then acquires', async () => {
      if (!reachable) return;
      const s = sessionId();
      const l = lock();
      await l.tryAcquire({ sessionId: s, clientId: 'holder', ttlSeconds: 30 });
      await l.release({ sessionId: s, clientId: 'holder' });
      expect(
        (await l.tryAcquire({ sessionId: s, clientId: 'next', ttlSeconds: 30 })).acquired,
        'a released lock is genuinely free',
      ).toBe(true);
    });

    it('releasing an absent lock is harmless', async () => {
      if (!reachable) return;
      const s = sessionId();
      await expect(lock().release({ sessionId: s, clientId: 'nobody' })).resolves.toBeUndefined();
    });

    it('CRITICAL the lock carries a TTL, so a crashed holder cannot wedge the session forever', async () => {
      if (!reachable || !redis) return;
      const s = sessionId();
      await lock().tryAcquire({ sessionId: s, clientId: 'holder', ttlSeconds: 30 });
      const ttl = await redis.ttl(`pair_lock:${s}`);
      expect(ttl, 'a lock with no expiry is a permanently wedged session').toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });
  },
);
