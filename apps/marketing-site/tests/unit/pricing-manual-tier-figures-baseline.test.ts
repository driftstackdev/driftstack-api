// W328.B — drift guard for Manual ladder pricing figures
// (solo / team / agency). Customer-quotable numbers — pin them so
// an accidental refactor can't silently mutate pricing.

import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';

interface ExpectedManual {
  id: string;
  monthlyUsd: number;
  annualMonthlyEquivalentUsd: number;
  concurrent: number;
  profiles: number;
}

const EXPECTED: ExpectedManual[] = [
  {
    id: 'solo_manual',
    monthlyUsd: 79,
    annualMonthlyEquivalentUsd: 63,
    concurrent: 1,
    profiles: 10,
  },
  {
    id: 'team_manual',
    monthlyUsd: 249,
    annualMonthlyEquivalentUsd: 199,
    concurrent: 3,
    profiles: 50,
  },
  {
    id: 'agency_manual',
    monthlyUsd: 699,
    annualMonthlyEquivalentUsd: 559,
    concurrent: 8,
    profiles: 200,
  },
];

describe('W328.B Manual ladder pricing figures baseline', () => {
  for (const exp of EXPECTED) {
    it(`${exp.id} carries the canonical monthly / annual / concurrent / profiles figures`, () => {
      const tier = API_TIERS.find((t) => t.id === exp.id);
      expect(tier).toBeDefined();
      expect(tier!.monthlyUsd).toBe(exp.monthlyUsd);
      expect(tier!.annualMonthlyEquivalentUsd).toBe(exp.annualMonthlyEquivalentUsd);
      expect(tier!.concurrent).toBe(exp.concurrent);
      expect(tier!.profiles).toBe(exp.profiles);
    });
  }

  it('Manual ladder annual is ~20% off monthly', () => {
    for (const exp of EXPECTED) {
      const tier = API_TIERS.find((t) => t.id === exp.id)!;
      const ratio = tier.annualMonthlyEquivalentUsd! / tier.monthlyUsd!;
      expect(ratio).toBeGreaterThan(0.79);
      expect(ratio).toBeLessThan(0.81);
    }
  });

  it('team_manual is the highlighted (recommended) tier', () => {
    const team = API_TIERS.find((t) => t.id === 'team_manual')!;
    expect(team.highlight).toBe(true);
  });

  it('solo_manual ships without the AI agent toggle (manual-only persona)', () => {
    const solo = API_TIERS.find((t) => t.id === 'solo_manual')!;
    expect(solo.aiAgent).toBe(false);
  });
});
