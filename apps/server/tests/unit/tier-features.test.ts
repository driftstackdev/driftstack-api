// V-485 — per-tier feature gating framework.
//
// The TIER_FEATURES registry is the central source of truth for
// "does this tier unlock feature X?" Tests pin the matrix shape +
// the requireTierFeature guard so a tier or feature change in
// packages/api-types/src/common.ts surfaces here loudly.

import { describe, expect, it } from 'vitest';
import {
  AccountTierSchema,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  TIER_FEATURES,
  tierFeatures,
  tierHasFeature,
  type AccountTier,
} from '@driftstack/api-types';
import { requireTierFeature } from '../../src/lib/errors-helpers.js';
import { ForbiddenError } from '../../src/lib/errors.js';

const ALL_TIERS: AccountTier[] = AccountTierSchema.options;

describe('V-485 — TIER_FEATURES registry shape', () => {
  it('covers every AccountTier enum value (no gaps)', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier]).toBeDefined();
    }
  });

  it('has exactly the same key set as AccountTierSchema', () => {
    const registryKeys = Object.keys(TIER_FEATURES).sort();
    const enumKeys = [...ALL_TIERS].sort();
    expect(registryKeys).toEqual(enumKeys);
  });

  it('agrees with TIER_CONCURRENT_SESSION_LIMITS for every tier', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier].concurrentSessions).toBe(TIER_CONCURRENT_SESSION_LIMITS[tier]);
    }
  });

  it('agrees with PROFILES_PER_TIER for every tier', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier].profiles).toBe(PROFILES_PER_TIER[tier]);
    }
  });

  it('only the free tier denies API access (manual-only)', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier].apiAccess).toBe(tier !== 'free');
    }
  });

  it('only the free tier mints test-environment API keys', () => {
    for (const tier of ALL_TIERS) {
      const expected = tier === 'free' ? 'test' : 'live';
      expect(TIER_FEATURES[tier].apiKeyEnvironment).toBe(expected);
    }
  });

  it('aiAgent and llmBilling are aligned: llmBilling is null iff aiAgent is false', () => {
    for (const tier of ALL_TIERS) {
      const f = TIER_FEATURES[tier];
      if (f.aiAgent) {
        expect(f.llmBilling).not.toBeNull();
      } else {
        expect(f.llmBilling).toBeNull();
      }
    }
  });

  it('locks the AI-agent matrix per ADR-004 + founder Tier 3 spec', () => {
    // free / solo_manual: AI agent OFF.
    expect(TIER_FEATURES.free.aiAgent).toBe(false);
    expect(TIER_FEATURES.solo_manual.aiAgent).toBe(false);
    // Manual mid + Manual top + API ladder: AI agent ON.
    expect(TIER_FEATURES.team_manual.aiAgent).toBe(true);
    expect(TIER_FEATURES.team_manual.llmBilling).toBe('byok_only');
    expect(TIER_FEATURES.agency_manual.aiAgent).toBe(true);
    expect(TIER_FEATURES.agency_manual.llmBilling).toBe('byok_only');
    expect(TIER_FEATURES.api_starter.aiAgent).toBe(true);
    expect(TIER_FEATURES.api_starter.llmBilling).toBe('byok_only');
    expect(TIER_FEATURES.api_builder.aiAgent).toBe(true);
    expect(TIER_FEATURES.api_builder.llmBilling).toBe('byok_or_bundled');
    expect(TIER_FEATURES.api_scale.aiAgent).toBe(true);
    expect(TIER_FEATURES.api_scale.llmBilling).toBe('byok_or_bundled');
    expect(TIER_FEATURES.enterprise.aiAgent).toBe(true);
    expect(TIER_FEATURES.enterprise.llmBilling).toBe('byok_or_bundled_custom');
  });
});

describe('V-485 — tierFeatures() lookup', () => {
  it('returns the full feature row by reference', () => {
    expect(tierFeatures('api_builder')).toBe(TIER_FEATURES.api_builder);
  });

  it('returns the free row with apiKeyEnvironment=test', () => {
    expect(tierFeatures('free').apiKeyEnvironment).toBe('test');
  });
});

describe('V-485 — tierHasFeature() boolean predicate', () => {
  it('returns true when the boolean feature is enabled', () => {
    expect(tierHasFeature('api_builder', 'aiAgent')).toBe(true);
    expect(tierHasFeature('api_builder', 'apiAccess')).toBe(true);
  });

  it('returns false when the boolean feature is disabled', () => {
    expect(tierHasFeature('solo_manual', 'aiAgent')).toBe(false);
    expect(tierHasFeature('free', 'apiAccess')).toBe(false);
  });
});

describe('V-485 — requireTierFeature() guard', () => {
  it('does not throw when the feature is enabled', () => {
    expect(() => requireTierFeature('api_builder', 'aiAgent')).not.toThrow();
    expect(() => requireTierFeature('api_builder', 'apiAccess')).not.toThrow();
  });

  it('throws ForbiddenError when the feature is disabled', () => {
    expect(() => requireTierFeature('solo_manual', 'aiAgent')).toThrow(ForbiddenError);
    expect(() => requireTierFeature('free', 'aiAgent')).toThrow(ForbiddenError);
  });

  it('error message names the feature and tier so the customer can read it', () => {
    let caught: unknown;
    try {
      requireTierFeature('solo_manual', 'aiAgent');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    const detail = (caught as ForbiddenError).message;
    expect(detail).toContain('aiAgent');
    expect(detail).toContain('solo_manual');
  });

  it('exhaustively gates aiAgent: only OFF on free + solo_manual', () => {
    for (const tier of ALL_TIERS) {
      if (tier === 'free' || tier === 'solo_manual') {
        expect(() => requireTierFeature(tier, 'aiAgent')).toThrow(ForbiddenError);
      } else {
        expect(() => requireTierFeature(tier, 'aiAgent')).not.toThrow();
      }
    }
  });
});
