// The target a credit UNIT is reconciled to — one payment's credit in one
// window — is a function of the facts alone (S17, the third audit's
// "converge by construction"). Stated here without a database:
//
//   · what a unit KEEPS is every grant and take attributed to it, each scaled
//     by what its payment still pays now over what it still paid when the
//     grant or take was made, summed UNFLOORED and rounded to whole credits
//     once (R3) — so a downgrade and a refund leave the same credit in either
//     order (A6), and no credit is lost to a double floor (A11);
//   · the interim annual cap shares out the debt a payment may leave, newest
//     window first, never more than a window's own shortfall;
//   · the stand-alone cover beside a window's own payment (a resubscription, a
//     crypto term, an override) earns its level above what that payment still
//     covers — decided against the payment, not against an upgrade line above
//     it (R5) — prorated from its own start;
//   · a window's two levels: the UNDISPUTED one follows the line (the window's
//     own payment and every upgrade line), the one SHOWN follows every cover,
//     and a canceled subscription's invoice keeps the month it paid for.

import { describe, expect, it } from 'vitest';
import type { WindowCover, WindowCovers } from '../../src/db/credit-windows-repo.js';
import {
  allowedDebtByUnit,
  envelopeKeepMicro,
  unitKeepMicro,
  unitTargetMicro,
  windowTargets,
} from '../../src/services/credit-grants.js';

const MICRO = 1_000_000;
const PAID = 4_900;
/** An 840-hour month, in microseconds. */
const MONTH_US = 840 * 3_600 * 1_000_000;

describe('what a unit keeps: every grant and take, each at its own still-paid share, floored once', () => {
  it('CRITICAL a month and a half refund keep half the month; a downgrade taken before the refund is scaled with it (A6, one order)', () => {
    // A builder month (10,000), downgraded halfway (3,500 taken at the whole
    // payment), then half refunded: half of the 6,500 the downgrade left.
    expect(
      unitKeepMicro({
        amountPaidMinor: PAID,
        stillPaidMinor: PAID / 2,
        terms: [
          { micro: 10_000 * MICRO, stillPaidAtMinor: PAID },
          { micro: -3_500 * MICRO, stillPaidAtMinor: PAID },
        ],
      }),
    ).toBe(3_250 * MICRO);
  });

  it('CRITICAL the same credit in the other order: the refund first, then a downgrade measured at half the payment (A6, the other order)', () => {
    // Half refunded first (the level falls to 5,000), then downgraded halfway:
    // (1,500 − 5,000) × ½ = −1,750, taken while half was still paid.
    expect(
      unitKeepMicro({
        amountPaidMinor: PAID,
        stillPaidMinor: PAID / 2,
        terms: [
          { micro: 10_000 * MICRO, stillPaidAtMinor: PAID },
          { micro: -1_750 * MICRO, stillPaidAtMinor: PAID / 2 },
        ],
      }),
    ).toBe(3_250 * MICRO);
  });

  it('CRITICAL the terms are summed unfloored and rounded ONCE: two half credits make a credit, not nothing (R3)', () => {
    expect(
      unitKeepMicro({
        amountPaidMinor: 2,
        stillPaidMinor: 1,
        terms: [
          { micro: 1 * MICRO, stillPaidAtMinor: 2 },
          { micro: 1 * MICRO, stillPaidAtMinor: 2 },
        ],
      }),
    ).toBe(1 * MICRO);
  });

  it('a month granted after a refund keeps its share of what was still paid when it was granted, and all of it once that is still paid (re-audit #5, and a won dispute)', () => {
    // Annual 58,800 half refunded when the month was granted at 1,500.
    const month = { micro: 1_500 * MICRO, stillPaidAtMinor: 29_400 };
    expect(unitKeepMicro({ amountPaidMinor: 58_800, stillPaidMinor: 14_700, terms: [month] })).toBe(
      750 * MICRO,
    );
    expect(unitKeepMicro({ amountPaidMinor: 58_800, stillPaidMinor: 29_400, terms: [month] })).toBe(
      1_500 * MICRO,
    );
  });

  it('a month drawn after a refund of one minor unit keeps 2,999 while a dispute of half stands, and all 2,999 once it is won (A11)', () => {
    const month = { micro: 2_999 * MICRO, stillPaidAtMinor: 4_899 };
    expect(unitKeepMicro({ amountPaidMinor: PAID, stillPaidMinor: 2_449, terms: [month] })).toBe(
      1_499 * MICRO,
    );
    expect(unitKeepMicro({ amountPaidMinor: PAID, stillPaidMinor: 4_899, terms: [month] })).toBe(
      2_999 * MICRO,
    );
  });

  it('a free invoice reverses nothing; a term made when nothing was still paid keeps all of itself or none; never below nothing', () => {
    expect(
      unitKeepMicro({
        amountPaidMinor: 0,
        stillPaidMinor: 0,
        terms: [{ micro: 3_000 * MICRO, stillPaidAtMinor: null }],
      }),
    ).toBe(3_000 * MICRO);
    expect(
      unitKeepMicro({
        amountPaidMinor: PAID,
        stillPaidMinor: 1,
        terms: [{ micro: 3_000 * MICRO, stillPaidAtMinor: 0 }],
      }),
    ).toBe(3_000 * MICRO);
    expect(
      unitKeepMicro({
        amountPaidMinor: PAID,
        stillPaidMinor: 0,
        terms: [{ micro: 3_000 * MICRO, stillPaidAtMinor: 0 }],
      }),
    ).toBe(0);
    expect(
      unitKeepMicro({
        amountPaidMinor: PAID,
        stillPaidMinor: PAID,
        terms: [{ micro: -3_500 * MICRO, stillPaidAtMinor: PAID }],
      }),
    ).toBe(0);
  });

  it('refuses amounts that are not whole', () => {
    expect(() => unitKeepMicro({ amountPaidMinor: 1.5, stillPaidMinor: 1, terms: [] })).toThrow(
      RangeError,
    );
    expect(() =>
      unitKeepMicro({
        amountPaidMinor: PAID,
        stillPaidMinor: PAID,
        terms: [{ micro: 0.5, stillPaidAtMinor: null }],
      }),
    ).toThrow(RangeError);
  });
});

