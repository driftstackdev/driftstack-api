// An invoice that was not paid is never recorded as a paid period.
//
// `billing_invoice_payments` is the evidence that a billing period was PAID FOR;
// monthly credits are granted from it and from nothing else. A row written for
// an invoice that is still open, was voided, or was written off would be a paid
// period that nobody paid for — and it is the $0 one that matters most, because
// a row with nothing paid and nothing refunded counts as covered.
//
// Two writers reach the table, and they hold different evidence:
//
//   · THE BACKFILL reads invoices from Stripe. Paging asks Stripe for paid
//     invoices only, but the repair mode reads WHATEVER invoice ids it is handed
//     — a mistyped id, or one copied from the wrong log line, is an open invoice
//     as easily as a paid one. So the backfill believes the invoice itself: it
//     records an invoice only when the invoice says `status: 'paid'`, and one
//     that says nothing is not evidence.
//   · THE WEBHOOK is told the invoice was paid by the event's type, which is its
//     evidence; a payload that carries no status is recorded as before. But an
//     event whose own invoice says it is NOT paid contradicts itself, and the
//     safe reading of a contradiction is "record nothing, tell someone".
//
// Neither changes what a customer sees: the receipt goes out exactly as it did.
//
// Held against the real backfill and the real StripeWebhooksService, on the
// in-memory repo (the rule is in the code that decides to write, not in SQL).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps, readPaidInvoice } from '../../src/lib/stripe-billing-facts.js';
import type { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import {
  runStripePeriodBackfill,
  type StripePeriodBackfillStripe,
} from '../../src/services/stripe-period-backfill.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';
import {
  INVOICE_SHAPES,
  buildInvoice,
  buildInvoiceEvent,
  sec,
  type InvoiceSpec,
  type PaidInvoiceEventType,
} from '../integration/_helpers/stripe-invoice-fixtures.js';

const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');
const CUSTOMER = 'cus_private_customer_id';
const MAPS = buildStripePriceMaps({
  api_scale: { monthly: 'price_scale_m', annual: 'price_scale_y' },
});

/** Every status an invoice can hold other than 'paid'. */
const NOT_PAID = ['draft', 'open', 'void', 'uncollectible'] as const;

/**
 * A renewal of the dearest plan with NOTHING paid on it: the row that would
 * cover a month of credits for free if it were ever written.
 */
function renewal(invoiceId: string, status: string | null | undefined): InvoiceSpec {
  return {
    invoiceId,
    customerId: CUSTOMER,
    subscriptionId: 'sub_1',
    amountPaid: 0,
    lines: [
      { priceId: 'price_scale_m', amount: 99900, periodStartSec: MAR_1, periodEndSec: APR_1 },
    ],
    ...(status === undefined ? {} : { status }),
  };
}

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

function newRepo(): { repo: InMemoryStripeWebhooksRepo; accountId: string } {
  const repo = new InMemoryStripeWebhooksRepo();
  const accountId = randomUUID();
  repo.registerAccount({ accountId, stripeCustomerId: CUSTOMER, tier: 'api_scale' });
  return { repo, accountId };
}

/** Stripe as the backfill sees it. The list does NOT filter: it returns what it is given. */
function fakeStripe(invoices: Array<Record<string, unknown>>): StripePeriodBackfillStripe {
  return {
    getInvoice: (id) => {
      const found = invoices.find((i) => i.id === id);
      return found === undefined
        ? Promise.reject(
            Object.assign(new Error('no such invoice'), { name: 'StripeApiError', status: 404 }),
          )
        : Promise.resolve(found);
    },
    listInvoices: (args) => {
      const from =
        args.startingAfter === undefined
          ? 0
          : invoices.findIndex((i) => i.id === args.startingAfter) + 1;
      return Promise.resolve({
        data: invoices.slice(from, from + args.limit),
        hasMore: from + args.limit < invoices.length,
      });
    },
    getSubscription: () =>
      Promise.reject(
        Object.assign(new Error('no such subscription'), { name: 'StripeApiError', status: 404 }),
      ),
  };
}

describe('an invoice that was not paid is never recorded as a paid period', () => {
  it('the reader reports what the invoice says about itself, in both shapes, and "nothing" when it says nothing', () => {
    for (const shape of INVOICE_SHAPES) {
      expect(
        readPaidInvoice(buildInvoice(shape, renewal('in_1', undefined)), MAPS).status,
        shape,
      ).toBe('paid');
      expect(
        readPaidInvoice(buildInvoice(shape, renewal('in_1', 'open')), MAPS).status,
        shape,
      ).toBe('open');
      expect(
        readPaidInvoice(buildInvoice(shape, renewal('in_1', null)), MAPS).status,
        shape,
      ).toBeNull();
      const odd = { ...buildInvoice(shape, renewal('in_1', undefined)), status: 7 };
      expect(readPaidInvoice(odd, MAPS).status, `${shape}: a status that is not text`).toBeNull();
    }
  });

  describe('the backfill, handed invoice ids to repair', () => {
    for (const status of [...NOT_PAID, null]) {
      const label = status === null ? 'no status at all' : `status '${status}'`;
      it(`CRITICAL an invoice with ${label} is NOT recorded: no row, counted as not paid, and its id logged for the person who asked`, async () => {
        const { repo } = newRepo();
        const { logger, lines } = recordingLogger();
        const alerts: SentryMessage[] = [];
        const invoice = buildInvoice('older', renewal('in_not_paid', status));
        // The fixture is a perfectly readable renewal — only its status differs.
        expect(readPaidInvoice(invoice, MAPS).line?.tier).toBe('api_scale');

        const report = await runStripePeriodBackfill(
          {
            stripe: fakeStripe([invoice]),
            repo,
            maps: MAPS,
            logger,
            sentry: { captureMessage: (m) => alerts.push(m) },
          },
          { invoiceIds: ['in_not_paid'] },
        );

        expect(
          repo.listInvoicePayments(),
          'an unpaid invoice was recorded as a paid period',
        ).toEqual([]);
        expect(report.invoices).toMatchObject({
          seen: 1,
          notPaid: 1,
          inserted: 0,
          completed: 0,
          unchanged: 0,
        });
        const errors = lines.filter((l) => l.level === 'error');
        expect(errors.map((l) => l.message)).toEqual(['invoice is not paid; not recorded']);
        expect(errors[0]?.fields).toEqual({
          component: 'stripe-period-backfill',
          stripeInvoiceId: 'in_not_paid',
          status,
        });
        // The operator is looking at the report; nobody else needs waking.
        expect(alerts).toEqual([]);
      });
    }

    it('CONTROL the very same invoice, paid, IS recorded — so the arms above are refusing the status and nothing else', async () => {
      const { repo, accountId } = newRepo();
      const { logger } = recordingLogger();
      const report = await runStripePeriodBackfill(
        {
          stripe: fakeStripe([buildInvoice('older', renewal('in_paid', 'paid'))]),
          repo,
          maps: MAPS,
          logger,
        },
        { invoiceIds: ['in_paid'] },
      );
      expect(report.invoices).toMatchObject({ seen: 1, notPaid: 0, inserted: 1 });
      expect(repo.listInvoicePayments()).toMatchObject([
        {
          stripeInvoiceId: 'in_paid',
          accountId,
          amountPaidMinor: 0,
          line: { kind: 'period', tier: 'api_scale' },
        },
      ]);
    });

    it('CRITICAL an invoice that was recorded while paid is left exactly as it is when a later read says otherwise', async () => {
      const { repo } = newRepo();
      const { logger } = recordingLogger();
      await runStripePeriodBackfill(
        {
          stripe: fakeStripe([buildInvoice('older', renewal('in_flip', 'paid'))]),
          repo,
          maps: MAPS,
          logger,
        },
        { invoiceIds: ['in_flip'] },
      );
      const before = repo.listInvoicePayments();
      const report = await runStripePeriodBackfill(
        {
          stripe: fakeStripe([buildInvoice('older', renewal('in_flip', 'void'))]),
          repo,
          maps: MAPS,
          logger,
        },
        { invoiceIds: ['in_flip'] },
      );
      expect(report.invoices).toMatchObject({ notPaid: 1, completed: 0, unchanged: 0 });
      expect(repo.listInvoicePayments()).toEqual(before);
    });
  });

  it('CRITICAL the backfill, paging: it asks Stripe for paid invoices and STILL believes only the invoice. An unpaid one on the page is skipped, the paid ones around it are recorded, and the cursor steps past it', async () => {
    const { repo } = newRepo();
    const { logger } = recordingLogger();
    const page = [
      buildInvoice('older', renewal('in_3', 'paid')),
      buildInvoice('newer', renewal('in_2', 'open')),
      buildInvoice('newer', renewal('in_1', 'paid')),
    ];
    const report = await runStripePeriodBackfill(
      { stripe: fakeStripe(page), repo, maps: MAPS, logger },
      { now: new Date('2026-04-15T00:00:00Z'), invoicePageSize: 2 },
    );
    expect(report.invoices).toMatchObject({ seen: 3, inserted: 2, notPaid: 1 });
    expect(repo.listInvoicePayments().map((r) => r.stripeInvoiceId)).toEqual(['in_3', 'in_1']);
    expect(report.cursor.invoices).toEqual({ done: true, after: 'in_1' });
  });

  describe('the webhook', () => {
    interface Harness {
      service: StripeWebhooksService;
      repo: InMemoryStripeWebhooksRepo;
      lines: LogLine[];
      alerts: SentryMessage[];
      receipts: string[];
      fetched: string[];
    }

    function harness(stripe?: (id: string) => Record<string, unknown>): Harness {
      const { repo } = newRepo();
      const { logger, lines } = recordingLogger();
      const alerts: SentryMessage[] = [];
      const receipts: string[] = [];
      const fetched: string[] = [];
      const lifecycle = {
        emit: (_id: string, event: { kind: string; stripeInvoiceId?: string }): Promise<void> => {
          if (event.kind === 'billing.payment_succeeded')
            receipts.push(event.stripeInvoiceId ?? '');
          return Promise.resolve();
        },
      } as unknown as AccountLifecycleService;
      const service = new StripeWebhooksService(
        repo,
        {
          logger,
          priceToTier: MAPS.priceToTier,
          priceToInterval: MAPS.priceToInterval,
          sentry: { captureMessage: (m) => alerts.push(m) },
          invoiceFetcher: {
            getInvoice: (id: string) => {
              fetched.push(id);
              return stripe === undefined
                ? Promise.reject(new Error('must not be asked'))
                : Promise.resolve(stripe(id));
            },
          },
        },
        lifecycle,
      );
      return { service, repo, lines, alerts, receipts, fetched };
    }

    let seq = 0;
    function event(type: PaidInvoiceEventType, invoice: Record<string, unknown>): StripeEvent {
      seq += 1;
      return buildInvoiceEvent({ eventId: `evt_not_paid_${String(seq)}`, type, invoice });
    }

    for (const type of ['invoice.payment_succeeded', 'invoice.paid'] as const) {
      it(`CRITICAL [${type}] an event whose own invoice says it is NOT paid records nothing, logs the invoice id and nothing about the customer, and raises the alert`, async () => {
        for (const status of NOT_PAID) {
          const h = harness();
          const e = event(
            type,
            buildInvoice('older', { ...renewal('in_contradiction', status), amountPaid: 99900 }),
          );
          expect(await h.service.handle(e, JSON.stringify(e)), status).toBe('handled');

          expect(h.repo.listInvoicePayments(), `${status}: recorded as a paid period`).toEqual([]);
          expect(
            h.fetched,
            `${status}: Stripe was asked about an invoice nobody will record`,
          ).toEqual([]);
          const errors = h.lines.filter((l) => l.level === 'error');
          expect(
            errors.map((l) => l.fields),
            status,
          ).toEqual([
            {
              component: 'stripe-webhooks',
              eventId: e.id,
              stripeInvoiceId: 'in_contradiction',
              reason: 'not_paid',
            },
          ]);
          expect(
            h.alerts.map((a) => a.tags),
            status,
          ).toEqual([{ kind: 'paid_invoice_unlinkable', reason: 'not_paid', source: 'webhook' }]);
          const sent = JSON.stringify(h.alerts);
          for (const secret of ['in_contradiction', CUSTOMER, e.id, 'sub_1']) {
            expect(sent.includes(secret), `${status}: the alert leaked ${secret}`).toBe(false);
          }
        }
      });
    }

    it('the log says what happened. An alert sends a person to the server log for the invoice id, and beside the refusal they must not read that the payment was recorded: invoice.paid says "recorded" only for an invoice that is on record once it returns', async () => {
      const kinds = (h: Harness): unknown[] =>
        h.lines.filter((l) => l.message === 'handled Stripe event').map((l) => l.fields.kind);

      const refused = harness();
      const open = event(
        'invoice.paid',
        buildInvoice('older', { ...renewal('in_log_open', 'open'), amountPaid: 99900 }),
      );
      await refused.service.handle(open, JSON.stringify(open));
      expect(refused.repo.listInvoicePayments()).toEqual([]);
      expect(kinds(refused)).toEqual(['invoice.paid (payment not recorded)']);

      const unreadableAmount = harness();
      const fractional = event(
        'invoice.paid',
        buildInvoice('older', { ...renewal('in_log_amount', 'paid'), amountPaid: 12.5 }),
      );
      await unreadableAmount.service.handle(fractional, JSON.stringify(fractional));
      expect(unreadableAmount.repo.listInvoicePayments()).toEqual([]);
      expect(kinds(unreadableAmount)).toEqual(['invoice.paid (payment not recorded)']);

      // CONTROL: the same event for a paid invoice is recorded, and says so — twice,
      // because a second delivery finds it on record, which is also "recorded".
      const recorded = harness();
      for (let i = 0; i < 2; i += 1) {
        const paid = event('invoice.paid', buildInvoice('older', renewal('in_log_paid', 'paid')));
        await recorded.service.handle(paid, JSON.stringify(paid));
      }
      expect(recorded.repo.listInvoicePayments()).toHaveLength(1);
      expect(kinds(recorded)).toEqual([
        'invoice.paid → payment recorded',
        'invoice.paid → payment recorded',
      ]);
    });

    it('the receipt is exactly what it was: the contradiction stops the RECORD, not the email that was always sent', async () => {
      const h = harness();
      const e = event(
        'invoice.payment_succeeded',
        buildInvoice('older', { ...renewal('in_receipt', 'open'), amountPaid: 99900 }),
      );
      await h.service.handle(e, JSON.stringify(e));
      expect(h.repo.listInvoicePayments()).toEqual([]);
      expect(h.receipts).toEqual(['in_receipt']);
    });

    it('CRITICAL a payload that says nothing, in a shape this server cannot read, is fetched — and when STRIPE then says the invoice is not paid, that is the same contradiction one step later: nothing recorded, alert raised', async () => {
      const unreadable = (status: string | null): Record<string, unknown> => {
        const invoice = buildInvoice('older', {
          ...renewal('in_asked', status),
          amountPaid: 99900,
        });
        delete invoice.subscription;
        return invoice;
      };
      const refused = harness(() => buildInvoice('older', renewal('in_asked', 'void')));
      const e = event('invoice.payment_succeeded', unreadable(null));
      await refused.service.handle(e, JSON.stringify(e));
      expect(refused.fetched).toEqual(['in_asked']);
      expect(
        refused.repo.listInvoicePayments(),
        'recorded although Stripe says it is void',
      ).toEqual([]);
      expect(refused.alerts.map((a) => a.tags?.reason)).toEqual(['not_paid']);

      // CONTROL: the same silent payload, and Stripe says paid → recorded, from the fetched line.
      const recorded = harness(() => buildInvoice('older', renewal('in_asked', 'paid')));
      const e2 = event('invoice.payment_succeeded', unreadable(null));
      await recorded.service.handle(e2, JSON.stringify(e2));
      expect(recorded.repo.listInvoicePayments()).toMatchObject([
        {
          stripeInvoiceId: 'in_asked',
          amountPaidMinor: 99900,
          line: { kind: 'period', tier: 'api_scale' },
        },
      ]);
      expect(recorded.alerts).toEqual([]);
    });

    it('a payload that carries NO status is recorded as before: the event’s type is the webhook’s evidence, and older payloads in this suite carry none', async () => {
      const h = harness();
      const e = event(
        'invoice.payment_succeeded',
        buildInvoice('newer', { ...renewal('in_silent', null), amountPaid: 99900 }),
      );
      await h.service.handle(e, JSON.stringify(e));
      expect(h.repo.listInvoicePayments()).toMatchObject([
        { stripeInvoiceId: 'in_silent', line: { kind: 'period', tier: 'api_scale' } },
      ]);
      expect(h.alerts).toEqual([]);
    });
  });
});
