// A debt is followed, oldest first, to the lot that repaid it or to whoever
// forgave it (S17 audit 4, R9 and R1').
//
// A won dispute gives back what it charged beyond its lots by what became of
// it: debt still owed is forgiven, debt later credit repaid goes back into the
// lot that repaid it while that lot lasts, and debt a lot that has since
// expired repaid — or an admin forgave — gives nothing back. The account holds
// ONE debt figure, so which clawback's debt a repayment paid is read off the
// ledger in order: the oldest debt still owed is paid first (which is how
// `settleDebtFromFree` pays), a forgiveness keyed to a unit or to one
// clawback's undoing lowers exactly that, and any other forgiveness is taken
// oldest first. `debtFates` is that walk, and it is pure.

import { describe, expect, it } from 'vitest';
import type { AccountClawback, LedgerDebtEvent } from '../../src/db/credit-windows-repo.js';
import { debtFates } from '../../src/services/credit-grants.js';

const C = 1_000_000;
const W = '11111111-2222-4333-8444-555555555555';
const UNIT = `window:${W}:in_base`;
const OTHER = `window:${W}:in_resub`;
const DISPUTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const REFUND = 'aaaaaaaa-0000-4000-8000-000000000002';
const SHARE = 'aaaaaaaa-0000-4000-8000-000000000003';

const clawbacks: AccountClawback[] = [
  { id: DISPUTE, source: 'stripe_dispute', sourceRef: 'dp_1', targetKey: UNIT, state: 'applied' },
  {
    id: REFUND,
    source: 'stripe_refund',
    sourceRef: 'ch_1:2450',
    targetKey: UNIT,
    state: 'applied',
  },
  { id: SHARE, source: 'stripe_dispute', sourceRef: 'dp_9', targetKey: OTHER, state: 'applied' },
];

let nextId = 1;
/** Each row its own transaction, a second apart, in the order it was written. */
function atOf(id: number): string {
  return `2026-09-01T00:${String(Math.floor(id / 60)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}.000000Z`;
}
function incurred(key: string, credits: number): LedgerDebtEvent {
  nextId += 1;
  return {
    id: nextId,
    at: atOf(nextId),
    kind: 'debt_incurred',
    key,
    lotId: null,
    debtDeltaMicro: credits * C,
  };
}
function repaid(lotId: string, credits: number): LedgerDebtEvent {
  nextId += 1;
  return {
    id: nextId,
    at: atOf(nextId),
    kind: 'debt_repayment',
    key: `debt_repayment:${lotId}:${String(nextId)}`,
    lotId,
    debtDeltaMicro: -credits * C,
  };
}
function forgiven(key: string, credits: number): LedgerDebtEvent {
  nextId += 1;
  return {
    id: nextId,
    at: atOf(nextId),
    kind: 'adjustment',
    key,
    lotId: null,
    debtDeltaMicro: -credits * C,
  };
}

const disputeDebt = `clawback:stripe_dispute:dp_1:${UNIT}:debt`;
const refundDebt = `clawback:stripe_refund:ch_1:2450:${UNIT}:debt`;
const shareDebt = `clawback:stripe_dispute:dp_9:${OTHER}:debt`;