describe('where a unit should stand, and the debt a payment may leave (the interim annual cap)', () => {
  it('with no cap a unit stands at what it keeps; with one it stands no lower than what was spent less the debt it may carry', () => {
    expect(unitTargetMicro(1_500 * MICRO, 3_000 * MICRO, null)).toBe(1_500 * MICRO);
    expect(unitTargetMicro(1_500 * MICRO, 3_000 * MICRO, 0)).toBe(3_000 * MICRO);
    expect(unitTargetMicro(1_500 * MICRO, 3_000 * MICRO, 500 * MICRO)).toBe(2_500 * MICRO);
    // Spent less than it keeps: the cap is not in play.
    expect(unitTargetMicro(1_500 * MICRO, 1_000 * MICRO, 0)).toBe(1_500 * MICRO);
  });

  it('CRITICAL an annual plan half refunded with one month spent may leave no debt: six months are still paid for (audit #6)', () => {
    // 36,000 bought, half still paid: 18,000 still covered, 3,000 spent.
    expect(
      allowedDebtByUnit(
        [{ keepMicro: 1_500 * MICRO, consumedMicro: 3_000 * MICRO }],
        18_000 * MICRO,
      ),
    ).toEqual([0]);
  });

  it('what may be owed is shared out newest window first, each at most its own shortfall; no cap is no cap', () => {
    const units = [
      { keepMicro: 0, consumedMicro: 2_000 * MICRO },
      { keepMicro: 0, consumedMicro: 3_000 * MICRO },
    ];
    // 5,000 spent, 1,000 still covered: 4,000 may be owed — 2,000 then 2,000.
    expect(allowedDebtByUnit(units, 1_000 * MICRO)).toEqual([2_000 * MICRO, 2_000 * MICRO]);
    expect(allowedDebtByUnit(units, null)).toEqual([null, null]);
  });
});

