// The month granted is the one with the highest allowance.
//
// An account can be covered twice over at once: a subscription and a crypto
// term, two subscriptions, a contract beside either. It still gets ONE window
// for a stretch of time, so something has to choose. The rule: the highest
// monthly level wins; between equals, the window that starts earliest (it covers
// more of the month); and then a fixed order, so the choice can never depend on
// the order the database happened to return the rows in.
//
// Also here, because they are the two pure pieces the grants lean on: which
// plans have a number to grant at all, and how a window's end becomes a job's
// due time without waking the job a fraction of a millisecond early.

import { describe, expect, it } from 'vitest';
import { AccountTierSchema, AI_PLAN_ENTITLEMENTS } from '@driftstack/api-types';
import {
  firstMillisecondAtOrAfter,
  planAllowancesJson,
  type CreditWindowCandidate,
} from '../../src/db/credit-windows-repo.js';
import { creditGrantsRun, pickWindowCandidate } from '../../src/services/credit-grants.js';

const MICRO = 1_000_000;

function candidate(over: Partial<CreditWindowCandidate>): CreditWindowCandidate {
  return {
    source: 'stripe_invoice',
    sourceRef: 'in_1',
    tier: 'api_starter',
    levelMicro: 3_000 * MICRO,
    naturalStart: '2026-09-01T00:00:00.000000Z',
    naturalEnd: '2026-10-01T00:00:00.000000Z',
    windowStart: '2026-09-01T00:00:00.000000Z',
    windowEnd: '2026-10-01T00:00:00.000000Z',
    ...over,
  };
}

/** Every ordering of a short list, so "whatever order they arrive in" is checked, not sampled. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('the month granted is the one with the highest allowance', () => {
  it('no coverage, no window', () => {
    expect(pickWindowCandidate([])).toBeNull();
  });

  it('CRITICAL the highest monthly level wins, whatever order the candidates arrive in and whatever their source', () => {
    const starter = candidate({ sourceRef: 'in_starter' });
    const scale = candidate({
      source: 'crypto_entitlement',
      sourceRef: 'ord_scale',
      tier: 'api_scale',
      levelMicro: 30_000 * MICRO,
      windowStart: '2026-09-20T00:00:00.000000Z',
    });
    const contract = candidate({
      source: 'plan_override',
      sourceRef: 'override',
      tier: 'enterprise',
      levelMicro: 12_000 * MICRO,
    });
    for (const order of permutations([starter, scale, contract])) {
      expect(pickWindowCandidate(order)?.sourceRef).toBe('ord_scale');
    }
  });

  it('between equal levels the window that STARTS EARLIEST wins — to the microsecond, which a millisecond clock could not tell apart', () => {
    const later = candidate({ sourceRef: 'in_later', windowStart: '2026-09-10T00:00:00.000002Z' });
    const earlier = candidate({
      sourceRef: 'in_earlier',
      windowStart: '2026-09-10T00:00:00.000001Z',
    });
    for (const order of permutations([later, earlier])) {
      expect(pickWindowCandidate(order)?.sourceRef).toBe('in_earlier');
    }
  });

  it('a full tie is broken by a FIXED order — Stripe, then crypto, then an override; then the reference — so the same coverage always grants the same window', () => {
    const tied = [
      candidate({ source: 'plan_override', sourceRef: 'override' }),
      candidate({ source: 'crypto_entitlement', sourceRef: 'ord_b' }),
      candidate({ source: 'stripe_invoice', sourceRef: 'in_b' }),
      candidate({ source: 'stripe_invoice', sourceRef: 'in_a' }),
    ];
    for (const order of permutations(tied)) {
      expect(pickWindowCandidate(order)?.sourceRef).toBe('in_a');
    }
    for (const order of permutations(tied.slice(0, 2))) {
      expect(pickWindowCandidate(order)?.sourceRef).toBe('ord_b');
    }
  });

  it('CRITICAL the plans that have a number to grant are exactly the six paid self-serve plans, at their own figures. Free has none and Enterprise’s comes from its contract, so a paid line on either grants nothing by itself', () => {
    const rows = JSON.parse(planAllowancesJson()) as Array<{
      tier: string;
      allowance_micro: number;
    }>;
    expect(Object.fromEntries(rows.map((r) => [r.tier, r.allowance_micro / MICRO]))).toEqual({
      solo_manual: 1_500,
      api_starter: 3_000,
      team_manual: 5_000,
      api_builder: 10_000,
      agency_manual: 15_000,
      api_scale: 30_000,
    });
    // Derived, not only restated: every plan with a positive number is in, and no other.
    const expected = AccountTierSchema.options.filter((t) => {
      const credits = AI_PLAN_ENTITLEMENTS[t].monthlyCredits;
      return credits !== 'contract' && credits > 0;
    });
    expect(rows.map((r) => r.tier).sort()).toEqual([...expected].sort());
  });

  it('a job due "when the window ends" is due at the first whole millisecond AT OR AFTER that instant — never a fraction of one before it, when the window would still be current', () => {
    expect(firstMillisecondAtOrAfter('2026-10-01T00:00:00.000000Z').toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(firstMillisecondAtOrAfter('2026-10-01T00:00:00.123000Z').toISOString()).toBe(
      '2026-10-01T00:00:00.123Z',
    );
    expect(firstMillisecondAtOrAfter('2026-10-01T00:00:00.123001Z').toISOString()).toBe(
      '2026-10-01T00:00:00.124Z',
    );
    expect(firstMillisecondAtOrAfter('2026-12-31T23:59:59.999999Z').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    for (const notAnInstant of ['2026-10-01T00:00:00.000Z', '2026-10-01 00:00:00.000000+00', '']) {
      expect(() => firstMillisecondAtOrAfter(notAnInstant), notAnInstant).toThrow(RangeError);
    }
  });

  it('grants run in shadow and in enforce, and in nothing else', () => {
    expect(creditGrantsRun('off')).toBe(false);
    expect(creditGrantsRun('shadow')).toBe(true);
    expect(creditGrantsRun('enforce')).toBe(true);
  });
});
