// S13–S16 re-audit, round 1, finding 6 — the staff credit views
// (`services/admin-credits.ts`) round what an account OWES, and what a
// forgiveness wiped out, UP — the rule `GET /v1/account/me/ai` already follows
// for the customer (S14 audit #2).
//
// Rounded down, 500 µcr of debt read `debt_credits: 0` beside
// `debt_reason: 'payment_reversed'` on the staff account view, and forgiving
// it answered `applied: true, forgiven_credits: 0`: a staff member told the
// account owed nothing, and that a forgiveness which did clear a debt cleared
// nothing.

import { describe, expect, it } from 'vitest';
import {
  AdminCreditAdjustmentResponseSchema,
  AdminCreditsAccountStateSchema,
} from '@driftstack/api-types';
import {
  buildAdminCreditLotView,
  buildAdminCreditsAccountState,
  buildForgiveDebtAdjustmentResponse,
  buildGoodwillAdjustmentResponse,
  type AdminCreditsStateInputs,
} from '../../src/services/admin-credits.js';
import type { CreditLotRecord } from '../../src/db/credit-ledger-repo.js';

const MICRO = 1_000_000;

function stateInputs(over: Partial<AdminCreditsStateInputs> = {}): AdminCreditsStateInputs {
  return {
    publicAccountId: 'acc_00000000-0000-4000-8000-0000000000aa',
    billingMode: 'credits',
    aiSource: null,
    aiSourceSetBy: null,
    aiSourceSetAt: null,
    currentWindow: null,
    lots: [],
    availableMicro: 0,
    debtMicro: 0,
    debtReason: null,
    reservationsInFlight: 0,
    planOverride: null,
    ledger: [],
    ...over,
  };
}

function goodwillLot(): CreditLotRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000b1',
    accountId: '00000000-0000-4000-8000-0000000000aa',
    kind: 'adjustment',
    spendRank: 1,
    windowId: null,
    grantKey: 'admin_goodwill:x:y',
    grantedMicro: 10 * MICRO,
    remainingMicro: 10 * MICRO,
    heldMicro: 0,
    startsAt: new Date('2026-09-01T00:00:00Z'),
    expiresAt: new Date('2026-12-01T00:00:00Z'),
    revokedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };
}

describe('the staff account view shows owed credit rounded UP', () => {
  it('CRITICAL 500 µcr of debt reads 0.001 beside its reason — never "owes 0" next to a debt reason', () => {
    const body = buildAdminCreditsAccountState(
      stateInputs({ debtMicro: 500, debtReason: 'payment_reversed' }),
    );
    expect(body.debt_reason).toBe('payment_reversed');
    expect(body.debt_credits).toBe(0.001);
    expect(AdminCreditsAccountStateSchema.safeParse(body).success).toBe(true);
  });

  it('1,000,001 µcr of debt reads 1.001, not 1', () => {
    expect(buildAdminCreditsAccountState(stateInputs({ debtMicro: MICRO + 1 })).debt_credits).toBe(
      1.001,
    );
  });

  it('what the account HAS still rounds down: 1,000,999 µcr available reads 1', () => {
    expect(
      buildAdminCreditsAccountState(stateInputs({ availableMicro: MICRO + 999 })).available_credits,
    ).toBe(1);
  });

  it('no debt reads exactly 0', () => {
    expect(buildAdminCreditsAccountState(stateInputs()).debt_credits).toBe(0);
  });
});

describe('a staff adjustment reports owed and forgiven credit rounded UP', () => {
  it('CRITICAL forgiving 500 µcr reports forgiven_credits 0.001 — a forgiveness that cleared a debt never reads as clearing nothing', () => {
    const body = buildForgiveDebtAdjustmentResponse({
      applied: true,
      forgivenMicro: 500,
      debtMicro: 0,
    });
    expect(body.forgiven_credits).toBe(0.001);
    expect(body.debt_credits).toBe(0);
    expect(AdminCreditAdjustmentResponseSchema.safeParse(body).success).toBe(true);
  });

  it('CRITICAL the debt left after a forgiveness rounds up too', () => {
    expect(
      buildForgiveDebtAdjustmentResponse({ applied: false, forgivenMicro: 0, debtMicro: 500 })
        .debt_credits,
    ).toBe(0.001);
  });

  it('CRITICAL a goodwill grant that leaves 500 µcr owing reports debt_credits 0.001', () => {
    const body = buildGoodwillAdjustmentResponse({
      applied: true,
      lot: goodwillLot(),
      debtMicro: 500,
    });
    expect(body.debt_credits).toBe(0.001);
    expect(AdminCreditAdjustmentResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe('the staff lot view shows held credit rounded UP, as the customer view does', () => {
  it('500 µcr held on a lot reads 0.001 held, never 0', () => {
    const view = buildAdminCreditLotView({ ...goodwillLot(), heldMicro: 500 });
    expect(view.held_credits).toBe(0.001);
    // What is left to spend still rounds down: the customer can never be
    // shown more than they have.
    expect(
      buildAdminCreditLotView({ ...goodwillLot(), remainingMicro: 1_500 }).remaining_credits,
    ).toBe(0.001);
  });
});
