// An account whose billing event never came is granted by the coverage sweep.
//
// Monthly credits are granted when something notices a payment: the paid
// invoice's event, the subscription's, the boundary job at the end of a window.
// Events get lost — an endpoint is down for an hour, a deploy drops a job, the
// event arrives before the row it depends on. So every 15 minutes a sweep asks
// the database one question — which accounts does paid coverage earn a window
// for RIGHT NOW that do not have one? — and refreshes each. It is the same
// question a refresh asks of one account, asked of all of them, so the sweep can
// never grant what a refresh would not, and an account it has granted drops out
// of the answer by itself.
//
// The walk goes in account-id order from a cursor the job carries from tick to
// tick. That is what keeps one account that fails every time from holding the
// head of the queue: the walk moves past it, reaches the end, and starts over.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditGrantsService } from '../../src/services/credit-grants.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  cryptoEntitlement,
  grantCounts,
  grantsHarness,
  insertWindow,
  newAccountOn,
  paidLine,
  payingCustomer,
  planOverride,
  subscription,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_coverage_sweep';
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

const owed = (): Promise<string[]> =>
  h().windows.accountsOwedAWindow({ afterAccountId: null, limit: 1_000 });

describe.skipIf(!RUN_DB_TESTS)(
  'an account whose billing event never came is granted by the coverage sweep',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL the sweep’s list is exactly the accounts a refresh would grant to: one paid by Stripe, one by crypto, one with a plan an admin set — and NOT one already granted, one with no coverage, one whose renewal is unpaid, one whose subscription is past due', async () => {
      expect(await owed(), 'a fresh database owes nobody').toEqual([]);

      const stripe = (await payingCustomer(db(), 'api_builder')).accountId;
      const crypto = await newAccountOn(db(), 'team_manual');
      await cryptoEntitlement(db(), crypto, { tier: 'team_manual' });
      const override = await newAccountOn(db(), 'enterprise');
      await planOverride(db(), override, { monthlyCredits: 50_000 });

      const alreadyGranted = (await payingCustomer(db(), 'api_starter')).accountId;
      await h().grants.refreshCredits(alreadyGranted);
      await newAccountOn(db(), 'api_scale'); // a tier, and nothing paid
      const unpaidRenewal = await newAccountOn(db(), 'api_scale');
      const renewalSub = await subscription(db(), unpaidRenewal, { tier: 'api_scale' });
      await paidLine(db(), unpaidRenewal, {
        subscriptionId: renewalSub,
        tier: 'api_scale',
        start: "date_trunc('second', now()) - interval '31 days'",
        end: "date_trunc('second', now()) - interval '1 hour'",
      });
      const pastDue = await newAccountOn(db(), 'api_scale');
      const pastDueSub = await subscription(db(), pastDue, {
        tier: 'api_scale',
        status: 'past_due',
      });
      await paidLine(db(), pastDue, { subscriptionId: pastDueSub, tier: 'api_scale' });

      expect(await owed()).toEqual([stripe, crypto, override].sort());

      const swept = await h().grants.sweepCoverage({ afterAccountId: null, limit: 100 });
      expect(swept).toEqual({
        visited: 3,
        granted: 3,
        expired: 0,
        failed: 0,
        nextAfterAccountId: null,
      });
      expect(await h().ledger.spendableMicro(stripe)).toBe(10_000 * MICRO);
      expect(await h().ledger.spendableMicro(crypto)).toBe(5_000 * MICRO);
      expect(await h().ledger.spendableMicro(override)).toBe(50_000 * MICRO);
      expect(await grantCounts(db(), unpaidRenewal)).toEqual({ windows: 0, lots: 0, ledger: 0 });
      expect(await grantCounts(db(), pastDue)).toEqual({ windows: 0, lots: 0, ledger: 0 });

      // Granted accounts drop out of the list by themselves: the next sweep visits nobody.
      expect(await owed()).toEqual([]);
      expect((await h().grants.sweepCoverage({ afterAccountId: null, limit: 100 })).visited).toBe(
        0,
      );
    });

    it('CRITICAL a renewal whose event was lost is healed: last month’s window has ended, this month’s invoice is paid, nothing ever refreshed the account — the sweep grants this month', async () => {
      const accountId = await newAccountOn(db(), 'api_starter');
      const subscriptionId = await subscription(db(), accountId, { tier: 'api_starter' });
      await insertWindow(db(), accountId, {
        sourceRef: 'in_last_month',
        start: "date_trunc('second', now()) - interval '32 days'",
        end: "date_trunc('second', now()) - interval '2 days'",
      });
      await paidLine(db(), accountId, {
        subscriptionId,
        tier: 'api_starter',
        start: "date_trunc('second', now()) - interval '2 days'",
        end: "date_trunc('second', now()) + interval '28 days'",
      });
      expect(await owed()).toEqual([accountId]);

      const swept = await h().grants.sweepCoverage({ afterAccountId: null, limit: 100 });
      expect(swept).toMatchObject({ visited: 1, granted: 1, failed: 0 });
      expect(await h().ledger.spendableMicro(accountId)).toBe(3_000 * MICRO);
    });

    it('CRITICAL one account that fails every time does not stop the sweep or hold the head of the queue: the others are granted, the failure is counted, and the walk pages past it and then starts over', async () => {
      const accounts: string[] = [];
      for (let i = 0; i < 5; i += 1)
        accounts.push((await payingCustomer(db(), 'solo_manual')).accountId);
      const inOrder = [...accounts].sort();
      // The FIRST in walk order is the one that always fails: the worst place for it.
      const broken = inOrder[0];
      const real = h().windows;
      const failing = Object.create(real) as typeof real;
      failing.coverageCandidates = (tx, accountId) =>
        accountId === broken
          ? Promise.reject(new Error('this account cannot be refreshed'))
          : real.coverageCandidates(tx, accountId);
      const grants = new CreditGrantsService({ ledger: h().ledger, windows: failing });

      const first = await grants.sweepCoverage({ afterAccountId: null, limit: 2 });
      expect(first).toEqual({
        visited: 2,
        granted: 1,
        expired: 0,
        failed: 1,
        nextAfterAccountId: inOrder[1],
      });
      const second = await grants.sweepCoverage({
        afterAccountId: first.nextAfterAccountId,
        limit: 2,
      });
      expect(second).toMatchObject({
        visited: 2,
        granted: 2,
        failed: 0,
        nextAfterAccountId: inOrder[3],
      });
      const third = await grants.sweepCoverage({
        afterAccountId: second.nextAfterAccountId,
        limit: 2,
      });
      // A short batch: the end was reached, so the next walk starts over.
      expect(third).toMatchObject({ visited: 1, granted: 1, failed: 0, nextAfterAccountId: null });

      expect(await owed(), 'only the account that cannot be refreshed is still owed').toEqual([
        broken,
      ]);
      for (const accountId of inOrder.slice(1)) {
        expect(await h().ledger.spendableMicro(accountId), accountId).toBe(1_500 * MICRO);
      }
    });
  },
);
