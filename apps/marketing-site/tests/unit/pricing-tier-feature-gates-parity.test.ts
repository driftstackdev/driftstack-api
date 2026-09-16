// 2026-09-15 — /pricing and /pricing/comparison render "API and SDK access",
// "VPN exits" and the AI-agent cell from data/pricing.ts. The server gates
// those features from TIER_FEATURES (packages/api-types/src/common.ts,
// enforced by requireTierFeature) and the free tier's device entitlement
// from ARCHETYPE_DEVICES_PER_TIER. A pricing row that says "Included" while
// the server answers 403 is a false sale, so the two records are pinned to
// each other for every tier — the same shape pricing-concurrency-profile-
// cap-parity gives the caps. Reads the BUILT package the way the site does.

import { describe, expect, it } from 'vitest';
import { ARCHETYPE_DEVICES_PER_TIER, TIER_FEATURES } from '@driftstack/api-types';
import { API_TIERS } from '../../src/data/pricing';

type TierId = keyof typeof TIER_FEATURES;

describe('pricing.ts feature gates ↔ TIER_FEATURES / ARCHETYPE_DEVICES_PER_TIER', () => {
  for (const tier of API_TIERS) {
    it(`${tier.id}: apiAccess / vpnEgress / aiAgent / llmBilling match the server gate`, () => {
      const features = TIER_FEATURES[tier.id as TierId];
      expect(features, `no TIER_FEATURES row for ${tier.id}`).toBeDefined();
      expect(tier.apiAccess).toBe(features.apiAccess);
      expect(tier.vpnEgress).toBe(features.vpnEgress);
      expect(tier.aiAgent).toBe(features.aiAgent);
      expect(tier.llmBilling).toBe(features.llmBilling);
    });
  }

  it('the free tier is the ONLY tier without API access and without VPN exits — the pricing copy says so in words, so the data must agree', () => {
    const without = API_TIERS.filter((t) => !t.apiAccess || !t.vpnEgress).map((t) => t.id);
    expect(without).toEqual(['free']);
  });

  it('the AI agent is off on exactly Free and Personal — "starts at Team, and is on every API plan" is the sentence the pages carry', () => {
    const off = API_TIERS.filter((t) => !t.aiAgent).map((t) => t.id);
    expect(off).toEqual(['free', 'solo_manual']);
    for (const t of API_TIERS.filter((t) => t.tierType === 'api')) {
      expect(t.aiAgent, t.id).toBe(true);
    }
  });

  it("the free row's device entitlement names exactly ARCHETYPE_DEVICES_PER_TIER.free, and every paid tier is unrestricted (null) and says so", () => {
    const free = API_TIERS.find((t) => t.id === 'free')!;
    const devices = ARCHETYPE_DEVICES_PER_TIER.free;
    expect(devices).not.toBeNull();
    for (const d of devices!) expect(free.archetypeAccess).toContain(d);
    for (const t of API_TIERS.filter((t) => t.id !== 'free')) {
      expect(ARCHETYPE_DEVICES_PER_TIER[t.id as TierId], t.id).toBeNull();
      expect(t.archetypeAccess, t.id).toMatch(/^All current/);
    }
  });
});
