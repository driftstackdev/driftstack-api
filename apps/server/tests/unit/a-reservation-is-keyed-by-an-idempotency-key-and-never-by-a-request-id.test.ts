// A reservation's `request_key` comes from an Idempotency-Key and from nothing
// else, and the two narrowings a settlement makes are stated once.
//
// ⛔ WHY THE REQUEST ID IS NOT A KEY (M2). `genReqId` returns the INBOUND
// `x-request-id` header when one is present, so it is client-controlled: a
// client or a proxy that reuses one would hit
// `credit_reservations_request_unique` on every later task and be refused a turn
// it is entitled to. The idempotent lane already prevents re-execution through
// its turn receipt, so a key there is a second guard on a lane that asked for
// one; everywhere else the column is NULL and the partial index does not apply.
//
// The other two functions here are narrowings: five clawback sources map onto
// two ledger movements and two debt reasons, and a settlement has to choose one
// of each from a source it read out of the database. Stated as pure functions so
// that every case can be written down without one, and checked against the
// vocabularies the database actually accepts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AiDebtReasonSchema } from '@driftstack/api-types';
import { CREDIT_LEDGER_KINDS, creditLedgerRowFor } from '../../src/db/credit-ledger-repo.js';
import { CREDIT_CLAWBACK_SOURCES } from '../../src/db/credit-windows-repo.js';
import {
  clawbackDebtReason,
  clawbackLedgerKind,
  requestKeyFor,
} from '../../src/services/credit-reservations.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(HERE, '..', '..', 'src', 'services', 'credit-reservations.ts');
const M = 1_000_000;

describe('a reservation is keyed by an Idempotency-Key and never by a request id', () => {
  it('CRITICAL no key at all means NULL, so the unique index does not apply to the ordinary lane', () => {
    expect(requestKeyFor(null)).toBeNull();
    // A header that is present but empty is not a key either: keyed on '', every
    // task on the account after the first would be refused.
    expect(requestKeyFor('')).toBeNull();
    expect(requestKeyFor('   ')).toBeNull();
  });

  it('CRITICAL a key is stored under the `idem:` prefix, trimmed, so the lane it came from is readable from the row', () => {
    expect(requestKeyFor('abc')).toBe('idem:abc');
    expect(requestKeyFor('  abc  ')).toBe('idem:abc');
    // Long enough to matter: the column takes 1 to 300 characters, and the
    // prefix is part of that budget.
    expect(requestKeyFor('k'.repeat(294))).toHaveLength(299);
  });

  it('⛔ CRITICAL the service never builds a key from a request id. The plan’s first draft used `req:<request id>`, which is the inbound x-request-id and client-controlled — a proxy that repeats one would refuse every later task on that account with a 409.', () => {
    const source = codeOnly(readFileSync(SERVICE, 'utf8'));
    expect(source, "no 'req:' key is constructed anywhere in the service").not.toMatch(/['"`]req:/);
    expect(source, 'and the one prefix it does build is the idempotent one').toContain('`idem:');
  });

  it('CRITICAL every clawback source maps to a ledger movement the database accepts, and a plan change is the only one that is a proration', () => {
    const mapped = Object.fromEntries(
      CREDIT_CLAWBACK_SOURCES.map((source) => [source, clawbackLedgerKind(source)]),
    );
    expect(mapped).toEqual({
      plan_change: 'proration_clawback',
      stripe_refund: 'refund_clawback',
      stripe_dispute: 'refund_clawback',
      crypto_refund: 'refund_clawback',
      admin: 'refund_clawback',
    });
    for (const kind of Object.values(mapped)) {
      expect(CREDIT_LEDGER_KINDS, `${kind} is a kind the ledger accepts`).toContain(kind);
    }
  });

  it('CRITICAL every clawback source maps to a debt reason the database accepts — there are five sources and two reasons, so the narrowing is written down rather than re-derived at each call site', () => {
    const mapped = Object.fromEntries(
      CREDIT_CLAWBACK_SOURCES.map((source) => [source, clawbackDebtReason(source)]),
    );
    expect(mapped).toEqual({
      plan_change: 'plan_change',
      stripe_refund: 'payment_reversed',
      stripe_dispute: 'payment_reversed',
      crypto_refund: 'payment_reversed',
      admin: 'payment_reversed',
    });
    for (const reason of Object.values(mapped)) {
      expect(AiDebtReasonSchema.options, `${reason} is a reason the database accepts`).toContain(
        reason,
      );
    }
  });

  it('CRITICAL a task charge carries all three facts the database requires of one — which task, at which rate card, on which model — and takes credit OUT of its lot', () => {
    const row = creditLedgerRowFor({
      accountId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'task_charge:r:l',
      kind: 'task_charge',
      lotId: '00000000-0000-4000-8000-0000000000aa',
      amountMicro: 3 * M,
      reservationId: '00000000-0000-4000-8000-0000000000bb',
      rateCardVersion: 1,
      model: 'claude-sonnet-5',
    });
    expect(row).toMatchObject({
      kind: 'task_charge',
      lotId: '00000000-0000-4000-8000-0000000000aa',
      lotDeltaMicro: -3 * M,
      debtDeltaMicro: 0,
      reservationId: '00000000-0000-4000-8000-0000000000bb',
      rateCardVersion: 1,
      model: 'claude-sonnet-5',
    });
  });

  it('CRITICAL every OTHER movement carries none of those three, so a row that names a task really is a task charge', () => {
    const grant = creditLedgerRowFor({
      accountId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'g',
      kind: 'grant',
      lotId: '00000000-0000-4000-8000-0000000000aa',
      amountMicro: M,
    });
    expect(grant).toMatchObject({ reservationId: null, rateCardVersion: null, model: null });
  });

  it('CRITICAL a refund clawback takes credit out of a lot the same way a proration clawback does — the two differ in why, not in shape', () => {
    const shape = (kind: 'proration_clawback' | 'refund_clawback') =>
      creditLedgerRowFor({
        accountId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: `k-${kind}`,
        kind,
        lotId: '00000000-0000-4000-8000-0000000000aa',
        amountMicro: 2 * M,
        reason: 'stripe_refund',
      });
    expect(shape('refund_clawback')).toMatchObject({
      kind: 'refund_clawback',
      lotDeltaMicro: -2 * M,
      debtDeltaMicro: 0,
      reason: 'stripe_refund',
    });
    expect(shape('proration_clawback')).toMatchObject({
      kind: 'proration_clawback',
      lotDeltaMicro: -2 * M,
    });
  });

  it('CRITICAL a charge that is not a positive whole number of microcredits is refused before the database sees it', () => {
    for (const bad of [0, -M, 1.5, Number.NaN, 2 ** 53]) {
      expect(
        () =>
          creditLedgerRowFor({
            accountId: '00000000-0000-4000-8000-000000000001',
            idempotencyKey: 'bad',
            kind: 'task_charge',
            lotId: '00000000-0000-4000-8000-0000000000aa',
            amountMicro: bad,
            reservationId: '00000000-0000-4000-8000-0000000000bb',
            rateCardVersion: 1,
            model: 'claude-sonnet-5',
          }),
        String(bad),
      ).toThrow(RangeError);
    }
  });
});
