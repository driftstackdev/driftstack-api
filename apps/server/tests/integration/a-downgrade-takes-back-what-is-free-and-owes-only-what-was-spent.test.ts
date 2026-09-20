// A downgrade takes back what is FREE, and the account owes only what it had
// already SPENT.
//
// The customer was granted a month of the larger plan and is keeping part of
// it. Taking the rest back is easy while it is still sitting there. The hard
// cases are the two where it is not:
//
//   · SPENT. Credit that has been used cannot be taken back, so the account
//     owes it — one `debt_incurred` row, reason `plan_change`. That is the only
//     thing a plan change ever charges for.
//   · HELD by a task that is still running. That credit is NOT spent and not
//     free either; it is the customer's, and the running task may still be
//     charged from it. Taking it out from under the task would break the task;
//     calling it debt would refuse the customer's next task over credit they
//     still have (finding M5). So the part of the shortfall that the account's
//     held credit covers becomes a PENDING CLAIM on the clawback record, paid
//     out of those credits when the tasks settle.
//
// ⚠️ THE PENDING CLAIM IS RECORDED HERE AND PAID IN S7. Nothing releases a hold
// yet, because reservations arrive with migration 0131. What these arms prove
// is that a clawback reads held credit, leaves it alone, and books the
// shortfall it covers as a claim instead of debt. The pay-down at settle is
// S7's to build and to prove.
//
// ⚠️ AND THE HOLDS BELOW ARE FORGED. `credit_lots.held_micro` moves only
// through `credit_reservation_holds`, which does not exist yet, so the two arms
// that need held credit write the column directly with the lot guard switched
// off for one statement (see `forgeHoldOnLot`). S7 owes the same property
// driven through a real reservation. The arithmetic itself is proved without a
// database in `a-clawback-asks-each-lot-for-what-it-still-has…`.
//
// ⛔ DEBT IS NEVER LEFT BESIDE CREDIT. The database refuses to COMMIT an account
// that owes credits while it holds spendable ones, so every clawback ends by
// paying its own debt down from whatever free credit the account has left —
// which is what lets a downgrade of a spent month commit at all when the
// customer also has bought credits.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { debtOf, fundedLot, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  ledgerOf,
  lotsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  clawbacksOf,
  forgeHoldOnLot,
  leaving,
  mirrorMovedTo,
  paidMonth,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_clawback';
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

/** An api_scale account whose month (30,000 credits) has been granted into one lot. */
async function scaleMonth(): Promise<{
  accountId: string;
  subscriptionId: string;
  windowId: string;
  lotId: string;
}> {
  const month = await paidMonth(db(), 'api_scale');
  const first = await h().grants.refreshCredits(month.accountId);
  if (first.window.outcome !== 'created') {
    throw new Error(`setup: the first refresh did not grant (${first.window.outcome})`);
  }
  const [lot] = await lotsOf(db(), month.accountId);
  if (lot === undefined) throw new Error('setup: the month was granted into no lot');
  return { ...month, windowId: first.window.windowId, lotId: lot.id };
}

/** Halve the plan, as of half the window ago: the claw is always 13,500 credits. */
async function downgradeToStarter(subscriptionId: string): Promise<void> {
  await mirrorMovedTo(db(), subscriptionId, 'api_starter', leaving(420));
}

