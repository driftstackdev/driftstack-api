// The billing receipt is unchanged by recording the paid invoice.
//
// `invoice.payment_succeeded` now writes a payment record before it sends the
// receipt, and reads far more of the invoice than it used to (its lines, its
// subscription, its payment references). None of that may change what a
// customer receives. Same email, same amount, same period text, same link, sent
// under the same conditions — and nothing new sent by the sibling `invoice.paid`
// event, which used to be ignored outright.
//
// ⛔ THIS FILE ASSERTS ONLY WHAT A CUSTOMER CAN SEE: emails and the account's
// plan. It says nothing about the payment record. That is deliberate: it means
// the very same file passes against the webhook service as it stood BEFORE the
// record existed, which is how "unchanged" was established rather than assumed.
//
// The central arm compares, it does not recite: a full invoice (lines,
// subscription, payment references, either payload shape) must produce a
// receipt IDENTICAL to the one produced by the same invoice stripped down to the
// handful of fields the receipt is built from.
//
// ⚠️ ONE THING DID CHANGE, ON PURPOSE (live-billing audit #12): the period. The
// receipt used to name the invoice's own top-level period, which on a renewal is
// the period that just ENDED — and this file pinned it: its second arm asserted
// "2026-02-01 – 2026-03-01" for a payment whose line is March, i.e. it asserted
// the defect. The receipt now names the paid LINE's period, the same one the
// payment record stores; the fields it is built from are therefore the line and
// the subscription link, and no longer the top-level period.

import { afterEach, describe, expect, it } from 'vitest';
import { signStripePayload } from '../../src/lib/stripe-signing.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import {
  INVOICE_SHAPES,
  buildInvoice,
  buildInvoiceEvent,
  sec,
  type InvoiceSpec,
  type PaidInvoiceEventType,
} from './_helpers/stripe-invoice-fixtures.js';

let fx: TestAppFixture;
let seq = 0;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const FEB_1 = sec('2026-02-01T00:00:00Z');
const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');

function spec(overrides: Partial<InvoiceSpec> = {}): InvoiceSpec {
  return {
    invoiceId: 'in_receipt',
    customerId: 'cus_test_default',
    subscriptionId: 'sub_1',
    amountPaid: 14900,
    paymentIntentId: 'pi_1',
    chargeId: 'ch_1',
    hostedInvoiceUrl: 'https://invoice.stripe.test/i/receipt',
    // The invoice's OWN period is February, the period that just ended; the
    // line is March, the period paid for — what the receipt names (audit #12).
    topLevelPeriod: { startSec: FEB_1, endSec: MAR_1 },
    lines: [
      {
        priceId: 'price_api_starter_monthly',
        amount: 14900,
        periodStartSec: MAR_1,
        periodEndSec: APR_1,
      },
    ],
    ...overrides,
  };
}

/** The same invoice reduced to the fields the receipt has always been built from. */
function stripped(invoice: Record<string, unknown>): Record<string, unknown> {
  // Audit #12: the period comes from the paid line — the lines and the
  // subscription link (`subscription` in the older shape, `parent` in the newer)
  // — and no longer from the invoice's own `period_start` / `period_end`.
  const keep = [
    'id',
    'customer',
    'amount_paid',
    'currency',
    'subscription',
    'parent',
    'lines',
    'hosted_invoice_url',
  ];
  return Object.fromEntries(keep.filter((k) => k in invoice).map((k) => [k, invoice[k]]));
}

async function post(
  type: PaidInvoiceEventType,
  invoice: Record<string, unknown>,
  eventId?: string,
): Promise<number> {
  seq += 1;
  const raw = JSON.stringify(
    buildInvoiceEvent({ eventId: eventId ?? `evt_receipt_${String(seq)}`, type, invoice }),
  );
  const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
  return res.statusCode;
}

type Sent = Array<{ template: string; to: string; vars: Record<string, unknown> }>;

/** Every email one delivery caused, on a fresh app. */
async function emailsFor(
  type: PaidInvoiceEventType,
  invoice: Record<string, unknown>,
): Promise<Sent> {
  fx = await buildTestApp({ tier: 'api_starter' });
  const before = fx.emailSends.length;
  expect(await post(type, invoice)).toBe(200);
  const sent = fx.emailSends.slice(before).map((s) => ({ ...s, vars: { ...s.vars } }));
  await fx.cleanup();
  return sent;
}

