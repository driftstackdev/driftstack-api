// A reversed payment takes back the credits it bought, and only those (S17,
// plan §6.7, H2, L5, M6, M8). Every arm below runs the real repos and the real
// clawback service against an isolated Postgres database rebuilt from the
// migrations, so what is proved is what the database will do.
//
// The customer paid 4,900 minor units for a month of api_starter (3,000
// credits) and has that month granted. What must hold:
//
//   · a refunded month takes back what was not spent, and the rest — what WAS
//     spent — becomes debt, never more;
//   · a partial refund takes back its share, and lowers the month's level by
//     the same share (M8), to exactly what the invoice now covers;
//   · the same refund delivered twice, or out of order, takes credits back
//     once (L5);
//   · a month whose credits expired UNUSED is refunded into no debt at all (H2);
//   · a chargeback puts the account in debt, which a new grant pays down first
//     (the reservation path's own tests prove a task on credits is refused
//     while debt stands; a task on the customer's own key is not — S12);
//   · a won dispute puts the credits back: the clawback is reversed, its debt
//     forgiven, the credits re-granted for the window they came from, the level
//     restored;
//   · after a full refund a NEW paid subscription earns its credits at once
//     (M8): the next refresh treats the new invoice as an upgrade from the
//     refunded level;
//   · a refunded crypto order takes back the credits its term granted;
//   · a refund that matches no recorded payment is kept for review: nothing
//     written, the log names the charge, the alert does not.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { CreditClawbacksService } from '../../src/services/credit-clawbacks.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  cryptoEntitlement,
  grantsHarness,
  insertWindow,
  ledgerOf,
  lotsOf,
  paidLine,
  payingCustomer,
  subscription,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  clawbacksOf,
  levelChangesOf,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_refunds';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4900;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let service: CreditClawbacksService | null = null;
const errors: Array<Record<string, unknown>> = [];
const alerts: SentryMessage[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url);
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (fields: Record<string, unknown>) => {
      errors.push(fields);
    },
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
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}
function svc(): CreditClawbacksService {
  if (service === null) throw new Error('isolated database unreachable');
  return service;
}

/** A paying api_starter customer with this month granted, the invoice carrying its charge. */
async function granted(chargeId: string) {
  const customer = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
  await db()`
    UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId}
     WHERE stripe_invoice_id = ${customer.invoiceId}`;
  const first = await h().grants.refreshCredits(customer.accountId);
  if (first.window.outcome !== 'created') {
    throw new Error(`setup: the month was not granted (${first.window.outcome})`);
  }
  const lots = await lotsOf(db(), customer.accountId);
  const monthly = lots.find((l) => l.kind === 'monthly');
  if (monthly === undefined) throw new Error('setup: no monthly lot');
  return { ...customer, windowId: first.window.windowId, lotId: monthly.id };
}

async function remaining(lotId: string): Promise<number> {
  const [row] = await db()<Array<{ remaining: string }>>`
    SELECT remaining_micro::text AS remaining FROM credit_lots WHERE id = ${lotId}::uuid`;
  return Number(row?.remaining ?? '0') / MICRO;
}

async function levelOf(windowId: string): Promise<number> {
  const [row] = await db()<Array<{ level: string }>>`
    SELECT level_micro::text AS level FROM credit_windows WHERE id = ${windowId}::uuid`;
  return Number(row?.level ?? '0') / MICRO;
}

async function paymentOf(invoiceId: string): Promise<{ refunded: number; disputed: number }> {
  const [row] = await db()<Array<{ refunded: string; disputed: string }>>`
    SELECT refunded_minor::text AS refunded, disputed_minor::text AS disputed
      FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}`;
  return { refunded: Number(row?.refunded ?? '0'), disputed: Number(row?.disputed ?? '0') };
}

