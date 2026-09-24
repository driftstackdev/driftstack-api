// A won dispute, a refund that arrives late, a downgrade and a second invoice
// in the same month each leave the customer EXACTLY the credit the payment
// still pays for. The independent re-audit of the S17 rework (37de51b26)
// reproduced fourteen defects with throwaway arms; every arm below is one of
// those, rebuilt as a permanent regression. Each ran against the code the
// re-audit read and failed there with the re-audit's own numbers (the report
// beside this change lists them), and each passes on the rework of it.
//
// The rule every arm holds (see the header of credit-clawbacks.ts): for one
// invoice and one month, with s the part of the payment still paid (refunds
// and a standing dispute taken off), each lot the payment bought keeps
// `floor_whole(granted × s / still-paid-when-granted)`; the customer keeps
// that, what they hold or spent above it is taken (the rest of it as debt),
// and a won dispute gives back whatever the dispute took — clawed credit,
// claims it collected, and debt that later credit repaid — then settles the
// invoice at its CURRENT refunded share.
//
// Every arm runs the real repos and services against an isolated Postgres
// database rebuilt from the migrations.

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { CreditClawbacksService, floorToPriorMinute } from '../../src/services/credit-clawbacks.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  ledgerOf,
  lotsOf,
  paidLine,
  payingCustomer,
  subscription,
  type GrantsHarness,
  samePeriodAs,
} from './_helpers/credit-grant-fixtures.js';
import {
  holdOnLot,
  leaving,
  mirrorMovedTo,
  paidMonth,
  paidProrationUpLine,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';
import {
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s17_round2';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4900;
const ANNUAL = 58_800;
const A_YEAR_FROM_FIVE_DAYS_AGO =
  "((date_trunc('second', now()) - interval '5 days') AT TIME ZONE 'UTC' + interval '1 year') AT TIME ZONE 'UTC'";

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let reservations: ReservationsHarness | null = null;
let service: CreditClawbacksService | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url, { max: 3 });
  reservations = reservationsHarness(opened.url, { max: 2 });
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  } as unknown as Logger;
  service = new CreditClawbacksService({
    ledger: harness.ledger,
    windows: harness.windows,
    grants: harness.grants,
    logger,
    sentry: { captureMessage: () => {} },
  });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
  await reservations?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}
function rh(): ReservationsHarness {
  if (reservations === null) throw new Error('isolated database unreachable');
  return reservations;
}
function svc(): CreditClawbacksService {
  if (service === null) throw new Error('isolated database unreachable');
  return service;
}

const credits = (micro: number): number => micro / MICRO;

