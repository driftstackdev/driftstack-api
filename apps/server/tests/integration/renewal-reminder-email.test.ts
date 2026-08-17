// V-327 — invoice.upcoming → renewal-reminder email dispatch.
//
// Asserts that:
//   1. A well-formed invoice.upcoming event triggers the
//      `billing-renewal-reminder` email send via the lifecycle
//      dispatcher.
//   2. Opt-out via the email-preferences endpoint suppresses the
//      send while still returning 200 'handled'.
//   3. invoice.upcoming with an unknown customer is silently
//      ignored (returns 200 'handled', no email).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signStripePayload } from '../../src/lib/stripe-signing.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildInvoiceUpcomingEvent(args: {
  eventId: string;
  invoiceId: string;
  stripeCustomerId: string;
  amountDue: number;
  currency: string;
  nextPaymentAttemptSec: number;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: 'invoice.upcoming',
    api_version: '2024-12-18.acacia',
    created: nowSec(),
    livemode: false,
    data: {
      object: {
        id: args.invoiceId,
        customer: args.stripeCustomerId,
        amount_due: args.amountDue,
        currency: args.currency,
        next_payment_attempt: args.nextPaymentAttemptSec,
      },
    },
  });
}

async function postEvent(
  fx: TestAppFixture,
  raw: string,
): Promise<{
  statusCode: number;
  body: { outcome: string };
}> {
  const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('V-327 — invoice.upcoming → renewal-reminder email', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('dispatches the renewal-reminder email when account opts in (default)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;

    const raw = buildInvoiceUpcomingEvent({
      eventId: 'evt_invoice_upcoming_001',
      invoiceId: 'in_001',
      stripeCustomerId: 'cus_test_default',
      amountDue: 14900, // $149.00
      currency: 'usd',
      nextPaymentAttemptSec: nowSec() + 7 * 24 * 60 * 60,
    });
    const result = await postEvent(fx, raw);

    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');

    const newSends = fx.emailSends.slice(beforeCount);
    const renewalSends = newSends.filter((s) => s.template === 'billing-renewal-reminder');
    expect(renewalSends).toHaveLength(1);
    expect(renewalSends[0]!.to).toBeDefined();
    expect(renewalSends[0]!.vars.amountFormatted).toBe('$149.00');
  });

  it('formats EUR with €', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const raw = buildInvoiceUpcomingEvent({
      eventId: 'evt_invoice_upcoming_002',
      invoiceId: 'in_002',
      stripeCustomerId: 'cus_test_default',
      amountDue: 4999,
      currency: 'eur',
      nextPaymentAttemptSec: nowSec() + 7 * 24 * 60 * 60,
    });
    await postEvent(fx, raw);
    const newSends = fx.emailSends.slice(beforeCount);
    const renewalSends = newSends.filter((s) => s.template === 'billing-renewal-reminder');
    expect(renewalSends[0]!.vars.amountFormatted).toBe('€49.99');
  });

  it('formats JPY without decimals', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const raw = buildInvoiceUpcomingEvent({
      eventId: 'evt_invoice_upcoming_003',
      invoiceId: 'in_003',
      stripeCustomerId: 'cus_test_default',
      amountDue: 12000,
      currency: 'jpy',
      nextPaymentAttemptSec: nowSec() + 7 * 24 * 60 * 60,
    });
    await postEvent(fx, raw);
    const newSends = fx.emailSends.slice(beforeCount);
    const renewalSends = newSends.filter((s) => s.template === 'billing-renewal-reminder');
    expect(renewalSends[0]!.vars.amountFormatted).toBe('12,000 JPY');
  });

  // JPY above proves the zero-decimal BRANCH. It does not prove the SET is
  // consulted: rewrite formatCents as `if (code === 'JPY')` and that arm still
  // passes while the other fifteen currencies silently divide by 100. A customer
  // billed ₩120,000 would be emailed "1,200.00 KRW" — understated a hundredfold,
  // in the one message whose entire job is telling them what they are about to
  // be charged.
  it('CRITICAL a zero-decimal currency OTHER than JPY also skips the decimals', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const raw = buildInvoiceUpcomingEvent({
      eventId: 'evt_invoice_upcoming_krw',
      invoiceId: 'in_krw',
      stripeCustomerId: 'cus_test_default',
      amountDue: 120000,
      currency: 'krw',
      nextPaymentAttemptSec: nowSec() + 7 * 24 * 60 * 60,
    });
    await postEvent(fx, raw);
    const sends = fx.emailSends
      .slice(beforeCount)
      .filter((s) => s.template === 'billing-renewal-reminder');
    expect(
      sends[0]!.vars.amountFormatted,
      'a zero-decimal currency other than JPY was divided by 100 — the renewal email understates ' +
        'the charge by a hundredfold',
    ).toBe('120,000 KRW');
  });

  // Membership drift is the other half, and it moves money in BOTH directions:
  // a currency dropped from the set is understated 100x, one wrongly added is
  // overstated 100x. The list is not ours — it is Stripe's published
  // zero-decimal set (stripe.com/docs/currencies#zero-decimal) — so it is pinned
  // exactly rather than sampled, and read from the source so the check cannot
  // drift away from the code it describes.
  it('CRITICAL the zero-decimal set is exactly Stripe’s published list', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/services/account-lifecycle.ts'),
      'utf8',
    );
    const block = /ZERO_DEC\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(
      block,
      'the zero-decimal set could not be located in account-lifecycle.ts',
    ).not.toBeNull();
    const members = [...(block?.[1] ?? '').matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]!).sort();
    expect(
      members,
      'the zero-decimal currency set no longer matches Stripe’s published list. Adding a currency ' +
        'that HAS decimals overstates every amount in it by 100x; dropping one that does not ' +
        'understates by 100x. Re-check against stripe.com/docs/currencies#zero-decimal before ' +
        'changing this',
    ).toEqual([
      'BIF',
      'CLP',
      'DJF',
      'GNF',
      'JPY',
      'KMF',
      'KRW',
      'MGA',
      'PYG',
      'RWF',
      'UGX',
      'VND',
      'VUV',
      'XAF',
      'XOF',
      'XPF',
    ]);
  });

  it('suppresses the email when account opts out via email-preferences', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Opt out.
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { event_type: 'billing-renewal-reminder', opted_in: false },
    });

    const beforeCount = fx.emailSends.length;
    const raw = buildInvoiceUpcomingEvent({
      eventId: 'evt_invoice_upcoming_004',
      invoiceId: 'in_004',
      stripeCustomerId: 'cus_test_default',
      amountDue: 14900,
      currency: 'usd',
      nextPaymentAttemptSec: nowSec() + 7 * 24 * 60 * 60,
    });
    const result = await postEvent(fx, raw);
    expect(result.body.outcome).toBe('handled');

    const newSends = fx.emailSends.slice(beforeCount);
    expect(newSends.filter((s) => s.template === 'billing-renewal-reminder')).toHaveLength(0);
  });

  it('returns handled (no email) when invoice.upcoming references an unknown customer', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const beforeCount = fx.emailSends.length;
    const raw = buildInvoiceUpcomingEvent({
      eventId: 'evt_invoice_upcoming_005',
      invoiceId: 'in_005',
      stripeCustomerId: 'cus_unknown_xxx',
      amountDue: 14900,
      currency: 'usd',
      nextPaymentAttemptSec: nowSec() + 7 * 24 * 60 * 60,
    });
    const result = await postEvent(fx, raw);
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');

    const newSends = fx.emailSends.slice(beforeCount);
    expect(newSends.filter((s) => s.template === 'billing-renewal-reminder')).toHaveLength(0);
  });
});
