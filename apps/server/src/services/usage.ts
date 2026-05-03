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
// Tier quotas. null = unmetered (enterprise-only by default).
// ───────────────────────────────────────────────────────────────────────────

// Locked pricing model — see D-019 + parent driftstack repo file 127
// (`docs/planning/127-pricing-self-hosted-strategy.md`), which
// supersedes files 8 + 39.
//
// **Primary billing meter is per-browser-hour.** The `session_minute`
// usage_record_type stays as the granular ledger primitive (one row
// per minute of active session time); the customer-facing cap is
// `session_minute_total / 60 = browser_hour_total` rolled up at
// summary time. Workstream D's Stripe-meter integration emits the
// per-browser-hour line item from the same minute-granular ledger.
//
// `session_minute` quota values below = file-127 monthly hour cap × 60
// minutes. Per-tier hour caps:
//   - free       25 hr  (one-time, 7-day trial window — full trial
//                        primitive lands in Workstream F; the value
//                        below is the "credit pool size" expressed in
//                        minutes for now)
//   - starter   100 hr/mo
//   - solo      400 hr/mo
//   - builder 1,500 hr/mo
//   - scale   6,000 hr/mo
//   - enterprise unmetered (null)
//
// Operation-count meters (navigate / interact / wait / state_capture /
// screenshot_capture) are NOT part of the file-127 pricing model.
// They remain as scaffolding for analytics + abuse detection; quotas
// here are conservative fair-use-style ceilings, not commercial
// commitments. Workstream D revisits when the Stripe meter setup
// lands.
const TIER_QUOTAS: Record<AccountTier, Record<UsageRecordType, number | null>> = {
  free: {
    session_minute: 1_500, // 25 hr (one-time, 7-day trial)
    navigate: 100,
    interact: 200,
    wait: 200,
    state_capture: 100,
    screenshot_capture: 50,
  },
  starter: {
    session_minute: 6_000, // 100 hr/mo
    navigate: 500,
    interact: 1_000,
    wait: 1_000,
    state_capture: 500,
    screenshot_capture: 250,
  },
  solo: {
    session_minute: 24_000, // 400 hr/mo
    navigate: 5_000,
    interact: 10_000,
    wait: 10_000,
    state_capture: 5_000,
    screenshot_capture: 2_500,
  },
  builder: {
    session_minute: 90_000, // 1,500 hr/mo
    navigate: 25_000,
    interact: 50_000,
    wait: 50_000,
    state_capture: 25_000,
    screenshot_capture: 12_500,
  },
  scale: {
    session_minute: 360_000, // 6,000 hr/mo
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
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStartUtc(monthStart: Date): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
}
