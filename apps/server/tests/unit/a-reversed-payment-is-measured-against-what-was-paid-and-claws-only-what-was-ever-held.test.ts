// The arithmetic of a refund or a dispute, stated without a database.
//
// A reversal is measured on STATE (S17, as the independent audit corrected
// it): with F the share of the payment refunded or disputed SO FAR, the
// customer keeps `E = floor((1 − F) × what the invoice's own lots were
// granted)`, and a reversal takes back what they hold or spent above E, less
// what the invoice's earlier reversals already asked beyond the lots — out of
// the lots first, and the rest (credit that was spent) as debt. Credit that
// expired unspent is neither held nor spent, so it is never asked for (H2).
//
// Every number below is checked by hand against the audit's arms and the
// slice's own list: a full refund with 1,000 of 3,000 spent takes 2,000 back
// and owes 1,000; a half refund with 2,500 spent takes 500 and owes 1,000; a
// second refund after the first refund's credit expired owes nothing (audit
// A); a dispute after a half refund owes nothing with nothing spent (E); two
// refunds of the whole owe nothing (G); an annual refund owes nothing for the
// one month used while six are still paid for (I).

import { describe, expect, it } from 'vitest';
import {
  PPM,
  floorToPriorMinute,
  levelScaledByPayment,
  planWindowReversal,
  refundSourceRef,
  reinstateGrantKey,
  reversalDebtBudgetMicro,
  reversalTargetKey,
  reversedFractionPpm,
  stillPaidForMicro,
  type ReversalWindowState,
} from '../../src/services/credit-clawbacks.js';

const MICRO = 1_000_000;
const NO_CAP = Number.MAX_SAFE_INTEGER;

/** One window of an invoice's own credit: a 3,000-credit month, untouched unless said otherwise. */
function window(over: Partial<ReversalWindowState> = {}): ReversalWindowState {
  return {
    grantedMicro: 3_000 * MICRO,
    consumedMicro: 0,
    remainingMicro: 3_000 * MICRO,
    heldMicro: 0,
    owedMicro: 0,
    ...over,
  };
}

const PAID = 4900;

describe('a reversed payment is measured against what was paid', () => {
  it('a full refund is the whole payment, a half refund half of it, and a refund of nothing is nothing', () => {
    expect(reversedFractionPpm(4900, 4900)).toBe(PPM);
    expect(reversedFractionPpm(2450, 4900)).toBe(PPM / 2);
    expect(reversedFractionPpm(0, 4900)).toBe(0);
  });

  it('is the share reversed SO FAR — refunded plus disputed — and only reported: no amount is computed from a share rounded one event at a time (audit #11)', () => {
    expect(reversedFractionPpm(2450 + 2450, 4900)).toBe(PPM);
    // Rounded shares of two events can add up to more than the whole, which is
    // why the amounts are exact arithmetic on minor units instead.
    expect(reversedFractionPpm(1, 3200) + reversedFractionPpm(3199, 3200)).toBeGreaterThan(PPM);
    expect(reversedFractionPpm(3200, 3200)).toBe(PPM);
  });

  it('never exceeds the whole payment and rounds to the nearest part per million', () => {
    expect(reversedFractionPpm(9800, 4900)).toBe(PPM);
    expect(reversedFractionPpm(1, 3)).toBe(333_333);
    expect(reversedFractionPpm(2, 3)).toBe(666_667);
  });

  it('a payment of nothing reverses nothing, whatever the event says', () => {
    expect(reversedFractionPpm(500, 0)).toBe(0);
  });

  it('refuses a fractional minor unit rather than measuring it', () => {
    expect(() => reversedFractionPpm(1.5, 4900)).toThrow(RangeError);
    expect(() => reversedFractionPpm(1, 49.5)).toThrow(RangeError);
  });
});

