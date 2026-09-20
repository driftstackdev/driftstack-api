// A paid-invoice event grants the month; a subscription event alone does not.
//
// The whole path, with nothing stood in for: real Stripe event payloads, the
// real webhook service, the real repositories, the real grants service, one
// Postgres. It is the only test in which the rows the grants READ were written
// by the code that writes them in production, so it is where a disagreement
// between the two — a column one side names and the other does not fill — would
// show.
//
// The order of events is the point. Stripe says a subscription is `active` when
// it is created; the invoice is paid a moment later, and sometimes never. The
// subscription event therefore refreshes the account and grants NOTHING, and the
// paid invoice is what grants. Stripe then sends two events for that one payment
// (`invoice.payment_succeeded` and `invoice.paid`), redelivers either at will,
// and runs its handlers before it records an event as seen — so the last arm
// delivers both at once, on two connections, and the month is granted once.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { DrizzleCreditWindowsRepo } from '../../src/db/credit-windows-repo.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { CreditGrantsService } from '../../src/services/credit-grants.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { MICRO, grantCounts, windowsOf } from './_helpers/credit-grant-fixtures.js';
import { buildInvoice, buildInvoiceEvent } from './_helpers/stripe-invoice-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_grants_webhook';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
const pools: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  for (let i = 0; i < 2; i += 1) pools.push(createDb(opened.url, { max: 2 }));
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(pools.map((p) => p.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

/** The webhook service as production wires it, on one pool. `credits: false` is AI credits switched off. */
function service(i: 0 | 1, opts: { credits: boolean }): StripeWebhooksService {
  const pool = pools[i];
  if (pool === undefined) throw new Error('isolated database unreachable');
  return new StripeWebhooksService(new DrizzleStripeWebhooksRepo(pool), {
    logger: createTestLogger(),
    priceToTier: { price_builder_m: 'api_builder', price_scale_m: 'api_scale' },
    priceToInterval: { price_builder_m: 'month', price_scale_m: 'month' },
    creditsRefresher: opts.credits
      ? new CreditGrantsService({
          ledger: new DrizzleCreditLedgerRepo(pool),
          windows: new DrizzleCreditWindowsRepo(pool),
        })
      : null,
  });
}

interface Customer {
  accountId: string;
  customerId: string;
  subscriptionId: string;
}

async function newCustomer(): Promise<Customer> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId}`;
  await db()`
    INSERT INTO accounts (id, email, stripe_customer_id)
    VALUES (${accountId}::uuid, ${`webhook-${accountId}@example.test`}, ${customerId})`;
  return { accountId, customerId, subscriptionId: `sub_${accountId}` };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

function subscriptionEvent(c: Customer, priceId: string, status = 'active'): StripeEvent {
  const start = nowSec() - 60;
  return {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.created',
    created: nowSec(),
    data: {
      object: {
        id: c.subscriptionId,
        customer: c.customerId,
        status,
        cancel_at_period_end: false,
        current_period_start: start,
        current_period_end: start + 30 * DAY,
        items: { data: [{ price: { id: priceId } }] },
      },
    },
  };
}

function paidInvoiceEvent(
  c: Customer,
  type: 'invoice.payment_succeeded' | 'invoice.paid',
  invoiceId: string,
  priceId: string,
): StripeEvent {
  const start = nowSec() - 60;
  return buildInvoiceEvent({
    eventId: `evt_${randomUUID()}`,
    type,
    invoice: buildInvoice('newer', {
      invoiceId,
      customerId: c.customerId,
      subscriptionId: c.subscriptionId,
      amountPaid: 14900,
      lines: [{ priceId, amount: 14900, periodStartSec: start, periodEndSec: start + 30 * DAY }],
    }),
  });
}

const deliver = (s: StripeWebhooksService, e: StripeEvent): Promise<string> =>
  s.handle(e, JSON.stringify(e));

describe.skipIf(!RUN_DB_TESTS)(
  'a paid-invoice event grants the month and an unpaid subscription event does not',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(pools).toHaveLength(2);
    });

    it('CRITICAL an ACTIVE subscription event grants nothing — the account is on the plan, may use it, and has paid for nothing yet — and the paid invoice that follows grants the month', async () => {
      const c = await newCustomer();
      const stripe = service(0, { credits: true });

      expect(await deliver(stripe, subscriptionEvent(c, 'price_builder_m'))).toBe('handled');
      const [account] = await db()<Array<{ tier: string }>>`
      SELECT tier::text AS tier FROM accounts WHERE id = ${c.accountId}::uuid`;
      expect(account?.tier, 'the subscription event still does its own job').toBe('api_builder');
      expect(await grantCounts(db(), c.accountId)).toEqual({ windows: 0, lots: 0, ledger: 0 });

      expect(
        await deliver(
          stripe,
          paidInvoiceEvent(c, 'invoice.payment_succeeded', 'in_first', 'price_builder_m'),
        ),
      ).toBe('handled');
      const [w] = await windowsOf(db(), c.accountId);
      expect(w).toMatchObject({
        source: 'stripe_invoice',
        source_ref: 'in_first',
        tier: 'api_builder',
        level_micro: String(10_000 * MICRO),
        current: true,
      });
      // The window is the invoice LINE's period, to the second.
      const [line] = await db()<Array<{ s: Date; e: Date }>>`
      SELECT line_period_start AS s, line_period_end AS e FROM billing_invoice_payments
       WHERE stripe_invoice_id = 'in_first'`;
      expect([w?.window_start.getTime(), w?.window_end.getTime()]).toEqual([
        line?.s.getTime(),
        line?.e.getTime(),
      ]);
    });

    it('the sibling event for the same payment, and a redelivery of either, grant nothing more', async () => {
      const c = await newCustomer();
      const stripe = service(0, { credits: true });
      await deliver(stripe, subscriptionEvent(c, 'price_scale_m'));
      const succeeded = paidInvoiceEvent(
        c,
        'invoice.payment_succeeded',
        `in_${c.accountId}`,
        'price_scale_m',
      );
      const paid = paidInvoiceEvent(c, 'invoice.paid', `in_${c.accountId}`, 'price_scale_m');

      expect(await deliver(stripe, succeeded)).toBe('handled');
      expect(await deliver(stripe, paid)).toBe('handled');
      expect(await deliver(stripe, succeeded)).toBe('duplicate');
      // A redelivery under a NEW event id is not deduplicated by the event ledger:
      // only the grant's own keys stand between it and a second month.
      expect(await deliver(stripe, { ...paid, id: `evt_${randomUUID()}` })).toBe('handled');

      expect(await grantCounts(db(), c.accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
    });

    it('a paid invoice for a subscription that is not active grants nothing, and the grant arrives when the subscription becomes active', async () => {
      const c = await newCustomer();
      const stripe = service(0, { credits: true });
      await deliver(stripe, subscriptionEvent(c, 'price_builder_m', 'incomplete'));
      await deliver(
        stripe,
        paidInvoiceEvent(c, 'invoice.paid', `in_${c.accountId}`, 'price_builder_m'),
      );
      expect(await grantCounts(db(), c.accountId)).toEqual({ windows: 0, lots: 0, ledger: 0 });

      const activated = subscriptionEvent(c, 'price_builder_m', 'active');
      activated.type = 'customer.subscription.updated';
      activated.created = nowSec() + 5;
      expect(await deliver(stripe, activated)).toBe('handled');
      expect(await grantCounts(db(), c.accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
    });

    it('CRITICAL with AI credits switched off the same events do exactly what they always did — the tier, the mirror, the recorded payment — and write no window, no lot, no ledger row and no credit row at all', async () => {
      const c = await newCustomer();
      const stripe = service(0, { credits: false });
      expect(await deliver(stripe, subscriptionEvent(c, 'price_builder_m'))).toBe('handled');
      expect(
        await deliver(
          stripe,
          paidInvoiceEvent(c, 'invoice.payment_succeeded', `in_${c.accountId}`, 'price_builder_m'),
        ),
      ).toBe('handled');
      expect(
        await deliver(
          stripe,
          paidInvoiceEvent(c, 'invoice.paid', `in_${c.accountId}`, 'price_builder_m'),
        ),
      ).toBe('handled');

      const [rows] = await db()<
        Array<{ payments: number; mirror: number; credit_accounts: number }>
      >`
      SELECT (SELECT count(*)::int FROM billing_invoice_payments WHERE account_id = ${c.accountId}::uuid) AS payments,
             (SELECT count(*)::int FROM subscriptions WHERE account_id = ${c.accountId}::uuid) AS mirror,
             (SELECT count(*)::int FROM credit_accounts WHERE account_id = ${c.accountId}::uuid) AS credit_accounts`;
      expect(rows).toEqual({ payments: 1, mirror: 1, credit_accounts: 0 });
      expect(await grantCounts(db(), c.accountId)).toEqual({ windows: 0, lots: 0, ledger: 0 });
    });

    it('CRITICAL RACE: both events for one payment are handled AT ONCE, on two connections, for twelve customers together. Every customer ends with one recorded payment and exactly one month', async () => {
      const stripeA = service(0, { credits: true });
      const stripeB = service(1, { credits: true });
      const customers: Customer[] = [];
      for (let i = 0; i < 12; i += 1) {
        const c = await newCustomer();
        await deliver(stripeA, subscriptionEvent(c, 'price_builder_m'));
        customers.push(c);
      }

      const outcomes = await Promise.all(
        customers.flatMap((c) => [
          deliver(
            stripeA,
            paidInvoiceEvent(
              c,
              'invoice.payment_succeeded',
              `in_${c.accountId}`,
              'price_builder_m',
            ),
          ),
          deliver(
            stripeB,
            paidInvoiceEvent(c, 'invoice.paid', `in_${c.accountId}`, 'price_builder_m'),
          ),
        ]),
      );
      expect(new Set(outcomes)).toEqual(new Set(['handled']));

      for (const c of customers) {
        expect(await grantCounts(db(), c.accountId), c.accountId).toEqual({
          windows: 1,
          lots: 1,
          ledger: 1,
        });
        const [spendable] = await db()<Array<{ micro: string }>>`
        SELECT coalesce(sum(remaining_micro - held_micro), 0)::text AS micro
          FROM credit_lots WHERE account_id = ${c.accountId}::uuid`;
        expect(spendable?.micro, c.accountId).toBe(String(10_000 * MICRO));
      }
    });
  },
);
