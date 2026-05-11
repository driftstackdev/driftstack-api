// V-541.H — unit tests for the production UsageAggregator + the
// billing-cycle window helper.

import { describe, expect, it, vi } from 'vitest';
import {
  UsageAggregatorFromUsageRepo,
  billingCycleWindow,
} from '../../src/services/cost-aggregator.js';
import type { UsageRepo, UsageTotals } from '../../src/services/usage.js';

function makeRepo(totals: UsageTotals['totals']): {
  repo: UsageRepo;
  totalsSpy: ReturnType<typeof vi.fn>;
} {
  const totalsSpy = vi.fn(() => Promise.resolve<UsageTotals>({ totals }));
  const repo: UsageRepo = {
    totalsForPeriod: totalsSpy,
    dailyBucketsForRange: () => Promise.resolve([]),
  };
  return { repo, totalsSpy };
}

describe('V-541.H billingCycleWindow', () => {
  it('maps 2026-05 → [May-1, Jun-1) UTC', () => {
    const w = billingCycleWindow('2026-05');
    expect(w?.start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(w?.end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('rolls over to next year for December', () => {
    const w = billingCycleWindow('2026-12');
    expect(w?.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(w?.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('returns null for malformed input', () => {
    expect(billingCycleWindow('not-a-cycle')).toBeNull();
    expect(billingCycleWindow('2026-13')).toBeNull();
    expect(billingCycleWindow('2026-00')).toBeNull();
    expect(billingCycleWindow('26-05')).toBeNull();
  });
});

describe('V-541.H UsageAggregatorFromUsageRepo', () => {
  it('returns null when the account has zero session minutes', async () => {
    const { repo } = makeRepo({});
    const agg = new UsageAggregatorFromUsageRepo({ repo });
    const result = await agg.aggregateForAccount({
      accountId: 'acc_1',
      billingCycle: '2026-05',
    });
    expect(result).toBeNull();
  });

  it('returns null on malformed billing_cycle without touching the repo', async () => {
    const { repo, totalsSpy } = makeRepo({});
    const agg = new UsageAggregatorFromUsageRepo({ repo });
    const result = await agg.aggregateForAccount({
      accountId: 'acc_1',
      billingCycle: 'garbage',
    });
    expect(result).toBeNull();
    expect(totalsSpy).not.toHaveBeenCalled();
  });

  it('returns session minutes from the repo + zeros for unmetered dimensions', async () => {
    const { repo, totalsSpy } = makeRepo({ session_minute: 1234 });
    const agg = new UsageAggregatorFromUsageRepo({ repo });
    const result = await agg.aggregateForAccount({
      accountId: 'acc_1',
      billingCycle: '2026-05',
    });
    expect(result).toEqual({
      sessionMinutes: 1234,
      storageGbMonths: 0,
      egressGb: 0,
      emailSends: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    });
    // The repo is called with the resolved billing-cycle window.
    expect(totalsSpy).toHaveBeenCalledTimes(1);
    const call = totalsSpy.mock.calls[0] as [string, Date, Date] | undefined;
    expect(call?.[0]).toBe('acc_1');
    expect(call?.[1].toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(call?.[2].toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('ignores usage record types other than session_minute (V-541.I/J/K follow-ups)', async () => {
    const { repo } = makeRepo({
      session_minute: 60,
      navigate: 100,
      interact: 200,
      wait: 5,
      state_capture: 0,
      screenshot_capture: 3,
    });
    const agg = new UsageAggregatorFromUsageRepo({ repo });
    const result = await agg.aggregateForAccount({
      accountId: 'acc_1',
      billingCycle: '2026-05',
    });
    // Only session_minute lands in the envelope; nav/interact/etc
    // do not have a cost-line representation today.
    expect(result?.sessionMinutes).toBe(60);
    expect(result?.storageGbMonths).toBe(0);
  });
});
