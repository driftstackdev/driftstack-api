// S14 — services/ai-account-state.ts: the internal → public ledger-kind
// mapping (`publicLedgerKind`/`LEDGER_KIND_MAP`), the signed display
// conversion (`signedCreditsForDisplay`), and `buildLedgerEntry`'s task/
// expires_at derivation. Pure: no database, no clock.

import { describe, expect, it } from 'vitest';
import { CREDIT_LEDGER_KINDS, type CreditLedgerKind } from '../../src/db/credit-ledger-repo.js';
import {
  buildLedgerEntry,
  publicLedgerKind,
  signedCreditsForDisplay,
} from '../../src/services/ai-account-state.js';

describe('publicLedgerKind — total over CREDIT_LEDGER_KINDS, and a paid claim reads as a refund', () => {
  it('CRITICAL maps every internal kind the database accepts, with no throw', () => {
    for (const kind of CREDIT_LEDGER_KINDS) {
      expect(() => publicLedgerKind(kind)).not.toThrow();
    }
  });

  it('grant and proration_grant both read as grant', () => {
    expect(publicLedgerKind('grant')).toBe('grant');
    expect(publicLedgerKind('proration_grant')).toBe('grant');
  });

  it('CRITICAL a clawback taking credit, AND the same clawback source later paying a pending claim off held credit, both read as refund — the internal kind is identical (clawbackLedgerKind in credit-reservations.ts), so the mapping needs no separate rule for "a paid pending claim"', () => {
    expect(publicLedgerKind('proration_clawback')).toBe('refund');
    expect(publicLedgerKind('refund_clawback')).toBe('refund');
  });

  it('debt_incurred and debt_repayment both read as debt', () => {
    expect(publicLedgerKind('debt_incurred')).toBe('debt');
    expect(publicLedgerKind('debt_repayment')).toBe('debt');
  });

  it('task_charge, top_up, expiry and adjustment are unchanged', () => {
    expect(publicLedgerKind('task_charge')).toBe('task_charge');
    expect(publicLedgerKind('top_up')).toBe('top_up');
    expect(publicLedgerKind('expiry')).toBe('expiry');
    expect(publicLedgerKind('adjustment')).toBe('adjustment');
  });

  it('every public kind produced is one AiLedgerEntryKind accepts (no stray value)', () => {
    const PUBLIC_KINDS = [
      'grant',
      'task_charge',
      'refund',
      'top_up',
      'expiry',
      'adjustment',
      'debt',
    ];
    for (const kind of CREDIT_LEDGER_KINDS) {
      expect(PUBLIC_KINDS).toContain(publicLedgerKind(kind));
    }
  });
});

describe('signedCreditsForDisplay — arrivals round down in magnitude, departures round up', () => {
  it('a positive (arriving) delta rounds its magnitude DOWN to 0.001 credit', () => {
    // 1,000,999 µcr = 1.000999 credits, floored to 1.000.
    expect(signedCreditsForDisplay(1_000_999)).toBe(1.0);
  });

  it('a negative (departing) delta rounds its magnitude UP to 0.001 credit', () => {
    // -1,000,001 µcr: the magnitude 1,000,001 ceils to 1.001, so the signed
    // result is -1.001 — never LESS negative than what really left.
    expect(signedCreditsForDisplay(-1_000_001)).toBe(-1.001);
  });

  it('zero is zero', () => {
    expect(signedCreditsForDisplay(0)).toBe(0);
  });

  it('an exact multiple of the display step round-trips exactly, either sign', () => {
    expect(signedCreditsForDisplay(2_000_000)).toBe(2);
    expect(signedCreditsForDisplay(-2_000_000)).toBe(-2);
  });
});

const BASE_ENTRY = {
  id: '42',
  kind: 'task_charge' as CreditLedgerKind,
  deltaMicro: -6_000_000,
  balanceAfterMicro: 10_000_000,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  lotExpiresAt: null,
  agentSessionId: 'agt_1',
  model: 'claude-sonnet-5',
  rateCardVersion: 1,
};

describe('buildLedgerEntry — task, and expires_at only on a row that added credit', () => {
  it('CRITICAL a task_charge with a full (session, model, rate card) triple carries a task block', () => {
    const entry = buildLedgerEntry(BASE_ENTRY);
    expect(entry.task).toEqual({
      agent_session_id: 'agt_1',
      model: 'claude-sonnet-5',
      rate_card_version: 1,
    });
    expect(entry.kind).toBe('task_charge');
    expect(entry.credits).toBe(-6);
  });

  it('a non-task_charge row never carries a task block, even with all three facts non-null', () => {
    const entry = buildLedgerEntry({ ...BASE_ENTRY, kind: 'grant', deltaMicro: 6_000_000 });
    expect(entry.task).toBeNull();
  });

  it('expires_at is null on a row that took credit away (a task_charge), whatever lotExpiresAt says', () => {
    const entry = buildLedgerEntry({
      ...BASE_ENTRY,
      lotExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(entry.expires_at).toBeNull();
  });

  it('CRITICAL expires_at is the lot expiry on a row that ADDED credit', () => {
    const entry = buildLedgerEntry({
      ...BASE_ENTRY,
      kind: 'grant',
      deltaMicro: 6_000_000,
      lotExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(entry.expires_at).toBe('2027-01-01T00:00:00.000Z');
  });

  it('expires_at is null on a row that added credit but names no lot (unreachable for a real grant, defensive)', () => {
    const entry = buildLedgerEntry({
      ...BASE_ENTRY,
      kind: 'adjustment',
      deltaMicro: 500_000,
      lotExpiresAt: null,
    });
    expect(entry.expires_at).toBeNull();
  });

  it('balance_after_credits reads the running balance, rounded down like any other balance', () => {
    const entry = buildLedgerEntry({ ...BASE_ENTRY, balanceAfterMicro: 10_000_999 });
    expect(entry.balance_after_credits).toBe(10.0);
  });
});
