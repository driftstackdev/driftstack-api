// A paid invoice records its subscription line's period and plan — through the
// real webhook route, signature and all.
//
// `invoice.payment_succeeded` and `invoice.paid` each write one
// `billing_invoice_payments` row per invoice. The row is the only evidence that a
// billing period was PAID for, so what it says has to be what the customer paid
// for: the period of the invoice's subscription line, never the invoice's own
// top-level period (on a renewal that is the period that just ended).
//
// Every fixture invoice carries a top-level period that is NOT its line's, so a
// handler that recorded the wrong one fails every arm here, not only the one
// written for it. The same top-level period is still what the RECEIPT shows, as
// it always has — see the arm that holds both at once.

import { afterEach, describe, expect, it } from 'vitest';
import { signStripePayload } from '../../src/lib/stripe-signing.js';
import type { InvoicePaymentRecord } from '../../src/lib/invoice-payment-record.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import {
  INVOICE_SHAPES,
  buildInvoice,
  buildInvoiceEvent,
  sec,
  type InvoiceSpec,
  type PaidInvoiceEventType,
} from './_helpers/stripe-invoice-fixtures.js';

const MAR_1 = sec('2026-03-01T00:00:00Z');
const MAR_17 = sec('2026-03-17T09:30:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');
const MAR_1_2027 = sec('2027-03-01T00:00:00Z');

let fx: TestAppFixture;
let seq = 0;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

function renewal(overrides: Partial<InvoiceSpec> = {}): InvoiceSpec {
  return {
    invoiceId: 'in_renewal',
    customerId: 'cus_test_default',
    subscriptionId: 'sub_1',
    billingReason: 'subscription_cycle',
    amountPaid: 49900,
    paymentIntentId: 'pi_1',
    chargeId: 'ch_1',
    paidAtSec: MAR_1 + 3700,
    hostedInvoiceUrl: 'https://invoice.stripe.test/i/renewal',
    lines: [
      {
        priceId: 'price_api_builder_monthly',
        amount: 49900,
        periodStartSec: MAR_1,
        periodEndSec: APR_1,
      },
    ],
    ...overrides,
  };
}

async function post(
  type: PaidInvoiceEventType,
  invoice: Record<string, unknown>,
  eventId?: string,
): Promise<{ statusCode: number; outcome: string }> {
  seq += 1;
  const raw = JSON.stringify(
    buildInvoiceEvent({ eventId: eventId ?? `evt_paid_${String(seq)}`, type, invoice }),
  );
  const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
  return { statusCode: res.statusCode, outcome: res.json<{ outcome: string }>().outcome };
}

/** A recorded payment with Dates as ISO strings, so a diff reads. */
function readable(record: InvoicePaymentRecord): Record<string, unknown> {
  return {
    ...record,
    paidAt: record.paidAt.toISOString(),
    line:
      record.line === null
        ? null
        : {
            ...record.line,
            periodStart: record.line.periodStart.toISOString(),
            periodEnd: record.line.periodEnd.toISOString(),
          },
  };
}

function payments(): Array<Record<string, unknown>> {
  return fx.stripeWebhooksRepo.listInvoicePayments().map(readable);
}

function receipts(): TestAppFixture['emailSends'] {
  return fx.emailSends.filter((s) => s.template === 'billing-receipt');
}

