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
//
// The re-audit (round 2) moved "what the customer keeps" onto each LOT: a lot
// keeps `floor_whole(granted × still paid now / still paid when it was
// granted)` (0137), so a month granted after a half refund keeps half its
// grant at a three-quarter refund, not a quarter (re-audit #5). The window's
// E is the sum of those, and `planWindowReversal` takes it as given.

import { describe, expect, it } from 'vitest';
import {
  PPM,
  disputeRecordTarget,
  floorToPriorMinute,
  levelScaledByPayment,
  lotKeepMicro,
  planWindowReversal,
  refundSourceRef,
  reinstateGrantKey,
  returnedGrantKey,
  reversalDebtBudgetMicro,
  reversalTargetKey,
  reversedFractionPpm,
  stillPaidForMicro,
  wonDisputeSettleRef,
  type ReversalWindowState,
} from '../../src/services/credit-clawbacks.js';

const MICRO = 1_000_000;
const NO_CAP = Number.MAX_SAFE_INTEGER;
const PAID = 4900;

/**
 * One window of an invoice's own credit: a 3,000-credit month granted with the
 * whole payment still paid, untouched unless said otherwise, measured at
 * `reversedMinor` reversed.
 */
function window(
  reversedMinor: number,
  over: Partial<ReversalWindowState> = {},
  paid = PAID,
): ReversalWindowState {
  return {
    keepMicro: lotKeepMicro(3_000 * MICRO, paid, null, reversedMinor),
    consumedMicro: 0,
    remainingMicro: 3_000 * MICRO,
    heldMicro: 0,
    owedMicro: 0,
    ...over,
  };
}

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
      window(PAID, { consumedMicro: 1_000 * MICRO, remainingMicro: 2_000 * MICRO }),
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
      window(PAID / 2, { consumedMicro: 2_500 * MICRO, remainingMicro: 500 * MICRO }),
      NO_CAP,
    );
    expect(plan.fromLotsMicro).toBe(500 * MICRO);
    expect(plan.beyondLotsMicro).toBe(1_000 * MICRO);
  });

  it('CRITICAL credit that expired unspent is never asked for (H2): nothing held, nothing spent, nothing taken', () => {
    const expired = window(PAID, { remainingMicro: 0 });
    expect(planWindowReversal(expired, NO_CAP).amountMicro).toBe(0);
  });

  it('CRITICAL a second refund after the first refund’s credit expired owes nothing (audit A): the first took 1,500, the other 1,500 expired', () => {
    const after = window(PAID, { remainingMicro: 0 });
    const plan = planWindowReversal(after, NO_CAP);
    expect(plan).toEqual({ amountMicro: 0, fromLotsMicro: 0, beyondLotsMicro: 0 });
  });

  it('CRITICAL two refunds that make the whole payment take exactly the lot and owe nothing (audit G)', () => {
    // The first refund of 1 of 3,200 leaves 2,999.0625 still paid for: the lot
    // keeps whole credits, 2,999, and gives up 1.
    const first = planWindowReversal(window(1, {}, 3200), NO_CAP);
    expect(first.amountMicro).toBe(1 * MICRO);
    const left = 3_000 * MICRO - first.amountMicro;
    const second = planWindowReversal(window(3200, { remainingMicro: left }, 3200), NO_CAP);
    expect(second).toEqual({ amountMicro: left, fromLotsMicro: left, beyondLotsMicro: 0 });
  });

  it('CRITICAL a dispute after a half refund is measured against what was still paid (audit E): the 1,500 left is taken, nothing owed', () => {
    const plan = planWindowReversal(
      // refunded 2,450 + disputed 4,900 is more than the payment: the whole of it.
      window(PAID / 2 + PAID, { remainingMicro: 1_500 * MICRO }),
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
    const held = window(PAID, { heldMicro: 3_000 * MICRO, owedMicro: 3_000 * MICRO });
    expect(planWindowReversal(held, NO_CAP).amountMicro).toBe(0);
    // 1,000 spent after a full refund that already owes it: nothing more.
    const owed = window(PAID, {
      consumedMicro: 1_000 * MICRO,
      remainingMicro: 0,
      owedMicro: 1_000 * MICRO,
    });
    expect(planWindowReversal(owed, NO_CAP).amountMicro).toBe(0);
  });

  it('CRITICAL the debt a reversal may create is capped by what the payment still pays for across every window — an annual refund owes nothing for the one month used while six are still paid for (audit I, interim pending the owner)', () => {
    const terms = { amountPaidMinor: 58_800, reversedMinor: 58_800 / 2 };
    const month = window(
      terms.reversedMinor,
      { consumedMicro: 3_000 * MICRO, remainingMicro: 0 },
      58_800,
    );
    const budget = reversalDebtBudgetMicro([month], { ...terms, paidForMicro: 12 * 3_000 * MICRO });
    expect(budget).toBe(0);
    expect(planWindowReversal(month, budget)).toEqual({
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
    const month = window(PAID, { consumedMicro: 1_000 * MICRO, remainingMicro: 2_000 * MICRO });
    const plan = planWindowReversal(month, 10_000 * MICRO);
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

describe('what one lot keeps is measured against what was still paid when it was granted (re-audit #5)', () => {
  it('CRITICAL a month granted at 1,500 after a half refund keeps 750 when the refund reaches three quarters — not the 375 a second halving gives', () => {
    // Annual 58,800: half refunded when the month was granted (29,400 still paid).
    expect(lotKeepMicro(1_500 * MICRO, 58_800, 29_400, (58_800 * 3) / 4)).toBe(750 * MICRO);
    // Measured against the whole payment, as the rework did, it was 375.
    expect(lotKeepMicro(1_500 * MICRO, 58_800, null, (58_800 * 3) / 4)).toBe(375 * MICRO);
  });

  it('a lot written before 0137 is measured against the whole payment; a lot granted in full keeps its share', () => {
    expect(lotKeepMicro(3_000 * MICRO, PAID, null, PAID / 2)).toBe(1_500 * MICRO);
    expect(lotKeepMicro(3_000 * MICRO, PAID, PAID, PAID / 2)).toBe(1_500 * MICRO);
    expect(lotKeepMicro(3_000 * MICRO, PAID, PAID, 0)).toBe(3_000 * MICRO);
    expect(lotKeepMicro(3_000 * MICRO, PAID, PAID, PAID)).toBe(0);
  });

  it('keeps WHOLE credits, rounded down, as every level and every grant is', () => {
    // 3,000 × 3,199 / 3,200 = 2,999.0625.
    expect(lotKeepMicro(3_000 * MICRO, 3200, null, 1)).toBe(2_999 * MICRO);
    // 3,000 × 3,900 / 4,900 = 2,387.755…
    expect(lotKeepMicro(3_000 * MICRO, PAID, null, 1_000)).toBe(2_387 * MICRO);
  });

  it('a lot granted while half the payment was disputed keeps its WHOLE month once the dispute is won — more than its grant; the win’s give-back makes up the difference', () => {
    expect(lotKeepMicro(1_500 * MICRO, 58_800, 29_400, 0)).toBe(3_000 * MICRO);
  });

  it('a payment of nothing reverses nothing, and amounts must be whole', () => {
    expect(lotKeepMicro(3_000 * MICRO, 0, null, 500)).toBe(3_000 * MICRO);
    expect(() => lotKeepMicro(1.5, PAID, null, 0)).toThrow(RangeError);
    expect(() => lotKeepMicro(MICRO, PAID, -1, 0)).toThrow(RangeError);
  });

  it('the interim cap keeps whole credits too, so on a full month it never binds below the per-window rule', () => {
    const month = window(1, { consumedMicro: 3_000 * MICRO, remainingMicro: 0 }, 3200);
    // Keep 2,999 (whole) of 3,000 spent: the cap allows exactly the 1 the window owes.
    expect(
      reversalDebtBudgetMicro([month], {
        amountPaidMinor: 3200,
        reversedMinor: 1,
        paidForMicro: 3_000 * MICRO,
      }),
    ).toBe(1 * MICRO);
    expect(planWindowReversal(month, 1 * MICRO).beyondLotsMicro).toBe(1 * MICRO);
  });
});

describe('the keys a won dispute is counted by (re-audit #1, #2, #3, #10, #13)', () => {
  it('what a win gives back to the invoice and what it returns to no invoice are two lots with distinct keys, neither a prefix match of the other’s exact key', () => {
    expect(reinstateGrantKey('cb_9')).toBe('reinstate:cb_9');
    expect(returnedGrantKey('cb_9')).toBe('reinstate:cb_9:returned');
    expect(returnedGrantKey('cb_9')).not.toBe(reinstateGrantKey('cb_9'));
  });

  it('a dispute’s record targets the invoice, never a window', () => {
    expect(disputeRecordTarget('in_1')).toBe('invoice:in_1');
    expect(disputeRecordTarget('in_1').startsWith('window:')).toBe(false);
  });

  it('the pass a win settles its invoice with is keyed to the win, apart from the dispute’s own rows', () => {
    expect(wonDisputeSettleRef('dp_1')).toBe('dp_1:won');
    expect(wonDisputeSettleRef('dp_1')).not.toBe('dp_1');
  });
});