describe('the billing receipt is unchanged by recording the paid invoice', () => {
  it('CRITICAL a full invoice — lines, subscription, payment references, either payload shape — sends a receipt IDENTICAL to the same invoice stripped to the fields the receipt is built from', async () => {
    for (const shape of INVOICE_SHAPES) {
      const full = buildInvoice(shape, spec());
      const fromFull = await emailsFor('invoice.payment_succeeded', full);
      const fromStripped = await emailsFor('invoice.payment_succeeded', stripped(full));
      // Both apps seed the same account email, so `to` is comparable too.
      expect(
        fromFull.map((s) => ({ template: s.template, vars: s.vars })),
        shape,
      ).toEqual(fromStripped.map((s) => ({ template: s.template, vars: s.vars })));
      expect(
        fromFull.map((s) => s.template),
        shape,
      ).toEqual(['billing-receipt']);
    }
  });

  // Moved by live-billing audit #12: this arm asserted '2026-02-01 – 2026-03-01',
  // the invoice's own period — the period that ENDED before the payment it
  // receipts. That was the defect, pinned. The line's period is the right one.
  it('CRITICAL the receipt says the amount, the PAID LINE’S period (not the invoice’s own, which just ended) and the hosted invoice link', async () => {
    for (const shape of INVOICE_SHAPES) {
      const [receipt, ...rest] = await emailsFor(
        'invoice.payment_succeeded',
        buildInvoice(shape, spec()),
      );
      expect(rest, shape).toEqual([]);
      expect(receipt?.template, shape).toBe('billing-receipt');
      expect(receipt?.to, shape).toEqual(expect.stringContaining('@'));
      expect(receipt?.vars, shape).toEqual({
        amountFormatted: '$149.00',
        period: '2026-03-01 – 2026-04-01',
        invoiceUrl: 'https://invoice.stripe.test/i/receipt',
      });
    }
  });

  it('an invoice with no paid line, no period of its own and no hosted link falls back exactly as the stripped one does', async () => {
    const full = buildInvoice('newer', spec({ lines: [] }));
    delete full.period_start;
    delete full.period_end;
    delete full.hosted_invoice_url;
    const fromFull = await emailsFor('invoice.payment_succeeded', full);
    const fromStripped = await emailsFor('invoice.payment_succeeded', stripped(full));
    expect(fromFull.map((s) => s.vars)).toEqual(fromStripped.map((s) => s.vars));
    expect(fromFull).toHaveLength(1);
    // The fallback period is today's date, and the link is not the invoice's.
    expect(fromFull[0]?.vars.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fromFull[0]?.vars.invoiceUrl).not.toBe('https://invoice.stripe.test/i/receipt');
  });

  it('CRITICAL the conditions under which NO receipt is sent are the same: a $0 invoice, an opted-out account, an unknown customer, a missing field, a repeated event', async () => {
    const full = (overrides: Partial<InvoiceSpec> = {}): Record<string, unknown> =>
      buildInvoice('older', spec(overrides));

    expect(await emailsFor('invoice.payment_succeeded', full({ amountPaid: 0 }))).toEqual([]);
    expect(
      await emailsFor('invoice.payment_succeeded', full({ customerId: 'cus_nobody_here' })),
    ).toEqual([]);
    for (const field of ['id', 'customer', 'amount_paid', 'currency']) {
      const broken = full();
      delete broken[field];
      expect(await emailsFor('invoice.payment_succeeded', broken), field).toEqual([]);
    }

    // Opted out: the event is still acknowledged, and nothing is sent.
    fx = await buildTestApp({ tier: 'api_starter' });
    const optOut = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { event_type: 'billing-receipt', opted_in: false },
    });
    expect(optOut.statusCode).toBe(204);
    let before = fx.emailSends.length;
    expect(await post('invoice.payment_succeeded', full())).toBe(200);
    expect(fx.emailSends.slice(before)).toEqual([]);
    await fx.cleanup();

    // The same event delivered three times: one receipt.
    fx = await buildTestApp({ tier: 'api_starter' });
    before = fx.emailSends.length;
    for (let i = 0; i < 3; i += 1) {
      expect(await post('invoice.payment_succeeded', full(), 'evt_receipt_repeated')).toBe(200);
    }
    expect(fx.emailSends.slice(before).map((s) => s.template)).toEqual(['billing-receipt']);
  });

  it('CRITICAL invoice.paid sends the customer NOTHING — alone, before, or after invoice.payment_succeeded — so one paid invoice is still one receipt', async () => {
    for (const shape of INVOICE_SHAPES) {
      expect(await emailsFor('invoice.paid', buildInvoice(shape, spec())), shape).toEqual([]);
    }
    for (const order of [
      ['invoice.paid', 'invoice.payment_succeeded'],
      ['invoice.payment_succeeded', 'invoice.paid'],
    ] as const) {
      fx = await buildTestApp({ tier: 'api_starter' });
      const before = fx.emailSends.length;
      const invoice = buildInvoice('older', spec());
      for (const type of order) expect(await post(type, invoice)).toBe(200);
      expect(
        fx.emailSends.slice(before).map((s) => s.template),
        order.join(' then '),
      ).toEqual(['billing-receipt']);
      await fx.cleanup();
    }
  });

  it('CRITICAL a paid invoice never moves the account’s plan or its subscription mirror, whatever plan its line names', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    const scale = buildInvoice(
      'older',
      spec({
        lines: [
          {
            priceId: 'price_api_scale_monthly',
            amount: 149900,
            periodStartSec: MAR_1,
            periodEndSec: APR_1,
          },
        ],
      }),
    );
    for (const type of ['invoice.payment_succeeded', 'invoice.paid'] as const) {
      expect(await post(type, scale)).toBe(200);
    }
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_starter');
    expect(fx.stripeWebhooksRepo.listSubscriptions()).toEqual([]);
    expect(fx.emailSends.filter((s) => s.template === 'tier-changed')).toEqual([]);
  });
});
