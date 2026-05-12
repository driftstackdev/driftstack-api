// W279.A — drift guard for marketing-site pricing.ts numeric caps.
// Every API_TIERS entry's `concurrent` and `profiles` fields must
// agree with TIER_CONCURRENT_SESSION_LIMITS and PROFILES_PER_TIER
// from the live schema. Self-hosted tiers (tierType: 'self_hosted')
// are exempt — they're a separate product.

import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';
import { PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

describe('W279.A pricing.ts ↔ tier numeric-caps parity', () => {
  for (const tier of API_TIERS) {
    if (tier.tierType === 'self_hosted') continue;
    const tierId = tier.id as keyof typeof PROFILES_PER_TIER;

    it(`${tier.id}: pricing.profiles matches PROFILES_PER_TIER`, () => {
      const live = PROFILES_PER_TIER[tierId];
      const pricing = tier.profiles;
      if (live === 'custom') {
        expect(typeof pricing).toBe('string');
        expect(String(pricing).toLowerCase()).toMatch(/custom/);
      } else {
        expect(pricing).toBe(live);
      }
    });

    it(`${tier.id}: pricing.concurrent matches TIER_CONCURRENT_SESSION_LIMITS`, () => {
      const live = TIER_CONCURRENT_SESSION_LIMITS[tierId];
      const pricing = tier.concurrent;
      if (tier.id === 'enterprise') {
        // Enterprise allows a "custom" string in the pricing page even
        // though the schema floor is 32. Either is acceptable.
        if (typeof pricing === 'string') {
          expect(pricing.toLowerCase()).toMatch(/custom/);
        } else {
          expect(pricing).toBe(live);
        }
      } else {
        expect(pricing).toBe(live);
      }
    });
  }
});
