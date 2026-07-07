// S44 2026-07-07 (founder-approved) — invoice.payment_succeeded →
// billing-receipt + invoice.payment_failed → billing-failure email
// dispatch (the TD-001 revival).
//
// Asserts that:
//   1. A well-formed invoice.payment_succeeded event fires the
//      `billing-receipt` email via the lifecycle dispatcher, with the
//      amount / period / hosted-invoice-url decoded from the payload.
//   2. The receipt honors the V-204 `billing-receipt` opt-out (send
//      suppressed, event still 200 'handled').
//   3. Zero-amount invoices (trial starts, 100% discounts) send NO
//      receipt.
//   4. invoice.payment_failed fires the `billing-failure` email
//      unconditionally — billing-failure is NOT in the opt-outable
//      enum (the PUT rejects it with 400), so there is no preference
//      a customer could set that suppresses it.
//   5. next_payment_attempt is passed through when present and null
//      on the final dunning attempt (the template copy adapts).
//   6. A duplicate event.id short-circuits at the processed_stripe_
//      events ledger → outcome 'duplicate', exactly ONE email total.
//   7. Unknown customers are ignored (200 'handled', no email).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signStripePayload } from '../../src/lib/stripe-signing.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildPaymentSucceededEvent(args: {
  eventId: string;
  invoiceId: string;
  stripeCustomerId: string;
  amountPaid: number;
  currency: string;
  hostedInvoiceUrl?: string;
  periodStartSec?: number;
  periodEndSec?: number;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: 'invoice.payment_succeeded',
    api_version: '2024-12-18.acacia',
    created: nowSec(),
    livemode: false,
    data: {
      object: {
        id: args.invoiceId,
        customer: args.stripeCustomerId,
        amount_paid: args.amountPaid,
        currency: args.currency,
        ...(args.hostedInvoiceUrl !== undefined
          ? { hosted_invoice_url: args.hostedInvoiceUrl }
          : {}),
        ...(args.periodStartSec !== undefined ? { period_start: args.periodStartSec } : {}),
        ...(args.periodEndSec !== undefined ? { period_end: args.periodEndSec } : {}),
      },
    },
  });
}

function buildPaymentFailedEvent(args: {
  eventId: string;
  invoiceId: string;
  stripeCustomerId: string;
  amountDue: number;
  currency: string;
  nextPaymentAttemptSec?: number | null;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: 'invoice.payment_failed',
    api_version: '2024-12-18.acacia',
    created: nowSec(),
    livemode: false,
    data: {
      object: {
        id: args.invoiceId,
        customer: args.stripeCustomerId,
        amount_due: args.amountDue,
        currency: args.currency,
        // Stripe sends an explicit null on the final attempt.
        next_payment_attempt: args.nextPaymentAttemptSec ?? null,
      },
    },
  });
}

async function postEvent(
  fx: TestAppFixture,
  raw: string,
): Promise<{ statusCode: number; body: { outcome: string } }> {
  const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('S44 — invoice.payment_succeeded → billing-receipt email', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('dispatches the receipt with amount/period/invoice-url decoded from the payload (default opt-in)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;

    const periodStart = Date.UTC(2026, 5, 7) / 1000; // 2026-06-07
    const periodEnd = Date.UTC(2026, 6, 7) / 1000; // 2026-07-07
    const result = await postEvent(
      fx,
      buildPaymentSucceededEvent({
        eventId: 'evt_pay_ok_001',
        invoiceId: 'in_ok_001',
        stripeCustomerId: 'cus_test_default',
        amountPaid: 14900,
        currency: 'usd',
        hostedInvoiceUrl: 'https://invoice.stripe.test/i/abc',
        periodStartSec: periodStart,
        periodEndSec: periodEnd,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');

    const receipts = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.to).toBeDefined();
    expect(receipts[0]!.vars.amountFormatted).toBe('$149.00');
    expect(receipts[0]!.vars.period).toBe('2026-06-07 – 2026-07-07');
    expect(receipts[0]!.vars.invoiceUrl).toBe('https://invoice.stripe.test/i/abc');
  });

  it('suppresses the receipt when the account opted out of billing-receipt (event still handled)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    const optOut = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { event_type: 'billing-receipt', opted_in: false },
    });
    expect(optOut.statusCode).toBe(204);

    const beforeCount = fx.emailSends.length;
    const result = await postEvent(
      fx,
      buildPaymentSucceededEvent({
        eventId: 'evt_pay_ok_002',
        invoiceId: 'in_ok_002',
        stripeCustomerId: 'cus_test_default',
        amountPaid: 14900,
        currency: 'usd',
        hostedInvoiceUrl: 'https://invoice.stripe.test/i/def',
      }),
    );
    expect(result.body.outcome).toBe('handled');

    const receipts = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-receipt');
    expect(receipts).toHaveLength(0);
  });

  it('zero-amount invoice (trial start / 100% discount) sends NO receipt', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const result = await postEvent(
      fx,
      buildPaymentSucceededEvent({
        eventId: 'evt_pay_ok_003',
        invoiceId: 'in_ok_003',
        stripeCustomerId: 'cus_test_default',
        amountPaid: 0,
        currency: 'usd',
      }),
    );
    expect(result.body.outcome).toBe('handled');
    expect(
      fx.emailSends.slice(beforeCount).filter((s) => s.template === 'billing-receipt'),
    ).toHaveLength(0);
  });

  it('duplicate event.id = exactly one receipt (ledger short-circuit → outcome duplicate)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const raw = buildPaymentSucceededEvent({
      eventId: 'evt_pay_ok_dup',
      invoiceId: 'in_ok_dup',
      stripeCustomerId: 'cus_test_default',
      amountPaid: 4999,
      currency: 'eur',
      hostedInvoiceUrl: 'https://invoice.stripe.test/i/dup',
    });

    const first = await postEvent(fx, raw);
    expect(first.body.outcome).toBe('handled');
    const second = await postEvent(fx, raw);
    expect(second.body.outcome).toBe('duplicate');

    const receipts = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.vars.amountFormatted).toBe('€49.99');
  });

  it('unknown customer → 200 handled, no receipt', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const result = await postEvent(
      fx,
      buildPaymentSucceededEvent({
        eventId: 'evt_pay_ok_004',
        invoiceId: 'in_ok_004',
        stripeCustomerId: 'cus_unknown_xxx',
        amountPaid: 14900,
        currency: 'usd',
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');
    expect(
      fx.emailSends.slice(beforeCount).filter((s) => s.template === 'billing-receipt'),
    ).toHaveLength(0);
  });
});

