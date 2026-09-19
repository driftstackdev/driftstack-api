// The credit ledger is append-only, and its rows die only with their account.
//
// A balance is the sum of its ledger rows, so a ledger row that could be edited
// or deleted would make every balance unverifiable. The database refuses both,
// and refuses deleting a lot or an account's credit row while the account lives
// (deleting a credit row would forgive its debt with no ledger row).
//
// The one way any of these rows goes is the cascade of the account itself being
// deleted. The guards tell the two apart by whether the account row still
// exists, so this file proves both halves: the refusals while it does, and a
// clean cascade — debt, lots, ledger rows naming those lots, an override — once
// it does not, with a second account's rows untouched beside it.
//
// "Whether the account row still exists" is a query inside the guard, and an
// unqualified table name in it would resolve to a session's TEMPORARY table of
// the same name first: an empty temporary `accounts` would make every account
// look deleted. The guard functions pin their search_path, and an arm here
// proves a stand-in changes nothing.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  debtOf,
  fundedLot,
  ledgerCount,
  newCreditAccount,
  openLedgerDatabase,
  remainingOf,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_append_only';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  client = opened?.sql ?? null;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

/** Rows each credit table holds for `accountId`. */
async function rowsOf(accountId: string): Promise<Record<string, number>> {
  const [row] = await db()<
    Array<{ accounts: number; ledger: number; lots: number; overrides: number }>
  >`
    SELECT (SELECT count(*)::int FROM credit_accounts WHERE account_id = ${accountId}::uuid) AS accounts,
           (SELECT count(*)::int FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger,
           (SELECT count(*)::int FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
           (SELECT count(*)::int FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid) AS overrides`;
  return { ...row };
}

/** An account with a credit row, two funded lots, an expiry, debt and an override. */
async function populatedAccount(): Promise<{ accountId: string; lotId: string }> {
  const accountId = await newCreditAccount(db());
  const lotId = await fundedLot(db(), accountId, { credits: 10 });
  await fundedLot(db(), accountId, { kind: 'top_up', credits: 5 });
  await db()`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
    VALUES (${accountId}::uuid, 'expiry', ${lotId}::uuid, ${-2 * MICRO}, 'expire:1')`;
  // Debt needs no spendable credit beside it at commit, so it is incurred and
  // the free credit expired in one transaction.
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
      VALUES (${accountId}::uuid, 'debt_incurred', ${3 * MICRO}, 'debt:1', 'payment_reversed')`;
    await tx`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
      SELECT ${accountId}::uuid, 'expiry', id, -remaining_micro, 'expire-rest:' || id
        FROM credit_lots WHERE account_id = ${accountId}::uuid AND remaining_micro > 0`;
  });
  await db()`
    INSERT INTO credit_plan_overrides (account_id, monthly_credits, anchor_at, reason)
    VALUES (${accountId}::uuid, 40000, now(), 'contract')`;
  return { accountId, lotId };
}

describe.skipIf(!RUN_DB_TESTS)(
  'the credit ledger is append-only and dies only with its account',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL an UPDATE of a ledger row is refused, whichever column it touches, and the balance it applied stays applied', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 10 });
      for (const set of [
        "reason = 'edited'",
        'lot_delta_micro = 1',
        "kind = 'top_up'",
        "idempotency_key = 'another'",
        "created_at = created_at - interval '1 day'",
      ]) {
        const refused = await refusal(
          () => db().unsafe(`UPDATE credit_ledger SET ${set} WHERE account_id = '${accountId}'`),
          set,
        );
        expect(refused, set).toMatchObject({
          code: '55000',
          message: 'credit_ledger is append-only: UPDATE refused',
        });
      }
      expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
    });

    it('CRITICAL a DELETE of a ledger row is refused while its account exists', async () => {
      const { accountId } = await populatedAccount();
      const before = await ledgerCount(db(), accountId);
      expect(before, 'the populated account has ledger rows').toBeGreaterThanOrEqual(5);
      const refused = await refusal(
        () => db()`DELETE FROM credit_ledger WHERE account_id = ${accountId}::uuid`,
      );
      expect(refused).toMatchObject({
        code: '55000',
        message: 'credit_ledger is append-only: DELETE refused',
      });
      expect(await ledgerCount(db(), accountId)).toBe(before);
    });

    it("CRITICAL a lot, and an account's credit row, cannot be deleted while the account exists — deleting the credit row would forgive its debt with no ledger row", async () => {
      const { accountId, lotId } = await populatedAccount();
      expect(await debtOf(db(), accountId), 'the populated account owes 3 credits').toBe(3 * MICRO);

      const lot = await refusal(() => db()`DELETE FROM credit_lots WHERE id = ${lotId}::uuid`);
      expect(lot).toMatchObject({
        code: '55000',
        message: 'credit_lots rows are removed only with their account',
      });
      const account = await refusal(
        () => db()`DELETE FROM credit_accounts WHERE account_id = ${accountId}::uuid`,
      );
      expect(account).toMatchObject({
        code: '55000',
        message: 'credit_accounts rows are removed only with their account',
      });
      expect(await rowsOf(accountId)).toEqual({ accounts: 1, ledger: 6, lots: 2, overrides: 1 });
      expect(await debtOf(db(), accountId)).toBe(3 * MICRO);
    });

    it('CRITICAL a session cannot make the guards read a temporary table in place of the real one — with a temporary "accounts" standing in (pg_temp is searched first), ledger rows, lots and the credit row are still refused a DELETE while the account lives', async () => {
      const { accountId } = await populatedAccount();
      const refused = await inRolledBackTransaction(db(), async (tx) => {
        await tx.unsafe('CREATE TEMP TABLE accounts (id uuid) ON COMMIT DROP');
        const [shadow] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM accounts`;
        expect(shadow?.n, 'an unqualified "accounts" now reads the empty stand-in').toBe(0);
        const out: string[] = [];
        for (const table of ['credit_ledger', 'credit_lots', 'credit_accounts']) {
          const r = await refusal(
            () =>
              tx.savepoint((sp) =>
                sp.unsafe(`DELETE FROM public.${table} WHERE account_id = '${accountId}'`),
              ),
            `a DELETE from ${table} beside a stand-in accounts table`,
          );
          out.push(`${table}: ${r.code}`);
        }
        return out;
      });
      expect(refused).toEqual([
        'credit_ledger: 55000',
        'credit_lots: 55000',
        'credit_accounts: 55000',
      ]);
      expect(await rowsOf(accountId)).toEqual({ accounts: 1, ledger: 6, lots: 2, overrides: 1 });
    });

    it("CRITICAL deleting the account removes every credit row it had — debt, lots, ledger rows naming those lots, its override — in one statement, and leaves another account's rows alone", async () => {
      const doomed = await populatedAccount();
      const bystander = await populatedAccount();
      expect(await rowsOf(doomed.accountId)).toEqual({
        accounts: 1,
        ledger: 6,
        lots: 2,
        overrides: 1,
      });

      await db()`DELETE FROM accounts WHERE id = ${doomed.accountId}::uuid`;

      expect(await rowsOf(doomed.accountId), 'nothing of the deleted account is left').toEqual({
        accounts: 0,
        ledger: 0,
        lots: 0,
        overrides: 0,
      });
      expect(await rowsOf(bystander.accountId), 'the other account is untouched').toEqual({
        accounts: 1,
        ledger: 6,
        lots: 2,
        overrides: 1,
      });
      expect(await debtOf(db(), bystander.accountId)).toBe(3 * MICRO);
      expect(await remainingOf(db(), bystander.lotId)).toBe(0);
    });
  },
);
