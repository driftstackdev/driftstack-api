// S14 audit fixes #2, #3 and #6 — `buildAccountAiState` /
// `buildLegacyAccountAiState` (services/ai-account-state.ts), the pure
// composition behind `GET /v1/account/me/ai`.
//
// #2: debt, pending claims and held credit are amounts the account OWES or
// has committed, so they round UP like a charge. Rounded down, 500 µcr of
// debt read `blocked_reason: 'debt'` beside `debt_credits: 0` — a customer
// told they are blocked for a debt of nothing.
//
// #3: `monthly.remaining_credits` already excluded what a running task holds
// on the monthly lot; each extra lot's `remaining_credits` did not, so the
// parts added up to MORE than `available_credits` (the audit's
// "monthly 40, extras 100, available 80").
//
// #6: `plan.monthly_included_credits` ignored `credit_plan_overrides`, so an
// Enterprise account with a signed contract always read `null` and an
// admin-assigned plan read the tier default instead of the figure it is
// granted. A LIVE override's figure is now shown; `null` only for an
// Enterprise account with none.
//
// The S13–S16 re-audit (#2) narrowed that to the figure the grant ACTUALLY
// uses (`planMonthlyIncludedCredits`): the current window's level when there is
// one, else the higher of the tier's figure and a live override's, a 0-credit
// override counting as none. Proved through the real route in
// the-ai-plan-figure-is-the-figure-the-monthly-grant-uses.test.ts.

import { describe, expect, it } from 'vitest';
import { AccountAiStateSchema } from '@driftstack/api-types';
import {
  buildAccountAiState,
  buildLegacyAccountAiState,
  livePlanOverrideCredits,
  planMonthlyIncludedCredits,
  type AccountAiStateInputs,
} from '../../src/services/ai-account-state.js';

const MICRO = 1_000_000;
const AT = new Date('2026-06-15T00:00:00Z');

function state(over: Partial<AccountAiStateInputs> = {}): AccountAiStateInputs {
  return {
    tier: 'team_manual',
    aiSource: 'credits',
    aiSourceSetBy: 'customer',
    ownKey: { hasKey: false, usable: false, setAt: null, expiresAt: null },
    currentWindow: {
      windowStart: '2026-06-01T00:00:00.000000Z',
      windowEnd: '2026-07-01T00:00:00.000000Z',
    },
    monthlyLot: { grantedMicro: 100 * MICRO, remainingMicro: 100 * MICRO, heldMicro: 0 },
    extraLots: [],
    availableMicro: 100 * MICRO,
    reservedInFlightMicro: 0,
    pendingClaimsMicro: 0,
    debtMicro: 0,
    debtReason: null,
    tasksInFlight: 0,
    minStartMicro: 3 * MICRO,
    planMonthlyIncludedCredits: 5_000,
    rateCard: { version: 1, effectiveAt: new Date('2026-01-01T00:00:00Z') },
    nextRateCard: null,
    ...over,
  };
}

describe('owed and committed credit rounds UP (#2)', () => {
  it('CRITICAL 500 µcr of debt reads 0.001 beside blocked_reason debt — never "blocked for a debt of 0"', () => {
    const body = buildAccountAiState(
      state({ debtMicro: 500, debtReason: 'payment_reversed', availableMicro: 0 }),
    );
    expect(body.blocked_reason).toBe('debt');
    expect(body.debt_reason).toBe('payment_reversed');
    expect(body.balance.debt_credits).toBe(0.001);
  });

  it('CRITICAL a pending claim of one microcredit reads 0.001, not 0', () => {
    expect(
      buildAccountAiState(state({ pendingClaimsMicro: 1 })).balance.pending_claims_credits,
    ).toBe(0.001);
  });

  it('CRITICAL credit a running task holds reads rounded up: 1,000,001 µcr is 1.001', () => {
    expect(
      buildAccountAiState(state({ reservedInFlightMicro: 1_000_001, tasksInFlight: 1 })).balance
        .reserved_in_flight_credits,
    ).toBe(1.001);
  });

  it('what the account HAS still rounds down: 1,000,999 µcr available is 1', () => {
    expect(
      buildAccountAiState(state({ availableMicro: 1_000_999 })).balance.available_credits,
    ).toBe(1);
  });
});

describe('an extra lot excludes what a running task holds on it (#3)', () => {
  it('CRITICAL the audit case: monthly and extras each hold 60 of 100, so they read 40 + 40 = the 80 available', () => {
    const body = buildAccountAiState(
      state({
        monthlyLot: {
          grantedMicro: 100 * MICRO,
          remainingMicro: 100 * MICRO,
          heldMicro: 60 * MICRO,
        },
        extraLots: [
          {
            kind: 'adjustment',
            remainingMicro: 100 * MICRO,
            heldMicro: 60 * MICRO,
            expiresAt: new Date('2026-08-01T00:00:00Z'),
          },
        ],
        availableMicro: 80 * MICRO,
        reservedInFlightMicro: 120 * MICRO,
        tasksInFlight: 1,
      }),
    );
    expect(body.balance.monthly?.remaining_credits).toBe(40);
    expect(body.balance.extras).toEqual([
      { kind: 'goodwill', remaining_credits: 40, expires_at: '2026-08-01T00:00:00.000Z' },
    ]);
    const parts =
      (body.balance.monthly?.remaining_credits ?? 0) +
      body.balance.extras.reduce((sum, e) => sum + e.remaining_credits, 0);
    expect(parts).toBe(body.balance.available_credits);
  });

  it('a lot held in full reads 0 remaining, never a negative', () => {
    const body = buildAccountAiState(
      state({
        extraLots: [
          {
            kind: 'top_up',
            remainingMicro: 5 * MICRO,
            heldMicro: 5 * MICRO,
            expiresAt: new Date('2027-01-01T00:00:00Z'),
          },
        ],
      }),
    );
    expect(body.balance.extras[0]?.remaining_credits).toBe(0);
  });
});

