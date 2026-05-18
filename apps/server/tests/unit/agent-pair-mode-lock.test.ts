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

  // Arc 4 Wave 2.A sub-slice 8.14 (v2-#8) — race-condition pin.
  // Two near-simultaneous tryAcquire calls on the same sessionId
  // resolve deterministically: exactly one wins; the loser sees the
  // winner's clientId. Both InMemory and Redis paths.
  it('v2-#8 sub-slice 8.14 race — parallel acquire from two distinct clients: exactly one wins, loser sees the winner', async () => {
    const lock = new InMemoryPairModeTakeoverLock();
    const [a, b] = await Promise.all([
      lock.tryAcquire({ sessionId: 'agt_race', clientId: 'cli_a' }),
      lock.tryAcquire({ sessionId: 'agt_race', clientId: 'cli_b' }),
    ]);
    const acquired = [a, b].filter((r) => r.acquired);
    const denied = [a, b].filter((r) => !r.acquired);
    expect(acquired).toHaveLength(1);
    expect(denied).toHaveLength(1);
    const winnerId = acquired[0]!.winnerClientId;
    expect(denied[0]!.winnerClientId).toBe(winnerId);
    expect(['cli_a', 'cli_b']).toContain(winnerId);
  });

  it('v2-#8 sub-slice 8.14 race — three-way contention: exactly one acquired, two denied, all denials report the same winner', async () => {
    const lock = new InMemoryPairModeTakeoverLock();
    const results = await Promise.all([
      lock.tryAcquire({ sessionId: 'agt_three', clientId: 'cli_a' }),
      lock.tryAcquire({ sessionId: 'agt_three', clientId: 'cli_b' }),
      lock.tryAcquire({ sessionId: 'agt_three', clientId: 'cli_c' }),
    ]);
    const acquired = results.filter((r) => r.acquired);
    const denied = results.filter((r) => !r.acquired);
    expect(acquired).toHaveLength(1);
    expect(denied).toHaveLength(2);
    const winnerId = acquired[0]!.winnerClientId;
    for (const r of denied) {
      expect(r.winnerClientId).toBe(winnerId);
    }
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
      async eval(script, _numKeys, ...args) {
        await Promise.resolve();
        // Tiny interpreter just for the release CAS-DEL script. The
        // real Redis Lua evaluator is opaque; we only need to model
        // the one script the service actually issues.
        const RELEASE_SCRIPT =
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
        if (script === RELEASE_SCRIPT) {
          const key = args[0]!;
          const value = args[1]!;
          if (store.get(key) === value) {
            store.delete(key);
            return 1;
          }
          return 0;
        }
        throw new Error(`unsupported test script: ${script}`);
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

  it('release deletes the key only when the calling clientId matches the stored value (atomic CAS-DEL via Lua)', async () => {
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

  // Arc 4 Wave 2.B sub-slice 8.20.j (v2-#8) — atomic-release race
  // regression pin. The original GET-then-DEL release had a window
  // where another client could acquire the lock between the GET and
  // the DEL — the original holder's stale DEL would then erase the
  // new holder's lock, leaving the session unlocked + the new holder
  // surprised that their lock evaporated. The Lua CAS-DEL collapses
  // GET+DEL into one Redis op so the race window closes.
  it('v2-#8 sub-slice 8.20.j atomic release — interleaved acquire-while-releasing does NOT erase the new holder', async () => {
    const { redis, store } = makeFakeRedis();
    const lock = new RedisPairModeTakeoverLock(redis);
    await lock.tryAcquire({ sessionId: 'agt_race', clientId: 'cli_a' });
    // Simulate the race: between the original GET and DEL we'd have
    // had a window. Since release is now atomic, we can hammer it
    // from a stale holder and the live holder's lock survives.
    await lock.release({ sessionId: 'agt_race', clientId: 'cli_a' });
    // cli_a is now released; cli_b acquires.
    const b = await lock.tryAcquire({ sessionId: 'agt_race', clientId: 'cli_b' });
    expect(b).toEqual({ acquired: true, winnerClientId: 'cli_b' });
    // cli_a tries to release again (e.g. its handler's finally{}
    // block fires after re-entry). Without the atomic CAS this would
    // delete cli_b's lock too. With Lua CAS-DEL the equality fails
    // and cli_b's lock survives.
    await lock.release({ sessionId: 'agt_race', clientId: 'cli_a' });
    expect(store.get('pair_lock:agt_race')).toBe('cli_b');
  });
});
