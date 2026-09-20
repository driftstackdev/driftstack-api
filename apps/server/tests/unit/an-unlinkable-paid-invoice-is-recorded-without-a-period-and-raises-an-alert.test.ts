// A paid invoice that cannot be tied to a subscription line is still recorded —
// with no period, covering nothing — and it raises an alert.
//
// The safe direction is "grant nothing on a period nobody could read". But that
// is a customer who PAID, so silence is not acceptable either: the invoice id is
// logged at error and an alert reaches a person. Before giving up, the server
// asks Stripe for the invoice once: the same invoice fetched at the API version
// this server pins may carry the link a webhook payload did not.
//
// What must hold, and is held here against the real StripeWebhooksService with
// the in-memory repo, a recording logger, a recording alert client and a fake
// Stripe reader:
//
//   · the fetch happens ONLY when the payload could not be read, and at most once;
//   · a fetch that fails transiently aborts the event (Stripe retries it whole);
//     one that fails any other way is not a reason to lose the record;
//   · the error log names the invoice and NOTHING about the customer;
//   · the alert names NOTHING at all — no invoice, customer, account or event id;
//   · the receipt behaves exactly as it did before any of this existed.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import { reportUnlinkableInvoice } from '../../src/lib/report-unlinkable-invoice.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import type { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';
import {
  buildInvoice,
  buildInvoiceEvent,
  sec,
  type InvoiceSpec,
} from '../integration/_helpers/stripe-invoice-fixtures.js';

const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');
const CUSTOMER = 'cus_private_customer_id';
const MAPS = buildStripePriceMaps({
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
});

interface LogLine {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger = { info: at('info'), warn: at('warn'), error: at('error'), debug: () => {} };
  return { logger: logger as unknown as Logger, lines };
}

interface Harness {
  service: StripeWebhooksService;
  repo: InMemoryStripeWebhooksRepo;
  accountId: string;
  lines: LogLine[];
  alerts: SentryMessage[];
  receipts: Array<{ accountId: string; stripeInvoiceId: string }>;
  fetched: string[];
}

function harness(
  options: {
    /** What Stripe answers for getInvoice. Omit for "no Stripe reader configured". */
    stripe?: (invoiceId: string) => Promise<Record<string, unknown>>;
    alertThrows?: boolean;
  } = {},
): Harness {
  const repo = new InMemoryStripeWebhooksRepo();
  const accountId = randomUUID();
  repo.registerAccount({ accountId, stripeCustomerId: CUSTOMER, tier: 'api_builder' });
  const { logger, lines } = recordingLogger();
  const alerts: SentryMessage[] = [];
  const receipts: Harness['receipts'] = [];
  const fetched: string[] = [];
  const lifecycle = {
    emit: (id: string, event: { kind: string; stripeInvoiceId?: string }): Promise<void> => {
      if (event.kind === 'billing.payment_succeeded') {
        receipts.push({ accountId: id, stripeInvoiceId: event.stripeInvoiceId ?? '' });
      }
      return Promise.resolve();
    },
  } as unknown as AccountLifecycleService;
  const stripe = options.stripe;
  const service = new StripeWebhooksService(
    repo,
    {
      logger,
      priceToTier: MAPS.priceToTier,
      priceToInterval: MAPS.priceToInterval,
      sentry: {
        captureMessage: (msg) => {
          if (options.alertThrows === true) throw new Error('alerting is down');
          alerts.push(msg);
        },
      },
      ...(stripe !== undefined
        ? {
            invoiceFetcher: {
              getInvoice: (id: string) => {
                fetched.push(id);
                return stripe(id);
              },
            },
          }
        : {}),
    },
    lifecycle,
  );
  return { service, repo, accountId, lines, alerts, receipts, fetched };
}

function linkedSpec(invoiceId: string): InvoiceSpec {
  return {
    invoiceId,
    customerId: CUSTOMER,
    subscriptionId: 'sub_1',
    amountPaid: 49900,
    lines: [
      { priceId: 'price_builder_m', amount: 49900, periodStartSec: MAR_1, periodEndSec: APR_1 },
    ],
  };
}

