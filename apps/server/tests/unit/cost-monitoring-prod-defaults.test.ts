// V-541.G — verifies the production CostMonitoringService wiring
// uses the centralised DEFAULT_COST_RATES + DEFAULT_TIER_THRESHOLDS_DERIVED.
// Bootstrap can't be unit-tested in full without spinning up Postgres,
// so this test reconstructs the service with the same constants and
// pins the contract that downstream routes depend on (specifically:
// the threshold band a known-tier customer lands in for a known usage
// breakdown matches the derived-from-price table, not some hand-tuned
// magic number scattered through fixtures).

import { describe, expect, it } from 'vitest';
import { CostMonitoringService } from '../../src/services/cost-monitoring.js';
import {
  DEFAULT_COST_RATES,
  DEFAULT_TIER_THRESHOLDS_DERIVED,
} from '../../src/lib/cost-defaults.js';

const EMPTY_USAGE = {
  sessionMinutes: 0,
  storageGbMonths: 0,
  egressGb: 0,
  emailSends: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
};

function makeService(tierByAccount: Record<string, string>) {
  return new CostMonitoringService({
    aggregator: {
      aggregateForAccount: ({ accountId }) =>
        Promise.resolve(
          accountId in tierByAccount
            ? { ...EMPTY_USAGE, sessionMinutes: 4000, llmInputTokens: 500_000 }
            : null,
        ),
    },
    rates: DEFAULT_COST_RATES,
    tierThresholds: DEFAULT_TIER_THRESHOLDS_DERIVED,
    resolveTier: (id) => Promise.resolve(tierByAccount[id] ?? null),
  });
}

describe('V-541.G — production cost-monitoring wiring', () => {
  it('uses DEFAULT_COST_RATES → solo_manual breakdown is computed against the centralised rate card', async () => {
    const svc = makeService({ acc_solo: 'solo_manual' });
    const summary = await svc.getAccountSummary({
      accountId: 'acc_solo',
      billingCycle: '2026-05',
    });
    expect(summary).not.toBeNull();
    // Centralised rates: compute=0.05 cents/min × 4000 = 200 cents.
    expect(summary?.breakdown.computeCents).toBe(200);
    // LLM input: 500k tokens / 1000 × 0.5 cents (Opus 4.7 list) = 250 cents.
    expect(summary?.breakdown.llmCents).toBe(250);
    // Total is the sum.
    expect(summary?.breakdown.totalCents).toBe(450);
  });

  it('uses DEFAULT_TIER_THRESHOLDS_DERIVED → solo_manual carries (4740, 7110) — derived-from-price, not hand-tuned', async () => {
    const svc = makeService({ acc_solo: 'solo_manual' });
    const summary = await svc.getAccountSummary({
      accountId: 'acc_solo',
      billingCycle: '2026-05',
    });
    expect(summary?.thresholds).toEqual({ softCents: 4740, hardCents: 7110 });
  });

  it('returns null when the account has no usage (stub aggregator behaviour)', async () => {
    const svc = makeService({});
    const summary = await svc.getAccountSummary({
      accountId: 'acc_unknown',
      billingCycle: '2026-05',
    });
    expect(summary).toBeNull();
  });
});
