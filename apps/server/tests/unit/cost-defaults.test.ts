// V-541.F — unit tests for the production cost-monitoring defaults.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COST_RATES,
  DEFAULT_TIER_THRESHOLDS_DERIVED,
  TIER_MONTHLY_PRICE_CENTS,
  deriveThresholdsFromMonthlyPrice,
} from '../../src/lib/cost-defaults.js';

describe('V-541.F DEFAULT_COST_RATES — shape + sanity', () => {
  it('all six rate components are positive finite numbers', () => {
    for (const [k, v] of Object.entries(DEFAULT_COST_RATES)) {
      expect(Number.isFinite(v), `rate ${k} not finite`).toBe(true);
      expect(v, `rate ${k} not positive`).toBeGreaterThan(0);
    }
  });

  it('llm-output rate is higher than llm-input rate (matches every vendor pricing)', () => {
    expect(DEFAULT_COST_RATES.llmCentsPer1kOutputTokens).toBeGreaterThan(
      DEFAULT_COST_RATES.llmCentsPer1kInputTokens,
    );
  });

  it('egress is more expensive per unit than storage (R2 free-egress aside, TURN egress dominates)', () => {
    expect(DEFAULT_COST_RATES.egressCentsPerGb).toBeGreaterThan(
      DEFAULT_COST_RATES.storageCentsPerGbMonth,
    );
  });
});

describe('V-541.F deriveThresholdsFromMonthlyPrice', () => {
  it('soft = round(P × 0.6), hard = round(P × 0.9)', () => {
    const t = deriveThresholdsFromMonthlyPrice(10_000);
    expect(t.softCents).toBe(6_000);
    expect(t.hardCents).toBe(9_000);
  });

  it('rounds non-integer results', () => {
    const t = deriveThresholdsFromMonthlyPrice(333);
    // 333 × 0.6 = 199.8 → 200; 333 × 0.9 = 299.7 → 300.
    expect(t.softCents).toBe(200);
    expect(t.hardCents).toBe(300);
  });

  it('hard is always > soft (the formula assumes P > 0)', () => {
    for (const price of [100, 2500, 5000, 100000]) {
      const t = deriveThresholdsFromMonthlyPrice(price);
      expect(t.hardCents).toBeGreaterThan(t.softCents);
    }
  });
});

describe('V-541.F DEFAULT_TIER_THRESHOLDS_DERIVED — derivation matches price table', () => {
  it('contains an entry for every priced tier', () => {
    for (const tier of Object.keys(TIER_MONTHLY_PRICE_CENTS)) {
      expect(DEFAULT_TIER_THRESHOLDS_DERIVED[tier]).toBeDefined();
    }
  });

  it('thresholds round-trip the derive helper', () => {
    for (const [tier, price] of Object.entries(TIER_MONTHLY_PRICE_CENTS)) {
      if (price === undefined) continue;
      const expected = deriveThresholdsFromMonthlyPrice(price);
      expect(DEFAULT_TIER_THRESHOLDS_DERIVED[tier]).toEqual(expected);
    }
  });

  it('solo_manual derives to (4740, 7110) — a sanity-check on the table', () => {
    // $79/mo × 0.6 = $47.40 soft, × 0.9 = $71.10 hard. Catches accidental
    // edits to TIER_MONTHLY_PRICE_CENTS that would silently re-anchor
    // the soft/hard alert bands for every existing customer.
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.solo_manual).toEqual({
      softCents: 4740,
      hardCents: 7110,
    });
  });
});
