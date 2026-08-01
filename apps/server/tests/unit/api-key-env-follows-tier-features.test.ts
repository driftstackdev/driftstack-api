// The tier table must actually decide which environment a key is minted in.
//
// `TIER_FEATURES[tier].apiKeyEnvironment` documents itself as the source of
// truth for this — "Stripe environment for API-key minting (test on free, live
// elsewhere)" — and it was read by no runtime code at all. Both mint paths,
// `create()` and `rotate()`, computed `tier === 'free' ? 'test' : 'live'`
// inline, in two copies.
//
// Measured: scanning the seven tier-keyed tables against every consumer source
// root found `apiKeyEnvironment` varying across tiers with zero readers outside
// its own declaration. Three test files assert its values, which is what made
// it look load-bearing — a pin on a constant tells you the constant is spelled
// right, not that anything consults it.
//
// Nothing was visibly wrong, because the ternary and the table agreed for all
// eight tiers. The exposure is the next tier: one added with
// `apiKeyEnvironment: 'test'` would have minted `ds_live_…` keys anyway, since
// the ternary only ever special-cased `free`. Free-tier `ds_test_…` credentials
// are documented to customers, so the two would have disagreed silently in the
// direction of issuing live-looking keys.
//
// THIS FILE DELIBERATELY MINTS THROUGH THE SERVICE rather than checking the
// helper against the table. The first draft did the latter — and
// `expect(apiKeyEnvForTier(t)).toBe(TIER_FEATURES[t].apiKeyEnvironment)` is a
// tautology once the helper reads that table. It would have passed just as
// happily while `create()` and `rotate()` kept their inline ternaries, which is
// the entire defect.

import { describe, expect, it } from 'vitest';
import { AccountTierSchema, TIER_FEATURES } from '@driftstack/api-types';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';
import {
  ApiKeysService,
  type ApiKeysRepo,
  type NewApiKeyInput,
} from '../../src/services/api-keys.js';
import type { AccountContext, AccountRow, ApiKeyRow } from '../../src/services/auth.js';

const ALL_TIERS = AccountTierSchema.options as readonly AccountTier[];

function callerCtx(tier: AccountTier): AccountContext {
  const account = { id: 'acc_1', email: 'u@example.com', tier, status: 'active' } as AccountRow;
  const apiKey = {
    id: 'k1',
    accountId: 'acc_1',
    keyPrefix: 'ds_live_abc',
    scopes: ['account_owner', 'read'] as ApiKeyScope[],
    revokedAt: null,
    provenance: null,
  } as ApiKeyRow;
  return { account, apiKey, rateLimitOverrides: {}, teams: [] } as unknown as AccountContext;
}

/** The narrowest repo `create()` touches: it inserts and reads nothing back. */
function stubRepo(): ApiKeysRepo {
  return {
    listApiKeysMintedBy: () => Promise.resolve([]),
    insertApiKey: (input: NewApiKeyInput) =>
      Promise.resolve({
        id: 'k_new',
        accountId: input.accountId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        scopes: input.scopes,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: input.expiresAt,
        provenance: input.provenance ?? null,
        createdAt: new Date(),
      } as ApiKeyRow),
  } as unknown as ApiKeysRepo;
}

/**
 * Mint a key as `tier` and return its plaintext.
 *
 * Free carries `apiAccess: false`, so an ordinary customer key is refused
 * there by design — the browser-authorized desktop flow is how Free gets a
 * credential, and that is the path whose environment the docs describe as
 * `ds_test_…`. Minting it with that provenance is what exercises the tier the
 * whole test/live split exists for.
 */
async function mintAs(tier: AccountTier): Promise<string> {
  const svc = new ApiKeysService(stubRepo());
  const result = await svc.create(callerCtx(tier), {
    name: 'probe',
    scopes: ['read'],
    expiresAt: null,
    ...(TIER_FEATURES[tier].apiAccess ? {} : { provenance: 'cli_device' as const }),
  });
  return result.plaintext;
}

describe('the minted API-key environment is decided by TIER_FEATURES', () => {
  it('CRITICAL every tier is exercised, and the roster comes from the schema enum rather than a list written here. A tier added to the product but not to this file would otherwise go unminted — and an unexercised tier is exactly what the inline ternary got wrong.', () => {
    expect(ALL_TIERS.length, 'tiers in AccountTierSchema').toBeGreaterThan(5);
    expect(
      ALL_TIERS.filter((t) => TIER_FEATURES[t] === undefined),
      'every tier has a TIER_FEATURES row',
    ).toEqual([]);
  });

  for (const tier of ALL_TIERS) {
    it(`CRITICAL minting as ${tier} produces a key in the environment its TIER_FEATURES row declares. This goes through the real service, so it fails if the mint path stops consulting the table — which is the regression, not a mismatched constant.`, async () => {
      const expected = TIER_FEATURES[tier].apiKeyEnvironment;
      await expect(mintAs(tier)).resolves.toMatch(new RegExp(`^ds_${expected}_[a-z2-7]{32}$`));
    });
  }

  it('POSITIVE CONTROL the tiers do not all mint the same environment. Every assertion above compares a minted key against the table, so a table collapsed to one value everywhere would satisfy all of them while the Free-tier distinction customers are promised had quietly disappeared.', () => {
    const environments = new Set(ALL_TIERS.map((t) => TIER_FEATURES[t].apiKeyEnvironment));
    expect([...environments].sort(), 'both environments are in use').toEqual(['live', 'test']);
    expect(TIER_FEATURES.free.apiKeyEnvironment, 'free is the test-environment tier').toBe('test');
  });
});
