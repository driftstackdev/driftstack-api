// W275.A — drift guard for marketing-site/pricing.ts tier ids.
// Every tier whose `tierType` is `trial | manual | api | enterprise`
// must have an `id` that is a member of AccountTierSchema. Self-hosted
// tiers (`tierType: 'self_hosted'`) are a separate product and are
// exempt.

import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';
import { AccountTierSchema } from '@driftstack/api-types';

describe('W275.A pricing.ts ↔ AccountTierSchema parity', () => {
  const liveTiers = new Set(AccountTierSchema.options);

  it('every non-self-hosted API_TIERS entry maps to a real AccountTier', () => {
    const offenders = API_TIERS.filter(
      (t) => t.tierType !== 'self_hosted' && !liveTiers.has(t.id as never),
    ).map((t) => t.id);
    expect(offenders).toEqual([]);
  });

  it('every AccountTier (except trial_pack) appears in API_TIERS', () => {
    // trial_pack is a one-time purchase, listed explicitly; the rest
    // should each have a card on the pricing page.
    const liveIds = AccountTierSchema.options;
    const apiIds = new Set(API_TIERS.map((t) => t.id));
    const missing = liveIds.filter((id) => !apiIds.has(id));
    expect(missing).toEqual([]);
  });

  it('no API_TIERS entry references a fictional tier (team_growth / solo_pro / enterprise_plus)', () => {
    const ids = API_TIERS.map((t) => t.id);
    expect(ids).not.toContain('team_growth');
    expect(ids).not.toContain('solo_pro');
    expect(ids).not.toContain('enterprise_plus');
  });
});