describe('what a stand-alone cover earns above the window’s own payment', () => {
  it('its level above what stands beneath it, prorated from its start, in whole credits', () => {
    expect(envelopeKeepMicro(3_000 * MICRO, 0, MONTH_US, MONTH_US)).toBe(3_000 * MICRO);
    expect(envelopeKeepMicro(3_000 * MICRO, 1_500 * MICRO, MONTH_US / 2, MONTH_US)).toBe(
      750 * MICRO,
    );
    // 1,500 over a third of the month is 500; 1,000 over a third is 333⅓ → 333.
    expect(envelopeKeepMicro(3_000 * MICRO, 2_000 * MICRO, MONTH_US / 3, MONTH_US)).toBe(
      333 * MICRO,
    );
    expect(envelopeKeepMicro(3_000 * MICRO, 3_000 * MICRO, MONTH_US, MONTH_US)).toBe(0);
    expect(envelopeKeepMicro(1_500 * MICRO, 3_000 * MICRO, MONTH_US, MONTH_US)).toBe(0);
  });
});

function cover(over: Partial<WindowCover> & Pick<WindowCover, 'sourceRef'>): WindowCover {
  return {
    source: 'stripe_invoice',
    lineKind: 'period',
    subscriptionId: 'sub_base',
    active: true,
    levelMicro: 3_000 * MICRO,
    undisputedLevelMicro: 3_000 * MICRO,
    stillPaidMinor: PAID,
    upAt: '2026-09-01T00:00:00.000000Z',
    upMicroseconds: MONTH_US,
    downAt: '2026-09-01T00:00:00.000000Z',
    downMicroseconds: MONTH_US,
    ...over,
  };
}

function window(covers: WindowCover[], over: Partial<WindowCovers> = {}): WindowCovers {
  return {
    windowId: '00000000-0000-4000-8000-000000000001',
    source: 'stripe_invoice',
    sourceRef: 'in_base',
    levelMicro: 3_000 * MICRO,
    undisputedLevelMicro: 3_000 * MICRO,
    levelSeq: 0,
    windowEnd: '2026-10-06T00:00:00.000000Z',
    naturalMicroseconds: MONTH_US,
    nowAt: '2026-09-20T00:00:00.000000Z',
    nowMicroseconds: MONTH_US / 2,
    covers,
    ...over,
  };
}

