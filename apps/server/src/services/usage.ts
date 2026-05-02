// Usage service — aggregates usage_records for the current billing period
// and pairs the totals with tier quotas.
//
// Period definition (Phase 6 default): calendar month UTC. The period start
// is `YYYY-MM-01T00:00:00Z`; end is the start of the next month. Customers
// who need finer granularity can wire in a per-account billing-anchor field
// later (out of scope for Phase 6).

import type { AccountContext } from './auth.js';
import type { AccountTier } from '@driftstack/api-types';

export type UsageRecordType =
  | 'session_minute'
  | 'navigate'
  | 'interact'
  | 'wait'
  | 'state_capture'
  | 'screenshot_capture';

const ALL_TYPES: UsageRecordType[] = [
  'session_minute',
  'navigate',
  'interact',
  'wait',
  'state_capture',
  'screenshot_capture',
];

// ───────────────────────────────────────────────────────────────────────────
// Tier quotas. null = unmetered (enterprise-only by default).
// ───────────────────────────────────────────────────────────────────────────

const TIER_QUOTAS: Record<AccountTier, Record<UsageRecordType, number | null>> = {
  free: {
    session_minute: 60,
    navigate: 100,
    interact: 200,
    wait: 200,
    state_capture: 100,
    screenshot_capture: 50,
  },
  starter: {
    session_minute: 1_500,
    navigate: 5_000,
    interact: 10_000,
    wait: 10_000,
    state_capture: 5_000,
    screenshot_capture: 2_500,
  },
  pro: {
    session_minute: 30_000,
    navigate: 100_000,
    interact: 200_000,
    wait: 200_000,
    state_capture: 100_000,
    screenshot_capture: 50_000,
  },
  enterprise: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Repo interface
// ───────────────────────────────────────────────────────────────────────────

export interface UsageTotals {
  totals: Partial<Record<UsageRecordType, number>>;
}

export interface UsageRepo {
  totalsForPeriod(accountId: string, periodStart: Date, periodEnd: Date): Promise<UsageTotals>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export interface UsageSummary {
  periodStart: Date;
  periodEnd: Date;
  tier: AccountTier;
  totals: Record<UsageRecordType, number>;
  quotas: Record<UsageRecordType, number | null>;
}

export class UsageService {
  constructor(private readonly repo: UsageRepo) {}

  async currentPeriodSummary(ctx: AccountContext, now: Date = new Date()): Promise<UsageSummary> {
    const periodStart = monthStartUtc(now);
    const periodEnd = nextMonthStartUtc(periodStart);

    const { totals } = await this.repo.totalsForPeriod(ctx.account.id, periodStart, periodEnd);

    const fullTotals: Record<UsageRecordType, number> = {
      session_minute: 0,
      navigate: 0,
      interact: 0,
      wait: 0,
      state_capture: 0,
      screenshot_capture: 0,
    };
    for (const t of ALL_TYPES) {
      fullTotals[t] = totals[t] ?? 0;
    }

    return {
      periodStart,
      periodEnd,
      tier: ctx.account.tier,
      totals: fullTotals,
      quotas: TIER_QUOTAS[ctx.account.tier],
    };
  }
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStartUtc(monthStart: Date): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
}
