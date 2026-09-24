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
// E is the sum of those.
//
// REVERSAL POLICY v2 (design-reversal-policy-v2.md §4) deletes the round-1
// helpers `planWindowReversal`, `reversalDebtBudgetMicro`, `levelScaledByPayment`
// and `lotKeepMicro` (no caller in src; the unit reconciliation in
// credit-grants.ts is what measures a reversal), so the arms that stated their
// arithmetic are gone with them. The same rules are held by the unit arithmetic's
// own tests (a-credit-units-target-is-computed-from-the-facts-alone) and by the
// integration files.

import { describe, expect, it } from 'vitest';
import {
  PPM,
  disputeRecordTarget,
  floorToPriorMinute,
  refundSourceRef,
  reinstateGrantKey,
  returnedGrantKey,
  reversalTargetKey,
  reversedFractionPpm,
  stillPaidForMicro,
  wonDisputeSettleRef,
} from '../../src/services/credit-clawbacks.js';

const MICRO = 1_000_000;
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

  it('refuses amounts that are not whole', () => {
    expect(() => stillPaidForMicro(1.5, PAID, 0)).toThrow(RangeError);
    expect(() => stillPaidForMicro(MICRO, PAID, -1)).toThrow(RangeError);
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
