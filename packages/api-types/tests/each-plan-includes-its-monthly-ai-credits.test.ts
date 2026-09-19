// Each plan includes the monthly AI credits it was sold with, and only the plans
// allowed their own provider key may use one.
//
// The figures are the owner's, and they are written here as literals ON PURPOSE:
// a test that read them back from the table it checks would agree with any
// edit. Enterprise has no plan-wide number — each account's comes from a
// contract an admin sets — so the table says 'contract', never a default.

import { describe, expect, it } from 'vitest';
import {
  AI_PLAN_ENTITLEMENTS,
  MICROCREDITS_PER_CREDIT,
  aiEntitlementFor,
  aiSourcesAllowedOnPlan,
  planMonthlyCreditsMicro,
  type AiPlanEntitlement,
} from '../src/ai-credits.js';
import { AccountTierSchema, PURCHASABLE_TIERS, type AccountTier } from '../src/common.js';

const OWNER_MONTHLY_CREDITS: Record<AccountTier, number | 'contract'> = {
  free: 0,
  solo_manual: 1_500,
  api_starter: 3_000,
  team_manual: 5_000,
  api_builder: 10_000,
  agency_manual: 15_000,
  api_scale: 30_000,
  enterprise: 'contract',
};

const OWN_KEY_PLANS: readonly AccountTier[] = [
  'api_starter',
  'team_manual',
  'agency_manual',
  'api_builder',
  'api_scale',
  'enterprise',
];

describe('each plan includes its monthly AI credits', () => {
  it('every tier has an entitlement, and the table has no row for a tier that does not exist', () => {
    expect(Object.keys(AI_PLAN_ENTITLEMENTS).sort()).toEqual([...AccountTierSchema.options].sort());
    for (const tier of AccountTierSchema.options) {
      const row = aiEntitlementFor(tier);
      expect(typeof row.aiIncluded, tier).toBe('boolean');
      expect(typeof row.ownKeyAllowed, tier).toBe('boolean');
      expect(
        row.monthlyCredits === 'contract' || Number.isSafeInteger(row.monthlyCredits),
        `${tier} monthly credits is a whole number or 'contract'`,
      ).toBe(true);
    }
  });

  it("each plan's monthly credits are the owner's figures", () => {
    for (const tier of AccountTierSchema.options) {
      expect(AI_PLAN_ENTITLEMENTS[tier].monthlyCredits, tier).toBe(OWNER_MONTHLY_CREDITS[tier]);
      const expected = OWNER_MONTHLY_CREDITS[tier];
      expect(planMonthlyCreditsMicro(tier), tier).toBe(
        expected === 'contract' ? null : expected * MICROCREDITS_PER_CREDIT,
      );
    }
  });

  it('Free has no AI at all — no credits, and not on its own key either', () => {
    expect(AI_PLAN_ENTITLEMENTS.free).toEqual({
      aiIncluded: false,
      ownKeyAllowed: false,
      monthlyCredits: 0,
    });
    expect(aiSourcesAllowedOnPlan('free')).toEqual([]);
  });

  it('Personal has included credits and no own key', () => {
    expect(AI_PLAN_ENTITLEMENTS.solo_manual).toEqual({
      aiIncluded: true,
      ownKeyAllowed: false,
      monthlyCredits: 1_500,
    });
    expect(aiSourcesAllowedOnPlan('solo_manual')).toEqual(['credits']);
  });

  it('Personal is the only paid plan without its own key, and every own-key plan is one the owner named', () => {
    const paid = [...PURCHASABLE_TIERS, 'enterprise'] as const;
    const withoutKey = paid.filter((t) => !AI_PLAN_ENTITLEMENTS[t].ownKeyAllowed);
    expect(withoutKey).toEqual(['solo_manual']);
    const withKey = AccountTierSchema.options.filter((t) => AI_PLAN_ENTITLEMENTS[t].ownKeyAllowed);
    expect([...withKey].sort()).toEqual([...OWN_KEY_PLANS].sort());
    for (const tier of OWN_KEY_PLANS) {
      expect(aiSourcesAllowedOnPlan(tier), tier).toEqual(['credits', 'own_key']);
    }
  });

  it('every paid plan includes AI', () => {
    for (const tier of [...PURCHASABLE_TIERS, 'enterprise'] as const) {
      expect(AI_PLAN_ENTITLEMENTS[tier].aiIncluded, tier).toBe(true);
    }
  });

  it('Enterprise has no plan-wide number: its allowance comes only from a contract override', () => {
    expect(AI_PLAN_ENTITLEMENTS.enterprise.monthlyCredits).toBe('contract');
    expect(planMonthlyCreditsMicro('enterprise')).toBeNull();
  });

  it('the table cannot be edited at run time', () => {
    expect(Object.isFrozen(AI_PLAN_ENTITLEMENTS)).toBe(true);
    expect(Object.isFrozen(AI_PLAN_ENTITLEMENTS.api_scale)).toBe(true);
    expect(() => {
      (AI_PLAN_ENTITLEMENTS.api_scale as { monthlyCredits: number }).monthlyCredits = 1e9;
    }).toThrow(TypeError);
    expect(AI_PLAN_ENTITLEMENTS.api_scale.monthlyCredits).toBe(30_000);
  });

  it('an unknown tier (a value a database cast let through) throws rather than borrowing another row', () => {
    expect(() => aiEntitlementFor('platinum' as AccountTier)).toThrow(RangeError);
    expect(() => aiEntitlementFor('toString' as AccountTier)).toThrow(RangeError);
    expect(() => planMonthlyCreditsMicro('__proto__' as AccountTier)).toThrow(RangeError);
  });

  it('a table that leaves a tier undecided does not type-check (compile-time arm, held by the package test typecheck)', () => {
    const partial = { free: { aiIncluded: false, ownKeyAllowed: false, monthlyCredits: 0 } };
    // @ts-expect-error — `solo_manual` and six more tiers are missing, so this is not the table's type.
    const undecided: typeof AI_PLAN_ENTITLEMENTS = partial;
    // Read on a SEPARATE line: an unused-variable error on the line above would
    // satisfy the directive by itself and keep this arm green after the table's
    // type stopped requiring every tier.
    const row: AiPlanEntitlement = undecided.free;
    expect(row.aiIncluded).toBe(false);
  });
});
