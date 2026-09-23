// S13–S16 re-audit, round 1, finding 7 — one monthly contract figure, one
// limit.
//
// Staff can set an account's monthly credit figure two ways: the plan-override
// PUT (`AdminSetPlanOverrideRequestSchema.monthly_credits`) and the Enterprise
// tier change (`ChangeTierRequestWithCreditsSchema.monthly_credits`). The PUT
// allowed up to 1,000,000 a month and the tier change up to 10,000,000, so a
// 2,000,000 contract written by the tier change could not be re-sent or amended
// through the PUT: a 400 for a figure already on file.
//
// Both now read ONE exported bound, `ADMIN_MONTHLY_CREDITS_MAX`: 10,000,000, the
// storage bound `credit_plan_overrides_credits_range` already enforces. The
// per-request bound for a one-off goodwill grant stays 1,000,000
// (`ADMIN_CREDITS_MAX_PER_REQUEST`): a monthly contract figure and a single
// grant are different amounts of money.

import { describe, expect, it } from 'vitest';
import * as apiTypes from '@driftstack/api-types';
import {
  AdminCreditAdjustmentRequestSchema,
  AdminSetPlanOverrideRequestSchema,
  ChangeTierRequestWithCreditsSchema,
} from '@driftstack/api-types';
import { CREDIT_PLAN_OVERRIDE_MAX_MONTHLY_CREDITS } from '../../src/db/credit-plan-overrides-repo.js';

function overrideAccepts(monthlyCredits: number): boolean {
  return AdminSetPlanOverrideRequestSchema.safeParse({
    monthly_credits: monthlyCredits,
    reason: 'contract',
  }).success;
}

function tierChangeAccepts(monthlyCredits: number): boolean {
  return ChangeTierRequestWithCreditsSchema.safeParse({
    tier: 'enterprise',
    monthly_credits: monthlyCredits,
  }).success;
}

describe('a monthly contract figure has one limit wherever staff set it', () => {
  it('CRITICAL a 2,000,000-credit contract the tier change accepts, the override PUT accepts too', () => {
    expect(tierChangeAccepts(2_000_000)).toBe(true);
    expect(overrideAccepts(2_000_000)).toBe(true);
  });

  it('CRITICAL both accept exactly 10,000,000 and both refuse 10,000,001', () => {
    expect(overrideAccepts(10_000_000)).toBe(true);
    expect(tierChangeAccepts(10_000_000)).toBe(true);
    expect(overrideAccepts(10_000_001)).toBe(false);
    expect(tierChangeAccepts(10_000_001)).toBe(false);
  });

  it('CRITICAL the two agree on every probe around both old limits and the storage bound', () => {
    for (const figure of [0, 1, 999_999, 1_000_000, 1_000_001, 9_999_999, 10_000_000, 10_000_001]) {
      expect(overrideAccepts(figure), `monthly_credits ${String(figure)}`).toBe(
        tierChangeAccepts(figure),
      );
    }
  });

  it('the one bound is exported as ADMIN_MONTHLY_CREDITS_MAX and is the storage bound the database enforces', () => {
    const bound = (apiTypes as Record<string, unknown>)['ADMIN_MONTHLY_CREDITS_MAX'];
    expect(bound).toBe(10_000_000);
    expect(bound).toBe(CREDIT_PLAN_OVERRIDE_MAX_MONTHLY_CREDITS);
  });
});

describe('a single goodwill grant keeps its own, tighter limit', () => {
  function goodwillAccepts(credits: number): boolean {
    return AdminCreditAdjustmentRequestSchema.safeParse({
      kind: 'goodwill',
      credits,
      expires_at: '2027-01-01T00:00:00Z',
      reason: 'r',
      idempotency_key: 'k',
    }).success;
  }

  it('goodwill accepts 1,000,000 and refuses 1,000,001 — ADMIN_CREDITS_MAX_PER_REQUEST, unchanged', () => {
    expect(apiTypes.ADMIN_CREDITS_MAX_PER_REQUEST).toBe(1_000_000);
    expect(goodwillAccepts(1_000_000)).toBe(true);
    expect(goodwillAccepts(1_000_001)).toBe(false);
  });
});
