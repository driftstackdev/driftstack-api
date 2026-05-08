// AuthCoalescer unit tests. Verifies single-flight semantics, settlement
// cleanup (both fulfil and reject), per-sha isolation, and the stats
// counters used for telemetry.

import { describe, expect, it, vi } from 'vitest';
import { AuthCoalescer } from '../../src/services/auth-coalescer.js';
import type { AccountContext } from '../../src/services/auth.js';

function fakeContext(accountId: string): AccountContext {
  return {
    account: {
      id: accountId,
      email: `${accountId}@x.test`,
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    apiKey: {
      id: `${accountId}-key`,
      accountId,
      name: 'k',
      keyPrefix: 'ds_test_pref',
      keyHash: 'hash',
      scopes: ['read'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    rateLimitOverrides: {},
    teams: [],
  };
}

/** Creates a slow-path that resolves only when `release()` is called. */
function deferred(): {
  load: () => Promise<AccountContext>;
  release: (ctx: AccountContext) => void;
  reject: (err: Error) => void;
  callCount: () => number;
} {
  let resolve: (ctx: AccountContext) => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<AccountContext>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return promise;
    },
    release: (ctx) => resolve(ctx),
    reject: (err) => reject(err),
    callCount: () => calls,
  };
}

describe('AuthCoalescer.coalesce', () => {
  it('runs the slow path once for N concurrent calls with the same sha', async () => {
    const coalescer = new AuthCoalescer();
    const d = deferred();
    const ctx = fakeContext('acc-1');

    const calls = Array.from({ length: 16 }, () => coalescer.coalesce('sha-A', d.load));
    // All 16 are awaiting; the slow path was kicked off once.
    expect(d.callCount()).toBe(1);

    d.release(ctx);
    const results = await Promise.all(calls);
    expect(results).toHaveLength(16);
    for (const r of results) expect(r).toBe(ctx);

    const s = coalescer.stats();
    expect(s.starts).toBe(1);
    expect(s.hits).toBe(15);
    expect(s.inFlight).toBe(0);
  });

  it('different shas do not coalesce — each runs its own slow path', async () => {
    const coalescer = new AuthCoalescer();
    const a = deferred();
    const b = deferred();
    const ctxA = fakeContext('acc-A');
    const ctxB = fakeContext('acc-B');

    const pA = coalescer.coalesce('sha-A', a.load);
    const pB = coalescer.coalesce('sha-B', b.load);

    expect(a.callCount()).toBe(1);
    expect(b.callCount()).toBe(1);
    expect(coalescer.stats().inFlight).toBe(2);

    a.release(ctxA);
    b.release(ctxB);

    expect(await pA).toBe(ctxA);
    expect(await pB).toBe(ctxB);
    expect(coalescer.stats().inFlight).toBe(0);
  });

  it('a sequential second call after the first resolves runs a new slow path', async () => {
    const coalescer = new AuthCoalescer();
    const ctx = fakeContext('acc-1');
    const slow = vi.fn(() => Promise.resolve(ctx));

    await coalescer.coalesce('sha-A', slow);
    await coalescer.coalesce('sha-A', slow);

    expect(slow).toHaveBeenCalledTimes(2);
    expect(coalescer.stats().starts).toBe(2);
    expect(coalescer.stats().hits).toBe(0);
  });

  it('a rejected slow path does not poison subsequent calls for the same sha', async () => {
    const coalescer = new AuthCoalescer();
    const d1 = deferred();
    const ctx = fakeContext('acc-1');

    const failing = coalescer.coalesce('sha-A', d1.load);
    d1.reject(new Error('scrypt blew up'));
    await expect(failing).rejects.toThrow('scrypt blew up');

    // Map should be empty now — the rejected promise was cleaned up via .finally().
    expect(coalescer.stats().inFlight).toBe(0);

    // A new call for the same sha should run a fresh slow path, not return
    // the rejected promise.
    const slow = vi.fn(() => Promise.resolve(ctx));
    const result = await coalescer.coalesce('sha-A', slow);
    expect(result).toBe(ctx);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('rejection propagates to all coalesced waiters, then the slot clears', async () => {
    const coalescer = new AuthCoalescer();
    const d = deferred();

    const calls = Array.from({ length: 5 }, () => coalescer.coalesce('sha-A', d.load));
    d.reject(new Error('upstream down'));

    for (const p of calls) {
      await expect(p).rejects.toThrow('upstream down');
    }
    expect(coalescer.stats().inFlight).toBe(0);
  });

  it('inFlight counter snapshots are accurate during execution', async () => {
    const coalescer = new AuthCoalescer();
    const a = deferred();
    const b = deferred();
    const ctxA = fakeContext('acc-A');
    const ctxB = fakeContext('acc-B');

    const pA = coalescer.coalesce('sha-A', a.load);
    expect(coalescer.stats().inFlight).toBe(1);
    const pB = coalescer.coalesce('sha-B', b.load);
    expect(coalescer.stats().inFlight).toBe(2);

    a.release(ctxA);
    await pA;
    expect(coalescer.stats().inFlight).toBe(1);

    b.release(ctxB);
    await pB;
    expect(coalescer.stats().inFlight).toBe(0);
  });
});
