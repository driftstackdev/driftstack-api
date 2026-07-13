// V-553.B-24 — unit tests for InMemoryMfaChallengeStore + helpers (V-353d).
//
// Surface under test:
//   - generateChallengeToken: url-safe + sufficient length (>=40 chars)
//     for the 5-minute TTL window
//   - redisKey: namespaced SHA-256 identifier; plaintext never enters keyspace
//   - InMemoryMfaChallengeStore.set + peek: read without consuming
//   - InMemoryMfaChallengeStore.consume: one-shot semantics — returns
//     the value once, null on second call; null on missing key; null on
//     TTL-expired key
//   - Overwrite: idempotent set replaces prior value

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateChallengeToken,
  InMemoryMfaChallengeStore,
  MFA_CHALLENGE_TTL_SECONDS,
  redisKey,
} from '../../src/services/mfa-challenge-store.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('V-553.B-24 generateChallengeToken', () => {
  it('returns url-safe base64 of >=40 chars', () => {
    const t = generateChallengeToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('generates a fresh token each call (collision unlikely)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i += 1) seen.add(generateChallengeToken());
    expect(seen.size).toBe(32);
  });
});

describe('V-553.B-24 redisKey', () => {
  it('prefixes a fixed-length digest and excludes the plaintext token', () => {
    const key = redisKey('abc');
    expect(key).toMatch(/^mfa-challenge:[0-9a-f]{64}$/);
    expect(key).not.toContain('abc');
  });
});

describe('V-553.B-24 InMemoryMfaChallengeStore.set + peek', () => {
  it('returns null on a missing key', async () => {
    const store = new InMemoryMfaChallengeStore();
    expect(await store.peek('nope')).toBeNull();
  });

  it('returns the value after set, without consuming it', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'v', 60);
    expect(await store.peek('k')).toBe('v');
    expect(await store.peek('k')).toBe('v'); // still there
  });

  it('overwrites a prior value (idempotent set)', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'old', 60);
    await store.set('k', 'new', 60);
    expect(await store.peek('k')).toBe('new');
  });

  it('peek returns null + lazily evicts after TTL elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T10:00:00Z'));
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'v', 60); // 60s TTL
    vi.setSystemTime(new Date('2026-05-11T10:02:00Z')); // 2min later
    expect(await store.peek('k')).toBeNull();
    // confirm internal eviction — a second peek is also null
    expect(await store.peek('k')).toBeNull();
  });
});

describe('V-553.B-24 InMemoryMfaChallengeStore.consume', () => {
  it('returns null on a missing key', async () => {
    const store = new InMemoryMfaChallengeStore();
    expect(await store.consume('nope')).toBeNull();
  });

  it('returns the value the first time, then null (one-shot)', async () => {
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'v', 60);
    expect(await store.consume('k')).toBe('v');
    expect(await store.consume('k')).toBeNull();
  });

  it('returns null when consumed after TTL expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T10:00:00Z'));
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'v', 60);
    vi.setSystemTime(new Date('2026-05-11T10:02:00Z'));
    expect(await store.consume('k')).toBeNull();
  });

  it('consume removes the entry even if it was expired (defensive sweep)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T10:00:00Z'));
    const store = new InMemoryMfaChallengeStore();
    await store.set('k', 'v', 60);
    vi.setSystemTime(new Date('2026-05-11T10:02:00Z'));
    await store.consume('k'); // null + delete
    // peek confirms it's gone
    expect(await store.peek('k')).toBeNull();
  });
});

describe('V-553.B-24 MFA_CHALLENGE_TTL_SECONDS', () => {
  it('is 5 minutes (matches the V-353d contract)', () => {
    expect(MFA_CHALLENGE_TTL_SECONDS).toBe(300);
  });
});