async function charge(invoiceId: string, chargeId: string): Promise<void> {
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${invoiceId}`;
}

/** A paying api_starter customer with this month granted, the invoice carrying its charge. */
async function granted(chargeId: string, amountPaid = PAID) {
  const customer = await payingCustomer(db(), 'api_starter', { amountPaid });
  await charge(customer.invoiceId, chargeId);
  const first = await h().grants.refreshCredits(customer.accountId);
  if (first.window.outcome !== 'created') {
    throw new Error(`setup: the month was not granted (${first.window.outcome})`);
  }
  const monthly = (await lotsOf(db(), customer.accountId)).find((l) => l.kind === 'monthly');
  if (monthly === undefined) throw new Error('setup: no monthly lot');
  return { ...customer, windowId: first.window.windowId, lotId: monthly.id };
}

/** An annual api_starter customer whose year began five days ago; nothing granted yet. */
async function annual(chargeId: string) {
  const customer = await payingCustomer(db(), 'api_starter', {
    amountPaid: ANNUAL,
    interval: 'year',
    end: A_YEAR_FROM_FIVE_DAYS_AGO,
  });
  await charge(customer.invoiceId, chargeId);
  return customer;
}

async function currentWindowOf(accountId: string): Promise<string> {
  const [row] = await db()<Array<{ id: string }>>`
    SELECT id FROM credit_windows
     WHERE account_id = ${accountId}::uuid AND window_start <= now() AND now() < window_end`;
  if (row === undefined) throw new Error('no current window');
  return row.id;
}

async function levelOf(windowId: string): Promise<number> {
  const [row] = await db()<Array<{ level: string }>>`
    SELECT level_micro::text AS level FROM credit_windows WHERE id = ${windowId}::uuid`;
  return Number(row?.level ?? '-1') / MICRO;
}

async function disputedOf(invoiceId: string): Promise<number> {
  const [row] = await db()<Array<{ d: string }>>`
    SELECT disputed_minor::text AS d FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}`;
  return Number(row?.d ?? '-1');
}

async function remainingOfLot(lotId: string): Promise<number> {
  const [row] = await db()<Array<{ r: string }>>`
    SELECT remaining_micro::text AS r FROM credit_lots WHERE id = ${lotId}::uuid`;
  return Number(row?.r ?? '-1') / MICRO;
}

async function spendable(accountId: string): Promise<number> {
  return credits(await h().ledger.spendableMicro(accountId));
}

async function debt(accountId: string): Promise<number> {
  return credits(await debtOf(db(), accountId));
}

/** A bought top-up of `amount` credits, funded and set against any debt in one transaction. */
async function buyTopUp(accountId: string, amount: number): Promise<string> {
  return h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId,
        kind: 'top_up',
        grantKey: `topup:${accountId}:${String(amount)}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
      tx,
    );
    // A top-up's funding row is written by the purchase that owns it, not by
    // the ledger repo's `append`; this is that row, as the purchase writes it.
    await tx.execute(sql`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
      VALUES (${accountId}::uuid, 'top_up', ${inserted.lot.id}::uuid,
              ${String(amount * MICRO)}::bigint, ${`top_up:${inserted.lot.id}`}, 'customer')`);
    await h().ledger.settleDebtFromFree(tx, accountId);
    return inserted.lot.id;
  });
}

/** Everything a refresh could write, counted: the refresh after a reversal writes none of it. */
async function aRefreshChangesNothing(accountId: string): Promise<void> {
  const before = await footprint(accountId);
  const result = await h().grants.refreshCredits(accountId);
  expect(result.level, 'the refresh after a reversal moved the level').toBeNull();
  expect(await footprint(accountId), 'the refresh wrote something').toEqual(before);
}

async function footprint(accountId: string) {
  const [row] = await db()<
    Array<{ lots: number; ledger: number; clawbacks: number; steps: number; windows: number }>
  >`
    SELECT (SELECT count(*)::int FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
           (SELECT count(*)::int FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger,
           (SELECT count(*)::int FROM credit_clawbacks WHERE account_id = ${accountId}::uuid) AS clawbacks,
           (SELECT count(*)::int FROM credit_window_level_changes s
              JOIN credit_windows w ON w.id = s.window_id
             WHERE w.account_id = ${accountId}::uuid) AS steps,
           (SELECT count(*)::int FROM credit_windows WHERE account_id = ${accountId}::uuid) AS windows`;
  return row;
}