describe('the two levels of the window containing now, and the cover that stands alone', () => {
  it('CRITICAL a dispute lowers the level SHOWN and never the undisputed one: a full dispute shows nothing, the month is still worth the plan', () => {
    const t = windowTargets(
      window([cover({ sourceRef: 'in_base', levelMicro: 0, undisputedLevelMicro: 3_000 * MICRO })]),
    );
    expect(t.levelMicro).toBe(0);
    expect(t.undisputedLevelMicro).toBe(3_000 * MICRO);
    expect(t.lineBest?.sourceRef).toBe('in_base');
    expect(t.envelope).toBeNull();
  });

  it('CRITICAL a resubscription beside a wholly refunded month earns the whole month, and the level shown is its level (re-audit #7, A9)', () => {
    const t = windowTargets(
      window([
        cover({ sourceRef: 'in_base', levelMicro: null, undisputedLevelMicro: null }),
        cover({ sourceRef: 'in_resub', subscriptionId: 'sub_resub' }),
      ]),
    );
    expect(t.undisputedLevelMicro).toBe(0);
    expect(t.levelMicro).toBe(3_000 * MICRO);
    expect(t.envelope?.cover.sourceRef).toBe('in_resub');
    expect(t.envelope?.keepMicro).toBe(3_000 * MICRO);
  });

  it('CRITICAL the hand-over is decided against the window’s own payment, not against an upgrade line above the resubscription (R5, A2)', () => {
    const t = windowTargets(
      window([
        cover({ sourceRef: 'in_base', levelMicro: null, undisputedLevelMicro: null }),
        cover({ sourceRef: 'in_resub', subscriptionId: 'sub_resub' }),
        cover({
          sourceRef: 'in_resub_up',
          subscriptionId: 'sub_resub',
          lineKind: 'proration_up',
          levelMicro: 10_000 * MICRO,
          undisputedLevelMicro: 10_000 * MICRO,
        }),
      ]),
    );
    // The upgrade line is the line's best and what the window shows…
    expect(t.lineBest?.sourceRef).toBe('in_resub_up');
    expect(t.levelMicro).toBe(10_000 * MICRO);
    expect(t.undisputedLevelMicro).toBe(10_000 * MICRO);
    // …and the resubscription still earns its own month above the refunded one.
    expect(t.envelope?.cover.sourceRef).toBe('in_resub');
    expect(t.envelope?.keepMicro).toBe(3_000 * MICRO);
  });

  it('an upgrade line BELOW the stand-alone cover is what stands beneath it: the month is not paid for twice', () => {
    const t = windowTargets(
      window([
        cover({ sourceRef: 'in_base' }),
        cover({
          sourceRef: 'in_up',
          lineKind: 'proration_up',
          levelMicro: 5_000 * MICRO,
          undisputedLevelMicro: 5_000 * MICRO,
        }),
        cover({
          sourceRef: 'in_resub',
          subscriptionId: 'sub_resub',
          levelMicro: 10_000 * MICRO,
          undisputedLevelMicro: 10_000 * MICRO,
        }),
      ]),
    );
    expect(t.envelope?.keepMicro).toBe(5_000 * MICRO);
    // The resubscription is not the line: the undisputed level stays the line's.
    expect(t.undisputedLevelMicro).toBe(5_000 * MICRO);
    expect(t.levelMicro).toBe(10_000 * MICRO);
  });

  it('a canceled subscription’s invoice keeps the month it paid for: listed but not active, it is still what the window stands on (audit #16, a lapse)', () => {
    const t = windowTargets(
      window([
        cover({
          sourceRef: 'in_base',
          active: false,
          levelMicro: 1_500 * MICRO,
          undisputedLevelMicro: 1_500 * MICRO,
        }),
      ]),
    );
    expect(t.levelMicro).toBe(1_500 * MICRO);
    expect(t.undisputedLevelMicro).toBe(1_500 * MICRO);
    expect(t.line).toEqual([]);
    expect(t.lineBest?.sourceRef).toBe('in_base');
  });

  it('a refunded crypto term (no longer listed) covers nothing, and the Stripe month beside it earns the whole month (A12)', () => {
    const t = windowTargets(
      window([cover({ sourceRef: 'in_sub' })], {
        source: 'crypto_entitlement',
        sourceRef: 'ord_1',
      }),
    );
    expect(t.ownAlone).toEqual({ levelMicro: 0, undisputedLevelMicro: 0 });
    expect(t.envelope?.cover.sourceRef).toBe('in_sub');
    expect(t.envelope?.keepMicro).toBe(3_000 * MICRO);
  });

  it('when an override the window was drawn from has ENDED, the coverage left is the line (a downgrade to it), and nothing stands alone', () => {
    const t = windowTargets(
      window([cover({ sourceRef: 'in_sub' })], {
        source: 'plan_override',
        sourceRef: 'override',
        levelMicro: 30_000 * MICRO,
        undisputedLevelMicro: 30_000 * MICRO,
      }),
    );
    expect(t.envelope).toBeNull();
    expect(t.undisputedLevelMicro).toBe(3_000 * MICRO);
    expect(t.lineBest?.sourceRef).toBe('in_sub');
  });

  it('the line’s best is chosen by a total order: at equal levels the upgrade line, then the source and reference', () => {
    const t = windowTargets(
      window([
        cover({ sourceRef: 'in_base' }),
        cover({ sourceRef: 'in_up', lineKind: 'proration_up' }),
      ]),
    );
    expect(t.lineBest?.sourceRef).toBe('in_up');
  });
});
