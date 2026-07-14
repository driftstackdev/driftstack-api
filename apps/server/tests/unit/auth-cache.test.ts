// AuthCache algorithm tests against the in-memory implementation.

import { describe, expect, it } from 'vitest';
import { InMemoryAuthCache, sha256Hex } from '../../src/services/auth-cache.js';
import type { AccountContext } from '../../src/services/auth.js';

const CTX: AccountContext = {
  account: {
    id: 'acc-1',
    email: 'a@x.test',
    name: null,
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  apiKey: {
    id: 'key-1',
    accountId: 'acc-1',
    name: 'default',
    keyPrefix: 'ds_live_aaaaaaaa',
    keyHash: 'hash',
    scopes: ['read', 'write', 'admin'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  rateLimitOverrides: {},
  teams: [],
  webSession: null,
};

const SHA = sha256Hex('ds_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

describe('sha256Hex', () => {
  it('produces a 64-char hex digest', () => {
    expect(SHA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    expect(sha256Hex('same-input')).toBe(sha256Hex('same-input'));
  });

  it('differs across distinct inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('InMemoryAuthCache', () => {
  it('miss when nothing cached', async () => {
    const cache = new InMemoryAuthCache();
    expect(await cache.get(SHA)).toBeNull();
  });

  it('hit after set, returns the same context', async () => {
    const cache = new InMemoryAuthCache();
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30);
    const got = await cache.get(SHA);
    expect(got).not.toBeNull();
    expect(got?.account.id).toBe('acc-1');
    expect(got?.apiKey.scopes).toEqual(['read', 'write', 'admin']);
  });

  it('expires entries past their TTL', async () => {
    const cache = new InMemoryAuthCache();
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 0);
    // TTL of 0 means expiresAt = now; await a tick.
    await new Promise((r) => setTimeout(r, 1));
    expect(await cache.get(SHA)).toBeNull();
  });

  it('invalidateKey removes the cached entry', async () => {
    const cache = new InMemoryAuthCache();
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30);
    await cache.invalidateKey(CTX.apiKey.id);
    expect(await cache.get(SHA)).toBeNull();
  });

  it('invalidateAccount makes future reads miss', async () => {
    const cache = new InMemoryAuthCache();
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30);
    expect(await cache.get(SHA)).not.toBeNull();

    await cache.invalidateAccount(CTX.account.id);
    expect(await cache.get(SHA)).toBeNull();
  });

  it('keeps a late write stale when it carries a pre-invalidation account generation', async () => {
    const cache = new InMemoryAuthCache();
    const captured = await cache.captureVersions(CTX.account.id, CTX.apiKey.id);
    await cache.invalidateAccount(CTX.account.id);
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30, captured);

    expect(cache.size()).toBe(1);
    expect(await cache.get(SHA)).toBeNull();
  });

  it('invalidateAccount affects only the specified account', async () => {
    const cache = new InMemoryAuthCache();
    const otherSha = sha256Hex('ds_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const otherCtx: AccountContext = {
      ...CTX,
      account: { ...CTX.account, id: 'acc-2' },
      apiKey: { ...CTX.apiKey, id: 'key-2', accountId: 'acc-2' },
    };

    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30);
    await cache.set(otherSha, otherCtx.apiKey.id, otherCtx.account.id, otherCtx, 30);

    await cache.invalidateAccount('acc-1');

    expect(await cache.get(SHA)).toBeNull();
    expect(await cache.get(otherSha)).not.toBeNull();
  });

  it('size reflects current entries', async () => {
    const cache = new InMemoryAuthCache();
    expect(cache.size()).toBe(0);
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30);
    expect(cache.size()).toBe(1);
    await cache.invalidateKey(CTX.apiKey.id);
    expect(cache.size()).toBe(0);
  });

  it('keeps a late write stale when it carries a pre-revocation key generation', async () => {
    const cache = new InMemoryAuthCache();
    const captured = await cache.captureVersions(CTX.account.id, CTX.apiKey.id);
    await cache.invalidateKey(CTX.apiKey.id);
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30, captured);

    expect(cache.size()).toBe(1);
    expect(await cache.get(SHA)).toBeNull();
  });

  it('per-key invalidation does not affect other keys on the same account', async () => {
    // Defense-in-depth: invalidating key A does not bump key B's version.
    const cache = new InMemoryAuthCache();
    const ctxB: AccountContext = {
      ...CTX,
      apiKey: { ...CTX.apiKey, id: 'key-2', keyPrefix: 'ds_live_bbbbbbbb' },
    };
    const shaB = sha256Hex('ds_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await cache.set(SHA, CTX.apiKey.id, CTX.account.id, CTX, 30);
    await cache.set(shaB, ctxB.apiKey.id, ctxB.account.id, ctxB, 30);
    await cache.invalidateKey(CTX.apiKey.id); // revoke key-1
    expect(await cache.get(SHA)).toBeNull();
    expect(await cache.get(shaB)).not.toBeNull(); // key-2 still valid
  });
});