describe('S44 — invoice.payment_failed → billing-failure email (never opt-outable)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('dispatches the failure notice with the retry timestamp when Stripe schedules one', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;

    const retrySec = nowSec() + 3 * 24 * 60 * 60;
    const result = await postEvent(
      fx,
      buildPaymentFailedEvent({
        eventId: 'evt_pay_fail_001',
        invoiceId: 'in_fail_001',
        stripeCustomerId: 'cus_test_default',
        amountDue: 14900,
        currency: 'usd',
        nextPaymentAttemptSec: retrySec,
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');

    const failures = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.vars.amountFormatted).toBe('$149.00');
    expect(failures[0]!.vars.retryAt).toBeInstanceOf(Date);
    expect((failures[0]!.vars.retryAt as Date).getTime()).toBe(retrySec * 1000);
  });

  it('final dunning attempt (next_payment_attempt null) still sends, with retryAt null', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const result = await postEvent(
      fx,
      buildPaymentFailedEvent({
        eventId: 'evt_pay_fail_002',
        invoiceId: 'in_fail_002',
        stripeCustomerId: 'cus_test_default',
        amountDue: 14900,
        currency: 'usd',
        nextPaymentAttemptSec: null,
      }),
    );
    expect(result.body.outcome).toBe('handled');

    const failures = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.vars.retryAt).toBeNull();
  });

  it('billing-failure CANNOT be opted out of: the preference PUT rejects it (400), and the email still sends after every other billing opt-out is set', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // The enum rejects billing-failure outright — there is no stored
    // preference a customer could create for it.
    const attempt = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { event_type: 'billing-failure', opted_in: false },
    });
    expect(attempt.statusCode).toBe(400);

    // Opt out of everything billing-related that IS opt-outable, to
    // prove none of those preferences gates the failure notice.
    for (const eventType of ['billing-receipt', 'billing-renewal-reminder'] as const) {
      const res = await fx.app.inject({
        method: 'PUT',
        url: '/v1/account/email-preferences',
        headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
        payload: { event_type: eventType, opted_in: false },
      });
      expect(res.statusCode).toBe(204);
    }

    const beforeCount = fx.emailSends.length;
    const result = await postEvent(
      fx,
      buildPaymentFailedEvent({
        eventId: 'evt_pay_fail_003',
        invoiceId: 'in_fail_003',
        stripeCustomerId: 'cus_test_default',
        amountDue: 9900,
        currency: 'usd',
        nextPaymentAttemptSec: nowSec() + 24 * 60 * 60,
      }),
    );
    expect(result.body.outcome).toBe('handled');

    const failures = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-failure');
    expect(failures).toHaveLength(1);
  });

  it('duplicate event.id = exactly one failure notice', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const raw = buildPaymentFailedEvent({
      eventId: 'evt_pay_fail_dup',
      invoiceId: 'in_fail_dup',
      stripeCustomerId: 'cus_test_default',
      amountDue: 14900,
      currency: 'usd',
      nextPaymentAttemptSec: nowSec() + 24 * 60 * 60,
    });
    const first = await postEvent(fx, raw);
    expect(first.body.outcome).toBe('handled');
    const second = await postEvent(fx, raw);
    expect(second.body.outcome).toBe('duplicate');
    expect(
      fx.emailSends.slice(beforeCount).filter((s) => s.template === 'billing-failure'),
    ).toHaveLength(1);
  });

  it('unknown customer → 200 handled, no failure notice', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const result = await postEvent(
      fx,
      buildPaymentFailedEvent({
        eventId: 'evt_pay_fail_004',
        invoiceId: 'in_fail_004',
        stripeCustomerId: 'cus_unknown_xxx',
        amountDue: 14900,
        currency: 'usd',
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');
    expect(
      fx.emailSends.slice(beforeCount).filter((s) => s.template === 'billing-failure'),
    ).toHaveLength(0);
  });
});
