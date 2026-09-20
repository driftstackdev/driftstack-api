// The receipt is not sent until the paid invoice is recorded — and a Stripe
// retry then does both, exactly once each.
//
// `invoice.payment_succeeded` does two things: it records the payment, and it
// sends the customer a receipt. They must happen in THAT order. If the receipt
// went first and the write then failed, the customer would hold a receipt for a
// payment this server never recorded; the retry would record it and — because
// the send-once claim is keyed on the event id — could never send a second
// receipt, so the ordering would be unobservable afterwards. Record first, and a
// failed write leaves NOTHING a customer can see; Stripe's retry does both.
//
// How the webhook service makes that true, which these arms drive end to end
// through the real route:
//
//   · a TRANSIENT failure (a database blip) is rethrown by dispatch(): the route
//     answers 500, no `processed_stripe_events` row is written, Stripe retries;
//   · a PERMANENT failure is recorded as `error:<name>` with a 200, so Stripe
//     stops — and still nothing went to the customer.
//
// The write is failed by wrapping the repo's `upsertInvoicePayment`, which is the
// one call the handler makes to record the payment.

import { afterEach, describe, expect, it } from 'vitest';
import { signStripePayload } from '../../src/lib/stripe-signing.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { buildInvoice, buildInvoiceEvent, sec } from './_helpers/stripe-invoice-fixtures.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');

function paidInvoice(invoiceId: string, amountPaid = 49900): Record<string, unknown> {
  return buildInvoice('older', {
    invoiceId,
    customerId: 'cus_test_default',
    subscriptionId: 'sub_1',
    amountPaid,
    hostedInvoiceUrl: 'https://invoice.stripe.test/i/order',
    lines: [
      {
        priceId: 'price_api_builder_monthly',
        amount: amountPaid,
        periodStartSec: MAR_1,
        periodEndSec: APR_1,
      },
    ],
  });
}

/** Deliver one event, byte-identical on every call: what a Stripe retry sends. */
function delivery(
  eventId: string,
  type: 'invoice.payment_succeeded' | 'invoice.paid',
  invoice: Record<string, unknown>,
): () => Promise<{ statusCode: number; outcome: string | undefined }> {
  const raw = JSON.stringify(
    buildInvoiceEvent({ eventId, type, invoice, createdSec: MAR_1 + 4000 }),
  );
  return async () => {
    const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload: raw,
    });
    return {
      statusCode: res.statusCode,
      outcome: res.json<{ outcome?: string }>().outcome,
    };
  };
}

/** Make the next `times` payment-row writes fail with `error`; later ones go through. */
function failNextWrites(times: number, error: Error): { attempts: () => number } {
  const repo = fx.stripeWebhooksRepo;
  const real = repo.upsertInvoicePayment.bind(repo);
  let attempts = 0;
  repo.upsertInvoicePayment = (args) => {
    attempts += 1;
    return attempts <= times ? Promise.reject(error) : real(args);
  };
  return { attempts: () => attempts };
}

function receipts(): TestAppFixture['emailSends'] {
  return fx.emailSends.filter((s) => s.template === 'billing-receipt');
}

function ledgerHas(eventId: string): boolean {
  return fx.stripeWebhooksRepo.list().some((e) => e.eventId === eventId);
}

const TRANSIENT_FAILURES: Array<[string, Error]> = [
  ['a dropped connection', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  [
    'a Postgres connection failure (SQLSTATE 08006)',
    Object.assign(new Error('connection failure'), { code: '08006' }),
  ],
  [
    'a lock timeout wrapped by the query layer',
    Object.assign(new Error('Failed query: insert into "billing_invoice_payments"'), {
      cause: Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      }),
    }),
  ],
];

