// A refund or a chargeback leaves the customer EXACTLY the credit they still
// paid for — no more, and never debt for credit they did not spend — and a won
// dispute puts back everything the dispute took. The independent audit of S17
// reproduced each defect below with a throwaway arm; every arm here is one of
// those, kept as a permanent regression, and each one failed on the code the
// audit read. The arms that did not are marked as guards in their names: they
// hold behaviour the audit found sound, so the new rule is held to it too.
//
// The rule every reversal now follows is STATE-BASED and CUMULATIVE, per
// window the invoice earned (see the header of credit-clawbacks.ts): with F the
// share of the payment refunded or disputed so far, the customer keeps
// `floor((1 − F) × what the invoice's own lots were granted)`, and a reversal
// takes back whatever they hold or spent above that, less what earlier
// reversals of the same invoice already charged beyond the lots. So a second
// refund after the first refund's credit expired finds nothing to take, two
// refunds that make the whole payment owe exactly what was spent, and a dispute
// after a refund is measured against what was still paid.
//
// Every arm runs the real repos and services against an isolated Postgres
// database rebuilt from the migrations.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { CreditClawbacksService } from '../../src/services/credit-clawbacks.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  insertWindow,
  lotsOf,
  paidLine,
  payingCustomer,
  subscription,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  clawbacksOf,
  holdOnLot,
  leaving,
  levelChangesOf,
  mirrorMovedTo,
  paidMonth,
  paidProrationUpLine,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';
