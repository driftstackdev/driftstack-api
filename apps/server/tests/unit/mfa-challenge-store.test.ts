// V-553.B-4 — unit tests for the V-353d MFA challenge token store.
//
// Coverage focused on the in-memory implementation + the freestanding
// helpers (generateChallengeToken, redisKey, TTL constant). Production
// uses Redis GETDEL semantics which integration tests at the route
// level already exercise; this unit suite pins the contract that any
// store implementation must satisfy.

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  InMemoryMfaChallengeStore,
  MFA_CHALLENGE_TTL_SECONDS,
  RedisMfaChallengeStore,
  generateChallengeToken,
  redisKey,
} from '../../src/services/mfa-challenge-store.js';

describe('V-353d.A RedisMfaChallengeStore — atomic attempt reservation TTL', () => {
  it('increments and attaches or repairs TTL in one Lua command', async () => {
    const evalFn = vi.fn().mockResolvedValue(3);
    const store = new RedisMfaChallengeStore({ eval: evalFn } as unknown as Redis);

    await expect(store.incrAttempts('attempt-key', 300)).resolves.toBe(3);
    expect(evalFn).toHaveBeenCalledOnce();

    const [script, numberOfKeys, key, ttl] = evalFn.mock.calls[0] ?? [];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('TTL', KEYS[1])");
    expect(script).toContain("if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end");
    expect(script).toContain('return count');
    expect(numberOfKeys).toBe(1);
    expect(key).toBe('attempt-key');
    expect(ttl).toBe('300');
  });
});

describe('V-553.B-4 generateChallengeToken', () => {
  it('returns a base64url string of ≥40 chars (≥256 bits)', () => {
    const t = generateChallengeToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it('generates distinct values on every call', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i += 1) tokens.add(generateChallengeToken());
    expect(tokens.size).toBe(100);
  });
});

describe('V-553.B-4 redisKey', () => {
  it('uses a deterministic fixed-length digest without exposing the bearer', () => {
    const key = redisKey('abc123');
    expect(key).toMatch(/^mfa-challenge:[0-9a-f]{64}$/);
    expect(key).not.toContain('abc123');
    expect(redisKey('abc123')).toBe(key);
    expect(redisKey('different')).not.toBe(key);
  });
});

describe('V-553.B-4 MFA_CHALLENGE_TTL_SECONDS', () => {
  it('is 5 minutes', () => {
    expect(MFA_CHALLENGE_TTL_SECONDS).toBe(5 * 60);
  });
});

describe('V-553.B-4 InMemoryMfaChallengeStore — set + consume one-shot', () => {
  it('set then consume returns the stored value once; second consume returns null', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k1', 'payload-1', 60);
    expect(await store.consume('k1')).toBe('payload-1');
    expect(await store.consume('k1')).toBeNull();
  });

  it('consume on a never-set key returns null', async () => {
    const store = new InMemoryMfaChallengeStore();
    expect(await store.consume('never-existed')).toBeNull();
  });

  it('overwrites the value when set is called twice on the same key', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'first', 60);
    await store.set('k', 'second', 60);
    expect(await store.consume('k')).toBe('second');
  });
});

describe('V-553.B-4 InMemoryMfaChallengeStore — peek vs consume', () => {
  it('peek returns the value without removing it; subsequent consume still works', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'payload', 60);
    expect(await store.peek('k')).toBe('payload');
    expect(await store.peek('k')).toBe('payload'); // still present
    expect(await store.consume('k')).toBe('payload');
    expect(await store.peek('k')).toBeNull(); // gone now
  });
});

describe('V-553.B-4 InMemoryMfaChallengeStore — TTL eviction', () => {
  it('peek returns null after the TTL window elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
    try {
      const store = new InMemoryMfaChallengeStore();
      await store.set('k', 'payload', 60);
      vi.setSystemTime(new Date('2026-05-11T12:01:01Z'));
      expect(await store.peek('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('consume after TTL returns null + clears the entry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
    try {
      const store = new InMemoryMfaChallengeStore();
      await store.set('k', 'payload', 60);
      vi.setSystemTime(new Date('2026-05-11T12:01:01Z'));
      expect(await store.consume('k')).toBeNull();
      // Entry is cleared — peek confirms.
      expect(await store.peek('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('V-353d.A InMemoryMfaChallengeStore — incrAttempts (brute-force cap counter)', () => {
  it('returns 1 on first increment, then counts up per key', async () => {
    const store = new InMemoryMfaChallengeStore();
    expect(await store.incrAttempts('a', 60)).toBe(1);
    expect(await store.incrAttempts('a', 60)).toBe(2);
    expect(await store.incrAttempts('a', 60)).toBe(3);
  });

  it('counts each key independently', async () => {
    const store = new InMemoryMfaChallengeStore();
    expect(await store.incrAttempts('a', 60)).toBe(1);
    expect(await store.incrAttempts('b', 60)).toBe(1);
    expect(await store.incrAttempts('a', 60)).toBe(2);
  });

  it('release removes only the caller reservation and deletes a zero counter', async () => {
    const store = new InMemoryMfaChallengeStore();
    expect(await store.incrAttempts('a', 60)).toBe(1);
    expect(await store.incrAttempts('a', 60)).toBe(2);
    expect(await store.incrAttempts('a', 60)).toBe(3);
    await store.releaseAttempt('a');
    expect(await store.incrAttempts('a', 60)).toBe(3);

    const single = new InMemoryMfaChallengeStore();
    expect(await single.incrAttempts('a', 60)).toBe(1);
    await single.releaseAttempt('a');
    expect(await single.incrAttempts('a', 60)).toBe(1);
  });

  it('resets to 1 after the TTL window elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
    try {
      const store = new InMemoryMfaChallengeStore();
      expect(await store.incrAttempts('a', 60)).toBe(1);
      expect(await store.incrAttempts('a', 60)).toBe(2);
      vi.setSystemTime(new Date('2026-05-11T12:01:01Z')); // past the 60s TTL
      expect(await store.incrAttempts('a', 60)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('release after expiry does not resurrect a negative counter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
    try {
      const store = new InMemoryMfaChallengeStore();
      expect(await store.incrAttempts('a', 60)).toBe(1);
      vi.setSystemTime(new Date('2026-05-11T12:01:01Z'));
      await store.releaseAttempt('a');
      expect(await store.incrAttempts('a', 60)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
