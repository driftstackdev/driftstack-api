// A new grant pays off debt first.
//
// An account can owe credits: it spent them, and the payment behind them was
// then reversed. While it owes, it has no credit to spend — the database refuses
// to COMMIT an account that holds debt beside spendable credit, so "in debt but
// still running tasks" cannot exist.
//
// That rule has a consequence for grants. The month a customer in debt has paid
// for arrives as free credit on an account with debt, which is exactly the state
// the database refuses. So the refresh ends by settling the debt out of whatever
// is now free, in the same transaction as the grant: the customer's new month is
// what is left after the debt is repaid, and the grant can commit at all.
//
// The contrast arm runs the grant WITHOUT that last step and watches the
// database refuse it, so the step is shown to be load-bearing rather than tidy.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantCounts,
  grantsHarness,
  ledgerOf,
  lotsOf,
  payingCustomer,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import { repoRefusal } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_grant_debt';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

/** A paying customer who owes `credits`, with nothing to spend. */
async function customerInDebt(credits: number): Promise<string> {
  const { accountId } = await payingCustomer(db(), 'api_starter');
  await h().ledger.ensureAccount(accountId);
  await h().ledger.append({
    accountId,
    kind: 'debt_incurred',
    amountMicro: credits * MICRO,
    reason: 'payment_reversed',
    idempotencyKey: 'a-payment-was-reversed',
  });
  expect(await debtOf(db(), accountId)).toBe(credits * MICRO);
  return accountId;
}

describe.skipIf(!RUN_DB_TESTS)('a new grant pays off debt first', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL a customer owing 1,000 credits is granted a 3,000-credit month: the debt is repaid from the grant in the same transaction, and 2,000 are left to spend', async () => {
    const accountId = await customerInDebt(1_000);

    const result = await h().grants.refreshCredits(accountId);
    expect(result.window).toMatchObject({ outcome: 'created', grantedMicro: 3_000 * MICRO });
    const [lot] = await lotsOf(db(), accountId);
    expect(result.repaid).toEqual([{ lotId: lot?.id, repaidMicro: 1_000 * MICRO }]);

    expect(await debtOf(db(), accountId)).toBe(0);
    expect(lot?.remaining_micro).toBe(String(2_000 * MICRO));
    expect(await h().ledger.spendableMicro(accountId)).toBe(2_000 * MICRO);
    expect((await ledgerOf(db(), accountId)).map((e) => e.kind)).toEqual([
      'debt_incurred',
      'grant',
      'debt_repayment',
    ]);
    expect((await ledgerOf(db(), accountId))[2]).toEqual({
      kind: 'debt_repayment',
      lot_id: lot?.id,
      lot_delta_micro: String(-1_000 * MICRO),
      debt_delta_micro: String(-1_000 * MICRO),
      idempotency_key: `debt_repayment:${lot?.id ?? ''}:1`,
    });
  });

  it('a debt larger than the month takes the whole grant: nothing is left to spend, and the rest is still owed', async () => {
    const accountId = await customerInDebt(5_000);

    const result = await h().grants.refreshCredits(accountId);
    expect(result.repaid.map((r) => r.repaidMicro)).toEqual([3_000 * MICRO]);
    expect(await debtOf(db(), accountId)).toBe(2_000 * MICRO);
    expect(await h().ledger.spendableMicro(accountId)).toBe(0);
    expect((await lotsOf(db(), accountId))[0]?.remaining_micro).toBe('0');

    // Asked again, there is nothing free to settle from and nothing new to grant.
    const again = await h().grants.refreshCredits(accountId);
    expect(again.window).toEqual({ outcome: 'none' });
    expect(again.repaid).toEqual([]);
    expect(await debtOf(db(), accountId)).toBe(2_000 * MICRO);
  });

  it('an account that owes nothing is settled of nothing: no repayment row, the whole month to spend', async () => {
    const { accountId } = await payingCustomer(db(), 'api_starter');
    const result = await h().grants.refreshCredits(accountId);
    expect(result.repaid).toEqual([]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(3_000 * MICRO);
  });

  it('CRITICAL the contrast: the same grant WITHOUT the settlement step cannot commit. The database refuses debt beside spendable credit at COMMIT, and the grant rolls back whole — which is what a refresh that forgot to settle would do to every customer in debt', async () => {
    const accountId = await customerInDebt(1_000);

    const r = await repoRefusal(() =>
      h().ledger.transaction(async (tx) => {
        await h().ledger.lockAccount(tx, accountId);
        const granted = await h().grants.materializeWindows(tx, accountId);
        expect(granted.outcome).toBe('created');
        // …and no settleDebtFromFree.
      }),
    );
    expect(r.code).toBe('23514');
    expect(r.constraint).toBe('credit_ledger_debt_vs_free');
    // Rolled back whole: only the debt row is there.
    expect(await grantCounts(db(), accountId)).toEqual({ windows: 0, lots: 0, ledger: 1 });
  });
});
