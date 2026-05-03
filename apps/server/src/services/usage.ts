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
