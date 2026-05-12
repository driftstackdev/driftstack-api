// W326.B — drift guard for API_TIERS monthly + annual figures
// (api ladder). The numbers are price-sensitive and customer-quoted;
// pin them so a refactor can't silently mutate pricing. Numbers
// derived from the data module are the source of truth — this test
// pins the values themselves to known-good figures (drift would
// likely indicate an unintended pricing change).

import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';

interface ExpectedApi {
  id: string;
  monthlyUsd: number;
  annualMonthlyEquivalentUsd: number;
  concurrent: number;
  profiles: number;
}

const EXPECTED: ExpectedApi[] = [
  {
    id: 'api_starter',
    monthlyUsd: 149,
    annualMonthlyEquivalentUsd: 119,
    concurrent: 2,
    profiles: 25,
  },
  {
    id: 'api_builder',
    monthlyUsd: 499,
    annualMonthlyEquivalentUsd: 399,
    concurrent: 8,
    profiles: 100,
  },
  {
    id: 'api_scale',
    monthlyUsd: 1_499,
    annualMonthlyEquivalentUsd: 1_199,
    concurrent: 24,
    profiles: 500,
  },
];

describe('W326.B /pricing API_TIERS figures baseline', () => {
  for (const exp of EXPECTED) {
    it(`${exp.id} carries the canonical monthly + annual + concurrent + profiles figures`, () => {
      const tier = API_TIERS.find((t) => t.id === exp.id);
      expect(tier).toBeDefined();
      expect(tier!.monthlyUsd).toBe(exp.monthlyUsd);
      expect(tier!.annualMonthlyEquivalentUsd).toBe(exp.annualMonthlyEquivalentUsd);
      expect(tier!.concurrent).toBe(exp.concurrent);
      expect(tier!.profiles).toBe(exp.profiles);
    });
  }

  it('enterprise tier is contact-sales (no fixed monthly)', () => {
    const ent = API_TIERS.find((t) => t.id === 'enterprise');
    expect(ent).toBeDefined();
    expect(ent!.monthlyUsd).toBeNull();
    expect(ent!.concurrent).toBe('Custom');
    expect(ent!.profiles).toBe('Custom');
  });

  it('annual is uniformly ~20% off monthly (matches ANNUAL_DISCOUNT_LABEL claim)', () => {
    for (const exp of EXPECTED) {
      const tier = API_TIERS.find((t) => t.id === exp.id)!;
      const ratio = tier.annualMonthlyEquivalentUsd! / tier.monthlyUsd!;
      // ~0.8 ± 0.01 (the 1199/1499 ratio is the loosest, ~0.7998)
      expect(ratio).toBeGreaterThan(0.79);
      expect(ratio).toBeLessThan(0.81);
    }
  });
});