describe('debtFates: each clawback’s debt, followed through the ledger oldest first', () => {
  it('CRITICAL a repayment pays the OLDEST debt still owed, lot by lot, and the rest stays owed', () => {
    const byGoodwill = repaid('lot_goodwill', 2_000);
    const byTopUp = repaid('lot_topup', 1_500);
    const fates = debtFates(
      [incurred(disputeDebt, 3_000), incurred(refundDebt, 1_000), byGoodwill, byTopUp],
      clawbacks,
    );
    // Each repaid part names the row that repaid it and when: from then on, a
    // twin without the debt held that credit in the lot.
    expect(fates.get(DISPUTE)).toEqual({
      incurredMicro: 3_000 * C,
      outstandingMicro: 0,
      repaid: [
        { lotId: 'lot_goodwill', micro: 2_000 * C, rowId: byGoodwill.id, at: byGoodwill.at },
        { lotId: 'lot_topup', micro: 1_000 * C, rowId: byTopUp.id, at: byTopUp.at },
      ],
      forgivenSelfMicro: 0,
      forgivenOtherMicro: 0,
    });
    expect(fates.get(REFUND)).toEqual({
      incurredMicro: 1_000 * C,
      outstandingMicro: 500 * C,
      repaid: [{ lotId: 'lot_topup', micro: 500 * C, rowId: byTopUp.id, at: byTopUp.at }],
      forgivenSelfMicro: 0,
      forgivenOtherMicro: 0,
    });
  });

  it('CRITICAL debt an admin forgave is forgiven by someone else: nothing a win could return (P4, ruling c)', () => {
    const fates = debtFates(
      [incurred(disputeDebt, 3_000), forgiven('admin_forgive_debt:support_1', 3_000)],
      clawbacks,
    );
    expect(fates.get(DISPUTE)).toMatchObject({
      outstandingMicro: 0,
      repaid: [],
      forgivenOtherMicro: 3_000 * C,
      forgivenSelfMicro: 0,
    });
  });

  it('a forgiveness keyed to a unit lowers THAT unit’s debt, oldest first, whatever else is older', () => {
    const fates = debtFates(
      [
        incurred(shareDebt, 700),
        incurred(disputeDebt, 1_000),
        forgiven(`reinstate:${UNIT}:dp_1:won:forgive`, 400),
      ],
      clawbacks,
    );
    expect(fates.get(SHARE)?.outstandingMicro).toBe(700 * C);
    expect(fates.get(DISPUTE)).toMatchObject({
      outstandingMicro: 600 * C,
      forgivenSelfMicro: 400 * C,
    });
  });

  it('a forgiveness keyed to one clawback’s undoing lowers only that clawback’s debt', () => {
    const fates = debtFates(
      [
        incurred(refundDebt, 500),
        incurred(disputeDebt, 800),
        forgiven(`reinstate:${UNIT}:undo:${DISPUTE}:forgive`, 800),
      ],
      clawbacks,
    );
    expect(fates.get(REFUND)?.outstandingMicro).toBe(500 * C);
    expect(fates.get(DISPUTE)).toMatchObject({ outstandingMicro: 0, forgivenSelfMicro: 800 * C });
  });

  it('a claim that became debt at a task’s settle is its clawback’s debt too', () => {
    const fates = debtFates(
      [
        incurred(`claim_debt:${DISPUTE}:bbbbbbbb-0000-4000-8000-000000000009`, 1_000),
        repaid('lot_month2', 250),
      ],
      clawbacks,
    );
    expect(fates.get(DISPUTE)).toMatchObject({
      incurredMicro: 1_000 * C,
      outstandingMicro: 750 * C,
      repaid: [{ lotId: 'lot_month2', micro: 250 * C }],
    });
  });

  it('a debt row no clawback wrote still takes its place in the order: it is repaid first when it is oldest', () => {
    const fates = debtFates(
      [
        incurred('some_other_writer:debt', 300),
        incurred(disputeDebt, 1_000),
        repaid('lot_goodwill', 500),
      ],
      clawbacks,
    );
    expect(fates.get(DISPUTE)).toMatchObject({
      outstandingMicro: 800 * C,
      repaid: [{ lotId: 'lot_goodwill', micro: 200 * C }],
    });
  });

  it('a plan change’s debt names no unit in its key; the unit it is attributed to is passed in', () => {
    const planChange: AccountClawback = {
      id: 'aaaaaaaa-0000-4000-8000-000000000004',
      source: 'plan_change',
      sourceRef: `${W}:2`,
      targetKey: `window:${W}`,
      state: 'applied',
    };
    const fates = debtFates(
      [
        incurred(`clawback:plan_change:${W}:2:debt`, 900),
        forgiven(`reinstate:${UNIT}:dp_1:won:forgive`, 900),
      ],
      [...clawbacks, planChange],
      new Map([[planChange.id, UNIT]]),
    );
    expect(fates.get(planChange.id)).toMatchObject({
      outstandingMicro: 0,
      forgivenSelfMicro: 900 * C,
    });
  });
});