describe('a reversal takes back only what the customer no longer paid for', () => {
  it('CRITICAL the credit still paid for is exact integer arithmetic on the payment, rounded down', () => {
    expect(stillPaidForMicro(3_000 * MICRO, PAID, 0)).toBe(3_000 * MICRO);
    expect(stillPaidForMicro(3_000 * MICRO, PAID, PAID / 2)).toBe(1_500 * MICRO);
    expect(stillPaidForMicro(3_000 * MICRO, PAID, PAID)).toBe(0);
    // A reversal beyond the payment is the whole of it; a payment of nothing reverses nothing.
    expect(stillPaidForMicro(3_000 * MICRO, PAID, PAID * 2)).toBe(0);
    expect(stillPaidForMicro(3_000 * MICRO, 0, 500)).toBe(3_000 * MICRO);
    // 3,000 credits × 3,199 / 3,200, rounded down.
    expect(stillPaidForMicro(3_000 * MICRO, 3200, 1)).toBe(2_999_062_500);
  });

  it('CRITICAL a full refund with 1,000 of 3,000 spent takes back the 2,000 left and owes the 1,000 spent', () => {
    const plan = planWindowReversal(
      window({ consumedMicro: 1_000 * MICRO, remainingMicro: 2_000 * MICRO }),
      { amountPaidMinor: PAID, reversedMinor: PAID },
      NO_CAP,
    );
    expect(plan).toEqual({
      amountMicro: 3_000 * MICRO,
      fromLotsMicro: 2_000 * MICRO,
      beyondLotsMicro: 1_000 * MICRO,
    });
  });

  it('CRITICAL a half refund with 2,500 spent takes the 500 left and owes 1,000 — never the 1,500 half of what was spent would suggest', () => {
    const plan = planWindowReversal(
      window({ consumedMicro: 2_500 * MICRO, remainingMicro: 500 * MICRO }),
      { amountPaidMinor: PAID, reversedMinor: PAID / 2 },
      NO_CAP,
    );
    expect(plan.fromLotsMicro).toBe(500 * MICRO);
    expect(plan.beyondLotsMicro).toBe(1_000 * MICRO);
  });

  it('CRITICAL credit that expired unspent is never asked for (H2): nothing held, nothing spent, nothing taken', () => {
    const expired = window({ remainingMicro: 0 });
    expect(
      planWindowReversal(expired, { amountPaidMinor: PAID, reversedMinor: PAID }, NO_CAP)
        .amountMicro,
    ).toBe(0);
  });

  it('CRITICAL a second refund after the first refund’s credit expired owes nothing (audit A): the first took 1,500, the other 1,500 expired', () => {
    const after = window({ remainingMicro: 0 });
    const plan = planWindowReversal(after, { amountPaidMinor: PAID, reversedMinor: PAID }, NO_CAP);
    expect(plan).toEqual({ amountMicro: 0, fromLotsMicro: 0, beyondLotsMicro: 0 });
  });

  it('CRITICAL two refunds that make the whole payment take exactly the lot and owe nothing (audit G)', () => {
    const first = planWindowReversal(window(), { amountPaidMinor: 3200, reversedMinor: 1 }, NO_CAP);
    expect(first.amountMicro).toBe(3_000 * MICRO - 2_999_062_500);
    const left = 3_000 * MICRO - first.amountMicro;
    const second = planWindowReversal(
      window({ remainingMicro: left }),
      { amountPaidMinor: 3200, reversedMinor: 3200 },
      NO_CAP,
    );
    expect(second).toEqual({ amountMicro: left, fromLotsMicro: left, beyondLotsMicro: 0 });
  });

  it('CRITICAL a dispute after a half refund is measured against what was still paid (audit E): the 1,500 left is taken, nothing owed', () => {
    const plan = planWindowReversal(
      window({ remainingMicro: 1_500 * MICRO }),
      // refunded 2,450 + disputed 4,900 is more than the payment: the whole of it.
      { amountPaidMinor: PAID, reversedMinor: PAID / 2 + PAID },
      NO_CAP,
    );
    expect(plan).toEqual({
      amountMicro: 1_500 * MICRO,
      fromLotsMicro: 1_500 * MICRO,
      beyondLotsMicro: 0,
    });
  });

  it('CRITICAL what an earlier reversal of the same invoice already asked beyond the lots — debt, or a claim on held credit — is not asked again', () => {
    // A task held the whole month when it was refunded: 3,000 of claim, 0 debt.
    const held = window({ heldMicro: 3_000 * MICRO, owedMicro: 3_000 * MICRO });
    expect(
      planWindowReversal(held, { amountPaidMinor: PAID, reversedMinor: PAID }, NO_CAP).amountMicro,
    ).toBe(0);
    // 1,000 spent after a full refund that already owes it: nothing more.
    const owed = window({
      consumedMicro: 1_000 * MICRO,
      remainingMicro: 0,
      owedMicro: 1_000 * MICRO,
    });
    expect(
      planWindowReversal(owed, { amountPaidMinor: PAID, reversedMinor: PAID }, NO_CAP).amountMicro,
    ).toBe(0);
  });

  it('CRITICAL the debt a reversal may create is capped by what the payment still pays for across every window — an annual refund owes nothing for the one month used while six are still paid for (audit I, interim pending the owner)', () => {
    const month = window({ consumedMicro: 3_000 * MICRO, remainingMicro: 0 });
    const terms = { amountPaidMinor: 58_800, reversedMinor: 58_800 / 2 };
    const budget = reversalDebtBudgetMicro([month], { ...terms, paidForMicro: 12 * 3_000 * MICRO });
    expect(budget).toBe(0);
    expect(planWindowReversal(month, terms, budget)).toEqual({
      amountMicro: 0,
      fromLotsMicro: 0,
      beyondLotsMicro: 0,
    });
    // Refunded in full, the same month is owed in full.
    const whole = { amountPaidMinor: 58_800, reversedMinor: 58_800 };
    expect(reversalDebtBudgetMicro([month], { ...whole, paidForMicro: 12 * 3_000 * MICRO })).toBe(
      3_000 * MICRO,
    );
    // No cap asked for: the per-window rule alone.
    expect(reversalDebtBudgetMicro([month], { ...terms, paidForMicro: null })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('the cap only ever lowers debt: a budget larger than what a window owes leaves the window’s own rule in charge', () => {
    const month = window({ consumedMicro: 1_000 * MICRO, remainingMicro: 2_000 * MICRO });
    const plan = planWindowReversal(
      month,
      { amountPaidMinor: PAID, reversedMinor: PAID },
      10_000 * MICRO,
    );
    expect(plan.beyondLotsMicro).toBe(1_000 * MICRO);
  });

  it('refuses amounts that are not whole', () => {
    expect(() => stillPaidForMicro(1.5, PAID, 0)).toThrow(RangeError);
    expect(() => stillPaidForMicro(MICRO, PAID, -1)).toThrow(RangeError);
  });
});

describe('the level a reversal leaves when nothing covers now', () => {
  it('CRITICAL falls by the share of what was still paid that the event reverses, not to zero (audit #16)', () => {
    expect(levelScaledByPayment(3_000 * MICRO, PAID, PAID / 2)).toBe(1_500 * MICRO);
    expect(levelScaledByPayment(3_000 * MICRO, PAID, 0)).toBe(0);
    // After a half refund, the rest refunded: from 1,500 to nothing.
    expect(levelScaledByPayment(1_500 * MICRO, PAID / 2, 0)).toBe(0);
  });

  it('rounds down to whole credits, and leaves a level alone when nothing was still paid', () => {
    expect(levelScaledByPayment(3_000 * MICRO, 3, 2)).toBe(2_000 * MICRO);
    expect(levelScaledByPayment(1_000 * MICRO, 3, 1)).toBe(333 * MICRO);
    expect(levelScaledByPayment(3_000 * MICRO, 0, 0)).toBe(3_000 * MICRO);
  });
});

describe('the keys a reversal is counted by', () => {
  it('a refund is keyed on the charge and the cumulative it reached, so each distinct cumulative claws once', () => {
    expect(refundSourceRef('ch_1', 2450)).toBe('ch_1:2450');
    expect(refundSourceRef('ch_1', 4900)).not.toBe(refundSourceRef('ch_1', 2450));
  });

  it('a reversal targets one invoice’s lots in one window, so two invoices sharing a window never take each other’s', () => {
    expect(reversalTargetKey('w1', 'in_1')).toBe('window:w1:in_1');
    expect(reversalTargetKey('w1', 'in_2')).not.toBe(reversalTargetKey('w1', 'in_1'));
  });

  it('a won dispute re-grants one lot per clawback it reverses, keyed on the clawback', () => {
    expect(reinstateGrantKey('cb_9')).toBe('reinstate:cb_9');
  });

  it('a re-granted lot starts on the whole minute BEFORE now, the same rule a goodwill grant uses', () => {
    const at = new Date('2026-09-22T05:07:33.456Z');
    expect(floorToPriorMinute(at).toISOString()).toBe('2026-09-22T05:06:00.000Z');
    // Two calls inside one minute agree, so a replay computes the same lot.
    expect(floorToPriorMinute(new Date('2026-09-22T05:07:59.999Z')).toISOString()).toBe(
      '2026-09-22T05:06:00.000Z',
    );
  });
});
