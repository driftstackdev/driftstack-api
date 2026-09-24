// The receipt names the period the payment paid for (live-billing audit #12).
//
// The billing receipt said "Your payment of $149.00 for the <start> – <end>
// period was successful", with the dates taken from the invoice's own top-level
// `period_start` / `period_end`. On a renewal those describe the period that
// just ENDED — March's payment was receipted "for the 2026-02-01 – 2026-03-01
// period" — and on a first invoice they are the same instant. The payment
// record written from the same invoice already used the paid LINE's period
// (lib/stripe-billing-facts.ts says why); the receipt now names that one too, in
// either payload shape, including a line only Stripe's own copy of the invoice
// names. With no line at all it falls back to the charge date, as before.
//
// Driven through the real StripeWebhooksService, AccountLifecycleService and
// email service, with the Drizzle repos on a Postgres rebuilt from the
// migrations. Only Postmark and the Stripe invoice read are doubles.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAccountLifecycleRepo } from '../../src/db/account-lifecycle-repo.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import { createEmailService, type PostmarkSendApi } from '../../src/services/email.js';
import type { EmailPreferencesService } from '../../src/services/email-preferences.js';
import { StripeWebhooksService } from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  INVOICE_SHAPES,
  buildInvoice,
  buildInvoiceEvent,
  sec,
  type InvoiceSpec,
} from './_helpers/stripe-invoice-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_receipt_period';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let pool: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  pool = createDb(opened.url, { max: 2 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await pool?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function database(): Database {
  if (pool === null) throw new Error('isolated database unreachable');
  return pool;
}

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
});

const FEB_1 = sec('2026-02-01T00:00:00Z');
const MAR_1 = sec('2026-03-01T00:00:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');

/** Postmark, recording what each email said. */
class RecordingPostmark implements PostmarkSendApi {
  readonly sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  sendEmail(input: {
    To: string;
    Subject: string;
    TextBody?: string;
    HtmlBody?: string;
  }): Promise<unknown> {
    this.sent.push({
      to: input.To,
      subject: input.Subject,
      text: input.TextBody ?? '',
      html: input.HtmlBody ?? '',
    });
    return Promise.resolve({ ErrorCode: 0, Message: 'OK' });
  }
}

async function harness(
  stripeCopy?: () => Record<string, unknown>,
): Promise<{ webhooks: StripeWebhooksService; postmark: RecordingPostmark; customerId: string }> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
  await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
             VALUES (${accountId}::uuid, ${`receipt-${accountId}@example.test`},
                     'api_starter'::account_tier, ${customerId})`;
  const postmark = new RecordingPostmark();
  const lifecycle = new AccountLifecycleService(
    new DrizzleAccountLifecycleRepo(database()),
    createEmailService({
      config: {
        apiToken: 'pm-test',
        from: 'billing@driftstack.dev',
        replyTo: 'support@driftstack.dev',
      },
      logger: silent,
      client: postmark,
      retryDelayFn: () => Promise.resolve(),
    }),
    { shouldSend: () => Promise.resolve(true) } as unknown as EmailPreferencesService,
    silent,
    {
      docsBaseUrl: 'https://docs.driftstack.io',
      billingPortalUrl: 'https://app.driftstack.io/billing',
      dashboardUrl: 'https://app.driftstack.io',
    },
  );
  const webhooks = new StripeWebhooksService(
    new DrizzleStripeWebhooksRepo(database()),
    {
      logger: silent,
      priceToTier: MAPS.priceToTier,
      priceToInterval: MAPS.priceToInterval,
      ...(stripeCopy !== undefined
        ? { invoiceFetcher: { getInvoice: () => Promise.resolve(stripeCopy()) } }
        : {}),
    },
    lifecycle,
  );
  return { webhooks, postmark, customerId };
}

function renewal(customerId: string, overrides: Partial<InvoiceSpec> = {}): InvoiceSpec {
  return {
    invoiceId: `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    customerId,
    subscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    amountPaid: 14_900,
    hostedInvoiceUrl: 'https://invoice.stripe.test/i/receipt',
    // The invoice's own period: February, the period that just ENDED.
    topLevelPeriod: { startSec: FEB_1, endSec: MAR_1 },
    // The line: March, the period this payment is for.
    lines: [
      { priceId: 'price_starter_m', amount: 14_900, periodStartSec: MAR_1, periodEndSec: APR_1 },
    ],
    ...overrides,
  };
}

async function receiptFor(
  h: { webhooks: StripeWebhooksService; postmark: RecordingPostmark },
  invoice: Record<string, unknown>,
): Promise<string> {
  const event = buildInvoiceEvent({
    eventId: `evt_receipt_${randomUUID()}`,
    type: 'invoice.payment_succeeded',
    invoice,
  });
  expect(await h.webhooks.handle(event, JSON.stringify(event))).toBe('handled');
  expect(h.postmark.sent).toHaveLength(1);
  return h.postmark.sent[0]?.text ?? '';
}

describe.skipIf(!RUN_DB_TESTS)('the receipt names the period the payment paid for', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  for (const shape of INVOICE_SHAPES) {
    it(`CRITICAL [${shape} payload] a renewal's receipt names March, the period paid for — not February, the invoice's own period that just ended`, async () => {
      const h = await harness();
      const text = await receiptFor(h, buildInvoice(shape, renewal(h.customerId)));
      expect(text).toContain(
        'Your payment of $149.00 for the 2026-03-01 – 2026-04-01 period was successful.',
      );
      expect(text).not.toContain('2026-02-01');
    });
  }

  it("CRITICAL a first invoice, whose own period is zero-length, is receipted for the line's month", async () => {
    const h = await harness();
    const text = await receiptFor(
      h,
      buildInvoice(
        'newer',
        renewal(h.customerId, {
          billingReason: 'subscription_create',
          topLevelPeriod: { startSec: MAR_1, endSec: MAR_1 },
        }),
      ),
    );
    expect(text).toContain('for the 2026-03-01 – 2026-04-01 period');
  });

  it("CRITICAL a payload that names no line is receipted for the line Stripe's own copy of the invoice names", async () => {
    let stripeCopy: Record<string, unknown> = {};
    const h = await harness(() => stripeCopy);
    stripeCopy = buildInvoice('newer', renewal(h.customerId));
    const bare = { ...stripeCopy, lines: { object: 'list', has_more: false, data: [] } };
    const text = await receiptFor(h, bare);
    expect(text).toContain('for the 2026-03-01 – 2026-04-01 period');
  });

  it('an invoice with no paid line anywhere — in the payload or in Stripe — falls back to the charge date, never to its own top-level period', async () => {
    const h = await harness();
    const invoice = buildInvoice('older', renewal(h.customerId, { lines: [] }));
    const text = await receiptFor(h, invoice);
    const today = new Date().toISOString().slice(0, 10);
    expect(text).toContain(`for the ${today} period`);
    expect(text).not.toContain('2026-02-01');
  });
});
