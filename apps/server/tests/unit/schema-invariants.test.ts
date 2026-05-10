// V-518 — cross-enum schema invariants. The api-types package
// declares several related enums that must stay aligned (every
// AccountTier needs a TIER_FEATURES row, every PROBLEM_TYPES URI
// is unique, every WebhookEventType is either subscribable or the
// test-ping sentinel, etc.). This test pins those invariants so
// adding a new enum value without updating the related table fails
// loudly at test time rather than silently shipping a drift.

import { describe, expect, it } from 'vitest';
import {
  AccountTierSchema,
  PROBLEM_TYPES,
  PROFILES_PER_TIER,
  SubscribableWebhookEventTypeSchema,
  TIER_CONCURRENT_SESSION_LIMITS,
  TIER_FEATURES,
  TIER_RATE_LIMIT_DEFAULTS,
  WebhookEventTypeSchema,
} from '@driftstack/api-types';

describe('V-518 — AccountTier related-table coverage', () => {
  const ALL_TIERS = AccountTierSchema.options;

  it('every AccountTier has a TIER_FEATURES row', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier]).toBeDefined();
    }
  });

  it('every AccountTier has a TIER_CONCURRENT_SESSION_LIMITS row', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_CONCURRENT_SESSION_LIMITS[tier]).toBeDefined();
    }
  });

  it('every AccountTier has a PROFILES_PER_TIER row', () => {
    for (const tier of ALL_TIERS) {
      expect(PROFILES_PER_TIER[tier]).toBeDefined();
    }
  });

  it('every AccountTier has a TIER_RATE_LIMIT_DEFAULTS row', () => {
    for (const tier of ALL_TIERS) {
      const row = TIER_RATE_LIMIT_DEFAULTS[tier];
      expect(row).toBeDefined();
      expect(row.global).toBeDefined();
      expect(row['sessions:create']).toBeDefined();
    }
  });

  it('TIER_FEATURES exposes only the AccountTier keys (no orphan rows)', () => {
    const featureKeys = Object.keys(TIER_FEATURES).sort();
    const tierKeys = [...ALL_TIERS].sort();
    expect(featureKeys).toEqual(tierKeys);
  });

  it('TIER_CONCURRENT_SESSION_LIMITS values agree with TIER_FEATURES.concurrentSessions', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier].concurrentSessions).toBe(TIER_CONCURRENT_SESSION_LIMITS[tier]);
    }
  });

  it('PROFILES_PER_TIER values agree with TIER_FEATURES.profiles', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_FEATURES[tier].profiles).toBe(PROFILES_PER_TIER[tier]);
    }
  });
});

describe('V-518 — PROBLEM_TYPES uniqueness', () => {
  it('every URI value appears exactly once', () => {
    const uris = Object.values(PROBLEM_TYPES);
    expect(new Set(uris).size).toBe(uris.length);
  });

  it('every URI is rooted at errors.driftstack.dev', () => {
    for (const uri of Object.values(PROBLEM_TYPES)) {
      expect(uri.startsWith('https://errors.driftstack.dev/')).toBe(true);
    }
  });

  it('no URI is the empty string or whitespace', () => {
    for (const uri of Object.values(PROBLEM_TYPES)) {
      expect(uri.length).toBeGreaterThan(0);
      expect(uri.trim()).toBe(uri);
    }
  });
});

describe('V-518 — WebhookEventType partition', () => {
  const ALL_WEBHOOK_EVENTS = WebhookEventTypeSchema.options;
  const SUBSCRIBABLE_EVENTS = SubscribableWebhookEventTypeSchema.options;

  it('every event is either subscribable or the test.ping sentinel', () => {
    const subscribable = new Set<string>(SUBSCRIBABLE_EVENTS);
    for (const evt of ALL_WEBHOOK_EVENTS) {
      const isPartitioned = subscribable.has(evt) || evt === 'test.ping';
      expect(isPartitioned).toBe(true);
    }
  });

  it('test.ping is not in the subscribable set', () => {
    const subscribable = new Set<string>(SUBSCRIBABLE_EVENTS);
    expect(subscribable.has('test.ping')).toBe(false);
  });

  it('every subscribable event is in the full event set', () => {
    const all = new Set<string>(ALL_WEBHOOK_EVENTS);
    for (const evt of SUBSCRIBABLE_EVENTS) {
      expect(all.has(evt)).toBe(true);
    }
  });

  it('subscribable + {test.ping} === full event set', () => {
    const reconstructed = new Set<string>([...SUBSCRIBABLE_EVENTS, 'test.ping']);
    const all = new Set<string>(ALL_WEBHOOK_EVENTS);
    expect(reconstructed.size).toBe(all.size);
    for (const evt of all) {
      expect(reconstructed.has(evt)).toBe(true);
    }
  });
});

describe('V-518 — TIER_FEATURES internal consistency', () => {
  const ALL_TIERS = AccountTierSchema.options;

  it('llmBilling is null iff aiAgent is false', () => {
    for (const tier of ALL_TIERS) {
      const f = TIER_FEATURES[tier];
      if (f.aiAgent) {
        expect(f.llmBilling).not.toBeNull();
      } else {
        expect(f.llmBilling).toBeNull();
      }
    }
  });

  it('apiKeyEnvironment is "test" iff trialPack is true', () => {
    for (const tier of ALL_TIERS) {
      const f = TIER_FEATURES[tier];
      if (f.trialPack) {
        expect(f.apiKeyEnvironment).toBe('test');
      } else {
        expect(f.apiKeyEnvironment).toBe('live');
      }
    }
  });

  it('exactly one tier has trialPack=true', () => {
    const trialTiers = ALL_TIERS.filter((t) => TIER_FEATURES[t].trialPack);
    expect(trialTiers).toEqual(['trial_pack']);
  });
});
