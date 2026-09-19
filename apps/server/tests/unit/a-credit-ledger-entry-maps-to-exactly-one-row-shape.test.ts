// A credit ledger entry maps to exactly one row shape.
//
// `creditLedgerRowFor` turns a typed movement — a grant, an expiry, a lot
// adjustment, forgiven debt, debt incurred, a repayment — into the one ledger
// row that records it: which kind, which lot, and the SIGN of each delta. The
// database's shape CHECK refuses a wrong sign, so a mapping error here fails at
// the INSERT; this pins it without a database, together with the early refusals
// (a non-positive or unsafe amount, a key outside 1 to 200 characters, a debt
// reason the database does not accept).
//
// And the vocabularies: the ledger kinds and actors, the lot kinds and the
// override reasons the repository declares are the lists migration 0128 writes
// into its CHECKs. The same comparison against the LIVE database runs in
// `database-check-enums-agree-with-the-code`; this one needs no database.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREDIT_LOT_KINDS } from '@driftstack/api-types';
import {
  CREDIT_LEDGER_ACTORS,
  CREDIT_LEDGER_KINDS,
  CREDIT_PLAN_OVERRIDE_REASONS,
  creditLedgerRowFor,
  type NewCreditLedgerEntry,
} from '../../src/db/credit-ledger-repo.js';

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/0128_credit_ledger.sql',
);

const account = '00000000-0000-4000-8000-000000000001';
const lot = '00000000-0000-4000-8000-0000000000aa';
const M = 1_000_000;

