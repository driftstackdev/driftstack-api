// S14 audit fixes #1 and #11 — `buildLedgerEntry` (services/ai-account-state.ts),
// the pure mapping every `GET /v1/account/me/ai/ledger` row goes through.
//
// #1: the running balance is Σ(lot_delta − debt_delta), so it is NEGATIVE
// whenever an account owes more than it holds. Displaying it through the
// balance helper (which refuses a negative) threw `RangeError: micro must not
// be negative`, and the route answered 500 for every page that held such a
// row — forever, because ledger history never changes. It is now a SIGNED
// amount, rounded toward minus infinity (`signedCreditsForDisplay`'s rule),
// and the schema field is `SignedCreditAmountSchema`.
//
// #11: `credit_ledger.model` is a plain text column. Parsing it through
// `AgentModelSchema` turned a model retired from the enum into a 500 on every
// page holding one of its charges. It now falls back to `null` — the one
// fallback the schema admits without widening the model enum into a free
// string.
//
// The real route over a real database, with the audit's exact scenario, is
// in the-credit-ledger-route-survives-debt-and-groups-a-tasks-charges-on-a-real-database.test.ts.

import { describe, expect, it } from 'vitest';
import { AiLedgerEntrySchema } from '@driftstack/api-types';
import {
  buildLedgerEntry,
  signedCreditsForDisplay,
  type LedgerEntryInputs,
} from '../../src/services/ai-account-state.js';

const DEBT_ROW: LedgerEntryInputs = {
  id: '3',
  kind: 'debt_incurred',
  deltaMicro: -5_000_000,
  balanceAfterMicro: -5_000_000,
  createdAt: new Date('2026-06-02T00:00:00Z'),
  lotExpiresAt: null,
  agentSessionId: null,
  model: null,
  rateCardVersion: null,
};

const TASK_ROW: LedgerEntryInputs = {
  id: '9',
  kind: 'task_charge',
  deltaMicro: -4_500_000,
  balanceAfterMicro: 5_500_000,
  createdAt: new Date('2026-06-03T00:00:00Z'),
  lotExpiresAt: new Date('2026-07-01T00:00:00Z'),
  agentSessionId: 'as_1',
  model: 'claude-sonnet-5',
  rateCardVersion: 1,
};

describe('a ledger entry whose running balance is below zero', () => {
  it('CRITICAL is shown signed (−5) rather than refused — the audit scenario: 10 granted, 10 clawed back, 5 of debt', () => {
    const entry = buildLedgerEntry(DEBT_ROW);
    expect(entry.balance_after_credits).toBe(-5);
    expect(entry.credits).toBe(-5);
  });

  it('CRITICAL is accepted by the published entry schema', () => {
    const parsed = AiLedgerEntrySchema.safeParse(buildLedgerEntry(DEBT_ROW));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('rounds toward minus infinity: one microcredit of debt reads −0.001, never 0', () => {
    expect(buildLedgerEntry({ ...DEBT_ROW, balanceAfterMicro: -1 }).balance_after_credits).toBe(
      -0.001,
    );
    expect(
      buildLedgerEntry({ ...DEBT_ROW, balanceAfterMicro: -4_999_999 }).balance_after_credits,
    ).toBe(-5);
  });

  it('is the same rule signedCreditsForDisplay applies, on both sides of zero', () => {
    for (const micro of [-10_000_001, -1, 0, 1, 999, 10_000_999]) {
      expect(
        buildLedgerEntry({ ...DEBT_ROW, balanceAfterMicro: micro }).balance_after_credits,
        String(micro),
      ).toBe(signedCreditsForDisplay(micro));
    }
  });

  it('a positive running balance still rounds DOWN, as every balance does', () => {
    expect(
      buildLedgerEntry({ ...DEBT_ROW, balanceAfterMicro: 10_000_999 }).balance_after_credits,
    ).toBe(10);
  });
});

describe('a task charge whose stored model has left the model enum', () => {
  it('CRITICAL still renders, with its session and rate card, and the model reported as null', () => {
    const entry = buildLedgerEntry({ ...TASK_ROW, model: 'claude-sonnet-3-retired' });
    expect(entry.task).toEqual({
      agent_session_id: 'as_1',
      model: null,
      rate_card_version: 1,
    });
    const parsed = AiLedgerEntrySchema.safeParse(entry);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('a model still in the enum is reported as itself', () => {
    expect(buildLedgerEntry(TASK_ROW).task?.model).toBe('claude-sonnet-5');
  });

  it('the fallback is null, not a free string: the schema still refuses a model outside the enum', () => {
    const entry = buildLedgerEntry(TASK_ROW);
    expect(
      AiLedgerEntrySchema.safeParse({
        ...entry,
        task: { agent_session_id: 'as_1', model: 'claude-sonnet-3-retired', rate_card_version: 1 },
      }).success,
    ).toBe(false);
  });
});
