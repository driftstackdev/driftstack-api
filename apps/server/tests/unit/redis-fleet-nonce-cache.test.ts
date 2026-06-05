// Unit tests for RedisFleetNonceCache — the production replay-defense cache.
// Uses a fake ioredis `set` honoring NX+EX semantics, so we verify the
// check-and-record contract + NUL-key isolation + the TTL clamp without a real
// Redis (real-Redis behavior is the documented contract; the SET NX command is
// atomic by Redis guarantee).

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisFleetNonceCache } from '../../src/lib/redis-fleet-nonce-cache.js';

interface FakeRedis {
  redis: Redis;
  calls: Array<{ key: string; ttl: number }>;
}

/** Minimal fake honoring `SET key val EX ttl NX`: stores set keys; NX returns
 *  null when the key already exists, 'OK' otherwise. Expiry not simulated (the
 *  TTL is asserted via the recorded calls). */
function fakeRedis(): FakeRedis {
  const store = new Set<string>();
  const calls: Array<{ key: string; ttl: number }> = [];
  const set = vi.fn(
    (key: string, _val: string, ex: string, ttl: number, nx: string): Promise<string | null> => {
      expect(ex).toBe('EX');
      expect(nx).toBe('NX');
      calls.push({ key, ttl });
      if (store.has(key)) return Promise.resolve(null);
      store.add(key);
      return Promise.resolve('OK');
    },
  );
  return { redis: { set } as unknown as Redis, calls };
}

describe('RedisFleetNonceCache', () => {
  it('first sight of an (iss, nonce) → true (records); replay → false', async () => {
    const { redis } = fakeRedis();
    const cache = new RedisFleetNonceCache(redis);
    expect(await cache.checkAndRecord('node-a', 'nonce-1', 300)).toBe(true);
    expect(await cache.checkAndRecord('node-a', 'nonce-1', 300)).toBe(false); // replay
  });

  it('a different nonce from the same node is accepted', async () => {
    const { redis } = fakeRedis();
    const cache = new RedisFleetNonceCache(redis);
    expect(await cache.checkAndRecord('node-a', 'nonce-1', 300)).toBe(true);
    expect(await cache.checkAndRecord('node-a', 'nonce-2', 300)).toBe(true);
  });

  it('the same nonce from a different node is accepted (NUL-separated keys, no cross-node collision)', async () => {
    const { redis, calls } = fakeRedis();
    const cache = new RedisFleetNonceCache(redis);
    expect(await cache.checkAndRecord('node-a', 'shared', 300)).toBe(true);
    expect(await cache.checkAndRecord('node-b', 'shared', 300)).toBe(true);
    // Keys differ + carry the NUL separator + the prefix.
    expect(calls[0]!.key).toBe('fleet-nonce:node-a\x00shared');
    expect(calls[1]!.key).toBe('fleet-nonce:node-b\x00shared');
  });

  it('clamps the TTL to a positive integer (EX cannot be 0/negative/fractional)', async () => {
    const { redis, calls } = fakeRedis();
    const cache = new RedisFleetNonceCache(redis);
    await cache.checkAndRecord('n', 'x', 0);
    await cache.checkAndRecord('n', 'y', -5);
    await cache.checkAndRecord('n', 'z', 12.9);
    expect(calls.map((c) => c.ttl)).toEqual([1, 1, 12]);
  });
});
