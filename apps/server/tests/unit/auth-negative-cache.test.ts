// DoS hardening — authenticate() must consult the negative cache so a
// flood of the SAME bogus bearer token only pays the prefix-lookup +
// scrypt verify ONCE, then short-circuits on repeats. Proven with a
// counting fake repo (no real Postgres / scrypt churn needed).

import { describe, expect, it } from 'vitest';
import { authenticate, type AccountAuthRepo, type ApiKeyRow } from '../../src/services/auth.js';
import { InvalidKeyError } from '../../src/lib/errors.js';
import { InProcessNegativeAuthCache } from '../../src/services/negative-auth-cache.js';

// A repo that records how many times findApiKeyByPrefix was hit. Always
// returns null (unknown key) so authenticate() throws InvalidKeyError —
// the exact "bogus token flood" outcome the negative cache must amortise.
function makeCountingRepo(): { repo: AccountAuthRepo; prefixLookups: () => number } {
  let prefixLookups = 0;
  const repo: AccountAuthRepo = {
    findApiKeyByPrefix(): Promise<ApiKeyRow | null> {
      prefixLookups += 1;
      return Promise.resolve(null);
    },
    getAccount: () => Promise.resolve(null),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveWebSession: () => Promise.resolve(null),
    touchWebSessionLastUsed: () => Promise.resolve(),
    updateAccountBasics: () => Promise.resolve(null),
    setOnboardingCompleted: () => Promise.resolve(),
    getOnboardingCompletedAt: () => Promise.resolve(null),
    getOrganization: () => Promise.resolve(null),
    setOrganization: () => Promise.resolve(),
  };
  return { repo, prefixLookups: () => prefixLookups };
}

// 24+ chars + `ds_` shape so it takes the API-key slow path.
const BOGUS = 'ds_live_thisisabogustokenvalue00';

describe('authenticate() negative cache', () => {
  it('first bogus token hits the DB once; the second SAME token skips it', async () => {
    const { repo, prefixLookups } = makeCountingRepo();
    const negativeCache = new InProcessNegativeAuthCache();

    await expect(
      authenticate(repo, BOGUS, null, new Date(), null, new Set(), negativeCache),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    expect(prefixLookups()).toBe(1);

    // Repeat the SAME bogus token — must short-circuit on the negative
    // cache, NOT re-hit findApiKeyByPrefix (the ungated DB + scrypt work).
    await expect(
      authenticate(repo, BOGUS, null, new Date(), null, new Set(), negativeCache),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    expect(prefixLookups()).toBe(1);
  });

  it('a DIFFERENT bogus token is NOT short-circuited (distinct sha → cache miss)', async () => {
    const { repo, prefixLookups } = makeCountingRepo();
    const negativeCache = new InProcessNegativeAuthCache();

    await expect(
      authenticate(repo, BOGUS, null, new Date(), null, new Set(), negativeCache),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(
      authenticate(repo, `${BOGUS}X`, null, new Date(), null, new Set(), negativeCache),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    // Two distinct tokens → two distinct shas → two DB lookups.
    expect(prefixLookups()).toBe(2);
  });

  it('without a negative cache, repeats re-hit the DB every time (regression guard)', async () => {
    const { repo, prefixLookups } = makeCountingRepo();

    await expect(
      authenticate(repo, BOGUS, null, new Date(), null, new Set(), null),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(
      authenticate(repo, BOGUS, null, new Date(), null, new Set(), null),
    ).rejects.toBeInstanceOf(InvalidKeyError);
    expect(prefixLookups()).toBe(2);
  });
});
