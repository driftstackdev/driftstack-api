import { describe, expect, it } from 'vitest';
import { InvalidKeyError } from '../../src/lib/errors.js';
import {
  authenticate,
  type AccountAuthRepo,
  type AccountRow,
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
});