describe('the receipt is not sent until the paid invoice is recorded', () => {
  for (const [what, error] of TRANSIENT_FAILURES) {
    it(`CRITICAL when recording the payment fails with ${what}: no receipt, no ledger row, a 500 — and Stripe’s retry records it and sends exactly ONE receipt`, async () => {
      fx = await buildTestApp({ tier: 'api_builder' });
      const before = receipts().length;
      const failing = failNextWrites(1, error);
      const deliver = delivery(
        'evt_order_1',
        'invoice.payment_succeeded',
        paidInvoice('in_order_1'),
      );

      // Delivery 1 — the write fails.
      const first = await deliver();
      expect(first.statusCode, 'a transient failure must not be acknowledged').toBe(500);
      expect(failing.attempts(), 'the payment write was never attempted').toBe(1);
      expect(receipts().length, 'a receipt went out for a payment that was not recorded').toBe(
        before,
      );
      expect(fx.stripeWebhooksRepo.listInvoicePayments()).toEqual([]);
      expect(
        ledgerHas('evt_order_1'),
        'the event was marked processed, so Stripe would not retry',
      ).toBe(false);

      // Delivery 2 — Stripe's retry of the SAME event.
      expect(await deliver()).toEqual({ statusCode: 200, outcome: 'handled' });
      expect(fx.stripeWebhooksRepo.listInvoicePayments().map((p) => p.stripeInvoiceId)).toEqual([
        'in_order_1',
      ]);
      expect(receipts().length).toBe(before + 1);
      expect(receipts().at(-1)?.vars.amountFormatted).toBe('$499.00');

      // Delivery 3 — and a further retry changes nothing.
      expect(await deliver()).toEqual({ statusCode: 200, outcome: 'duplicate' });
      expect(fx.stripeWebhooksRepo.listInvoicePayments()).toHaveLength(1);
      expect(receipts().length, 'a retry sent a second receipt').toBe(before + 1);
    });
  }

  it('CRITICAL a write that keeps failing keeps the receipt back, however many times Stripe retries; the first retry that records the payment sends the one receipt', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const before = receipts().length;
    failNextWrites(3, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const deliver = delivery('evt_order_2', 'invoice.payment_succeeded', paidInvoice('in_order_2'));
    for (let i = 0; i < 3; i += 1) {
      expect((await deliver()).statusCode).toBe(500);
      expect(receipts().length).toBe(before);
    }
    expect((await deliver()).outcome).toBe('handled');
    expect(receipts().length).toBe(before + 1);
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toHaveLength(1);
  });

  it('CRITICAL a PERMANENT failure of the write is recorded as an error and acknowledged, so Stripe stops retrying — and still no receipt goes out for a payment that was never recorded', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const before = receipts().length;
    failNextWrites(1, new TypeError('a deterministic bug'));
    const deliver = delivery('evt_order_3', 'invoice.payment_succeeded', paidInvoice('in_order_3'));

    expect(await deliver()).toEqual({ statusCode: 200, outcome: 'error:typeerror' });
    expect(receipts().length).toBe(before);
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toEqual([]);
    expect(ledgerHas('evt_order_3')).toBe(true);
    // The event is now a duplicate: the receipt is not sent late, either.
    expect((await deliver()).outcome).toBe('duplicate');
    expect(receipts().length).toBe(before);
  });

  it('a $0 invoice is held to the same order: its write is attempted BEFORE the zero-amount return, so a failed write is retried rather than silently skipped', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const failing = failNextWrites(
      1,
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    );
    const deliver = delivery(
      'evt_order_4',
      'invoice.payment_succeeded',
      paidInvoice('in_order_4', 0),
    );
    expect((await deliver()).statusCode).toBe(500);
    expect(failing.attempts(), 'the $0 invoice returned before its payment was written').toBe(1);
    expect((await deliver()).outcome).toBe('handled');
    expect(fx.stripeWebhooksRepo.listInvoicePayments().map((p) => p.amountPaidMinor)).toEqual([0]);
  });

  it('invoice.paid retries the same way, and never sends a receipt on either attempt', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const before = receipts().length;
    failNextWrites(1, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const deliver = delivery('evt_order_5', 'invoice.paid', paidInvoice('in_order_5'));
    expect((await deliver()).statusCode).toBe(500);
    expect(ledgerHas('evt_order_5')).toBe(false);
    expect(await deliver()).toEqual({ statusCode: 200, outcome: 'handled' });
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toHaveLength(1);
    expect(receipts().length).toBe(before);
  });

  it('control: with nothing failing, one delivery records the payment and sends the receipt — so the arms above fail for the write, not for the fixture', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const before = receipts().length;
    const deliver = delivery('evt_order_6', 'invoice.payment_succeeded', paidInvoice('in_order_6'));
    expect(await deliver()).toEqual({ statusCode: 200, outcome: 'handled' });
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toHaveLength(1);
    expect(receipts().length).toBe(before + 1);
  });
});