describe.skipIf(!RUN_DB_TESTS)('a refund or chargeback takes credits back', () => {
  it('the isolated database was rebuilt from the migrations and is reachable', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL a refunded month takes back what was not spent, and what WAS spent becomes debt — 1,000 spent of 3,000: 2,000 back, 1,000 owed', async () => {
    const c = await granted('ch_full');
    await spendFromLot(db(), c.accountId, c.lotId, 1_000);
    const outcome = await svc().applyStripeRefund({
      chargeId: 'ch_full',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID,
    });
    expect(outcome.kind).toBe('applied');
    expect(await remaining(c.lotId)).toBe(0);
    expect(await debtOf(db(), c.accountId)).toBe(1_000 * MICRO);
    const rows = await clawbacksOf(db(), c.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'stripe_refund',
      source_ref: `ch_full:${String(PAID)}`,
      // The target names the window AND the invoice: a window can hold lots
      // two invoices paid for, and a refund takes only its own (S17 audit #4, #5).
      target_key: `window:${c.windowId}:${c.invoiceId}`,
      state: 'applied',
      clawed_micro: String(2_000 * MICRO),
      debt_micro: String(1_000 * MICRO),
    });
    const kinds = (await ledgerOf(db(), c.accountId)).map((r) => r.kind);
    expect(kinds).toContain('refund_clawback');
    expect(kinds).toContain('debt_incurred');
    expect(await h().ledger.latestDebtReason(c.accountId)).toBe('payment_reversed');
    // The month covers nothing now: its level is zero, recorded as a refund.
    expect(await levelOf(c.windowId)).toBe(0);
    expect((await levelChangesOf(db(), c.windowId)).at(-1)?.reason).toBe('refund');
    expect((await paymentOf(c.invoiceId)).refunded).toBe(PAID);
  });

  it('CRITICAL a partial refund takes back its share and lowers the level by the same share (M8): half refunded → 1,500 back, level 3,000 → 1,500', async () => {
    const c = await granted('ch_half');
    const outcome = await svc().applyStripeRefund({
      chargeId: 'ch_half',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID / 2,
    });
    expect(outcome.kind).toBe('applied');
    expect(await remaining(c.lotId)).toBe(1_500);
    expect(await debtOf(db(), c.accountId)).toBe(0);
    expect(await levelOf(c.windowId)).toBe(1_500);
    // And the level a reconciliation would target agrees, so the next refresh
    // changes nothing: no plan-change row appears, no proration lot is granted.
    const after = await h().grants.refreshCredits(c.accountId);
    expect(after.level).toBeNull();
    expect((await levelChangesOf(db(), c.windowId)).map((r) => r.reason)).toEqual(['refund']);
  });

  it('CRITICAL a refund delivered twice takes credits back once, and one delivered OUT OF ORDER adds nothing (L5)', async () => {
    const c = await granted('ch_twice');
    await svc().applyStripeRefund({
      chargeId: 'ch_twice',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID / 2,
    });
    const again = await svc().applyStripeRefund({
      chargeId: 'ch_twice',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID / 2,
    });
    expect(again.kind).toBe('already_applied');
    const late = await svc().applyStripeRefund({
      chargeId: 'ch_twice',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: 1000,
    });
    expect(late.kind).toBe('already_applied');
    expect(await remaining(c.lotId)).toBe(1_500);
    expect(await clawbacksOf(db(), c.accountId)).toHaveLength(1);
    // A larger cumulative arriving afterwards takes back only what it adds.
    const rest = await svc().applyStripeRefund({
      chargeId: 'ch_twice',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID,
    });
    expect(rest.kind).toBe('applied');
    expect(await remaining(c.lotId)).toBe(0);
    expect(await clawbacksOf(db(), c.accountId)).toHaveLength(2);
    expect(await debtOf(db(), c.accountId)).toBe(0);
  });

  it('CRITICAL a refund after partial spending creates debt only for the refunded share of what was spent — 2,500 spent, half refunded: 500 back, 1,000 owed, never 1,500', async () => {
    const c = await granted('ch_spent');
    await spendFromLot(db(), c.accountId, c.lotId, 2_500);
    await svc().applyStripeRefund({
      chargeId: 'ch_spent',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID / 2,
    });
    // Half of 3,000 is asked; 500 is free; the 1,000 the lots cannot give is
    // owed, and it is less than what was spent — a refund never owes more
    // than the customer used.
    expect(await remaining(c.lotId)).toBe(0);
    expect(await debtOf(db(), c.accountId)).toBe(1_000 * MICRO);
  });

  it('CRITICAL a month whose credits EXPIRED unused is refunded into no debt at all (H2)', async () => {
    const accountId = (await payingCustomer(db(), 'api_starter', { amountPaid: PAID })).accountId;
    // A past month this invoice bought: the window ended ten days ago and its
    // lot expired with it, unspent.
    const pastSubscription = await subscription(db(), accountId, { tier: 'api_starter' });
    const pastInvoice = await paidLine(db(), accountId, {
      subscriptionId: pastSubscription,
      tier: 'api_starter',
      start: "now() - interval '40 days'",
      end: "now() - interval '10 days'",
      amountPaid: PAID,
    });
    await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_expired' WHERE stripe_invoice_id = ${pastInvoice}`;
    const windowId = await insertWindow(db(), accountId, {
      sourceRef: pastInvoice,
      start: "now() - interval '40 days'",
      end: "now() - interval '10 days'",
      credits: 3_000,
    });
    await h().ledger.transaction(async (tx) => {
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
      await h().ledger.expireDueLots(tx, accountId);
    });
    const kindsBefore = (await ledgerOf(db(), accountId)).map((r) => r.kind);
    expect(kindsBefore, 'setup: the lot expired unspent').toContain('expiry');
    const outcome = await svc().applyStripeRefund({
      chargeId: 'ch_expired',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID,
    });
    expect(outcome.kind).toBe('applied');
    expect(await debtOf(db(), accountId)).toBe(0);
    const kinds = (await ledgerOf(db(), accountId)).map((r) => r.kind);
    expect(kinds).not.toContain('refund_clawback');
    expect(kinds).not.toContain('debt_incurred');
    expect(await clawbacksOf(db(), accountId)).toEqual([]);
  });

  it('CRITICAL a chargeback puts the account in debt for what was spent, and a new grant pays that debt down before anything else', async () => {
    const c = await granted('ch_disputed');
    await spendFromLot(db(), c.accountId, c.lotId, 1_000);
    const outcome = await svc().applyStripeDispute({
      disputeId: 'dp_1',
      chargeId: 'ch_disputed',
      stripeInvoiceId: null,
      amountMinor: PAID,
    });
    expect(outcome.kind).toBe('applied');
    expect(await debtOf(db(), c.accountId)).toBe(1_000 * MICRO);
    expect(await h().ledger.spendableMicro(c.accountId)).toBe(0);
    expect(await h().ledger.latestDebtReason(c.accountId)).toBe('payment_reversed');
    expect((await levelChangesOf(db(), c.windowId)).at(-1)?.reason).toBe('dispute');
    expect((await paymentOf(c.invoiceId)).disputed).toBe(PAID);
    // A redelivery of the same dispute claws nothing more.
    expect(
      (
        await svc().applyStripeDispute({
          disputeId: 'dp_1',
          chargeId: 'ch_disputed',
          stripeInvoiceId: null,
          amountMinor: PAID,
        })
      ).kind,
    ).toBe('already_applied');
    // Credit that arrives pays the debt first: a 400-credit goodwill lot
    // leaves 600 owed and nothing spendable.
    await h().ledger.transaction(async (tx) => {
      await h().ledger.lockAccount(tx, c.accountId);
      const lot = await h().ledger.insertLot(
        {
          accountId: c.accountId,
          kind: 'adjustment',
          grantKey: 'goodwill:after-dispute',
          grantedMicro: 400 * MICRO,
          startsAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        tx,
      );
      await h().ledger.append(
        {
          accountId: c.accountId,
          kind: 'grant',
          lotId: lot.lot.id,
          amountMicro: 400 * MICRO,
          idempotencyKey: 'goodwill:after-dispute:grant',
        },
        tx,
      );
      await h().ledger.settleDebtFromFree(tx, c.accountId);
    });
    expect(await debtOf(db(), c.accountId)).toBe(600 * MICRO);
    expect(await h().ledger.spendableMicro(c.accountId)).toBe(0);
  });

  it('CRITICAL a won dispute restores the credits and clears its debt: the clawback is reversed, the debt forgiven, the credits re-granted for the window, the level put back', async () => {
    const c = await granted('ch_won');
    await spendFromLot(db(), c.accountId, c.lotId, 1_000);
    await svc().applyStripeDispute({
      disputeId: 'dp_won',
      chargeId: 'ch_won',
      stripeInvoiceId: null,
      amountMinor: PAID,
    });
    expect(await debtOf(db(), c.accountId)).toBe(1_000 * MICRO);
    expect(await levelOf(c.windowId)).toBe(0);
    const outcome = await svc().reinstateDispute({
      disputeId: 'dp_won',
      chargeId: 'ch_won',
      stripeInvoiceId: null,
      amountMinor: PAID,
    });
    expect(outcome).toMatchObject({
      kind: 'reinstated',
      reversed: 1,
      regrantedMicro: 2_000 * MICRO,
      forgivenMicro: 1_000 * MICRO,
    });
    expect(await debtOf(db(), c.accountId)).toBe(0);
    const rows = await clawbacksOf(db(), c.accountId);
    expect(rows.map((r) => r.state)).toEqual(['reversed']);
    // The credits are re-granted INTO the window's own lot, which expires with
    // the window: it holds the 2,000 it held before the dispute, exactly as if
    // the dispute had never been filed (S17 round 3 — a separate goodwill lot
    // is spent after every other included credit of the month, which moved what
    // a later refund of an annual invoice under the interim cap left the
    // customer; see the third audit's twin test). No goodwill lot is needed.
    expect(await remaining(c.lotId)).toBe(2_000);
    expect((await lotsOf(db(), c.accountId)).map((l) => l.kind)).toEqual(['monthly']);
    expect(await h().ledger.spendableMicro(c.accountId)).toBe(2_000 * MICRO);
    expect(await levelOf(c.windowId)).toBe(3_000);
    expect((await levelChangesOf(db(), c.windowId)).map((r) => r.reason)).toEqual([
      'dispute',
      'dispute_reinstated',
    ]);
    expect((await paymentOf(c.invoiceId)).disputed).toBe(0);
    // Reinstating again finds nothing standing.
    expect(
      (
        await svc().reinstateDispute({
          disputeId: 'dp_won',
          chargeId: 'ch_won',
          stripeInvoiceId: null,
          amountMinor: PAID,
        })
      ).kind,
    ).toBe('nothing_to_reinstate');
  });

  it('CRITICAL a new subscription after a full refund gets its credits at once (M8): the next refresh treats the new invoice as an upgrade from the refunded level', async () => {
    const c = await granted('ch_resub');
    await svc().applyStripeRefund({
      chargeId: 'ch_resub',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: PAID,
    });
    expect(await levelOf(c.windowId)).toBe(0);
    // The customer comes back the same day on a NEW subscription with a paid month.
    const nextSubscription = await subscription(db(), c.accountId, { tier: 'api_starter' });
    await paidLine(db(), c.accountId, {
      subscriptionId: nextSubscription,
      tier: 'api_starter',
      amountPaid: PAID,
    });
    const refreshed = await h().grants.refreshCredits(c.accountId);
    expect(refreshed.level).not.toBeNull();
    expect(refreshed.level?.deltaMicro ?? 0).toBeGreaterThan(0);
    expect(await levelOf(c.windowId)).toBe(3_000);
    const kinds = (await ledgerOf(db(), c.accountId)).map((r) => r.kind);
    expect(kinds).toContain('proration_grant');
    expect(await h().ledger.spendableMicro(c.accountId)).toBeGreaterThan(0);
  });

  it('CRITICAL a refunded crypto order takes back the credits its term granted', async () => {
    const accountId = (await payingCustomer(db(), 'free')).accountId;
    const orderId = await cryptoEntitlement(db(), accountId, { tier: 'api_starter' });
    const first = await h().grants.refreshCredits(accountId);
    expect(first.window.outcome).toBe('created');
    const outcome = await svc().applyCryptoRefund({ accountId, orderId });
    expect(outcome.kind).toBe('applied');
    expect(await h().ledger.spendableMicro(accountId)).toBe(0);
    const rows = await clawbacksOf(db(), accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'crypto_refund',
      source_ref: orderId,
      state: 'applied',
    });
    expect((await svc().applyCryptoRefund({ accountId, orderId })).kind).toBe('applied');
    expect(await clawbacksOf(db(), accountId)).toHaveLength(1);
  });

  it('CRITICAL a refund that matches no recorded payment is kept for review: nothing written, the log names the charge, the alert does not', async () => {
    errors.length = 0;
    alerts.length = 0;
    const outcome = await svc().applyStripeRefund({
      chargeId: 'ch_nobody',
      stripeInvoiceId: null,
      cumulativeRefundedMinor: 100,
    });
    expect(outcome).toEqual({ kind: 'unmatched' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.chargeId).toBe('ch_nobody');
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).not.toContain('ch_nobody');
  });
});
