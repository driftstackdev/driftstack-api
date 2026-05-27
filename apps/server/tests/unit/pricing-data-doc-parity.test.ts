// W246.B — drift-guard for the locked pricing table in
// marketing-site/src/data/pricing.ts. The server's
// TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER + AccountTier
// enum are the source of truth; this guard fails if either layer
// drifts.

import { describe, expect, it } from 'vitest';
import {
  AccountTierSchema,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
} from '@driftstack/api-types';
import { API_TIERS } from '../../../marketing-site/src/data/pricing.ts';

describe('W246.B pricing data ↔ tier-constants parity', () => {
  const liveTiers = new Set((AccountTierSchema._def.values as readonly string[]).slice());

  it('every pricing tier id is a real AccountTier', () => {
    const offenders = API_TIERS.filter(
      (t) => !liveTiers.has(t.id) && !t.id.startsWith('self_hosted_'),
    );
    expect(offenders.map((t) => t.id)).toEqual([]);
  });

  it('every AccountTier has a pricing row', () => {
    const ids = new Set(API_TIERS.map((t) => t.id));
    const missing = [...liveTiers].filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it('concurrent caps match TIER_CONCURRENT_SESSION_LIMITS', () => {
    for (const t of API_TIERS) {
      if (!liveTiers.has(t.id)) continue;
      const live =
        TIER_CONCURRENT_SESSION_LIMITS[t.id as keyof typeof TIER_CONCURRENT_SESSION_LIMITS];
      if (typeof t.concurrent === 'number') {
        expect(t.concurrent).toBe(live);
      } else {
        // Enterprise displays "Custom"; live cap is 32. Acceptable
        // because contract-tier customers see a non-numeric label.
        expect(t.id).toBe('enterprise');
        expect(t.concurrent).toBe('Custom');
      }
    }
  });

  it('profile counts match PROFILES_PER_TIER', () => {
    for (const t of API_TIERS) {
      if (!liveTiers.has(t.id)) continue;
      const live = PROFILES_PER_TIER[t.id as keyof typeof PROFILES_PER_TIER];
      if (typeof t.profiles === 'number') {
        expect(t.profiles).toBe(live);
      } else {
        // Enterprise displays "Custom"; live is the 'custom' sentinel.
        expect(t.id).toBe('enterprise');
        expect(t.profiles).toBe('Custom');
        expect(live).toBe('custom');
      }
    }
  });

  it('free tier stays single-concurrent / single-profile', () => {
    const free = API_TIERS.find((t) => t.id === 'free');
    expect(free).toBeDefined();
    expect(free!.concurrent).toBe(1);
    expect(free!.profiles).toBe(1);
  });
});
