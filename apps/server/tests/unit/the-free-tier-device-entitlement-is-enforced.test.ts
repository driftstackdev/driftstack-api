// V-1611 #15 — the free tier may create profiles on two devices, and that is
// enforced rather than merely published.
//
// ⛔ THE PLAN ASKED FOR "OLDER iOS ONLY" AND THE REGISTRY CANNOT EXPRESS IT.
// iOS has three distinct values across the registry and two of the three are the
// same product generation, so an iOS cut separates almost nothing. DEVICE has 19
// distinct values and is what a customer already understands. Recorded here
// because the next reader will find the plan text and wonder why it was ignored.
//
// ⚠️ This is an ENTITLEMENT, not a catalog filter. `GET /v1/archetypes` is public,
// unauthenticated and cached for 300s; it answers "what does this product
// support", which is the same for everyone. Hiding rows per tier would need auth
// on a public route and gain nothing, since the ids ship in the OpenAPI document.
// So the test below asserts the catalog is NOT filtered as well.

import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_DEVICES_PER_TIER,
  defaultArchetypeIdForTier,
  LOCKED_ARCHETYPE_ID,
  ARCHETYPE_REGISTRY,
  archetypeAllowedForTier,
  archetypeIdsForTier,
  AccountTierSchema,
} from '@driftstack/api-types';

describe('the free-tier device entitlement is enforced', () => {
  it('CRITICAL every tier has an entry, so a new tier cannot default to unrestricted by omission. A missing key reads as `undefined`, and `undefined ?? null` is the permissive branch — the failure would be silent and in the wrong direction.', () => {
    for (const tier of AccountTierSchema.options) {
      expect(
        Object.prototype.hasOwnProperty.call(ARCHETYPE_DEVICES_PER_TIER, tier),
        `${tier} has no ARCHETYPE_DEVICES_PER_TIER entry`,
      ).toBe(true);
    }
  });

  it('CRITICAL free is restricted and the paid tiers are not — asserted as a CONTRAST, because a map that restricted everything, or nothing, would satisfy either half alone', () => {
    expect(ARCHETYPE_DEVICES_PER_TIER.free).toEqual(['iPhone 13', 'iPhone 13 mini']);
    for (const tier of AccountTierSchema.options) {
      if (tier === 'free') continue;
      expect(ARCHETYPE_DEVICES_PER_TIER[tier], `${tier} is restricted`).toBeNull();
    }
  });

  it('CRITICAL the restriction actually narrows the set, and the paid set is the whole registry', () => {
    const free = archetypeIdsForTier('free');
    const paid = archetypeIdsForTier('api_builder');
    expect(free.length, 'free has some devices').toBeGreaterThan(0);
    expect(paid.length, 'paid is the whole registry').toBe(ARCHETYPE_REGISTRY.length);
    expect(free.length, 'free is strictly narrower').toBeLessThan(paid.length);
  });

  it('CRITICAL both free devices resolve to real registry entries. A tier restricted to a device the registry does not carry is a tier that can create nothing, and the contrast arm above would still pass.', () => {
    for (const device of ARCHETYPE_DEVICES_PER_TIER.free ?? []) {
      expect(
        ARCHETYPE_REGISTRY.some((a) => a.device === device),
        `${device} is not in the registry`,
      ).toBe(true);
    }
  });

  it('CRITICAL an unknown archetype id is refused on EVERY tier — fail-closed, so a typo cannot pass a gate by matching nothing', () => {
    for (const tier of AccountTierSchema.options) {
      expect(archetypeAllowedForTier(tier, 'iphone99_ios99_safari99')).toBe(false);
    }
  });

  it('a paid-only device is refused on free and allowed on paid — the same id, both answers', () => {
    const paidOnly = ARCHETYPE_REGISTRY.find(
      (a) => !(ARCHETYPE_DEVICES_PER_TIER.free ?? []).includes(a.device),
    );
    expect(paidOnly, 'the registry carries a device free does not get').toBeDefined();
    expect(archetypeAllowedForTier('free', paidOnly!.id)).toBe(false);
    expect(archetypeAllowedForTier('api_builder', paidOnly!.id)).toBe(true);
  });

  // P-15 (2026-09-05) — the DEFAULT is a door too. A create that names no device used to
  // get the launch default on every tier, which the free tier is not entitled to; the
  // default now resolves per tier and is judged like an explicit choice.
  it('CRITICAL the default device a tier gets when it names none is one it is entitled to', () => {
    const freeDefault = defaultArchetypeIdForTier('free');
    expect(archetypeAllowedForTier('free', freeDefault), freeDefault).toBe(true);
    expect(ARCHETYPE_REGISTRY.find((a) => a.id === freeDefault)?.device).toBe('iPhone 13');
    expect(freeDefault).not.toBe(LOCKED_ARCHETYPE_ID);
    // Pinned by id so a registry edit reds here instead of silently moving the default:
    // the newest selectable iPhone 13 by numeric (iOS, Safari) version.
    expect(freeDefault).toBe('iphone13_ios18_7_safari26_5');
    // Tiers with every device keep the launch default.
    for (const tier of ['api_builder', 'solo_manual', 'enterprise'] as const) {
      expect(defaultArchetypeIdForTier(tier), tier).toBe(LOCKED_ARCHETYPE_ID);
    }
  });
});
