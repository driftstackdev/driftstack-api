// The credits refresh is the last thing a billing event does, and a retry
// repeats nothing.
//
// While AI credits are switched on, a paid invoice ends by refreshing the
// account's monthly credits. That refresh can fail — the database blinks — and a
// failure raises the question every handler with more than one side effect has
// to answer: what has already happened, and what happens on the retry?
//
// The answer here is by ORDER. The refresh runs AFTER everything the handler
// already did: the paid invoice is recorded, the receipt is sent. So:
//
//   · a TRANSIENT failure answers 500 and records no event, and Stripe retries.
//     The retry records nothing twice (the invoice is keyed on its id), sends no
//     second receipt (the send is claimed once per event), and refreshes again;
//   · any OTHER failure is logged, alerted and swallowed. The event is handled —
//     it WAS handled: the payment is recorded and the receipt sent — and the
//     coverage sweep retries the account. A refresh must never turn a handled
//     billing event into a failed one.
//
// Driven end to end through the real route, with the refresh stood in for by a
// spy that records what it could already see when it was called.

import { afterEach, describe, expect, it } from 'vitest';
import { signStripePayload } from '../../src/lib/stripe-signing.js';
import type { CreditsRefresher, CreditsRefreshResult } from '../../src/services/credit-grants.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { buildInvoice, buildInvoiceEvent, sec } from './_helpers/stripe-invoice-fixtures.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');

const NOTHING_TO_DO: CreditsRefreshResult = {
  expired: [],
  window: { outcome: 'none' },
  level: null,
  repaid: [],
  currentWindowEnd: null,
};

interface Seen {
  accountId: string;
  invoicesRecorded: number;
  receiptsSent: number;
}

/** A refresher that records what was already done when it was called, then does `behave`. */
function spy(behave: (call: number) => Promise<CreditsRefreshResult>): {
  refresher: CreditsRefresher;
  calls: Seen[];
} {
  const calls: Seen[] = [];
  return {
    calls,
    refresher: {
      refreshCredits: (accountId) => {
        calls.push({
          accountId,
          invoicesRecorded: fx.stripeWebhooksRepo.listInvoicePayments().length,
          receiptsSent: receipts(),
        });
        return behave(calls.length);
      },
    },
  };
}

function receipts(): number {
  return fx.emailSends.filter((s) => s.template === 'billing-receipt').length;
}

function paidInvoice(
  invoiceId: string,
  amountPaid = 14900,
  status?: string,
): Record<string, unknown> {
  return buildInvoice('older', {
    invoiceId,
    customerId: 'cus_test_default',
    subscriptionId: 'sub_1',
    amountPaid,
    ...(status !== undefined ? { status } : {}),
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

async function post(event: Record<string, unknown>): Promise<{ status: number; outcome?: string }> {
  const raw = JSON.stringify(event);
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: {
      'stripe-signature': signStripePayload({
        rawBody: raw,
        secret: fx.stripeWebhookSigningSecret,
      }),
      'content-type': 'application/json',
    },
    payload: raw,
  });
  const outcome = res.json<{ outcome?: string }>().outcome;
  return { status: res.statusCode, ...(outcome !== undefined ? { outcome } : {}) };
}

function subscriptionEvent(
  eventId: string,
  createdSec: number,
  status = 'active',
): Record<string, unknown> {
  return {
    id: eventId,
    type: 'customer.subscription.updated',
    created: createdSec,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_test_default',
        status,
        cancel_at_period_end: false,
        current_period_start: MAR_1,
        current_period_end: APR_1,
        items: { data: [{ price: { id: 'price_api_builder_monthly' } }] },
      },
    },
  };
}

const transient = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