/** The same invoice as a webhook would deliver it in a shape this server cannot read. */
function unreadable(invoiceId: string): Record<string, unknown> {
  const invoice = buildInvoice('older', linkedSpec(invoiceId));
  delete invoice.subscription;
  invoice.subscription_in_some_future_shape = { id: 'sub_1' };
  return invoice;
}

let seq = 0;
function paid(
  invoice: Record<string, unknown>,
  type: 'invoice.payment_succeeded' | 'invoice.paid' = 'invoice.payment_succeeded',
): StripeEvent {
  seq += 1;
  return buildInvoiceEvent({ eventId: `evt_unlinkable_${String(seq)}`, type, invoice });
}

function handle(h: Harness, event: StripeEvent): Promise<string> {
  return h.service.handle(event, JSON.stringify(event));
}

const stripeError = (status: number): Error =>
  Object.assign(new Error(`Stripe /v1/invoices/in_x failed`), {
    name: 'StripeApiError',
    status,
    stripeError: { type: 'api_error' },
  });

describe('an unlinkable paid invoice is recorded without a period and raises an alert', () => {
  it('CRITICAL still unlinkable after asking Stripe: the payment is recorded with NO period, the invoice id is logged at error, an alert goes out — and the receipt is sent exactly as before', async () => {
    const h = harness({ stripe: (id) => Promise.resolve(unreadable(id)) });
    expect(await handle(h, paid(unreadable('in_cannot_link')))).toBe('handled');

    const [row] = h.repo.listInvoicePayments();
    expect(row).toMatchObject({
      stripeInvoiceId: 'in_cannot_link',
      accountId: h.accountId,
      amountPaidMinor: 49900,
      stripeSubscriptionId: null,
      line: null,
    });
    expect(h.repo.listInvoicePayments()).toHaveLength(1);
    expect(h.fetched).toEqual(['in_cannot_link']);

    const errors = h.lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('paid invoice is tied to no billing period');
    expect(Object.keys(errors[0]?.fields ?? {}).sort()).toEqual([
      'component',
      'eventId',
      'reason',
      'stripeInvoiceId',
    ]);
    expect(errors[0]?.fields.stripeInvoiceId).toBe('in_cannot_link');
    expect(errors[0]?.fields.reason).toBe('no_subscription');

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.level).toBe('error');
    expect(h.alerts[0]?.fingerprint).toEqual([
      'billing',
      'paid_invoice_unlinkable',
      'no_subscription',
    ]);
    expect(h.alerts[0]?.tags).toEqual({
      kind: 'paid_invoice_unlinkable',
      reason: 'no_subscription',
      source: 'webhook',
    });

    expect(h.receipts).toEqual([{ accountId: h.accountId, stripeInvoiceId: 'in_cannot_link' }]);
  });

  it('CRITICAL the alert carries NO identifier: not the invoice, the customer, the account or the event. The log line carries the invoice id and nothing about the customer.', async () => {
    const h = harness();
    const event = paid(unreadable('in_secret_invoice_id'));
    await handle(h, event);
    expect(h.alerts).toHaveLength(1);
    const alert = JSON.stringify(h.alerts[0]);
    for (const identifier of ['in_secret_invoice_id', CUSTOMER, h.accountId, event.id, 'sub_1']) {
      expect(alert, `the alert leaked ${identifier}`).not.toContain(identifier);
    }
    const logged = JSON.stringify(h.lines.filter((l) => l.level === 'error'));
    expect(logged).toContain('in_secret_invoice_id');
    for (const customerData of [CUSTOMER, h.accountId, '49900', 'usd']) {
      expect(logged, `the error log carried ${customerData}`).not.toContain(customerData);
    }
  });

  it('CRITICAL a payload this server cannot read is fetched from Stripe ONCE, and the fetched invoice ties it to its line: no alert, no error', async () => {
    const h = harness({
      stripe: (id) => Promise.resolve(buildInvoice('older', linkedSpec(id))),
    });
    await handle(h, paid(unreadable('in_fetched')));
    expect(h.fetched).toEqual(['in_fetched']);
    expect(h.repo.listInvoicePayments()).toMatchObject([
      {
        stripeInvoiceId: 'in_fetched',
        stripeSubscriptionId: 'sub_1',
        line: { kind: 'period', tier: 'api_builder', interval: 'month' },
      },
    ]);
    expect(h.repo.listInvoicePayments()[0]?.line?.periodStart.toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
    expect(h.alerts).toEqual([]);
    expect(h.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('a payload that CAN be read never asks Stripe for anything', async () => {
    const h = harness({ stripe: () => Promise.reject(new Error('must not be called')) });
    for (const shape of ['older', 'newer'] as const) {
      await handle(h, paid(buildInvoice(shape, linkedSpec(`in_readable_${shape}`))));
    }
    expect(h.fetched).toEqual([]);
    expect(h.repo.listInvoicePayments().map((p) => p.line?.kind)).toEqual(['period', 'period']);
    expect(h.alerts).toEqual([]);
  });

  it('CRITICAL a TRANSIENT failure of the fetch aborts the whole event — nothing recorded, no receipt, no ledger row — so Stripe’s retry can read it properly', async () => {
    let calls = 0;
    const h = harness({
      stripe: (id) => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
        return Promise.resolve(buildInvoice('older', linkedSpec(id)));
      },
    });
    const event = paid(unreadable('in_blip'));
    await expect(handle(h, event)).rejects.toThrow('aborted');
    expect(h.repo.listInvoicePayments()).toEqual([]);
    expect(h.receipts).toEqual([]);
    expect(await h.repo.hasEvent(event.id)).toBe(false);
    expect(h.alerts).toEqual([]);

    // The retry: same event, Stripe reachable again.
    expect(await handle(h, event)).toBe('handled');
    expect(h.repo.listInvoicePayments().map((p) => p.line?.kind)).toEqual(['period']);
    expect(h.receipts).toHaveLength(1);
    expect(h.alerts).toEqual([]);
  });

  it('a fetch that fails any OTHER way is not a reason to lose the record: recorded with no period, alert raised, receipt sent', async () => {
    for (const status of [404, 401, 500]) {
      const h = harness({ stripe: () => Promise.reject(stripeError(status)) });
      expect(await handle(h, paid(unreadable(`in_stripe_${String(status)}`))), String(status)).toBe(
        'handled',
      );
      expect(h.repo.listInvoicePayments().map((p) => p.line)).toEqual([null]);
      expect(h.alerts).toHaveLength(1);
      expect(h.receipts).toHaveLength(1);
    }
  });

  it('an answer for a DIFFERENT invoice is not used to fill this one', async () => {
    const h = harness({
      stripe: () => Promise.resolve(buildInvoice('older', linkedSpec('in_somebody_elses'))),
    });
    await handle(h, paid(unreadable('in_mine')));
    expect(h.repo.listInvoicePayments()).toMatchObject([
      { stripeInvoiceId: 'in_mine', line: null },
    ]);
    expect(h.alerts).toHaveLength(1);
  });

  it('with no Stripe reader configured the invoice is recorded with no period and the alert still fires', async () => {
    const h = harness();
    await handle(h, paid(unreadable('in_no_reader')));
    expect(h.repo.listInvoicePayments().map((p) => p.line)).toEqual([null]);
    expect(h.alerts.map((a) => a.tags?.reason)).toEqual(['no_subscription']);
  });

  it('the reason says which half was missing: no subscription at all, or a subscription with no line that can be read', async () => {
    const h = harness();
    const noLine = buildInvoice('older', { ...linkedSpec('in_no_line'), lines: [] });
    await handle(h, paid(noLine));
    await handle(h, paid(unreadable('in_no_sub')));
    expect(h.alerts.map((a) => a.tags?.reason)).toEqual([
      'no_subscription_line',
      'no_subscription',
    ]);
    expect(h.lines.filter((l) => l.level === 'error').map((l) => l.fields.reason)).toEqual([
      'no_subscription_line',
      'no_subscription',
    ]);
  });

  it('CRITICAL an invoice already tied to its line raises nothing when a later sighting cannot read it: the alert is about the STORED record, not about this delivery', async () => {
    const h = harness();
    await handle(
      h,
      paid(buildInvoice('older', linkedSpec('in_known')), 'invoice.payment_succeeded'),
    );
    await handle(h, paid(unreadable('in_known'), 'invoice.paid'));
    expect(h.repo.listInvoicePayments().map((p) => p.line?.kind)).toEqual(['period']);
    expect(h.alerts).toEqual([]);
    expect(h.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('an invoice already recorded against another account is left alone and raises its own alert', async () => {
    const h = harness();
    const other = randomUUID();
    h.repo.registerAccount({ accountId: other, stripeCustomerId: 'cus_other' });
    await handle(
      h,
      paid(buildInvoice('older', { ...linkedSpec('in_shared'), customerId: 'cus_other' })),
    );
    await handle(h, paid(buildInvoice('older', linkedSpec('in_shared')), 'invoice.paid'));
    expect(h.repo.listInvoicePayments().map((p) => p.accountId)).toEqual([other]);
    expect(h.alerts.map((a) => a.tags?.reason)).toEqual(['account_mismatch']);
  });

  it('an amount that is not a whole non-negative number is not recorded, and says so', async () => {
    const h = harness();
    const invoice = buildInvoice('older', linkedSpec('in_bad_amount'));
    invoice.amount_paid = 49900.5;
    await handle(h, paid(invoice, 'invoice.paid'));
    expect(h.repo.listInvoicePayments()).toEqual([]);
    expect(h.alerts.map((a) => a.tags?.reason)).toEqual(['invalid_amount']);
  });

  it('a price the configuration does not name is a WARNING, not an alert: a custom contract is an expected state', async () => {
    const h = harness();
    const custom = linkedSpec('in_custom');
    custom.lines = [
      { priceId: 'price_custom', amount: 49900, periodStartSec: MAR_1, periodEndSec: APR_1 },
    ];
    await handle(h, paid(buildInvoice('older', custom)));
    expect(h.repo.listInvoicePayments()).toMatchObject([{ line: { kind: 'period', tier: null } }]);
    expect(h.alerts).toEqual([]);
    expect(h.lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(h.lines.filter((l) => l.level === 'warn').map((l) => l.message)).toContain(
      'paid invoice line price not in priceToTier map; recorded without a plan',
    );
  });

  it('an alert client that throws does not fail the event: the payment is recorded and the receipt still goes', async () => {
    const h = harness({ alertThrows: true });
    expect(await handle(h, paid(unreadable('in_alert_down')))).toBe('handled');
    expect(h.repo.listInvoicePayments()).toHaveLength(1);
    expect(h.receipts).toHaveLength(1);
  });

  it('the reporter itself: no client, no report; one Sentry issue per reason; a count for a run that stands for many', () => {
    expect(
      reportUnlinkableInvoice(undefined, { reason: 'no_subscription', source: 'webhook' }),
    ).toBe(false);
    const sent: SentryMessage[] = [];
    const client = { captureMessage: (m: SentryMessage): number => sent.push(m) };
    expect(
      reportUnlinkableInvoice(client, {
        reason: 'no_subscription_line',
        source: 'backfill',
        count: 7,
      }),
    ).toBe(true);
    expect(sent[0]?.fingerprint).toEqual([
      'billing',
      'paid_invoice_unlinkable',
      'no_subscription_line',
    ]);
    expect(sent[0]?.extra).toEqual({
      reason: 'no_subscription_line',
      source: 'backfill',
      count: 7,
    });
  });
});