import {
  reservationsHarness,
  settledCall,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s17_fixes';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4900;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let reservations: ReservationsHarness | null = null;
let service: CreditClawbacksService | null = null;
const alerts: SentryMessage[] = [];

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
    sentry: {
      captureMessage: (msg) => {
        alerts.push(msg);
      },
    },
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

/** A paying api_starter customer with this month granted, the invoice carrying its charge. */
async function granted(chargeId: string, amountPaid = PAID) {
  const customer = await payingCustomer(db(), 'api_starter', { amountPaid });
  await db()`
    UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId}
     WHERE stripe_invoice_id = ${customer.invoiceId}`;
  const first = await h().grants.refreshCredits(customer.accountId);
  if (first.window.outcome !== 'created') {
    throw new Error(`setup: the month was not granted (${first.window.outcome})`);
  }
  const monthly = (await lotsOf(db(), customer.accountId)).find((l) => l.kind === 'monthly');
  if (monthly === undefined) throw new Error('setup: no monthly lot');
  return { ...customer, windowId: first.window.windowId, lotId: monthly.id };
}

/** A month this invoice bought that is already over: its window ended ten days ago. */
async function pastMonth(chargeId: string) {
  const accountId = (await payingCustomer(db(), 'api_starter', { amountPaid: PAID })).accountId;
  const sub = await subscription(db(), accountId, { tier: 'api_starter' });
  const invoiceId = await paidLine(db(), accountId, {
    subscriptionId: sub,
    tier: 'api_starter',
    start: "now() - interval '40 days'",
    end: "now() - interval '10 days'",
    amountPaid: PAID,
  });
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${invoiceId}`;
  const windowId = await insertWindow(db(), accountId, {
    sourceRef: invoiceId,
    start: "now() - interval '40 days'",
    end: "now() - interval '10 days'",
    credits: 3_000,
  });
  const lotId = await h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const lot = await h().windows.ensureMonthlyLot(tx, accountId, windowId);
    if (lot === null) throw new Error('setup: no lot for the past window');
    await h().ledger.append(
      {
        accountId,
        kind: 'grant',
        lotId: lot.lotId,
        amountMicro: lot.grantedMicro,
        idempotencyKey: `grant:${lot.lotId}`,
      },
      tx,
    );
    return lot.lotId;
  });
  return { accountId, invoiceId, windowId, lotId };
}

async function expireNow(accountId: string): Promise<void> {
  await h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    await h().ledger.expireDueLots(tx, accountId);
  });
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

/**
 * The next refresh finds nothing a reversal left undone: no level change, no
 * new lot, no new clawback. The level a reversal sets and the level coverage
 * computes are one number, so nothing is re-granted or taken twice.
 */
async function aRefreshChangesNothing(accountId: string): Promise<void> {
  const lotsBefore = (await lotsOf(db(), accountId)).length;
  const clawbacksBefore = (await clawbacksOf(db(), accountId)).length;
  const result = await h().grants.refreshCredits(accountId);
  expect(result.level, 'the refresh after a reversal moved the level').toBeNull();
  expect(result.window.outcome === 'created', 'the refresh granted a new window').toBe(false);
  expect((await lotsOf(db(), accountId)).length, 'the refresh wrote a lot').toBe(lotsBefore);
  expect((await clawbacksOf(db(), accountId)).length, 'the refresh clawed').toBe(clawbacksBefore);
}

describe.skipIf(!RUN_DB_TESTS)(
  'a reversal leaves the customer exactly what they still paid for',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a second refund after the first refund’s credit expired unspent owes nothing: nothing was spent (audit #1, H2)', async () => {
      const m = await pastMonth('ch_fx_a');
      // Half refunded while the lot still held its credit…
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_a',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID / 2,
      });
      expect(await remainingOfLot(m.lotId)).toBe(1_500);
      // …the other 1,500 expires unspent, then the rest of the payment is refunded.
      await expireNow(m.accountId);
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_a',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID,
      });
      expect(await debtOf(db(), m.accountId)).toBe(0);
      expect((await clawbacksOf(db(), m.accountId)).map((r) => r.debt_micro)).toEqual(['0']);
    });

    it('CRITICAL two refunds that together make the whole payment owe nothing when nothing was spent — no rounding debt (audit #11)', async () => {
      const c = await granted('ch_fx_g', 3200);
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_g',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: 1,
      });
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_g',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: 3200,
      });
      expect(await debtOf(db(), c.accountId)).toBe(0);
      expect(await remainingOfLot(c.lotId)).toBe(0);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL a dispute after a half refund is measured against what was still paid: nothing spent, nothing owed (audit #7)', async () => {
      const c = await granted('ch_fx_e');
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_e',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID / 2,
      });
      await aRefreshChangesNothing(c.accountId);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_e',
        chargeId: 'ch_fx_e',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await debtOf(db(), c.accountId)).toBe(0);
      expect(await remainingOfLot(c.lotId)).toBe(0);
      await aRefreshChangesNothing(c.accountId);
    });

    it('CRITICAL a half refund of an UPGRADE invoice takes back half of what that upgrade bought, from the upgrade’s own lot, and the level falls to the base plus half the upgrade (audit #5a)', async () => {
      const m = await paidMonth(db(), 'api_starter');
      await h().grants.refreshCredits(m.accountId);
      await mirrorMovedTo(db(), m.subscriptionId, 'api_builder', leaving(420));
      const upgrade = await paidProrationUpLine(db(), m.accountId, {
        subscriptionId: m.subscriptionId,
        tier: 'api_builder',
        from: leaving(420),
      });
      await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_fx_f1' WHERE stripe_invoice_id = ${upgrade}`;
      const up = await h().grants.refreshCredits(m.accountId);
      // 7,000 more a month for 420 of the month's 840 hours: 3,500.
      expect(credits(up.level?.deltaMicro ?? 0)).toBe(3_500);
      const prorationLot = (await lotsOf(db(), m.accountId)).find((l) => l.kind === 'proration');
      if (prorationLot === undefined || up.level === null) throw new Error('setup: no upgrade');

      const outcome = await svc().applyStripeRefund({
        chargeId: 'ch_fx_f1',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID / 2,
      });
      expect(outcome.kind).toBe('applied');
      const rows = await clawbacksOf(db(), m.accountId);
      expect(
        rows.map((r) => [r.source, credits(Number(r.amount_micro)), credits(Number(r.debt_micro))]),
      ).toEqual([['stripe_refund', 1_750, 0]]);
      expect(await remainingOfLot(prorationLot.id)).toBe(1_750);
      // 3,000 + (10,000 − 3,000) × ½ = 6,500.
      expect(await levelOf(up.level.windowId)).toBe(6_500);
      await aRefreshChangesNothing(m.accountId);
    });

    it('CRITICAL a full refund of the BASE month after a paid upgrade leaves the upgrade’s own lot alone, and the next refresh grants nothing (audit #5b)', async () => {
      const m = await paidMonth(db(), 'api_starter');
      await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_fx_f2' WHERE stripe_invoice_id = ${m.invoiceId}`;
      await h().grants.refreshCredits(m.accountId);
      await mirrorMovedTo(db(), m.subscriptionId, 'api_builder', leaving(420));
      await paidProrationUpLine(db(), m.accountId, {
        subscriptionId: m.subscriptionId,
        tier: 'api_builder',
        from: leaving(420),
      });
      const up = await h().grants.refreshCredits(m.accountId);
      expect(credits(up.level?.deltaMicro ?? 0)).toBe(3_500);

      await svc().applyStripeRefund({
        chargeId: 'ch_fx_f2',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID,
      });
      const rows = await clawbacksOf(db(), m.accountId);
      expect(rows.map((r) => credits(Number(r.amount_micro)))).toEqual([3_000]);
      expect(await spendable(m.accountId)).toBe(3_500);
      await aRefreshChangesNothing(m.accountId);
      expect(await spendable(m.accountId)).toBe(3_500);
    });

    it('CRITICAL after a resubscription re-upgraded the month, a further refund of the OLD invoice takes only from the old invoice’s lot, never adds credits, and the next refresh changes nothing (audit #4, M8)', async () => {
      const c = await granted('ch_fx_d');
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_d',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID / 2,
      });
      const nextSub = await subscription(db(), c.accountId, { tier: 'api_starter' });
      await paidLine(db(), c.accountId, {
        subscriptionId: nextSub,
        tier: 'api_starter',
        amountPaid: PAID,
      });
      await h().grants.refreshCredits(c.accountId);
      const before = await spendable(c.accountId);
      expect(before).toBe(3_000);
      const reupgrade = (await lotsOf(db(), c.accountId)).find((l) => l.kind === 'proration');
      if (reupgrade === undefined) throw new Error('setup: no re-upgrade lot');

      await svc().applyStripeRefund({
        chargeId: 'ch_fx_d',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: (PAID * 3) / 4,
      });
      const after = await spendable(c.accountId);
      expect(after).toBeLessThanOrEqual(before);
      // A quarter of the old invoice's 3,000 is still paid for: its lot keeps 750.
      expect(await remainingOfLot(c.lotId)).toBe(750);
      expect(await remainingOfLot(reupgrade.id), 'the new subscription’s lot was clawed').toBe(
        1_500,
      );
      expect(await levelOf(c.windowId), 'the new subscription still covers the month').toBe(3_000);
      await aRefreshChangesNothing(c.accountId);
      expect(await spendable(c.accountId)).toBe(after);
    });

    it('CRITICAL an annual plan canceled in its first month with half the year refunded owes nothing for the month it used — the interim cap pending the owner (audit #6)', async () => {
      const customer = await payingCustomer(db(), 'api_starter', {
        amountPaid: 58_800,
        interval: 'year',
        end: "((date_trunc('second', now()) - interval '5 days') AT TIME ZONE 'UTC' + interval '1 year') AT TIME ZONE 'UTC'",
      });
      await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_fx_i' WHERE stripe_invoice_id = ${customer.invoiceId}`;
      const first = await h().grants.refreshCredits(customer.accountId);
      if (first.window.outcome !== 'created') throw new Error('setup');
      const lot = (await lotsOf(db(), customer.accountId)).find((l) => l.kind === 'monthly');
      if (lot === undefined) throw new Error('setup: no lot');
      await spendFromLot(db(), customer.accountId, lot.id, 3_000);
      await db()`UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = ${customer.subscriptionId}`;

      await svc().applyStripeRefund({
        chargeId: 'ch_fx_i',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: 58_800 / 2,
      });
      // Six months are still paid for and one was used: nothing is owed.
      expect(await debtOf(db(), customer.accountId)).toBe(0);
      // And the level is what the half still paid for covers, not zero (audit #16).
      expect(await levelOf(first.window.windowId)).toBe(1_500);
    });

    it('CRITICAL a refund of an invoice whose subscription was already canceled lowers the level by the share refunded, not to zero, so a resubscription upgrades from there (audit #16)', async () => {
      const c = await granted('ch_fx_16');
      await db()`UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = ${c.subscriptionId}`;
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_16',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID / 2,
      });
      expect(await levelOf(c.windowId)).toBe(1_500);
      expect(await remainingOfLot(c.lotId)).toBe(1_500);
      await aRefreshChangesNothing(c.accountId);

      const nextSub = await subscription(db(), c.accountId, { tier: 'api_starter' });
      await paidLine(db(), c.accountId, {
        subscriptionId: nextSub,
        tier: 'api_starter',
        amountPaid: PAID,
      });
      const resubscribed = await h().grants.refreshCredits(c.accountId);
      expect(resubscribed.level?.fromLevelMicro).toBe(1_500 * MICRO);
      expect(resubscribed.level?.toLevelMicro).toBe(3_000 * MICRO);
    });

    it('CRITICAL a refund delivered before invoice.paid recorded its payment is refused for a retry, and the retry after the payment takes the credits back (audit #8)', async () => {
      const accountId = (await payingCustomer(db(), 'free')).accountId;
      await expect(
        svc().applyStripeRefund({
          chargeId: 'ch_fx_h',
          stripeInvoiceId: 'in_fx_h_late',
          cumulativeRefundedMinor: PAID,
        }),
      ).rejects.toMatchObject({ name: 'CreditReversalAwaitsPaymentError' });
      const sub = await subscription(db(), accountId, { tier: 'api_starter' });
      await db()`UPDATE accounts SET tier = 'api_starter' WHERE id = ${accountId}::uuid`;
      await paidLine(db(), accountId, {
        invoiceId: 'in_fx_h_late',
        subscriptionId: sub,
        tier: 'api_starter',
        amountPaid: PAID,
      });
      await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_fx_h' WHERE stripe_invoice_id = 'in_fx_h_late'`;
      await h().grants.refreshCredits(accountId);
      expect(await spendable(accountId)).toBe(3_000);
      // Stripe redelivers the refund: now it is matched and applied.
      const retried = await svc().applyStripeRefund({
        chargeId: 'ch_fx_h',
        stripeInvoiceId: 'in_fx_h_late',
        cumulativeRefundedMinor: PAID,
      });
      expect(retried.kind).toBe('applied');
      expect(await spendable(accountId)).toBe(0);
    });

    it('CRITICAL a won dispute whose month was all spent puts the invoice and the level back, and the next refresh keeps them (audit #2)', async () => {
      const c = await granted('ch_fx_b');
      await spendFromLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_b',
        chargeId: 'ch_fx_b',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await debtOf(db(), c.accountId)).toBe(3_000 * MICRO);
      const out = await svc().reinstateDispute({
        disputeId: 'dp_fx_b',
        chargeId: 'ch_fx_b',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(out).toMatchObject({
        kind: 'reinstated',
        reversed: 1,
        regrantedMicro: 0,
        forgivenMicro: 3_000 * MICRO,
      });
      expect(await disputedOf(c.invoiceId)).toBe(0);
      expect(await levelOf(c.windowId)).toBe(3_000);
      expect(await debtOf(db(), c.accountId)).toBe(0);
      await aRefreshChangesNothing(c.accountId);
      expect(await levelOf(c.windowId)).toBe(3_000);
    });

    it('CRITICAL a won dispute on a month that was never granted leaves the month grantable in full: the invoice is put back even though the dispute clawed nothing (audit #2)', async () => {
      const customer = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
      await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_fx_b0' WHERE stripe_invoice_id = ${customer.invoiceId}`;
      const disputed = await svc().applyStripeDispute({
        disputeId: 'dp_fx_b0',
        chargeId: 'ch_fx_b0',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(disputed.kind).toBe('no_windows');
      expect(await disputedOf(customer.invoiceId)).toBe(PAID);
      await svc().reinstateDispute({
        disputeId: 'dp_fx_b0',
        chargeId: 'ch_fx_b0',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await disputedOf(customer.invoiceId)).toBe(0);
      // R4 (S17 round 3) — the win draws the month it makes the invoice cover
      // again INSIDE the win: the month is grantable in full because it is
      // granted, at once, and the refresh after the win (which this arm used to
      // see `created` it) finds it drawn and writes nothing.
      expect(await spendable(customer.accountId)).toBe(3_000);
      const refreshed = await h().grants.refreshCredits(customer.accountId);
      expect(refreshed.window.outcome).toBe('none');
      await aRefreshChangesNothing(customer.accountId);
      expect(await spendable(customer.accountId)).toBe(3_000);
    });

    it('CRITICAL a created dispute redelivered after it was won takes nothing again and leaves the level where the win put it (audit #12)', async () => {
      const c = await granted('ch_fx_b2');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_b2',
        chargeId: 'ch_fx_b2',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      await svc().reinstateDispute({
        disputeId: 'dp_fx_b2',
        chargeId: 'ch_fx_b2',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await levelOf(c.windowId)).toBe(3_000);
      const again = await svc().applyStripeDispute({
        disputeId: 'dp_fx_b2',
        chargeId: 'ch_fx_b2',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(again.kind).toBe('already_applied');
      expect(await disputedOf(c.invoiceId)).toBe(0);
      expect(await levelOf(c.windowId)).toBe(3_000);
      expect(await spendable(c.accountId)).toBe(2_000);
    });

    it('CRITICAL a won dispute cancels the claim it had on a running task’s credit: the task settles for nothing and the whole month is spendable again (audit #3)', async () => {
      const c = await granted('ch_fx_c');
      const reservationId = await holdOnLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_c',
        chargeId: 'ch_fx_c',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect((await clawbacksOf(db(), c.accountId)).map((r) => r.pending_micro)).toEqual([
        String(3_000 * MICRO),
      ]);
      await svc().reinstateDispute({
        disputeId: 'dp_fx_c',
        chargeId: 'ch_fx_c',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await clawbacksOf(db(), c.accountId)).toMatchObject([
        { state: 'reversed', pending_micro: '0' },
      ]);
      const settled = await rh().service.settle(reservationId, 'completed');
      expect(settled.claimsPaidMicro).toBe(0);
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await debtOf(db(), c.accountId)).toBe(0);
    });

    it('CRITICAL a won dispute re-grants what its claim already collected from a task that spent part of what it held, and forgives the rest (audit #3)', async () => {
      const c = await granted('ch_fx_c2');
      const reservationId = await holdOnLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_c2',
        chargeId: 'ch_fx_c2',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      // The task spends 1,000 and settles: the 2,000 it releases pays the claim,
      // and the 1,000 the claim still asks for becomes debt.
      await settledCall(db(), {
        reservationId,
        accountId: c.accountId,
        chargedMicro: 1_000 * MICRO,
      });
      const settled = await rh().service.settle(reservationId, 'completed');
      expect(settled.claimsPaidMicro).toBe(2_000 * MICRO);
      expect(await debtOf(db(), c.accountId)).toBe(1_000 * MICRO);

      const out = await svc().reinstateDispute({
        disputeId: 'dp_fx_c2',
        chargeId: 'ch_fx_c2',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(out).toMatchObject({
        kind: 'reinstated',
        regrantedMicro: 2_000 * MICRO,
        forgivenMicro: 1_000 * MICRO,
      });
      expect(await spendable(c.accountId)).toBe(2_000);
      expect(await debtOf(db(), c.accountId)).toBe(0);
      expect(await levelOf(c.windowId)).toBe(3_000);
    });

    it('a claim whose clawback was reversed is neither counted against held credit nor paid when the task settles', async () => {
      const c = await granted('ch_fx_rev');
      const reservationId = await holdOnLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_rev',
        chargeId: 'ch_fx_rev',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      // A reversed clawback still carrying its claim: the state a reinstatement
      // written before this fix leaves behind, which the guard permits.
      await db()`UPDATE credit_clawbacks SET state = 'reversed' WHERE source_ref = 'dp_fx_rev'`;
      const standing = await h().ledger.transaction((tx) =>
        h().windows.pendingClaimTotalMicro(tx, c.accountId),
      );
      expect(standing).toBe(0);
      const settled = await rh().service.settle(reservationId, 'completed');
      expect(settled.claimsPaidMicro).toBe(0);
      expect(await remainingOfLot(c.lotId)).toBe(3_000);
    });

    it('CRITICAL the level change a reversal writes records no second amount: its delta is zero, and the credits moved are the clawback’s (audit #14)', async () => {
      const c = await granted('ch_fx_14');
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_14',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID,
      });
      const changes = await levelChangesOf(db(), c.windowId);
      expect(changes.map((r) => [r.reason, r.delta_micro])).toEqual([['refund', '0']]);
    });

    it('CRITICAL a won dispute waits for the account’s credit lock before it locks any clawback row — the order a settlement takes them in (audit #13)', async () => {
      const c = await granted('ch_fx_13');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_13',
        chargeId: 'ch_fx_13',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      const [row] = await db()<
        Array<{ id: string }>
      >`SELECT id FROM credit_clawbacks WHERE source_ref = 'dp_fx_13'`;
      if (row === undefined) throw new Error('setup: the dispute wrote no clawback');

      let release = (): void => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let held = (): void => undefined;
      const holding = new Promise<void>((r) => {
        held = r;
      });
      const holder = db().begin(async (tx) => {
        await tx`SELECT account_id FROM credit_accounts WHERE account_id = ${c.accountId}::uuid FOR UPDATE`;
        held();
        await released;
      });
      await holding;
      const reinstating = svc().reinstateDispute({
        disputeId: 'dp_fx_13',
        chargeId: 'ch_fx_13',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      try {
        // Wait until the reinstatement is queued on a lock.
        let blocked = false;
        for (let i = 0; i < 400 && !blocked; i += 1) {
          const [waiting] = await db()<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          blocked = Number(waiting?.n ?? '0') > 0;
          if (!blocked) await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked, 'the reinstatement never waited on the account lock').toBe(true);
        // While it waits, it holds no clawback row: a settlement could take it.
        const probe = await db()
          .begin(async (tx) => {
            await tx`SELECT id FROM credit_clawbacks WHERE id = ${row.id}::uuid FOR UPDATE NOWAIT`;
            return 'free';
          })
          .catch((err: { code?: string }) => err.code ?? 'error');
        expect(probe).toBe('free');
      } finally {
        release();
        await holder;
      }
      expect((await reinstating).kind).toBe('reinstated');
    });

    it('a refund of an invoice after its won dispute takes back the re-granted credits too (a guard for the new attribution: it held before the fix by a different route)', async () => {
      const c = await granted('ch_fx_rg');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_rg',
        chargeId: 'ch_fx_rg',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      await svc().reinstateDispute({
        disputeId: 'dp_fx_rg',
        chargeId: 'ch_fx_rg',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await spendable(c.accountId)).toBe(2_000);
      await svc().applyStripeRefund({
        chargeId: 'ch_fx_rg',
        stripeInvoiceId: null,
        cumulativeRefundedMinor: PAID,
      });
      // Fully refunded, 1,000 spent: nothing left, 1,000 owed.
      expect(await spendable(c.accountId)).toBe(0);
      expect(await debtOf(db(), c.accountId)).toBe(1_000 * MICRO);
    });

    it('a win sent as two events — closed, then funds_reinstated — puts the credits back once (a guard: the audit found this sound)', async () => {
      const c = await granted('ch_fx_2ev');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_2ev',
        chargeId: 'ch_fx_2ev',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      const first = await svc().reinstateDispute({
        disputeId: 'dp_fx_2ev',
        chargeId: 'ch_fx_2ev',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(first).toMatchObject({ kind: 'reinstated', regrantedMicro: 2_000 * MICRO });
      const second = await svc().reinstateDispute({
        disputeId: 'dp_fx_2ev',
        chargeId: 'ch_fx_2ev',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(second.kind).toBe('nothing_to_reinstate');
      expect(await spendable(c.accountId)).toBe(2_000);
      // Once: the month's own lot holds its 2,000 again (the win puts the
      // credit back into the lot it came from, S17 round 3), and the second
      // event added nothing to it and no lot beside it.
      expect(await remainingOfLot(c.lotId)).toBe(2_000);
      expect((await lotsOf(db(), c.accountId)).map((l) => l.kind)).toEqual(['monthly']);
      expect(await levelOf(c.windowId)).toBe(3_000);
    });

    it('a win after the disputed month ended re-grants nothing — the credit would have expired with its month (M6) — and still puts the invoice back (a guard: the audit found this sound)', async () => {
      const m = await pastMonth('ch_fx_late');
      await svc().applyStripeDispute({
        disputeId: 'dp_fx_late',
        chargeId: 'ch_fx_late',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(await remainingOfLot(m.lotId)).toBe(0);
      const out = await svc().reinstateDispute({
        disputeId: 'dp_fx_late',
        chargeId: 'ch_fx_late',
        stripeInvoiceId: null,
        amountMinor: PAID,
      });
      expect(out).toMatchObject({ kind: 'reinstated', reversed: 1, regrantedMicro: 0 });
      expect((await lotsOf(db(), m.accountId)).filter((l) => l.kind === 'adjustment')).toEqual([]);
      expect(await disputedOf(m.invoiceId)).toBe(0);
    });

    it('two deliveries of one refund at once claw once, and two cumulatives at once end with the lot empty and nothing owed (a guard: the audit found this sound)', async () => {
      const c = await granted('ch_fx_race');
      await Promise.all([
        svc().applyStripeRefund({
          chargeId: 'ch_fx_race',
          stripeInvoiceId: null,
          cumulativeRefundedMinor: PAID / 2,
        }),
        svc().applyStripeRefund({
          chargeId: 'ch_fx_race',
          stripeInvoiceId: null,
          cumulativeRefundedMinor: PAID / 2,
        }),
      ]);
      const c2 = await granted('ch_fx_race2');
      await Promise.all([
        svc().applyStripeRefund({
          chargeId: 'ch_fx_race2',
          stripeInvoiceId: null,
          cumulativeRefundedMinor: PAID,
        }),
        svc().applyStripeRefund({
          chargeId: 'ch_fx_race2',
          stripeInvoiceId: null,
          cumulativeRefundedMinor: PAID / 2,
        }),
      ]);
      expect(await remainingOfLot(c.lotId)).toBe(1_500);
      expect(await remainingOfLot(c2.lotId)).toBe(0);
      expect(await debtOf(db(), c2.accountId)).toBe(0);
    });
  },
);
