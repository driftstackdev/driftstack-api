// Arc 2 sub-slice 8.8 (v2-#8) — pair-mode takeover lock tests.

import { describe, expect, it } from 'vitest';
import {
  InMemoryPairModeTakeoverLock,
  RedisPairModeTakeoverLock,
  type RedisLikeClient,
} from '../../src/services/agent-pair-mode-lock.js';

describe('Arc 2 v2-#8 sub-slice 8.8 InMemoryPairModeTakeoverLock', () => {
  it('first acquire wins; second concurrent acquire reports the holder', async () => {
    const lock = new InMemoryPairModeTakeoverLock();
    const a = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_a' });
    expect(a).toEqual({ acquired: true, winnerClientId: 'cli_a' });
    const b = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_b' });
    expect(b).toEqual({ acquired: false, winnerClientId: 'cli_a' });
  });

  it('per-session isolation: holding a lock on agt_x does NOT block agt_y', async () => {
    const lock = new InMemoryPairModeTakeoverLock();
    await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_a' });
    const y = await lock.tryAcquire({ sessionId: 'agt_y', clientId: 'cli_b' });
    expect(y.acquired).toBe(true);
  });

  it('release: lock-holder can re-acquire after release; non-holder release is a no-op', async () => {
    const lock = new InMemoryPairModeTakeoverLock();
    await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_a' });
    // Non-holder release does nothing.
    await lock.release({ sessionId: 'agt_x', clientId: 'cli_b' });
    const b = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_b' });
    expect(b.acquired).toBe(false);
    // Holder release frees the slot.
    await lock.release({ sessionId: 'agt_x', clientId: 'cli_a' });
    const b2 = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_b' });
    expect(b2.acquired).toBe(true);
  });

  it('TTL expiry: a stale lock past its ttl is reclaimable', async () => {
    let now = new Date('2026-05-18T00:00:00Z');
    const lock = new InMemoryPairModeTakeoverLock(() => now);
    await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_a', ttlSeconds: 1 });
    // Advance past the TTL.
    now = new Date('2026-05-18T00:00:02Z');
    const b = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_b', ttlSeconds: 1 });
    expect(b).toEqual({ acquired: true, winnerClientId: 'cli_b' });
  });
});

describe('Arc 2 v2-#8 sub-slice 8.8 RedisPairModeTakeoverLock', () => {
  function makeFakeRedis(): {
    redis: RedisLikeClient;
    store: Map<string, string>;
  } {
    const store = new Map<string, string>();
    const redis: RedisLikeClient = {
      async set(key, value, nxFlag, _expiryFlag, _ttl) {
        await Promise.resolve();
        if (nxFlag === 'NX' && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      async get(key) {
        await Promise.resolve();
        return store.get(key) ?? null;
      },
      async del(key) {
        await Promise.resolve();
        return store.delete(key) ? 1 : 0;
      },
    };
    return { redis, store };
  }

  it('SET NX EX semantics: first wins → "OK"; second collides → null → reports holder via GET', async () => {
    const { redis, store } = makeFakeRedis();
    const lock = new RedisPairModeTakeoverLock(redis);
    const a = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_a' });
    expect(a).toEqual({ acquired: true, winnerClientId: 'cli_a' });
    expect(store.get('pair_lock:agt_x')).toBe('cli_a');
    const b = await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_b' });
    expect(b).toEqual({ acquired: false, winnerClientId: 'cli_a' });
  });

  it('release deletes the key only when the calling clientId matches the stored value (best-effort CAS)', async () => {
    const { redis, store } = makeFakeRedis();
    const lock = new RedisPairModeTakeoverLock(redis);
    await lock.tryAcquire({ sessionId: 'agt_x', clientId: 'cli_a' });
    // Non-holder release — store unchanged.
    await lock.release({ sessionId: 'agt_x', clientId: 'cli_b' });
    expect(store.get('pair_lock:agt_x')).toBe('cli_a');
    // Holder release — key gone.
    await lock.release({ sessionId: 'agt_x', clientId: 'cli_a' });
    expect(store.has('pair_lock:agt_x')).toBe(false);
  });
});
