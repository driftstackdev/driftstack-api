// Usage service — aggregates usage_records for the current billing period
// and pairs the totals with tier quotas.
//
// Period definition (Phase 6 default): calendar month UTC. The period start
// is `YYYY-MM-01T00:00:00Z`; end is the start of the next month. Customers
// who need finer granularity can wire in a per-account billing-anchor field
// later (out of scope for Phase 6).

import type { AccountContext } from './auth.js';
import type { AccountTier } from '@driftstack/api-types';

// FUTURE-SELF NOTE — `session_minute` rename to `browser_hour` is
// deferred to Workstream D (Stripe Meter integration). The unit name
// is misleading: this column stores **minutes** of session time (one
// row per minute of active session). The customer-facing meter is
// browser-hours (file 127 + V-061), so summary-layer code rolls this
// up via `floor(session_minute_total / 60) = browser_hour_total`. The
// rename is a coordinated breaking change (Postgres enum migration +
// 3-SDK regen + OpenAPI version bump) and bundles cleanly with the
// Stripe Meter event-name introduction in Workstream D — doing it
// twice would create churn. Until then: anywhere code references
// `session_minute`, treat the value as a minute-granular ledger and
// translate to hours at the API/UI boundary.
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
// Tier quotas. null = unmetered.
// ───────────────────────────────────────────────────────────────────────────

// Per ADR-004: paid tiers are concurrent-only; hours metering exists
// ONLY for the trial pack (via `accounts.trial_pack_credit_cents`
// decrement at session_end per ADR-003 — independent of this map).
// All TIER_QUOTAS values are now `null` (unmetered) across every
// tier; the `session_minute` usage_record_type stays as the granular
// ledger primitive for analytics + abuse detection but is not gated
// against a per-tier cap. Operation-count meters (navigate / interact
// / wait / state_capture / screenshot_capture) likewise remain
// unmetered scaffolding.
//
// V-073 NOTE: this map is preserved with `null` values rather than
// removed entirely so the `/v1/usage` summary response shape (which
// returns `quotas: Record<UsageRecordType, number | null>`) doesn't
// change. The customer-visible signal is "no per-meter caps at this
// tier" rather than the absence of the field.
const TIER_QUOTAS: Record<AccountTier, Record<UsageRecordType, number | null>> = {
  trial_pack: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
  solo_manual: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
  team_manual: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
  agency_manual: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
  api_starter: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
  api_builder: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
  },
  api_scale: {
    session_minute: null,
    navigate: null,
    interact: null,
    wait: null,
    state_capture: null,
    screenshot_capture: null,
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

/** V-170 — one daily bucket of usage totals. Date is the UTC day in `YYYY-MM-DD`. */
export interface UsageDailyBucket {
  date: string;
  totals: Partial<Record<UsageRecordType, number>>;
}

export interface UsageRepo {
  totalsForPeriod(accountId: string, periodStart: Date, periodEnd: Date): Promise<UsageTotals>;
  /**
   * V-170 — daily aggregation in `[fromDate, toDate)` (toDate exclusive).
   * Returns one bucket per UTC day, INCLUDING days with zero usage
   * (caller can render gaps as zeros without filling missing dates).
   * Buckets are ordered ascending by date.
   */
  dailyBucketsForRange(
    accountId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<readonly UsageDailyBucket[]>;
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
    return this.summaryFor(ctx.account.id, ctx.account.tier, now);
  }

  /**
   * Admin-flavoured summary: look up another account's totals + quotas
   * by id + tier. The route layer is responsible for permission
   * enforcement (admin scope) and for fetching the target tier.
   */
  async summaryFor(
    accountId: string,
    tier: AccountTier,
    now: Date = new Date(),
  ): Promise<UsageSummary> {
    const periodStart = monthStartUtc(now);
    const periodEnd = nextMonthStartUtc(periodStart);

    const { totals } = await this.repo.totalsForPeriod(accountId, periodStart, periodEnd);

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
      tier,
      totals: fullTotals,
      quotas: TIER_QUOTAS[tier],
    };
  }

  /**
   * V-170 — daily series for the most recent N days (default 30, max 90).
   * Returns one bucket per UTC day in [fromDate, now), inclusive of days
   * with zero usage. Customer-dashboard /usage sparklines consume this.
   *
   * Today the buckets are all empty because usage_records writers
   * aren't wired in production code (per V-014/V-015 amendment +
   * usage.ts:51-53 comment). The endpoint returns the contract shape
   * with zeros; once writers land, the dashboard auto-populates.
   */
  async dailySeries(
    ctx: AccountContext,
    days: number = 30,
    now: Date = new Date(),
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{
    fromDate: string;
    toDate: string;
    buckets: readonly UsageDailyBucket[];
  }> {
    const clampedDays = Math.max(1, Math.min(days, 90));
    const toDate = dayStartUtc(now);
    const fromDate = new Date(toDate.getTime() - clampedDays * 24 * 60 * 60 * 1000);
    // V-330e — pull the OWNER's daily buckets when called via team
    // RBAC. Tier-derived quotas don't apply to the series response
    // shape (it's just bucket counts), so we don't need the owner's
    // tier here.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const raw = await this.repo.dailyBucketsForRange(accountId, fromDate, toDate);

    // Fill missing days with empty buckets so the response is contiguous
    // (sparkline rendering doesn't need to handle gaps).
    const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>();
    for (const b of raw) byDate.set(b.date, b.totals);

    const buckets: UsageDailyBucket[] = [];
    for (let i = 0; i < clampedDays; i += 1) {
      const day = new Date(fromDate.getTime() + i * 24 * 60 * 60 * 1000);
      const dateStr = day.toISOString().slice(0, 10);
      buckets.push({ date: dateStr, totals: byDate.get(dateStr) ?? {} });
    }

    return {
      fromDate: fromDate.toISOString().slice(0, 10),
      toDate: toDate.toISOString().slice(0, 10),
      buckets,
    };
  }
}

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStartUtc(monthStart: Date): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
}