describe.skipIf(!RUN_DB_TESTS)(
  'a downgrade takes back what is free and owes only what was spent',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a downgrade after the month was SPENT becomes debt, and only then: nothing is taken from the empty lot, the account owes the 13,500 it no longer has, and the row says why', async () => {
      const { accountId, subscriptionId, windowId, lotId } = await scaleMonth();
      await spendFromLot(db(), accountId, lotId, 30_000);
      expect(await h().ledger.spendableMicro(accountId)).toBe(0);

      await downgradeToStarter(subscriptionId);
      const result = await h().grants.refreshCredits(accountId);

      expect(result.level?.deltaMicro).toBe(-13_500 * MICRO);
      expect(result.level?.clawback).toMatchObject({
        source: 'plan_change',
        sourceRef: `${windowId}:1`,
        amountMicro: 13_500 * MICRO,
        clawedMicro: 0,
        pendingMicro: 0,
        debtMicro: 13_500 * MICRO,
      });
      expect(await debtOf(db(), accountId)).toBe(13_500 * MICRO);

      const ledger = await ledgerOf(db(), accountId);
      expect(ledger.filter((e) => e.kind === 'proration_clawback')).toEqual([]);
      const debts = ledger.filter((e) => e.kind === 'debt_incurred');
      expect(debts).toEqual([
        {
          kind: 'debt_incurred',
          lot_id: null,
          lot_delta_micro: '0',
          debt_delta_micro: String(13_500 * MICRO),
          idempotency_key: `clawback:plan_change:${windowId}:1:debt`,
        },
      ]);
      const [{ reason } = { reason: null }] = await db()<Array<{ reason: string }>>`
        SELECT reason FROM credit_ledger
         WHERE account_id = ${accountId}::uuid AND kind = 'debt_incurred'`;
      expect(reason).toBe('plan_change');
    });

    it('CRITICAL only what was already spent becomes debt: with 5,000 of the month left, the lot gives up all 5,000 and the account owes the other 8,500 — never the whole claw', async () => {
      const { accountId, subscriptionId, lotId } = await scaleMonth();
      await spendFromLot(db(), accountId, lotId, 25_000);

      await downgradeToStarter(subscriptionId);
      const result = await h().grants.refreshCredits(accountId);

      expect(result.level?.clawback).toMatchObject({
        amountMicro: 13_500 * MICRO,
        clawedMicro: 5_000 * MICRO,
        pendingMicro: 0,
        debtMicro: 8_500 * MICRO,
      });
      expect(await debtOf(db(), accountId)).toBe(8_500 * MICRO);
      expect((await lotsOf(db(), accountId))[0]?.remaining_micro).toBe('0');
      expect(await h().ledger.spendableMicro(accountId)).toBe(0);
    });

    it('CRITICAL a downgrade while a task HOLDS credit records a pending claim, not debt: the held credit is left exactly where it is, and the account is not refused its next task over credit it still has', async () => {
      const { accountId, subscriptionId, windowId, lotId } = await scaleMonth();
      await spendFromLot(db(), accountId, lotId, 20_000);
      // 10,000 left, every credit of it held by a task that is still running.
      await forgeHoldOnLot(db(), lotId, 10_000);

      await downgradeToStarter(subscriptionId);
      const result = await h().grants.refreshCredits(accountId);

      expect(result.level?.clawback).toMatchObject({
        sourceRef: `${windowId}:1`,
        amountMicro: 13_500 * MICRO,
        clawedMicro: 0,
        pendingMicro: 10_000 * MICRO,
        debtMicro: 3_500 * MICRO,
      });
      expect(await debtOf(db(), accountId), 'held credit was written off as debt').toBe(
        3_500 * MICRO,
      );

      const [{ remaining, held } = { remaining: '', held: '' }] = await db()<
        Array<{ remaining: string; held: string }>
      >`SELECT remaining_micro::text AS remaining, held_micro::text AS held
          FROM credit_lots WHERE id = ${lotId}::uuid`;
      expect(remaining, 'the clawback took credit a running task was holding').toBe(
        String(10_000 * MICRO),
      );
      expect(held).toBe(String(10_000 * MICRO));
      // Nothing is spendable: every credit left is held. That is what makes the
      // account's debt legal to commit beside it.
      expect(await h().ledger.spendableMicro(accountId)).toBe(0);
    });

    it('a claim never exceeds what is held: with the whole month held by running tasks the downgrade writes NO debt at all, only a claim for its full amount', async () => {
      const { accountId, subscriptionId, lotId } = await scaleMonth();
      await forgeHoldOnLot(db(), lotId, 30_000);

      await downgradeToStarter(subscriptionId);
      const result = await h().grants.refreshCredits(accountId);

      expect(result.level?.clawback).toMatchObject({
        amountMicro: 13_500 * MICRO,
        clawedMicro: 0,
        pendingMicro: 13_500 * MICRO,
        debtMicro: 0,
      });
      expect(await debtOf(db(), accountId)).toBe(0);
      expect((await ledgerOf(db(), accountId)).filter((e) => e.kind === 'debt_incurred')).toEqual(
        [],
      );
    });

    it('CRITICAL a downgrade never leaves debt beside credit the customer still has: the debt of a spent month is paid down at once from their bought credits, which is also what lets the transaction commit', async () => {
      const { accountId, subscriptionId, lotId } = await scaleMonth();
      await spendFromLot(db(), accountId, lotId, 30_000);
      const topUpId = await fundedLot(db(), accountId, { kind: 'top_up', credits: 20_000 });

      await downgradeToStarter(subscriptionId);
      const result = await h().grants.refreshCredits(accountId);

      // The clawback still RECORDS the debt it caused…
      expect(result.level?.clawback).toMatchObject({ debtMicro: 13_500 * MICRO });
      // …and the account does not end up owing it.
      expect(await debtOf(db(), accountId)).toBe(0);
      expect((await ledgerOf(db(), accountId)).filter((e) => e.kind === 'debt_repayment')).toEqual([
        {
          kind: 'debt_repayment',
          lot_id: topUpId,
          lot_delta_micro: String(-13_500 * MICRO),
          debt_delta_micro: String(-13_500 * MICRO),
          idempotency_key: `debt_repayment:${topUpId}:1`,
        },
      ]);
      expect(await h().ledger.spendableMicro(accountId)).toBe(6_500 * MICRO);
    });

    it('CRITICAL the same clawback applied twice takes credit ONCE, across two transactions: the second call finds the record already there, takes nothing and returns it unchanged', async () => {
      const { accountId, windowId, lotId } = await scaleMonth();
      const key = {
        source: 'plan_change',
        sourceRef: `${windowId}:99`,
        targetKey: `window:${windowId}`,
      } as const;
      const input = {
        ...key,
        windowId,
        amountMicro: 4_000 * MICRO,
        ledgerKind: 'proration_clawback',
        debtReason: 'plan_change',
      } as const;

      const first = await h().ledger.transaction(async (tx) => {
        await h().ledger.lockAccount(tx, accountId);
        return h().grants.clawBack(tx, accountId, input);
      });
      const after = {
        lots: await lotsOf(db(), accountId),
        ledger: await ledgerOf(db(), accountId),
      };

      const second = await h().ledger.transaction(async (tx) => {
        await h().ledger.lockAccount(tx, accountId);
        return h().grants.clawBack(tx, accountId, input);
      });
      // …and again inside one transaction, which is the shape a retry of a
      // single refresh would take.
      const third = await h().ledger.transaction(async (tx) => {
        await h().ledger.lockAccount(tx, accountId);
        await h().grants.clawBack(tx, accountId, input);
        return h().grants.clawBack(tx, accountId, input);
      });

      expect(first).toMatchObject({ clawedMicro: 4_000 * MICRO, debtMicro: 0 });
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(await lotsOf(db(), accountId)).toEqual(after.lots);
      expect(await ledgerOf(db(), accountId)).toEqual(after.ledger);
      expect(await clawbacksOf(db(), accountId)).toHaveLength(1);
      expect((await lotsOf(db(), accountId))[0]?.id).toBe(lotId);
      expect(await h().ledger.spendableMicro(accountId)).toBe(26_000 * MICRO);
    });

    it('a clawback asks the lots for no more than they were ever granted: an amount larger than the whole window is not debt, because credit that was never granted was never the customer’s to owe', async () => {
      const { accountId, windowId } = await scaleMonth();

      const record = await h().ledger.transaction(async (tx) => {
        await h().ledger.lockAccount(tx, accountId);
        return h().grants.clawBack(tx, accountId, {
          source: 'plan_change',
          sourceRef: `${windowId}:98`,
          targetKey: `window:${windowId}`,
          windowId,
          amountMicro: 500_000 * MICRO,
          ledgerKind: 'proration_clawback',
          debtReason: 'plan_change',
        });
      });

      expect(record).toMatchObject({
        amountMicro: 500_000 * MICRO,
        clawedMicro: 30_000 * MICRO,
        pendingMicro: 0,
        debtMicro: 0,
      });
      expect(await debtOf(db(), accountId)).toBe(0);
      expect(await h().ledger.spendableMicro(accountId)).toBe(0);
    });
  },
);