describe('a paid invoice records its subscription line’s period and plan', () => {
  it('CRITICAL a paid renewal is recorded with its LINE’s period, plan and interval, its subscription, its payment references and when it was paid — in both payload shapes', async () => {
    for (const shape of INVOICE_SHAPES) {
      fx = await buildTestApp({ tier: 'api_builder' });
      const result = await post('invoice.payment_succeeded', buildInvoice(shape, renewal()));
      expect(result, shape).toEqual({ statusCode: 200, outcome: 'handled' });
      expect(payments(), shape).toEqual([
        {
          stripeInvoiceId: 'in_renewal',
          accountId: fx.accountId,
          stripeSubscriptionId: 'sub_1',
          billingReason: 'subscription_cycle',
          amountPaidMinor: 49900,
          currency: 'usd',
          stripePaymentIntentId: 'pi_1',
          stripeChargeId: 'ch_1',
          line: {
            kind: 'period',
            stripePriceId: 'price_api_builder_monthly',
            tier: 'api_builder',
            interval: 'month',
            periodStart: '2026-03-01T00:00:00.000Z',
            periodEnd: '2026-04-01T00:00:00.000Z',
          },
          paidAt: new Date((MAR_1 + 3700) * 1000).toISOString(),
        },
      ]);
      await fx.cleanup();
    }
  });

  it('CRITICAL a $0 invoice is recorded. It was paid — a 100% discount, a plan change that nets to nothing — and it still sends no receipt', async () => {
    for (const shape of INVOICE_SHAPES) {
      fx = await buildTestApp({ tier: 'api_builder' });
      const before = receipts().length;
      const result = await post(
        'invoice.payment_succeeded',
        buildInvoice(shape, renewal({ invoiceId: 'in_zero', amountPaid: 0 })),
      );
      expect(result, shape).toEqual({ statusCode: 200, outcome: 'handled' });
      expect(payments(), shape).toMatchObject([
        {
          stripeInvoiceId: 'in_zero',
          amountPaidMinor: 0,
          line: { kind: 'period', tier: 'api_builder', periodStart: '2026-03-01T00:00:00.000Z' },
        },
      ]);
      expect(receipts().length, `${shape}: a $0 receipt was sent`).toBe(before);
      await fx.cleanup();
    }
  });

  it('CRITICAL the invoice’s top-level period is never used for the record — while the receipt goes on showing it, exactly as before', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const before = receipts().length;
    // Top-level: FEBRUARY (the period that just ended). Line: MARCH.
    const invoice = buildInvoice(
      'older',
      renewal({ topLevelPeriod: { startSec: sec('2026-02-01T00:00:00Z'), endSec: MAR_1 } }),
    );
    await post('invoice.payment_succeeded', invoice);

    expect(payments()).toMatchObject([
      {
        line: {
          periodStart: '2026-03-01T00:00:00.000Z',
          periodEnd: '2026-04-01T00:00:00.000Z',
        },
      },
    ]);
    const sent = receipts().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.vars.period).toBe('2026-02-01 – 2026-03-01');
  });

  it('CRITICAL invoice.paid records the payment and sends NOTHING; both events for one invoice leave one row and one receipt', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const before = receipts().length;
    const invoice = buildInvoice('older', renewal());

    expect(await post('invoice.paid', invoice)).toEqual({ statusCode: 200, outcome: 'handled' });
    expect(payments()).toHaveLength(1);
    expect(receipts().length, 'invoice.paid sent a receipt').toBe(before);

    expect(await post('invoice.payment_succeeded', invoice)).toEqual({
      statusCode: 200,
      outcome: 'handled',
    });
    // And in the other order, for a second invoice.
    const second = buildInvoice('newer', renewal({ invoiceId: 'in_second' }));
    await post('invoice.payment_succeeded', second);
    await post('invoice.paid', second);

    expect(payments().map((p) => p.stripeInvoiceId)).toEqual(['in_renewal', 'in_second']);
    expect(receipts().length).toBe(before + 2);
  });

  it('an annual price is recorded as yearly, with the year-long period of its line', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await post(
      'invoice.payment_succeeded',
      buildInvoice(
        'newer',
        renewal({
          invoiceId: 'in_annual',
          amountPaid: 479000,
          lines: [
            {
              priceId: 'price_api_builder_annual',
              amount: 479000,
              periodStartSec: MAR_1,
              periodEndSec: MAR_1_2027,
            },
          ],
        }),
      ),
    );
    expect(payments()).toMatchObject([
      {
        line: {
          kind: 'period',
          tier: 'api_builder',
          interval: 'year',
          periodStart: '2026-03-01T00:00:00.000Z',
          periodEnd: '2027-03-01T00:00:00.000Z',
        },
      },
    ]);
  });

  it('a paid plan-change invoice records the positive proration line: the rest of the period on the new plan', async () => {
    for (const shape of INVOICE_SHAPES) {
      fx = await buildTestApp({ tier: 'api_starter' });
      await post(
        'invoice.payment_succeeded',
        buildInvoice(
          shape,
          renewal({
            invoiceId: 'in_upgrade',
            billingReason: 'subscription_update',
            amountPaid: 63000,
            lines: [
              {
                priceId: 'price_api_starter_monthly',
                amount: -7000,
                proration: true,
                periodStartSec: MAR_17,
                periodEndSec: APR_1,
              },
              {
                priceId: 'price_api_scale_monthly',
                amount: 70000,
                proration: true,
                periodStartSec: MAR_17,
                periodEndSec: APR_1,
              },
            ],
          }),
        ),
      );
      expect(payments(), shape).toMatchObject([
        {
          billingReason: 'subscription_update',
          line: {
            kind: 'proration_up',
            tier: 'api_scale',
            periodStart: '2026-03-17T09:30:00.000Z',
            periodEnd: '2026-04-01T00:00:00.000Z',
          },
        },
      ]);
      await fx.cleanup();
    }
  });

  it('a price the configuration does not name is recorded with its period and no plan', async () => {
    fx = await buildTestApp({ tier: 'enterprise' });
    await post(
      'invoice.payment_succeeded',
      buildInvoice(
        'older',
        renewal({
          invoiceId: 'in_custom',
          lines: [
            {
              priceId: 'price_custom_contract',
              amount: 49900,
              periodStartSec: MAR_1,
              periodEndSec: APR_1,
            },
          ],
        }),
      ),
    );
    expect(payments()).toMatchObject([
      {
        stripeInvoiceId: 'in_custom',
        line: {
          kind: 'period',
          stripePriceId: 'price_custom_contract',
          tier: null,
          interval: null,
        },
      },
    ]);
  });

  it('an invoice for a customer who is no account here, or one missing what identifies it, records nothing', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    for (const type of ['invoice.payment_succeeded', 'invoice.paid'] as const) {
      const stranger = buildInvoice('older', renewal({ customerId: 'cus_nobody_here' }));
      expect((await post(type, stranger)).outcome).toBe('handled');
      for (const field of ['id', 'customer', 'amount_paid', 'currency']) {
        const broken = buildInvoice('older', renewal());
        delete broken[field];
        expect((await post(type, broken)).outcome, `${type} without ${field}`).toBe('handled');
      }
    }
    expect(payments()).toEqual([]);
  });

  it('an amount paid that is not a whole non-negative number is not recorded as one', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    for (const amount of [12.5, -100]) {
      const invoice = buildInvoice('older', renewal({ invoiceId: `in_amount_${String(amount)}` }));
      invoice.amount_paid = amount;
      expect((await post('invoice.paid', invoice)).outcome).toBe('handled');
    }
    expect(payments()).toEqual([]);
  });
});