describe('a credit ledger entry maps to exactly one row shape', () => {
  it('CRITICAL each movement writes its kind, its lot and the sign the database requires', () => {
    const cases: Array<[NewCreditLedgerEntry, object]> = [
      [
        { accountId: account, idempotencyKey: 'g', kind: 'grant', lotId: lot, amountMicro: 5 * M },
        { kind: 'grant', lotId: lot, lotDeltaMicro: 5 * M, debtDeltaMicro: 0 },
      ],
      [
        { accountId: account, idempotencyKey: 'e', kind: 'expiry', lotId: lot, amountMicro: 5 * M },
        { kind: 'expiry', lotId: lot, lotDeltaMicro: -5 * M, debtDeltaMicro: 0 },
      ],
      [
        {
          accountId: account,
          idempotencyKey: 'a+',
          kind: 'adjustment',
          lotId: lot,
          lotDeltaMicro: 2 * M,
        },
        { kind: 'adjustment', lotId: lot, lotDeltaMicro: 2 * M, debtDeltaMicro: 0 },
      ],
      [
        {
          accountId: account,
          idempotencyKey: 'a-',
          kind: 'adjustment',
          lotId: lot,
          lotDeltaMicro: -2 * M,
        },
        { kind: 'adjustment', lotId: lot, lotDeltaMicro: -2 * M, debtDeltaMicro: 0 },
      ],
      [
        { accountId: account, idempotencyKey: 'f', kind: 'adjustment', forgiveDebtMicro: 3 * M },
        { kind: 'adjustment', lotId: null, lotDeltaMicro: 0, debtDeltaMicro: -3 * M },
      ],
      [
        {
          accountId: account,
          idempotencyKey: 'd',
          kind: 'debt_incurred',
          amountMicro: 4 * M,
          reason: 'plan_change',
        },
        {
          kind: 'debt_incurred',
          lotId: null,
          lotDeltaMicro: 0,
          debtDeltaMicro: 4 * M,
          reason: 'plan_change',
        },
      ],
      [
        {
          accountId: account,
          idempotencyKey: 'r',
          kind: 'debt_repayment',
          lotId: lot,
          amountMicro: 4 * M,
        },
        { kind: 'debt_repayment', lotId: lot, lotDeltaMicro: -4 * M, debtDeltaMicro: -4 * M },
      ],
    ];
    for (const [entry, expected] of cases) {
      expect(creditLedgerRowFor(entry), entry.idempotencyKey).toMatchObject({
        accountId: account,
        idempotencyKey: entry.idempotencyKey,
        ...expected,
      });
    }
  });

  it('the actor defaults to the system and the session and reason to none; given ones are kept', () => {
    const plain = creditLedgerRowFor({
      accountId: account,
      idempotencyKey: 'plain',
      kind: 'grant',
      lotId: lot,
      amountMicro: M,
    });
    expect(plain).toMatchObject({ actor: 'system', agentSessionId: null, reason: null });
    const attributed = creditLedgerRowFor({
      accountId: account,
      idempotencyKey: 'attributed',
      kind: 'adjustment',
      lotId: lot,
      lotDeltaMicro: M,
      actor: 'admin',
      agentSessionId: 'as_1',
      reason: 'goodwill',
    });
    expect(attributed).toMatchObject({
      actor: 'admin',
      agentSessionId: 'as_1',
      reason: 'goodwill',
    });
  });

  it('CRITICAL an amount that is not a positive safe integer of microcredits is refused before the database', () => {
    for (const bad of [0, -M, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(
        () =>
          creditLedgerRowFor({
            accountId: account,
            idempotencyKey: 'bad',
            kind: 'grant',
            lotId: lot,
            amountMicro: bad,
          }),
        String(bad),
      ).toThrow(RangeError);
      expect(
        () =>
          creditLedgerRowFor({
            accountId: account,
            idempotencyKey: 'bad',
            kind: 'adjustment',
            forgiveDebtMicro: bad,
          }),
        String(bad),
      ).toThrow(RangeError);
    }
    // A lot adjustment is signed, so only zero and unsafe values are refused.
    for (const bad of [0, 0.5, 2 ** 53]) {
      expect(() =>
        creditLedgerRowFor({
          accountId: account,
          idempotencyKey: 'bad',
          kind: 'adjustment',
          lotId: lot,
          lotDeltaMicro: bad,
        }),
      ).toThrow(RangeError);
    }
  });

  it('CRITICAL an idempotency key is 1 to 200 characters, counted as Postgres counts them (code points, not UTF-16 units)', () => {
    const row = (idempotencyKey: string) =>
      creditLedgerRowFor({
        accountId: account,
        idempotencyKey,
        kind: 'grant',
        lotId: lot,
        amountMicro: M,
      });
    expect(() => row('')).toThrow(RangeError);
    expect(() => row('k'.repeat(201))).toThrow(RangeError);
    expect(row('k'.repeat(200)).idempotencyKey).toHaveLength(200);
    // 200 astral characters are 400 UTF-16 units and 200 characters.
    const astral = '𝄞'.repeat(200);
    expect(astral.length).toBe(400);
    expect(row(astral).idempotencyKey).toBe(astral);
    expect(() => row('𝄞'.repeat(201))).toThrow(RangeError);
  });

  it('CRITICAL debt is incurred only for a reason the database accepts', () => {
    expect(() =>
      creditLedgerRowFor({
        accountId: account,
        idempotencyKey: 'debt',
        kind: 'debt_incurred',
        amountMicro: M,
        reason: 'fraud' as never,
      }),
    ).toThrow(RangeError);
  });

  it('CRITICAL the vocabularies the repository declares are the lists migration 0128 writes into its CHECKs', () => {
    const sql = readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, ' ');
    const listOf = (constraint: string): string[] => {
      const m = new RegExp(`"${constraint}" CHECK \\(\\s*"\\w+" IN \\(([^)]*)\\)\\)`).exec(sql);
      expect(m, `${constraint} not found as a plain IN list`).not.toBeNull();
      return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((v) => v[1] ?? '');
    };
    expect(listOf('credit_ledger_kind')).toEqual([...CREDIT_LEDGER_KINDS]);
    expect(listOf('credit_ledger_actor')).toEqual([...CREDIT_LEDGER_ACTORS]);
    expect(listOf('credit_lots_kind')).toEqual([...CREDIT_LOT_KINDS]);
    expect(listOf('credit_plan_overrides_reason')).toEqual([...CREDIT_PLAN_OVERRIDE_REASONS]);
  });
});
