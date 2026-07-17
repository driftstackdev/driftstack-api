// V-541.B — unit tests for CostMonitoringService.

import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_CYCLE_PATTERN,
  CostThresholdConfigurationError,
  billingCycleFromDate,
  CostMonitoringService,
  type UsageAggregator,
} from '../../src/services/cost-monitoring.js';
import type { CostRates, UsageInputs } from '../../src/lib/cost-estimator.js';

const RATES: CostRates = {
  computeCentsPerMinute: 1,
  storageCentsPerGbMonth: 2,
  egressCentsPerGb: 5,
  emailCentsPerSend: 1,
  llmCentsPer1kInputTokens: 30,
  llmCentsPer1kOutputTokens: 150,
};

const EMPTY: UsageInputs = {
  sessionMinutes: 0,
  storageGbMonths: 0,
  egressGb: 0,
  emailSends: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
};

function makeAggregator(rows: Map<string, UsageInputs>): UsageAggregator {
  return {
    aggregateForAccount: ({ accountId }) => Promise.resolve(rows.get(accountId) ?? null),
  };
}

describe('V-541.B billingCycleFromDate', () => {
  it('formats UTC year-month with leading zero', () => {
    expect(billingCycleFromDate(new Date('2026-01-15T00:00:00Z'))).toBe('2026-01');
    expect(billingCycleFromDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('accepts only real two-digit calendar months', () => {
    expect(BILLING_CYCLE_PATTERN.test('2026-01')).toBe(true);
    expect(BILLING_CYCLE_PATTERN.test('2026-12')).toBe(true);
    expect(BILLING_CYCLE_PATTERN.test('2026-00')).toBe(false);
    expect(BILLING_CYCLE_PATTERN.test('2026-13')).toBe(false);
  });
});

describe('V-541.B getAccountSummary', () => {
  it('returns breakdown + tier + thresholds when usage exists', async () => {
    const aggregator = makeAggregator(new Map([['acc_a', { ...EMPTY, sessionMinutes: 120 }]]));
    const svc = new CostMonitoringService({
      aggregator,
      rates: RATES,
      resolveTier: () => Promise.resolve('api_builder'),
    });
    const r = await svc.getAccountSummary({ accountId: 'acc_a', billingCycle: '2026-05' });
    expect(r).not.toBeNull();
    expect(r?.tier).toBe('api_builder');
    expect(r?.breakdown.computeCents).toBe(120);
    expect(r?.breakdown.totalCents).toBe(120);
    expect(r?.thresholds.softCents).toBeGreaterThan(0);
  });

  it('returns null when the aggregator has no row for the account', async () => {
    const svc = new CostMonitoringService({
      aggregator: makeAggregator(new Map()),
      rates: RATES,
      resolveTier: () => Promise.resolve('api_builder'),
    });
    expect(
      await svc.getAccountSummary({ accountId: 'acc_missing', billingCycle: '2026-05' }),
    ).toBeNull();
  });

  it('returns null when resolveTier returns null (unknown account)', async () => {
    const svc = new CostMonitoringService({
      aggregator: makeAggregator(new Map([['acc_a', { ...EMPTY, sessionMinutes: 1 }]])),
      rates: RATES,
      resolveTier: () => Promise.resolve(null),
    });
    expect(await svc.getAccountSummary({ accountId: 'acc_a', billingCycle: '2026-05' })).toBeNull();
  });

  it('fails closed when the resolved tier has no exact threshold configuration', async () => {
    const aggregateForAccount = vi.fn(() =>
      Promise.resolve<UsageInputs | null>({ ...EMPTY, sessionMinutes: 1 }),
    );
    const svc = new CostMonitoringService({
      aggregator: { aggregateForAccount },
      rates: RATES,
      tierThresholds: { api_starter: { softCents: 3000, hardCents: 6000 } },
      resolveTier: () => Promise.resolve('free'),
    });

    await expect(
      svc.getAccountSummary({ accountId: 'acc_free', billingCycle: '2026-05' }),
    ).rejects.toEqual(expect.any(CostThresholdConfigurationError));
    await expect(
      svc.getAccountSummary({ accountId: 'acc_free', billingCycle: '2026-05' }),
    ).rejects.toMatchObject({ tier: 'free' });
    expect(aggregateForAccount).not.toHaveBeenCalled();
  });

  it('does not synthesize an empty-cycle result when its tier threshold is unconfigured', async () => {
    const aggregateForAccount = vi.fn(() => Promise.resolve<UsageInputs | null>(null));
    const svc = new CostMonitoringService({
      aggregator: { aggregateForAccount },
      rates: RATES,
      tierThresholds: { api_starter: { softCents: 3000, hardCents: 6000 } },
      resolveTier: () => Promise.resolve('enterprise'),
    });

    await expect(
      svc.getAccountSummary({ accountId: 'acc_enterprise', billingCycle: '2026-05' }),
    ).rejects.toThrow('No cost alert thresholds are configured for tier "enterprise".');
    expect(aggregateForAccount).not.toHaveBeenCalled();
  });

  it('threshold_state reflects the configured per-tier thresholds', async () => {
    const aggregator = makeAggregator(new Map([['acc_a', { ...EMPTY, sessionMinutes: 100_000 }]]));
    const svc = new CostMonitoringService({
      aggregator,
      rates: RATES,
      tierThresholds: { solo_manual: { softCents: 1000, hardCents: 5000 } },
      resolveTier: () => Promise.resolve('solo_manual'),
    });
    const r = await svc.getAccountSummary({ accountId: 'acc_a', billingCycle: '2026-05' });
    expect(r?.breakdown.thresholdState).toBe('over-hard');
  });
});

describe('V-541.B getOverview', () => {
  it('returns one summary per account that has usage; omits empty ones', async () => {
    const aggregator = makeAggregator(
      new Map([
        ['acc_a', { ...EMPTY, sessionMinutes: 100 }],
        ['acc_b', { ...EMPTY, storageGbMonths: 50 }],
        // acc_c absent → omitted from result.
      ]),
    );
    const svc = new CostMonitoringService({
      aggregator,
      rates: RATES,
      resolveTier: () => Promise.resolve('api_builder'),
    });
    const summaries = await svc.getOverview({
      accountIds: ['acc_a', 'acc_b', 'acc_c'],
      billingCycle: '2026-05',
    });
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.account_id).sort()).toEqual(['acc_a', 'acc_b']);
  });

  it('sorts summaries by totalCents descending', async () => {
    const aggregator = makeAggregator(
      new Map([
        ['acc_small', { ...EMPTY, sessionMinutes: 10 }],
        ['acc_big', { ...EMPTY, sessionMinutes: 10_000 }],
        ['acc_mid', { ...EMPTY, sessionMinutes: 500 }],
      ]),
    );
    const svc = new CostMonitoringService({
      aggregator,
      rates: RATES,
      resolveTier: () => Promise.resolve('api_builder'),
    });
    const summaries = await svc.getOverview({
      accountIds: ['acc_small', 'acc_big', 'acc_mid'],
      billingCycle: '2026-05',
    });
    expect(summaries.map((s) => s.account_id)).toEqual(['acc_big', 'acc_mid', 'acc_small']);
  });

  it('calls the aggregator exactly once per account', async () => {
    const aggregate = vi.fn(() => Promise.resolve({ ...EMPTY, sessionMinutes: 1 }));
    const aggregator: UsageAggregator = { aggregateForAccount: aggregate };
    const svc = new CostMonitoringService({
      aggregator,
      rates: RATES,
      resolveTier: () => Promise.resolve('api_builder'),
    });
    await svc.getOverview({
      accountIds: ['acc_a', 'acc_b', 'acc_c'],
      billingCycle: '2026-05',
    });
    expect(aggregate).toHaveBeenCalledTimes(3);
  });

  it('rejects the whole batch rather than returning partial summaries under a borrowed threshold', async () => {
    const aggregator = makeAggregator(
      new Map([
        ['acc_configured', { ...EMPTY, sessionMinutes: 100 }],
        ['acc_unconfigured', { ...EMPTY, sessionMinutes: 200 }],
      ]),
    );
    const svc = new CostMonitoringService({
      aggregator,
      rates: RATES,
      tierThresholds: { api_builder: { softCents: 1000, hardCents: 2000 } },
      resolveTier: (accountId) =>
        Promise.resolve(accountId === 'acc_configured' ? 'api_builder' : 'free'),
    });

    await expect(
      svc.getOverview({
        accountIds: ['acc_configured', 'acc_unconfigured'],
        billingCycle: '2026-05',
      }),
    ).rejects.toMatchObject({ name: 'CostThresholdConfigurationError', tier: 'free' });
  });
});
