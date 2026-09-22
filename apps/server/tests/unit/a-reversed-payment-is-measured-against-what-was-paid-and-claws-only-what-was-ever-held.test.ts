// The arithmetic of a refund or a dispute, stated without a database. Two
// numbers decide what a reversed payment takes back:
//
//   · its FRACTION of the payment — the NEW money reversed by this event over
//     what was paid, in parts per million (L5: for a refund, "new" is the
//     cumulative less the largest cumulative already recorded, so an event
//     delivered twice or out of order adds nothing);
//   · what that fraction is of what the payment's lots EVER HELD — granted less
//     what expired unspent (H2), rounded down. Credit that expired was never
//     used and is never asked for, so a refund of an untouched month is a
//     refund of nothing. What the lots cannot give back after that is the
//     existing clawback arithmetic's business (`planClawbackOfAmount`).

import { describe, expect, it } from 'vitest';
import {
  PPM,
  clawbackAmountForFraction,
  floorToPriorMinute,
  refundSourceRef,
  reinstateGrantKey,
  reversedFractionPpm,
} from '../../src/services/credit-clawbacks.js';

const MICRO = 1_000_000;
const lot = (id: string, granted: number, expired = 0) => ({
  lotId: id,
  grantedMicro: granted * MICRO,
  expiredMicro: expired * MICRO,
  remainingMicro: 0,
  heldMicro: 0,
});

describe('a reversed payment is measured against what was paid', () => {
  it('a full refund is the whole payment, a half refund half of it, and a refund of nothing is nothing', () => {
    expect(reversedFractionPpm(4900, 4900)).toBe(PPM);
    expect(reversedFractionPpm(2450, 4900)).toBe(PPM / 2);
    expect(reversedFractionPpm(0, 4900)).toBe(0);
  });

  it('is measured on the NEW money reversed, never the cumulative: the same cumulative delivered again is a delta of zero', () => {
    const stored = 2450;
    expect(reversedFractionPpm(2450 - stored, 4900)).toBe(0);
    // A larger cumulative arriving later reverses only what it adds.
    expect(reversedFractionPpm(4900 - stored, 4900)).toBe(PPM / 2);
    // A SMALLER cumulative arriving late (out of order) adds nothing either.
    expect(reversedFractionPpm(1000 - stored, 4900)).toBe(0);
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

describe('a reversal claws only what the lots ever held', () => {
  it('CRITICAL a half refund of a 3,000-credit month asks for 1,500 credits', () => {
    expect(clawbackAmountForFraction([lot('m', 3_000)], PPM / 2)).toBe(1_500 * MICRO);
  });

  it('CRITICAL credit that EXPIRED unspent is never asked for (H2): a full refund of a month whose lot expired untouched asks for nothing', () => {
    expect(clawbackAmountForFraction([lot('m', 3_000, 3_000)], PPM)).toBe(0);
    // Half of it expired: only the half that was ever usable is asked for.
    expect(clawbackAmountForFraction([lot('m', 3_000, 1_500)], PPM)).toBe(1_500 * MICRO);
  });

  it('sums every lot the window holds — the month and a mid-month upgrade share — before taking the fraction', () => {
    expect(clawbackAmountForFraction([lot('month', 3_000), lot('upgrade', 900)], PPM / 4)).toBe(
      975 * MICRO,
    );
  });

  it('rounds DOWN, so a rounding never asks for a microcredit the payment did not buy', () => {
    expect(clawbackAmountForFraction([lot('m', 1)], 333_333)).toBe(333_333);
    expect(clawbackAmountForFraction([lot('m', 1)], 1)).toBe(1);
  });

  it('refuses a fraction outside the whole', () => {
    expect(() => clawbackAmountForFraction([lot('m', 1)], PPM + 1)).toThrow(RangeError);
    expect(() => clawbackAmountForFraction([lot('m', 1)], -1)).toThrow(RangeError);
  });
});

describe('the keys a reversal is counted by', () => {
  it('a refund is keyed on the charge and the cumulative it reached, so each distinct cumulative claws once', () => {
    expect(refundSourceRef('ch_1', 2450)).toBe('ch_1:2450');
    expect(refundSourceRef('ch_1', 4900)).not.toBe(refundSourceRef('ch_1', 2450));
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
