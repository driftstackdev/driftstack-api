// V-553.B-17 — unit tests for UsageService (V-014 / V-015 / V-170 / V-330e).
//
// Surface under test:
//   - currentPeriodSummary(): scopes period to UTC calendar month
//     from the given `now`, fills missing meters with zeros, returns
//     tier-derived (currently all-null) quotas
//   - summaryFor(): admin-flavoured call with explicit accountId + tier
//   - dailySeries(): clamps days to [1, 90], fills missing days with
//     empty buckets so the array is contiguous, honours V-330e
//     effectiveAccountId redirect

import { describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import {
  UsageService,
  type UsageDailyBucket,
  type UsageRepo,
  type UsageTotals,
} from '../../src/services/usage.js';
import type { AccountContext } from '../../src/services/auth.js';

function ctxWith(accountId: string, tier: AccountTier): AccountContext {
  return {
    account: { id: accountId, tier },
    apiKey: { id: 'key_1', scopes: ['read'] },
  } as unknown as AccountContext;
}

function makeRepo(
  opts: {
    totals?: UsageTotals['totals'];
    buckets?: UsageDailyBucket[];
  } = {},
): {
  repo: UsageRepo;
  totalsCalls: Array<{ accountId: string; from: Date; to: Date }>;
  bucketsCalls: Array<{ accountId: string; from: Date; to: Date }>;
} {
  const totalsCalls: Array<{ accountId: string; from: Date; to: Date }> = [];
  const bucketsCalls: Array<{ accountId: string; from: Date; to: Date }> = [];
  const repo: UsageRepo = {
    totalsForPeriod: (accountId, from, to) => {
      totalsCalls.push({ accountId, from, to });
      return Promise.resolve({ totals: opts.totals ?? {} });
    },
    dailyBucketsForRange: (accountId, from, to) => {
      bucketsCalls.push({ accountId, from, to });
      return Promise.resolve(opts.buckets ?? []);
    },
  };
  return { repo, totalsCalls, bucketsCalls };
}

describe('V-553.B-17 UsageService.currentPeriodSummary', () => {
  it('windows the period to [month-start, next-month-start) UTC', async () => {
    const { repo, totalsCalls } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.currentPeriodSummary(
      ctxWith('acc_1', 'solo_manual'),
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(result.periodStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(result.periodEnd.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(totalsCalls[0]?.from.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(totalsCalls[0]?.to.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('fills all six meter types with zero when the repo returns nothing', async () => {
    const { repo } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.currentPeriodSummary(
      ctxWith('acc_1', 'solo_manual'),
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(result.totals).toEqual({
      session_minute: 0,
      navigate: 0,
      interact: 0,
      wait: 0,
      state_capture: 0,
      screenshot_capture: 0,
    });
  });

  it('forwards real totals from the repo for present meters', async () => {
    const { repo } = makeRepo({
      totals: { session_minute: 1200, navigate: 50 },
    });
    const svc = new UsageService(repo);
    const result = await svc.currentPeriodSummary(
      ctxWith('acc_1', 'solo_manual'),
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(result.totals.session_minute).toBe(1200);
    expect(result.totals.navigate).toBe(50);
    expect(result.totals.interact).toBe(0);
  });

  it('returns null quotas across all meters (every tier is unmetered today)', async () => {
    const { repo } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.currentPeriodSummary(
      ctxWith('acc_1', 'api_builder'),
      new Date('2026-05-11T15:00:00Z'),
    );
    for (const v of Object.values(result.quotas)) {
      expect(v).toBeNull();
    }
  });

  it('end-of-month "now" still produces the same month window', async () => {
    // 31 May 23:59Z is the last second of May — period should still be May.
    const { repo } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.currentPeriodSummary(
      ctxWith('acc_1', 'solo_manual'),
      new Date('2026-05-31T23:59:59Z'),
    );
    expect(result.periodStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(result.periodEnd.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('December rolls over to next January', async () => {
    const { repo } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.currentPeriodSummary(
      ctxWith('acc_1', 'solo_manual'),
      new Date('2026-12-15T15:00:00Z'),
    );
    expect(result.periodEnd.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('V-553.B-17 UsageService.summaryFor', () => {
  it('admin-flavoured call uses the supplied accountId + tier directly', async () => {
    const { repo, totalsCalls } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.summaryFor(
      'acc_other',
      'team_manual',
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(totalsCalls[0]?.accountId).toBe('acc_other');
    expect(result.tier).toBe('team_manual');
  });
});

describe('V-553.B-17 UsageService.dailySeries — windowing', () => {
  it('default days=30 + dayStartUtc(now) → [now-30d, now)', async () => {
    const { repo, bucketsCalls } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.dailySeries(
      ctxWith('acc_1', 'solo_manual'),
      undefined,
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(result.fromDate).toBe('2026-04-11');
    expect(result.toDate).toBe('2026-05-11');
    expect(bucketsCalls[0]?.from.toISOString()).toBe('2026-04-11T00:00:00.000Z');
    expect(bucketsCalls[0]?.to.toISOString()).toBe('2026-05-11T00:00:00.000Z');
    expect(result.buckets).toHaveLength(30);
  });

  it('clamps days < 1 to 1', async () => {
    const { repo } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.dailySeries(
      ctxWith('acc_1', 'solo_manual'),
      0,
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(result.buckets).toHaveLength(1);
  });

  it('clamps days > 90 to 90', async () => {
    const { repo } = makeRepo();
    const svc = new UsageService(repo);
    const result = await svc.dailySeries(
      ctxWith('acc_1', 'solo_manual'),
      365,
      new Date('2026-05-11T15:00:00Z'),
    );
    expect(result.buckets).toHaveLength(90);
  });

  it('fills missing days with empty buckets — contiguous output', async () => {
    const { repo } = makeRepo({
      buckets: [
        { date: '2026-05-08', totals: { session_minute: 30 } },
        { date: '2026-05-10', totals: { session_minute: 15 } },
      ],
    });
    const svc = new UsageService(repo);
    const result = await svc.dailySeries(
      ctxWith('acc_1', 'solo_manual'),
      5,
      new Date('2026-05-11T15:00:00Z'),
    );
    // 5 days back from 2026-05-11 → from 2026-05-06 (inclusive) to 2026-05-11 (exclusive).
    expect(result.buckets.map((b) => b.date)).toEqual([
      '2026-05-06',
      '2026-05-07',
      '2026-05-08',
      '2026-05-09',
      '2026-05-10',
    ]);
    const may8 = result.buckets.find((b) => b.date === '2026-05-08');
    const may9 = result.buckets.find((b) => b.date === '2026-05-09');
    expect(may8?.totals.session_minute).toBe(30);
    expect(may9?.totals).toEqual({});
  });

  it('V-330e effectiveAccountId redirects bucket lookup to OWNER', async () => {
    const { repo, bucketsCalls } = makeRepo();
    const svc = new UsageService(repo);
    await svc.dailySeries(
      ctxWith('acc_member', 'solo_manual'),
      7,
      new Date('2026-05-11T15:00:00Z'),
      { effectiveAccountId: 'acc_owner' },
    );
    expect(bucketsCalls[0]?.accountId).toBe('acc_owner');
  });
});
