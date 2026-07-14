// V-553.B-8 — unit tests for RateLimitOverridesService (V-097).
//
// Surface under test:
//   - set(): exact staff scope guard ('driftstack_internal_admin'), input validation (capacity,
//     refill range, expiresAt-in-future), pass-through to repo,
//     cache invalidation on success
//   - clear(): exact staff scope guard, 404 when no row, cache invalidation
//   - listAll(): exact staff scope guard ('driftstack_internal_admin'),
//     repo pass-through

import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import {
  RateLimitOverridesService,
  type RateLimitOverrideRecord,
  type RateLimitOverridesRepo,
  type SetOverrideInput,
} from '../../src/services/rate-limit-overrides.js';
import type { AccountContext } from '../../src/services/auth.js';
import type { AuthCache } from '../../src/services/auth-cache.js';

function ctxWithScopes(scopes: ApiKeyScope[], apiKeyId = 'key_admin'): AccountContext {
  return {
    account: { id: 'acc_admin' },
    apiKey: { id: apiKeyId, scopes },
  } as unknown as AccountContext;
}

function makeRecord(input: SetOverrideInput): RateLimitOverrideRecord {
  const now = new Date();
  return {
    id: `rlo_${input.accountId}_${input.bucketKey}`,
    accountId: input.accountId,
    bucketKey: input.bucketKey,
    capacity: input.capacity,
    refillPerSecond: input.refillPerSecond,
    reason: input.reason ?? null,
    expiresAt: input.expiresAt,
    setByKeyId: input.setByKeyId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRepo(): {
  repo: RateLimitOverridesRepo;
  upsertSpy: ReturnType<typeof vi.fn>;
  clearSpy: ReturnType<typeof vi.fn>;
  listAllSpy: ReturnType<typeof vi.fn>;
  rows: RateLimitOverrideRecord[];
  clearWillReturn: (v: boolean) => void;
  listAllWillReturn: (items: RateLimitOverrideRecord[], nextCursor: string | null) => void;
} {
  const rows: RateLimitOverrideRecord[] = [];
  let clearReturn = true;
  let listAllReturn: { items: RateLimitOverrideRecord[]; nextCursor: string | null } = {
    items: [],
    nextCursor: null,
  };
  const upsertSpy = vi.fn((input: SetOverrideInput) => {
    const rec = makeRecord(input);
    rows.push(rec);
    return Promise.resolve(rec);
  });
  const clearSpy = vi.fn(() => Promise.resolve(clearReturn));
  const listAllSpy = vi.fn(() => Promise.resolve(listAllReturn));
  return {
    repo: { upsert: upsertSpy, clear: clearSpy, listAll: listAllSpy },
    upsertSpy,
    clearSpy,
    listAllSpy,
    rows,
    clearWillReturn: (v: boolean) => {
      clearReturn = v;
    },
    listAllWillReturn: (items: RateLimitOverrideRecord[], nextCursor: string | null) => {
      listAllReturn = { items, nextCursor };
    },
  };
}

function makeCache(): { cache: AuthCache; invalidateSpy: ReturnType<typeof vi.fn> } {
  const invalidateSpy = vi.fn(() => Promise.resolve());
  const cache = { invalidateAccount: invalidateSpy } as unknown as AuthCache;
  return { cache, invalidateSpy };
}

const FUTURE_DATE = new Date(Date.now() + 60 * 60 * 1000); // +1h
const PAST_DATE = new Date(Date.now() - 60 * 60 * 1000); // -1h

describe('V-553.B-8 RateLimitOverridesService.set — scope + validation', () => {
  it('requires exact internal staff scope; customer read and legacy admin are denied', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    const input = {
      accountId: 'acc_b',
      bucketKey: 'global',
      capacity: 10,
      refillPerSecond: 1,
      expiresAt: FUTURE_DATE,
    };
    for (const scopes of [['read'], ['admin']] satisfies ApiKeyScope[][]) {
      await expect(svc.set(ctxWithScopes(scopes), input)).rejects.toThrow(
        /driftstack_internal_admin/,
      );
    }
  });

  it('rejects capacity < 1', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 0,
        refillPerSecond: 1,
        expiresAt: FUTURE_DATE,
      }),
    ).rejects.toThrow(/capacity/);
  });

  it('rejects refill below the centi-quantum floor', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 10,
        refillPerSecond: 0.001,
        expiresAt: FUTURE_DATE,
      }),
    ).rejects.toThrow(/refill_per_second/);
  });

  it('rejects refill above the 100_000/s sanity cap', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 10,
        refillPerSecond: 200_000,
        expiresAt: FUTURE_DATE,
      }),
    ).rejects.toThrow(/refill_per_second/);
  });

  it('rejects NaN refill before repository mutation', async () => {
    const { repo, upsertSpy } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 10,
        refillPerSecond: Number.NaN,
        expiresAt: FUTURE_DATE,
      }),
    ).rejects.toThrow(/refill_per_second/);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects expiresAt in the past', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 10,
        refillPerSecond: 1,
        expiresAt: PAST_DATE,
      }),
    ).rejects.toThrow(/expires_at/);
  });

  it('rejects an invalid expiresAt before repository mutation', async () => {
    const { repo, upsertSpy } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 10,
        refillPerSecond: 1,
        expiresAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow(/expires_at/);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe('V-553.B-8 RateLimitOverridesService.set — happy path', () => {
  it('floors capacity, forwards refill verbatim, stamps setByKeyId, invalidates cache', async () => {
    const { repo, upsertSpy } = makeRepo();
    const { cache, invalidateSpy } = makeCache();
    const svc = new RateLimitOverridesService(repo, cache);
    const result = await svc.set(ctxWithScopes(['driftstack_internal_admin'], 'key_admin_1'), {
      accountId: 'acc_b',
      bucketKey: 'global',
      capacity: 25.7,
      refillPerSecond: 0.5,
      expiresAt: FUTURE_DATE,
      reason: 'paid-customer-burst',
    });
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const upsertArg = upsertSpy.mock.calls[0]?.[0] as SetOverrideInput | undefined;
    expect(upsertArg?.capacity).toBe(25);
    expect(upsertArg?.refillPerSecond).toBe(0.5);
    expect(upsertArg?.reason).toBe('paid-customer-burst');
    expect(upsertArg?.setByKeyId).toBe('key_admin_1');
    expect(invalidateSpy).toHaveBeenCalledWith('acc_b');
    expect(result.bucketKey).toBe('global');
  });

  it('omits reason from repo input when caller did not supply it', async () => {
    const { repo, upsertSpy } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await svc.set(ctxWithScopes(['driftstack_internal_admin']), {
      accountId: 'acc_b',
      bucketKey: 'global',
      capacity: 5,
      refillPerSecond: 1,
      expiresAt: FUTURE_DATE,
    });
    const upsertArg = upsertSpy.mock.calls[0]?.[0] as SetOverrideInput | undefined;
    expect('reason' in (upsertArg ?? {})).toBe(false);
  });

  it('swallows cache-invalidation errors — authorized staff write still succeeds', async () => {
    const { repo } = makeRepo();
    const invalidateSpy = vi.fn(() => Promise.reject(new Error('cache down')));
    const cache = { invalidateAccount: invalidateSpy } as unknown as AuthCache;
    const svc = new RateLimitOverridesService(repo, cache);
    await expect(
      svc.set(ctxWithScopes(['driftstack_internal_admin']), {
        accountId: 'acc_b',
        bucketKey: 'global',
        capacity: 5,
        refillPerSecond: 1,
        expiresAt: FUTURE_DATE,
      }),
    ).resolves.toBeDefined();
  });
});

describe('V-553.B-8 RateLimitOverridesService.clear', () => {
  it('requires exact internal staff scope; customer read and legacy admin are denied', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    for (const scopes of [['read'], ['admin']] satisfies ApiKeyScope[][]) {
      await expect(svc.clear(ctxWithScopes(scopes), 'acc_b', 'global')).rejects.toThrow(
        /driftstack_internal_admin/,
      );
    }
  });

  it('throws NotFound when no row was deleted', async () => {
    const { repo, clearWillReturn } = makeRepo();
    clearWillReturn(false);
    const svc = new RateLimitOverridesService(repo);
    await expect(
      svc.clear(ctxWithScopes(['driftstack_internal_admin']), 'acc_b', 'global'),
    ).rejects.toThrow(/No active override/);
  });

  it('invalidates the auth cache on successful delete', async () => {
    const { repo } = makeRepo();
    const { cache, invalidateSpy } = makeCache();
    const svc = new RateLimitOverridesService(repo, cache);
    await svc.clear(ctxWithScopes(['driftstack_internal_admin']), 'acc_b', 'global');
    expect(invalidateSpy).toHaveBeenCalledWith('acc_b');
  });
});

describe('V-553.B-8 RateLimitOverridesService.listAll', () => {
  it('requires the exact driftstack_internal_admin scope', async () => {
    const { repo } = makeRepo();
    const svc = new RateLimitOverridesService(repo);
    await expect(svc.listAll(ctxWithScopes(['account_owner']), { limit: 10 })).rejects.toThrow(
      /driftstack_internal_admin/,
    );
    await expect(svc.listAll(ctxWithScopes(['admin']), { limit: 10 })).rejects.toThrow(
      /driftstack_internal_admin/,
    );
  });

  it('passes the opts through to the repo and returns its result verbatim', async () => {
    const { repo, listAllSpy, listAllWillReturn } = makeRepo();
    const sample: RateLimitOverrideRecord = makeRecord({
      accountId: 'acc_b',
      bucketKey: 'global',
      capacity: 50,
      refillPerSecond: 5,
      expiresAt: FUTURE_DATE,
      setByKeyId: 'key_admin',
    });
    listAllWillReturn([sample], 'cursor_next');
    const svc = new RateLimitOverridesService(repo);
    const result = await svc.listAll(ctxWithScopes(['driftstack_internal_admin']), {
      limit: 25,
      accountId: 'acc_b',
      includeExpired: true,
    });
    expect(listAllSpy).toHaveBeenCalledWith({
      limit: 25,
      accountId: 'acc_b',
      includeExpired: true,
    });
    expect(result.items).toEqual([sample]);
    expect(result.nextCursor).toBe('cursor_next');
  });
});