describe('the credits refresh is the last thing a billing event does, and a retry repeats nothing', () => {
  it('CRITICAL on invoice.payment_succeeded the refresh is called ONCE, for the paying account, and by then the invoice is already recorded and the receipt already sent', async () => {
    const s = spy(() => Promise.resolve(NOTHING_TO_DO));
    fx = await buildTestApp({ tier: 'api_builder', creditsRefresher: s.refresher });
    const before = receipts();

    const res = await post(
      buildInvoiceEvent({
        eventId: 'evt_order',
        type: 'invoice.payment_succeeded',
        invoice: paidInvoice('in_order'),
      }),
    );
    expect(res).toEqual({ status: 200, outcome: 'handled' });
    expect(s.calls).toEqual([
      { accountId: fx.accountId, invoicesRecorded: 1, receiptsSent: before + 1 },
    ]);
  });

  it('invoice.paid refreshes after recording and sends no receipt; a $0 invoice refreshes too, because it was paid', async () => {
    const s = spy(() => Promise.resolve(NOTHING_TO_DO));
    fx = await buildTestApp({ tier: 'api_builder', creditsRefresher: s.refresher });
    const before = receipts();

    await post(
      buildInvoiceEvent({
        eventId: 'evt_paid',
        type: 'invoice.paid',
        invoice: paidInvoice('in_paid'),
      }),
    );
    await post(
      buildInvoiceEvent({
        eventId: 'evt_zero',
        type: 'invoice.payment_succeeded',
        invoice: paidInvoice('in_zero', 0),
      }),
    );
    expect(s.calls.map((c) => c.invoicesRecorded)).toEqual([1, 2]);
    expect(receipts(), 'neither of these sends a receipt').toBe(before);
  });

  it('an invoice that was NOT recorded refreshes nothing: one that says itself it is not paid, and one for a customer this server does not know', async () => {
    const s = spy(() => Promise.resolve(NOTHING_TO_DO));
    fx = await buildTestApp({ tier: 'api_builder', creditsRefresher: s.refresher });

    await post(
      buildInvoiceEvent({
        eventId: 'evt_open',
        type: 'invoice.paid',
        invoice: paidInvoice('in_open', 14900, 'open'),
      }),
    );
    const stranger = paidInvoice('in_stranger');
    stranger.customer = 'cus_nobody_we_know';
    await post(
      buildInvoiceEvent({
        eventId: 'evt_stranger',
        type: 'invoice.payment_succeeded',
        invoice: stranger,
      }),
    );

    expect(s.calls).toEqual([]);
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toEqual([]);
  });

  it('an APPLIED subscription event refreshes the account; a stale one, skipped by the recency guard, refreshes nothing', async () => {
    const s = spy(() => Promise.resolve(NOTHING_TO_DO));
    fx = await buildTestApp({ tier: 'api_builder', creditsRefresher: s.refresher });

    expect(await post(subscriptionEvent('evt_sub_new', MAR_1 + 500))).toEqual({
      status: 200,
      outcome: 'handled',
    });
    expect(s.calls.map((c) => c.accountId)).toEqual([fx.accountId]);

    // Older than the row it would overwrite: acknowledged, and nothing else.
    expect(await post(subscriptionEvent('evt_sub_old', MAR_1 + 100))).toEqual({
      status: 200,
      outcome: 'handled',
    });
    expect(s.calls, 'a skipped event refreshed the account').toHaveLength(1);
  });

  it('CRITICAL a TRANSIENT refresh failure answers 500 and records no event, so Stripe retries — and the retry records the invoice ONCE, sends ONE receipt in total, refreshes again, and is handled', async () => {
    const s = spy((call) =>
      call === 1 ? Promise.reject(transient()) : Promise.resolve(NOTHING_TO_DO),
    );
    fx = await buildTestApp({ tier: 'api_builder', creditsRefresher: s.refresher });
    const before = receipts();
    const event = buildInvoiceEvent({
      eventId: 'evt_retry',
      type: 'invoice.payment_succeeded',
      invoice: paidInvoice('in_retry'),
      createdSec: MAR_1 + 4000,
    });

    const first = await post(event);
    expect(first.status, 'a transient failure must not be acknowledged').toBe(500);
    expect(
      fx.stripeWebhooksRepo.list().some((e) => e.eventId === 'evt_retry'),
      'the event was marked processed, so Stripe would not retry',
    ).toBe(false);
    // What the handler did before the refresh stands.
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toHaveLength(1);
    expect(receipts()).toBe(before + 1);

    const second = await post(event);
    expect(second).toEqual({ status: 200, outcome: 'handled' });
    expect(
      fx.stripeWebhooksRepo.listInvoicePayments(),
      'the invoice was recorded twice',
    ).toHaveLength(1);
    expect(receipts(), 'the retry sent a second receipt').toBe(before + 1);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]).toEqual({
      accountId: fx.accountId,
      invoicesRecorded: 1,
      receiptsSent: before + 1,
    });
  });

  it('CRITICAL any OTHER refresh failure is swallowed: the event is handled (200, not an error outcome), the payment is recorded and the receipt sent, and Stripe is not asked to retry what cannot be fixed by retrying', async () => {
    const s = spy(() => Promise.reject(new RangeError('a level is not a safe integer')));
    fx = await buildTestApp({ tier: 'api_builder', creditsRefresher: s.refresher });
    const before = receipts();

    const res = await post(
      buildInvoiceEvent({
        eventId: 'evt_bug',
        type: 'invoice.payment_succeeded',
        invoice: paidInvoice('in_bug'),
      }),
    );
    expect(res).toEqual({ status: 200, outcome: 'handled' });
    expect(fx.stripeWebhooksRepo.list().find((e) => e.eventId === 'evt_bug')?.result).toBe(
      'handled',
    );
    expect(fx.stripeWebhooksRepo.listInvoicePayments()).toHaveLength(1);
    expect(receipts()).toBe(before + 1);
    expect(s.calls).toHaveLength(1);
  });
});