describe('plan.monthly_included_credits reads a live plan override (#6)', () => {
  it('CRITICAL an Enterprise account with a contract and no window shows the contract figure, not null', () => {
    const figure = planMonthlyIncludedCredits({
      tier: 'enterprise',
      currentWindowLevelMicro: null,
      liveOverrideCredits: 40_000,
    });
    expect(figure).toBe(40_000);
    const body = buildAccountAiState(
      state({ tier: 'enterprise', planMonthlyIncludedCredits: figure }),
    );
    expect(body.plan.monthly_included_credits).toBe(40_000);
    expect(AccountAiStateSchema.safeParse(body).success).toBe(true);
  });

  it('CRITICAL an admin-assigned plan above the tier shows the figure the override grants, not the tier default', () => {
    expect(
      planMonthlyIncludedCredits({
        tier: 'team_manual',
        currentWindowLevelMicro: null,
        liveOverrideCredits: 7_500,
      }),
    ).toBe(7_500);
  });

  it('an Enterprise account with NO live override is the only null', () => {
    expect(
      planMonthlyIncludedCredits({
        tier: 'enterprise',
        currentWindowLevelMicro: null,
        liveOverrideCredits: null,
      }),
    ).toBeNull();
    expect(
      planMonthlyIncludedCredits({
        tier: 'team_manual',
        currentWindowLevelMicro: null,
        liveOverrideCredits: null,
      }),
    ).toBe(5_000);
  });

  it('a LEGACY account reads the figure the same way — the plan is a property of the account, not of its billing mode', () => {
    const legacy = buildLegacyAccountAiState({
      tier: 'enterprise',
      ownKey: { hasKey: false, usable: false, setAt: null, expiresAt: null },
      rateCard: { version: 1, effectiveAt: new Date('2026-01-01T00:00:00Z') },
      nextRateCard: null,
      planMonthlyIncludedCredits: 12_000,
    });
    expect(legacy.plan.monthly_included_credits).toBe(12_000);
  });
});

describe('planMonthlyIncludedCredits — the figure the grant uses (re-audit #2)', () => {
  it('CRITICAL a window over now wins over every other figure: its level is what was granted', () => {
    expect(
      planMonthlyIncludedCredits({
        tier: 'enterprise',
        currentWindowLevelMicro: 30_000 * MICRO,
        liveOverrideCredits: 20_000,
      }),
    ).toBe(30_000);
    expect(
      planMonthlyIncludedCredits({
        tier: 'team_manual',
        currentWindowLevelMicro: 3_000 * MICRO,
        liveOverrideCredits: null,
      }),
    ).toBe(3_000);
  });

  it('CRITICAL with no window the higher figure wins, as the grant picks: a 3,000 override on Team reads 5,000', () => {
    expect(
      planMonthlyIncludedCredits({
        tier: 'team_manual',
        currentWindowLevelMicro: null,
        liveOverrideCredits: 3_000,
      }),
    ).toBe(5_000);
  });

  it('a window level is shown in whole credits, rounded down', () => {
    expect(
      planMonthlyIncludedCredits({
        tier: 'team_manual',
        currentWindowLevelMicro: 5_000 * MICRO + 999_999,
        liveOverrideCredits: null,
      }),
    ).toBe(5_000);
  });
});

describe('livePlanOverrideCredits — only an override in force counts (#6)', () => {
  const base = {
    monthlyCredits: 40_000,
    anchorAt: new Date('2026-01-01T00:00:00Z'),
    effectiveSince: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  };

  it('CRITICAL a live override with no end is its figure', () => {
    expect(livePlanOverrideCredits(base, AT)).toBe(40_000);
  });

  it('none on file is null', () => {
    expect(livePlanOverrideCredits(null, AT)).toBeNull();
  });

  it('an override that has ended no longer counts', () => {
    expect(
      livePlanOverrideCredits({ ...base, endsAt: new Date('2026-06-01T00:00:00Z') }, AT),
    ).toBeNull();
  });

  it('an override ending exactly now has ended (the window predicate is at < ends_at)', () => {
    expect(livePlanOverrideCredits({ ...base, endsAt: AT }, AT)).toBeNull();
  });

  it('an override anchored in the future does not count yet', () => {
    expect(
      livePlanOverrideCredits({ ...base, anchorAt: new Date('2026-07-01T00:00:00Z') }, AT),
    ).toBeNull();
  });

  it('CRITICAL a zero-credit override counts as no override — the grant skips it (re-audit #2)', () => {
    expect(livePlanOverrideCredits({ ...base, monthlyCredits: 0 }, AT)).toBeNull();
  });
});
