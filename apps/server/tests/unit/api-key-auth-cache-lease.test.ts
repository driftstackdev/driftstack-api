import { describe, expect, it } from 'vitest';
import { hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { RevokedKeyError } from '../../src/lib/errors.js';
import {
  authenticate,
  type AccountAuthRepo,
  type AccountRow,
  type ApiKeyRow,
} from '../../src/services/auth.js';
import { InMemoryAuthCache, sha256Hex } from '../../src/services/auth-cache.js';

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

  it('keeps a positive API-key cache hit free of repository lookups', async () => {
    const cache = new InMemoryAuthCache();
    const key = await activeKey();
    let lookupCount = 0;
    const repo = repoWith({
      findApiKeyByPrefix: () => {
        lookupCount += 1;
        return Promise.resolve(key);
      },
    });

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:00.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id }, webSession: null });
    expect(lookupCount).toBe(2);

    await expect(
      authenticate(repo, PLAINTEXT, cache, new Date('2026-07-14T00:00:01.000Z')),
    ).resolves.toMatchObject({ apiKey: { id: key.id }, webSession: null });
    expect(lookupCount).toBe(2);
  });
});
