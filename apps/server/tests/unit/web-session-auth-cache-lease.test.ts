import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidKeyError } from '../../src/lib/errors.js';
import {
  authenticate,
  type AccountAuthRepo,
  type AccountRow,
  type RateLimitOverride,
  type WebSessionAuthRow,
} from '../../src/services/auth.js';
import { InMemoryAuthCache, sha256Hex } from '../../src/services/auth-cache.js';

const PLAINTEXT = 'wsess_epoch_cache_aaaaaaaaaaaaaaaaaaaaaaaa';
const SHA = sha256Hex(PLAINTEXT);
const ACCOUNT: AccountRow = {
  id: 'acc_epoch_cache',
  email: 'epoch-cache@example.test',
  name: null,
  tier: 'api_builder',
  status: 'active',
  timezone: null,
  avatarR2Key: null,
  slug: null,
  region: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};
const SESSION: WebSessionAuthRow = {
  id: 'ws_epoch_cache',
  accountId: ACCOUNT.id,
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  revokedAt: null,
  lastUsedAt: null,
  mfaSatisfiedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function repoWith(overrides: Partial<AccountAuthRepo>): AccountAuthRepo {
  return {
    findApiKeyByPrefix: () => Promise.resolve(null),
    getAccount: () => Promise.resolve(ACCOUNT),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    findActiveWebSession: () => Promise.resolve(SESSION),
    touchWebSessionLastUsed: () => Promise.resolve(),
    findTeamMemberships: () => Promise.resolve([]),
    updateAccountBasics: () => Promise.resolve(null),
    setOnboardingCompleted: () => Promise.resolve(),
    getOnboardingCompletedAt: () => Promise.resolve(null),
    getOrganization: () => Promise.resolve(null),
    setOrganization: () => Promise.resolve(),
    ...overrides,
  };
}

describe('web-session positive-cache generation lease', () => {
  it('rechecks the session after capturing a generation that already reflects reset', async () => {
    const cache = new InMemoryAuthCache();
    let lookupCount = 0;
    const repo = repoWith({
      findActiveWebSession: async () => {
        lookupCount += 1;
        if (lookupCount === 1) {
          await cache.invalidateAccount(ACCOUNT.id);
          return SESSION;
        }
        return null;
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    expect(lookupCount).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('tags a cache write stale when reset invalidates after the authoritative recheck', async () => {
    const cache = new InMemoryAuthCache();
    let lookupCount = 0;
    const repo = repoWith({
      findActiveWebSession: () => {
        lookupCount += 1;
        return Promise.resolve(SESSION);
      },
      findTeamMemberships: async () => {
        await cache.invalidateAccount(ACCOUNT.id);
        return [];
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ webSession: { id: SESSION.id } });
    expect(lookupCount).toBe(2);
    expect(cache.size()).toBe(1);
    await expect(cache.get(SHA)).resolves.toBeNull();
  });

  it('rejects a cached predecessor when PostgreSQL authority changes without cache invalidation', async () => {
    const cache = new InMemoryAuthCache();
    let activeSession: WebSessionAuthRow | null = SESSION;
    let lookupCount = 0;
    const repo = repoWith({
      findActiveWebSession: () => {
        lookupCount += 1;
        return Promise.resolve(activeSession);
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ webSession: { id: SESSION.id } });
    expect(lookupCount).toBe(2);
    await expect(cache.get(SHA)).resolves.not.toBeNull();

    // Model an auth-epoch advance or revoke that commits in
    // PostgreSQL while Redis generation invalidation is lost. The physical
    // positive cache entry remains current, but it must no longer authorize.
    activeSession = null;
    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    expect(lookupCount).toBe(3);
    await expect(cache.get(SHA)).resolves.not.toBeNull();
  });

  it('refreshes MFA satisfaction from live session authority on every cache hit', async () => {
    const cache = new InMemoryAuthCache();
    let mfaSatisfiedAt: Date | null = null;
    let lookupCount = 0;
    const repo = repoWith({
      findActiveWebSession: () => {
        lookupCount += 1;
        return Promise.resolve({ ...SESSION, mfaSatisfiedAt });
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ webSession: { id: SESSION.id, mfaSatisfiedAt: null } });
    expect(lookupCount).toBe(2);

    mfaSatisfiedAt = new Date('2026-07-14T00:00:30.000Z');
    const refreshed = await authenticate(
      repo,
      PLAINTEXT,
      cache,
      new Date('2026-07-14T00:00:31.000Z'),
    );
    expect(refreshed.webSession?.mfaSatisfiedAt).toEqual(mfaSatisfiedAt);
    expect(refreshed.apiKey.expiresAt).toEqual(SESSION.expiresAt);
    expect(lookupCount).toBe(3);

    // The serialized cache still contains its original snapshot. Returning the
    // fresh timestamp therefore proves authenticate() used the live row.
    await expect(cache.get(SHA)).resolves.toMatchObject({
      webSession: { id: SESSION.id, mfaSatisfiedAt: null },
    });
  });

  it('rejects a cached web session when the live account is suspended without invalidation', async () => {
    const cache = new InMemoryAuthCache();
    let liveAccount = ACCOUNT;
    const repo = repoWith({
      getAccount: () => Promise.resolve(liveAccount),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    liveAccount = { ...ACCOUNT, status: 'suspended' };

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('drops a cached staff scope when the live account email leaves the allowlist', async () => {
    const cache = new InMemoryAuthCache();
    let liveAccount = ACCOUNT;
    const repo = repoWith({
      getAccount: () => Promise.resolve(liveAccount),
    });
    const staffEmails = new Set([ACCOUNT.email]);

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'), null, staffEmails),
    ).resolves.toMatchObject({
      apiKey: {
        scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
      },
    });

    liveAccount = { ...ACCOUNT, email: 'former-staff@example.test' };
    const refreshed = await authenticate(
      repo,
      PLAINTEXT,
      cache,
      new Date('2026-07-14T00:00:01.000Z'),
      null,
      staffEmails,
    );
    expect(refreshed.apiKey.scopes).toEqual(['read', 'write', 'account_owner']);
  });

  it('refreshes active rate-limit overrides on a positive web-session hit', async () => {
    const cache = new InMemoryAuthCache();
    let liveOverrides: RateLimitOverride[] = [
      {
        bucketKey: 'global',
        capacity: 9_999,
        refillPerSecond: 99,
        expiresAt: new Date('2026-07-15T00:00:00.000Z'),
      },
    ];
    const repo = repoWith({
      findActiveRateLimitOverrides: () => Promise.resolve(liveOverrides),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    liveOverrides = [{ ...liveOverrides[0]!, capacity: 7, refillPerSecond: 0.5 }];

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).resolves.toMatchObject({
      rateLimitOverrides: { global: { capacity: 7, refillPerSecond: 0.5 } },
    });
  });
});
