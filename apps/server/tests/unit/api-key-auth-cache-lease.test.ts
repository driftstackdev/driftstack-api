import { describe, expect, it } from 'vitest';
import { hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  RevokedKeyError,
} from '../../src/lib/errors.js';
import {
  authenticate,
  resolveEffectiveAccount,
  type AccountAuthRepo,
  type AccountRow,
  type ApiKeyRow,
  type RateLimitOverride,
  type TeamMembership,
} from '../../src/services/auth.js';
import { InMemoryAuthCache, sha256Hex } from '../../src/services/auth-cache.js';
import type { AuthCache, AuthCacheVersions } from '../../src/services/auth-cache.js';
import type { AccountContext } from '../../src/services/auth.js';

const PLAINTEXT = 'ds_live_cache_lease_aaaaaaaaaaaaaaaaaaaaaaaa';
const SHA = sha256Hex(PLAINTEXT);
const ACCOUNT: AccountRow = {
  id: 'acc_key_cache_lease',
  email: 'key-cache-lease@example.test',
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

function repoWith(overrides: Partial<AccountAuthRepo>): AccountAuthRepo {
  return {
    findApiKeyByPrefix: () => Promise.resolve(null),
    getAccount: () => Promise.resolve(ACCOUNT),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    findActiveWebSession: () => Promise.resolve(null),
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

async function activeKey(): Promise<ApiKeyRow> {
  return {
    id: 'key_cache_lease',
    accountId: ACCOUNT.id,
    name: 'cache lease',
    keyPrefix: keyPrefixFromPlaintext(PLAINTEXT),
    keyHash: await hashApiKey(PLAINTEXT),
    scopes: ['read', 'write'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** Delegates everything except the WRITE, which rejects — a cache backend
 *  that is up for reads and failing on writes, the shape a real outage takes.
 *  `setCalls` exists so an arm can prove the write was actually attempted. */
class CacheWhoseWriteFails implements AuthCache {
  setCalls = 0;
  private readonly inner = new InMemoryAuthCache();
  get(plaintextSha256: string): Promise<AccountContext | null> {
    return this.inner.get(plaintextSha256);
  }
  captureVersions(accountId: string, keyId: string): Promise<AuthCacheVersions | null> {
    return this.inner.captureVersions(accountId, keyId);
  }
  set(): Promise<void> {
    this.setCalls += 1;
    return Promise.reject(new Error('auth cache backend unavailable'));
  }
  invalidateKey(keyId: string): Promise<void> {
    return this.inner.invalidateKey(keyId);
  }
  invalidateAccount(accountId: string): Promise<void> {
    return this.inner.invalidateAccount(accountId);
  }
}

describe('API-key positive-cache generation lease', () => {
  it('rechecks the key after capturing generations that already reflect revocation', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    const revokedAt = new Date('2026-07-14T00:00:00.000Z');
    let lookupCount = 0;
    const repo = repoWith({
      findApiKeyByPrefix: async () => {
        lookupCount += 1;
        if (lookupCount === 1) {
          await cache.invalidateKey(key.id);
          return key;
        }
        return { ...key, revokedAt };
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).rejects.toBeInstanceOf(RevokedKeyError);
    expect(lookupCount).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('tags a cache write stale when revocation invalidates after the authoritative recheck', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let lookupCount = 0;
    const repo = repoWith({
      findApiKeyByPrefix: () => {
        lookupCount += 1;
        return Promise.resolve(key);
      },
      findTeamMemberships: async () => {
        await cache.invalidateKey(key.id);
        return [];
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id } });
    expect(lookupCount).toBe(2);
    expect(cache.size()).toBe(1);
    await expect(cache.get(SHA)).resolves.toBeNull();
  });

  it('revalidates a positive API-key cache hit without repeating its slow path', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let lookupCount = 0;
    let accountLookupCount = 0;
    const repo = repoWith({
      findApiKeyByPrefix: () => {
        lookupCount += 1;
        return Promise.resolve(key);
      },
      getAccount: () => {
        accountLookupCount += 1;
        return Promise.resolve(ACCOUNT);
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id }, webSession: null });
    expect(lookupCount).toBe(2);
    expect(accountLookupCount).toBe(1);

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id }, webSession: null });
    expect(lookupCount).toBe(3);
    expect(accountLookupCount).toBe(2);
  });

  it('rejects a cached key revoked after population when invalidation is lost', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveKey = key;
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(liveKey),
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id } });
    await expect(cache.get(SHA)).resolves.not.toBeNull();

    liveKey = { ...key, revokedAt: new Date('2026-07-14T00:00:01.000Z') };
    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:02.000Z')),
    ).rejects.toBeInstanceOf(RevokedKeyError);
    await expect(cache.get(SHA)).resolves.not.toBeNull();
  });

  // Expiry is compared with `<=`, so a credential whose expiresAt IS the current
  // instant is already expired. That one-tick difference is a real one here: the
  // FAST path pins it (flipping the cached comparison to `<` reds an arm), while
  // these two authoritative re-checks did not — flipping either left all 1745
  // auth tests green. The asymmetry is the risk: a "simplification" to `<` on the
  // live side alone would make the same credential pass on a cache miss and fail
  // on a cache hit, at exactly the moment it expires.
  //
  // The re-checks are defensive by design — the production query already filters
  // expired rows — so reaching them needs a repo that does not, which is exactly
  // the custom implementation the source comment says they exist to keep honest.
  it('CRITICAL a live key whose expiry IS the current instant is already expired', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    const at = new Date('2026-07-14T00:00:02.000Z');
    let liveKey = key;
    const repo = repoWith({ findApiKeyByPrefix: () => Promise.resolve(liveKey) });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id } });

    liveKey = { ...key, expiresAt: at };
    await expect(authenticate(repo, PLAINTEXT, cache, at)).rejects.toBeInstanceOf(ExpiredKeyError);

    // …and one millisecond earlier it is still valid, so this is a boundary and
    // not a blanket rejection of anything carrying an expiry.
    liveKey = { ...key, expiresAt: new Date(at.getTime() + 1) };
    await expect(authenticate(repo, PLAINTEXT, cache, at)).resolves.toMatchObject({
      apiKey: { id: key.id },
    });
  });

  it('CRITICAL a live web session whose expiry IS the current instant is already expired', async () => {
    const cache = new InMemoryAuthCache();
    const token = 'websession-token-that-is-long-enough-aaaa';
    const at = new Date('2026-07-14T00:00:02.000Z');
    const sessionRow = (expiresAt: Date) => ({
      id: 'sess_expiry_boundary',
      accountId: ACCOUNT.id,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      mfaSatisfiedAt: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    let live = sessionRow(new Date('2026-07-20T00:00:00.000Z'));
    const repo = repoWith({ findActiveWebSession: () => Promise.resolve(live) });

    await expect(
      authenticate(repo, token, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ account: { id: ACCOUNT.id } });

    live = sessionRow(at);
    await expect(authenticate(repo, token, cache, at)).rejects.toBeInstanceOf(ExpiredKeyError);

    live = sessionRow(new Date(at.getTime() + 1));
    await expect(authenticate(repo, token, cache, at)).resolves.toMatchObject({
      account: { id: ACCOUNT.id },
    });
  });

  // The two arms above cover the CACHE-HIT revalidation. The same comparison
  // appears twice more on the slow path, and flipping either left all 1747 auth
  // tests green: the first-time web-session authentication, and the API-key
  // re-read that runs after the cache generations are captured.
  //
  // Completing the set matters for the same reason as the first pair: four
  // copies of one boundary, and a change applied to some of them makes the same
  // credential accepted or rejected depending only on which path served it.
  it('CRITICAL a slow-path web session whose expiry IS the current instant is already expired', async () => {
    const token = 'websession-token-that-is-long-enough-bbbb';
    const at = new Date('2026-07-14T00:00:02.000Z');
    const sessionRow = (expiresAt: Date) => ({
      id: 'sess_slow_path_boundary',
      accountId: ACCOUNT.id,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      mfaSatisfiedAt: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    // No cache at all, so this takes the slow path rather than the cache-hit
    // revalidation the arms above exercise.
    const expiring = repoWith({ findActiveWebSession: () => Promise.resolve(sessionRow(at)) });
    await expect(authenticate(expiring, token, null, at)).rejects.toBeInstanceOf(ExpiredKeyError);

    const valid = repoWith({
      findActiveWebSession: () => Promise.resolve(sessionRow(new Date(at.getTime() + 1))),
    });
    await expect(authenticate(valid, token, null, at)).resolves.toMatchObject({
      account: { id: ACCOUNT.id },
    });
  });

  it('CRITICAL a key that expires between the first read and the revalidation is rejected', async () => {
    // After capturing the cache generations the slow path re-reads the key, so
    // a key can be valid on the first read and expired on the second. That
    // second comparison is the one under test: the first read returns an
    // unexpired key, the re-read returns one whose expiry IS the current
    // instant.
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    const at = new Date('2026-07-14T00:00:02.000Z');
    let reads = 0;
    const repo = repoWith({
      findApiKeyByPrefix: () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? key : { ...key, expiresAt: at });
      },
    });

    await expect(authenticate(repo, PLAINTEXT, cache, at)).rejects.toBeInstanceOf(ExpiredKeyError);
    expect(reads, 'the revalidation re-read must actually have happened').toBe(2);
  });

  it('rejects a cached key whose live secret hash rotated without invalidation', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveKey = key;
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(liveKey),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    liveKey = {
      ...key,
      keyHash: await hashApiKey('ds_live_rotated_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    };

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('rejects a cached credential when the live account is suspended without invalidation', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveAccount = ACCOUNT;
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(key),
      getAccount: () => Promise.resolve(liveAccount),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    liveAccount = { ...ACCOUNT, status: 'suspended' };

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refreshes live account tier and API-key scopes on a positive hit', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveKey = key;
    let liveAccount = ACCOUNT;
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(liveKey),
      getAccount: () => Promise.resolve(liveAccount),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    liveKey = { ...key, scopes: ['read'] };
    liveAccount = { ...ACCOUNT, tier: 'enterprise' };

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).resolves.toMatchObject({
      account: { tier: 'enterprise' },
      apiKey: { scopes: ['read'] },
    });
  });

  it('fails closed instead of trusting a positive entry when authority is unavailable', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let authorityAvailable = true;
    const repo = repoWith({
      findApiKeyByPrefix: () =>
        authorityAvailable
          ? Promise.resolve(key)
          : Promise.reject(new Error('authority unavailable')),
      getAccount: () =>
        authorityAvailable
          ? Promise.resolve(ACCOUNT)
          : Promise.reject(new Error('authority unavailable')),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    authorityAvailable = false;

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).rejects.toThrow('authority unavailable');
  });

  it('drops a removed team grant from a positive cache hit without invalidation', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    const membership: TeamMembership = {
      membershipId: 'mem_cache_authority',
      ownerAccountId: 'owner_cache_authority',
      ownerEmail: 'owner@example.test',
      ownerName: null,
      role: 'admin',
    };
    let liveTeams = [membership];
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(key),
      findTeamMemberships: () => Promise.resolve(liveTeams),
    });

    const warmed = await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    expect(resolveEffectiveAccount(warmed, 'acc_owner_cache_authority')).toMatchObject({
      kind: 'team',
      role: 'admin',
    });
    await expect(cache.get(SHA)).resolves.not.toBeNull();

    liveTeams = [];
    const refreshed = await authenticate(
      repo,
      PLAINTEXT,
      cache,
      new Date('2026-07-14T00:00:01.000Z'),
    );
    expect(refreshed.teams).toEqual([]);
    expect(() => resolveEffectiveAccount(refreshed, 'acc_owner_cache_authority')).toThrow(
      ForbiddenError,
    );
  });

  it('replaces a cached admin team role with the live member role', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveTeams: TeamMembership[] = [
      {
        membershipId: 'mem_role_authority',
        ownerAccountId: 'owner_role_authority',
        role: 'admin',
      },
    ];
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(key),
      findTeamMemberships: () => Promise.resolve(liveTeams),
    });

    await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z'));
    liveTeams = [{ ...liveTeams[0]!, role: 'member' }];

    const refreshed = await authenticate(
      repo,
      PLAINTEXT,
      cache,
      new Date('2026-07-14T00:00:01.000Z'),
    );
    expect(resolveEffectiveAccount(refreshed, 'acc_owner_role_authority')).toMatchObject({
      kind: 'team',
      role: 'member',
    });
  });

  it('drops a cleared rate-limit override from a positive cache hit without invalidation', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveOverrides: RateLimitOverride[] = [
      {
        bucketKey: 'global',
        capacity: 9_999,
        refillPerSecond: 99,
        expiresAt: new Date('2026-07-15T00:00:00.000Z'),
      },
    ];
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(key),
      findActiveRateLimitOverrides: () => Promise.resolve(liveOverrides),
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ rateLimitOverrides: { global: { capacity: 9_999 } } });
    liveOverrides = [];

    const refreshed = await authenticate(
      repo,
      PLAINTEXT,
      cache,
      new Date('2026-07-14T00:00:01.000Z'),
    );
    expect(refreshed.rateLimitOverrides).toEqual({});
  });

  it('replaces a cached permissive rate-limit override with its live tightened value', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let liveOverrides: RateLimitOverride[] = [
      {
        bucketKey: 'global',
        capacity: 9_999,
        refillPerSecond: 99,
        expiresAt: new Date('2026-07-15T00:00:00.000Z'),
      },
    ];
    const repo = repoWith({
      findApiKeyByPrefix: () => Promise.resolve(key),
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
  // The cache write at the end of the scrypt path is wrapped in a catch that
  // drops the failure on the floor: "auth still completed via scrypt path...
  // next request will retry the cache write". That swallow is the difference
  // between a cache outage costing latency and a cache outage costing every
  // authenticated request in the fleet — rethrowing turns a Redis blip into a
  // total authentication failure.
  //
  // Nothing exercised it. No test in the suite makes a cache write throw; the
  // only files naming cache-failure resilience are content-parity pins over
  // the comment. This drives the real authenticate() with a cache whose write
  // rejects, and asserts the write was attempted so it cannot pass by never
  // reaching the swallow.
  it('CRITICAL authentication still succeeds when the cache WRITE fails', async () => {
    const cache = new CacheWhoseWriteFails();
    const key = await activeKey();
    const repo = repoWith({ findApiKeyByPrefix: () => Promise.resolve(key) });

    const ctx = await authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z'));

    expect(
      cache.setCalls,
      'the cache write must actually be attempted, or this proves nothing about the swallow',
    ).toBe(1);
    expect(ctx.account.id).toBe(ACCOUNT.id);
    expect(ctx.apiKey.id).toBe(key.id);
  });
  // The web-session path ends in the SAME swallow, commented "Same
  // graceful-degradation as the API key path." It needs its own arm: breaking
  // it reds nothing across 275 auth/session files and 3312 tests, because the
  // arm above drives the api-key branch and never reaches this one.
  it('CRITICAL a web session still authenticates when the cache WRITE fails', async () => {
    const cache = new CacheWhoseWriteFails();
    // Not ds_-shaped, so authenticate() routes straight to the web-session path.
    const token = 'websession-token-that-is-long-enough-aaaa';
    const now = new Date('2026-07-14T00:00:01.000Z');
    const repo = repoWith({
      findActiveWebSession: () =>
        Promise.resolve({
          id: 'sess_cache_write_fails',
          accountId: ACCOUNT.id,
          expiresAt: new Date('2026-07-20T00:00:00.000Z'),
          revokedAt: null,
          lastUsedAt: null,
          mfaSatisfiedAt: null,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
    });

    const ctx = await authenticate(repo, token, cache, now);

    expect(cache.setCalls, 'the cache write must actually be attempted').toBe(1);
    expect(ctx.account.id).toBe(ACCOUNT.id);
    expect(ctx.webSession?.id).toBe('sess_cache_write_fails');
  });
});