function dispute(id: string, chargeId: string, amountMinor = PAID) {
  return { disputeId: id, chargeId, stripeInvoiceId: null, amountMinor };
}
function refund(chargeId: string, cumulativeRefundedMinor: number) {
  return { chargeId, stripeInvoiceId: null, cumulativeRefundedMinor };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a won dispute, a late refund and a downgrade leave exactly what the payment still pays for',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a won dispute that took a fractional amount of credit is reinstated, not refused by the whole-credit rule (re-audit #1)', async () => {
      const c = await granted('ch_r2_1a');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000.5);
      const disputed = await svc().applyStripeDispute(dispute('dp_r2_1a', 'ch_r2_1a'));
      expect(disputed.kind).toBe('applied');
      await expect(svc().reinstateDispute(dispute('dp_r2_1a', 'ch_r2_1a'))).resolves.toMatchObject({
        kind: 'reinstated',
      });
      expect(await disputedOf(c.invoiceId)).toBe(0);
      expect(await levelOf(c.windowId)).toBe(3_000);
      // The whole month less what was spent: nothing gained, nothing lost.
      expect(await spendable(c.accountId)).toBe(1_999.5);
      expect(await debt(c.accountId)).toBe(0);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL a won PARTIAL dispute is reinstated in full (re-audit #1, second shape)', async () => {
      const c = await granted('ch_r2_1b');
      await svc().applyStripeDispute(dispute('dp_r2_1b', 'ch_r2_1b', 1_000));
      await expect(
        svc().reinstateDispute(dispute('dp_r2_1b', 'ch_r2_1b', 1_000)),
      ).resolves.toMatchObject({ kind: 'reinstated' });
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await levelOf(c.windowId)).toBe(3_000);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL a won dispute gives back the part of its debt that later credit already repaid (re-audit #2)', async () => {
      const c = await granted('ch_r2_2');
      await spendFromLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute(dispute('dp_r2_2', 'ch_r2_2'));
      expect(await debt(c.accountId)).toBe(3_000);
      // Later credit — a bought top-up standing in for next month's grant — repays it.
      await buyTopUp(c.accountId, 3_000);
      expect(await debt(c.accountId)).toBe(0);
      expect(await spendable(c.accountId)).toBe(0);

      await svc().reinstateDispute(dispute('dp_r2_2', 'ch_r2_2'));
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await debt(c.accountId)).toBe(0);
      expect(await levelOf(c.windowId)).toBe(3_000);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL a win after a refund delivered DURING the dispute leaves what the refund left, the same as the refund landing first (re-audit #3)', async () => {
      // Late: the full dispute lands first, the half refund after it.
      const late = await granted('ch_r2_3a');
      await svc().applyStripeDispute(dispute('dp_r2_3a', 'ch_r2_3a'));
      await svc().applyStripeRefund(refund('ch_r2_3a', PAID / 2));
      await svc().reinstateDispute(dispute('dp_r2_3a', 'ch_r2_3a'));
      // In order: the refund first.
      const inOrder = await granted('ch_r2_3b');
      await svc().applyStripeRefund(refund('ch_r2_3b', PAID / 2));
      await svc().applyStripeDispute(dispute('dp_r2_3b', 'ch_r2_3b'));
      await svc().reinstateDispute(dispute('dp_r2_3b', 'ch_r2_3b'));

      for (const c of [late, inOrder]) {
        expect(await spendable(c.accountId)).toBe(1_500);
        expect(await levelOf(c.windowId)).toBe(1_500);
        expect(await debt(c.accountId)).toBe(0);
        await aRefreshChangesNothing(c.accountId);
      }
    });

    it('CRITICAL the same with the month spent: the win leaves the refunded half owed (re-audit #3, R1b)', async () => {
      const c = await granted('ch_r2_3c');
      await spendFromLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute(dispute('dp_r2_3c', 'ch_r2_3c'));
      await svc().applyStripeRefund(refund('ch_r2_3c', PAID / 2));
      await svc().reinstateDispute(dispute('dp_r2_3c', 'ch_r2_3c'));
      expect(await debt(c.accountId)).toBe(1_500);
      expect(await spendable(c.accountId)).toBe(0);
      expect(await levelOf(c.windowId)).toBe(1_500);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL both orders end in the same state when the amounts are fractional (re-audit #3 with #1)', async () => {
      const late = await granted('ch_r2_3d');
      await spendFromLot(db(), late.accountId, late.lotId, 1_000.5);
      await svc().applyStripeDispute(dispute('dp_r2_3d', 'ch_r2_3d'));
      await svc().applyStripeRefund(refund('ch_r2_3d', PAID / 2));
      await svc().reinstateDispute(dispute('dp_r2_3d', 'ch_r2_3d'));
      const inOrder = await granted('ch_r2_3e');
      await spendFromLot(db(), inOrder.accountId, inOrder.lotId, 1_000.5);
      await svc().applyStripeRefund(refund('ch_r2_3e', PAID / 2));
      await svc().applyStripeDispute(dispute('dp_r2_3e', 'ch_r2_3e'));
      await svc().reinstateDispute(dispute('dp_r2_3e', 'ch_r2_3e'));
      for (const c of [late, inOrder]) {
        expect(await spendable(c.accountId)).toBe(499.5);
        expect(await debt(c.accountId)).toBe(0);
        expect(await levelOf(c.windowId)).toBe(1_500);
      }
    });

    it('CRITICAL a refund after a downgrade does not charge again for the spend the downgrade already made debt (re-audit #4)', async () => {
      const m = await paidMonth(db(), 'api_builder');
      await charge(m.invoiceId, 'ch_r2_4');
      await h().grants.refreshCredits(m.accountId);
      const lot = (await lotsOf(db(), m.accountId)).find((l) => l.kind === 'monthly');
      if (lot === undefined) throw new Error('setup: no monthly lot');
      await spendFromLot(db(), m.accountId, lot.id, 10_000);
      await mirrorMovedTo(db(), m.subscriptionId, 'api_starter', leaving(420));
      await h().grants.refreshCredits(m.accountId);
      expect(await debt(m.accountId)).toBe(3_500);

      await svc().applyStripeRefund(refund('ch_r2_4', PAID));
      // Everything spent is owed, once.
      expect(await debt(m.accountId)).toBe(10_000);
      await aRefreshChangesNothing(m.accountId);
    });

    it('CRITICAL a second refund of an annual invoice measures a month granted after the first against what was still paid then (re-audit #5)', async () => {
      const a = await annual('ch_r2_5');
      await svc().applyStripeRefund(refund('ch_r2_5', ANNUAL / 2));
      await h().grants.refreshCredits(a.accountId);
      const lot = (await lotsOf(db(), a.accountId)).find((l) => l.kind === 'monthly');
      if (lot === undefined) throw new Error('setup: no monthly lot');
      expect(credits(Number(lot.granted_micro))).toBe(1_500);

      await svc().applyStripeRefund(refund('ch_r2_5', (ANNUAL * 3) / 4));
      expect(await remainingOfLot(lot.id)).toBe(750);
      expect(await levelOf(await currentWindowOf(a.accountId))).toBe(750);
      await aRefreshChangesNothing(a.accountId);
    });

    it('a month’s lot records what its invoice still paid when it was granted, and the database refuses to change it afterwards (0137)', async () => {
      const whole = await granted('ch_r2_5b');
      const [row] = await db()<Array<{ still: string | null }>>`
        SELECT still_paid_minor::text AS still FROM credit_lots WHERE id = ${whole.lotId}::uuid`;
      expect(row?.still).toBe(String(PAID));

      const a = await annual('ch_r2_5c');
      await svc().applyStripeRefund(refund('ch_r2_5c', ANNUAL / 2));
      await h().grants.refreshCredits(a.accountId);
      const [halved] = await db()<Array<{ id: string; still: string | null }>>`
        SELECT id, still_paid_minor::text AS still FROM credit_lots
         WHERE account_id = ${a.accountId}::uuid AND kind = 'monthly'`;
      expect(halved?.still).toBe(String(ANNUAL / 2));

      const refused =
        await db()`UPDATE credit_lots SET still_paid_minor = 1 WHERE id = ${whole.lotId}::uuid`.then(
          () => 'updated',
          (err: { code?: string }) => err.code ?? 'error',
        );
      expect(refused).toBe('55000');
    });

    it('CRITICAL a win raises a month drawn while the dispute stood AND grants the credit for it (re-audit #6)', async () => {
      const a = await annual('ch_r2_6');
      await svc().applyStripeDispute(dispute('dp_r2_6', 'ch_r2_6', ANNUAL / 2));
      await h().grants.refreshCredits(a.accountId);
      const windowId = await currentWindowOf(a.accountId);
      expect(await levelOf(windowId)).toBe(1_500);
      expect(await spendable(a.accountId)).toBe(1_500);

      await svc().reinstateDispute(dispute('dp_r2_6', 'ch_r2_6', ANNUAL / 2));
      expect(await levelOf(windowId)).toBe(3_000);
      expect(await spendable(a.accountId)).toBe(3_000);
      await aRefreshChangesNothing(a.accountId);

      // The top-up is part of the month, not more of what the payment bought:
      // a half refund afterwards leaves half the month, not more.
      await svc().applyStripeRefund(refund('ch_r2_6', ANNUAL / 2));
      expect(await spendable(a.accountId)).toBe(1_500);
      expect(await levelOf(windowId)).toBe(1_500);
      await aRefreshChangesNothing(a.accountId);
    });

    it('CRITICAL a resubscription made BEFORE the old invoice is refunded covers the month once the old invoice no longer does (re-audit #7)', async () => {
      const c = await granted('ch_r2_7a');
      const nextSub = await subscription(db(), c.accountId, { tier: 'api_starter' });
      await paidLine(db(), c.accountId, {
        subscriptionId: nextSub,
        tier: 'api_starter',
        amountPaid: PAID,
        // The SAME month as the old invoice, to the second (see samePeriodAs).
        ...(await samePeriodAs(db(), c.invoiceId)),
      });
      await h().grants.refreshCredits(c.accountId);
      expect(await spendable(c.accountId)).toBe(3_000);

      await svc().applyStripeRefund(refund('ch_r2_7a', PAID));
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await levelOf(c.windowId)).toBe(3_000);
      expect(await remainingOfLot(c.lotId), 'the refunded invoice kept its lot').toBe(0);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL the builder’s order — half refund, resubscribe, three-quarter refund — also ends at the new subscription’s month, not 2,250 (re-audit #7, the known limitation)', async () => {
      const c = await granted('ch_r2_7b');
      await svc().applyStripeRefund(refund('ch_r2_7b', PAID / 2));
      const nextSub = await subscription(db(), c.accountId, { tier: 'api_starter' });
      await paidLine(db(), c.accountId, {
        subscriptionId: nextSub,
        tier: 'api_starter',
        amountPaid: PAID,
        // The SAME month as the old invoice, to the second (see samePeriodAs).
        ...(await samePeriodAs(db(), c.invoiceId)),
      });
      await h().grants.refreshCredits(c.accountId);
      expect(await spendable(c.accountId)).toBe(3_000);

      await svc().applyStripeRefund(refund('ch_r2_7b', (PAID * 3) / 4));
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await remainingOfLot(c.lotId)).toBe(750);
      expect(await levelOf(c.windowId)).toBe(3_000);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL a half refund of an ANNUAL upgrade invoice whose month is spent writes no debt: the payment still covers far more of the step up than was used (re-audit #8, interim cap)', async () => {
      const a = await annual('ch_r2_8_base');
      await h().grants.refreshCredits(a.accountId);
      const upFrom = "date_trunc('second', now()) - interval '1 hour'";
      await mirrorMovedTo(db(), a.subscriptionId, 'api_builder', upFrom);
      const upgrade = await paidLine(db(), a.accountId, {
        subscriptionId: a.subscriptionId,
        tier: 'api_builder',
        lineKind: 'proration_up',
        interval: 'year',
        start: upFrom,
        end: A_YEAR_FROM_FIVE_DAYS_AGO,
        amountPaid: 41_000,
      });
      await charge(upgrade, 'ch_r2_8_up');
      await h().grants.refreshCredits(a.accountId);
      const upLot = (await lotsOf(db(), a.accountId)).find((l) => l.kind === 'proration');
      if (upLot === undefined) throw new Error('setup: no upgrade lot');
      await spendFromLot(db(), a.accountId, upLot.id, credits(Number(upLot.granted_micro)));

      await svc().applyStripeRefund(refund('ch_r2_8_up', 41_000 / 2));
      expect(await debt(a.accountId)).toBe(0);
      // The base month is untouched.
      expect(await spendable(a.accountId)).toBe(3_000);
      // The level is the base plus half the step up.
      expect(await levelOf(await currentWindowOf(a.accountId))).toBe(6_500);
      await aRefreshChangesNothing(a.accountId);
    });

    it('CRITICAL a task holding a bought top-up pays no claim of the invoice; its release repays the dispute’s debt, which the win gives back into the top-up, where no refund of the invoice can take it (re-audit #10, policy v2 rule 4)', async () => {
      const c = await granted('ch_r2_10');
      await spendFromLot(db(), c.accountId, c.lotId, 3_000);
      const topUp = await buyTopUp(c.accountId, 500);
      const task = await holdOnLot(db(), c.accountId, topUp, 500);
      await svc().applyStripeDispute(dispute('dp_r2_10', 'ch_r2_10'));
      // Rule 4: a reversal's claim is paid only from what tasks release into
      // the payment's OWN lots. The task ends having spent nothing: its 500
      // pays no claim, goes back into the top-up, and repays 500 of the
      // dispute's 3,000 of debt (the month was spent whole).
      const settled = await rh().service.settle(task, 'completed');
      expect(settled.claimsPaidMicro).toBe(0);
      expect(await debt(c.accountId)).toBe(2_500);
      expect(await spendable(c.accountId)).toBe(0);
      // Rule 6: the debt still owed (2,500) is forgiven, and the 500 the top-up
      // paid goes back into the top-up.
      await svc().reinstateDispute(dispute('dp_r2_10', 'ch_r2_10'));
      expect(await debt(c.accountId)).toBe(0);
      expect(await spendable(c.accountId)).toBe(500);
      expect(await remainingOfLot(topUp)).toBe(500);

      await svc().applyStripeRefund(refund('ch_r2_10', PAID));
      // 3,000 spent on a refunded month is owed; the top-up's 500 is the
      // customer's own and pays part of it. (Debt and free credit never stand
      // together, so the 500 appears as 500 less debt.)
      expect(await debt(c.accountId)).toBe(2_500);
      expect(await spendable(c.accountId)).toBe(0);
    });

    it('CRITICAL a downgrade after a won dispute takes from the credit the win gave back, so a later refund owes nothing when nothing was spent (re-audit #11)', async () => {
      const m = await paidMonth(db(), 'api_starter');
      await charge(m.invoiceId, 'ch_r2_11');
      await h().grants.refreshCredits(m.accountId);
      await svc().applyStripeDispute(dispute('dp_r2_11', 'ch_r2_11'));
      await svc().reinstateDispute(dispute('dp_r2_11', 'ch_r2_11'));
      expect(await spendable(m.accountId)).toBe(3_000);
      await mirrorMovedTo(db(), m.subscriptionId, 'solo_manual', leaving(420));
      await h().grants.refreshCredits(m.accountId);
      expect(await spendable(m.accountId)).toBe(2_250);

      await svc().applyStripeRefund(refund('ch_r2_11', PAID));
      expect(await debt(m.accountId)).toBe(0);
      const rows = await ledgerOf(db(), m.accountId);
      expect(
        rows.filter((r) => r.kind === 'debt_incurred'),
        'nothing was ever spent',
      ).toEqual([]);
    });

    it('CRITICAL another invoice’s refund claims nothing of this invoice’s lot: the task’s release repays that refund’s debt instead, which counts as spending of this invoice (re-audit #12, policy v2 rule 4)', async () => {
      async function upgradedMonth(chargeBase: string, chargeUp: string) {
        const m = await paidMonth(db(), 'api_starter');
        await charge(m.invoiceId, chargeBase);
        await h().grants.refreshCredits(m.accountId);
        await mirrorMovedTo(db(), m.subscriptionId, 'api_builder', leaving(420));
        const up = await paidProrationUpLine(db(), m.accountId, {
          subscriptionId: m.subscriptionId,
          tier: 'api_builder',
          from: leaving(420),
        });
        await charge(up, chargeUp);
        await h().grants.refreshCredits(m.accountId);
        const lots = await lotsOf(db(), m.accountId);
        const monthly = lots.find((l) => l.kind === 'monthly');
        const proration = lots.find((l) => l.kind === 'proration');
        if (monthly === undefined || proration === undefined) throw new Error('setup');
        await spendFromLot(db(), m.accountId, proration.id, 3_500);
        return { ...m, monthlyId: monthly.id };
      }
      // Control: no task running.
      const control = await upgradedMonth('ch_r2_12c_base', 'ch_r2_12c_up');
      await svc().applyStripeRefund(refund('ch_r2_12c_up', PAID));
      await svc().applyStripeRefund(refund('ch_r2_12c_base', PAID));
      expect(await debt(control.accountId)).toBe(3_500);

      // A task holds 1,000 of the BASE invoice's lot when the upgrade is refunded.
      // The upgrade's 3,500 spent is owed; the base month's 2,000 free repays
      // 2,000 of it. Rule 4: the upgrade's refund may claim nothing of the base
      // invoice's lot, so when the task releases its 1,000 it pays no claim —
      // it is free credit again, and repays the next 1,000 of the debt.
      const m = await upgradedMonth('ch_r2_12_base', 'ch_r2_12_up');
      const task = await holdOnLot(db(), m.accountId, m.monthlyId, 1_000);
      await svc().applyStripeRefund(refund('ch_r2_12_up', PAID));
      const settled = await rh().service.settle(task, 'completed');
      expect(settled.claimsPaidMicro).toBe(0);
      expect(await debt(m.accountId)).toBe(500);
      expect(await remainingOfLot(m.monthlyId)).toBe(0);
      const claimRows = (await ledgerOf(db(), m.accountId)).filter((r) =>
        r.idempotency_key.startsWith('claim:'),
      );
      expect(claimRows, 'no claim was collected from the base invoice’s lot').toEqual([]);
      // The base month repaid 3,000 of the upgrade's debt: refunded whole, it
      // owes that 3,000 back, the same total as the control.
      await svc().applyStripeRefund(refund('ch_r2_12_base', PAID));
      expect(await debt(m.accountId)).toBe(3_500);
    });

    it('CRITICAL a dispute that took nothing is still remembered once won: its `created` delivered again changes nothing (re-audit #13)', async () => {
      const customer = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
      await charge(customer.invoiceId, 'ch_r2_13');
      const first = await svc().applyStripeDispute(dispute('dp_r2_13', 'ch_r2_13'));
      expect(first.kind).toBe('no_windows');
      await svc().reinstateDispute(dispute('dp_r2_13', 'ch_r2_13'));
      expect(await disputedOf(customer.invoiceId)).toBe(0);
      // R4 (S17 round 3) — the win draws the month it makes the invoice cover
      // again INSIDE the win, so the month is there at once. This arm said the
      // next refresh `created` it; that refresh now finds it drawn and writes
      // nothing.
      expect(await spendable(customer.accountId)).toBe(3_000);

      const again = await svc().applyStripeDispute(dispute('dp_r2_13', 'ch_r2_13'));
      expect(again.kind).toBe('already_applied');
      expect(await disputedOf(customer.invoiceId)).toBe(0);
      const refreshed = await h().grants.refreshCredits(customer.accountId);
      expect(refreshed.window.outcome).toBe('none');
      await aRefreshChangesNothing(customer.accountId);
      expect(await spendable(customer.accountId)).toBe(3_000);
    });

    it('CRITICAL a win delivered BEFORE the dispute’s own `created` is remembered too: the late `created` takes nothing (re-audit #13)', async () => {
      const c = await granted('ch_r2_13b');
      await svc().reinstateDispute(dispute('dp_r2_13b', 'ch_r2_13b'));
      const late = await svc().applyStripeDispute(dispute('dp_r2_13b', 'ch_r2_13b'));
      expect(late.kind).toBe('already_applied');
      expect(await disputedOf(c.invoiceId)).toBe(0);
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await levelOf(c.windowId)).toBe(3_000);
    });

    it('a normal dispute’s `funds_withdrawn` after its `created` changes nothing: it is the same dispute, applied once (re-audit #9)', async () => {
      const c = await granted('ch_r2_9');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await svc().applyStripeDispute(dispute('dp_r2_9', 'ch_r2_9'));
      const before = await footprint(c.accountId);
      const withdrawn = await svc().applyStripeDispute(dispute('dp_r2_9', 'ch_r2_9'));
      expect(withdrawn.kind).toBe('already_applied');
      expect(await footprint(c.accountId)).toEqual(before);
      expect(await debt(c.accountId)).toBe(1_000);
    });
  },
);
