// The payment-failure notice says until when the paid plan stays
// (live-billing audit #3).
//
// A failed renewal now keeps the paid plan for seven days (ToS 8.5: at least
// seven days' written notice before a suspension for non-payment), and the
// payment-failure email sent at the first failure is that notice — so it must
// say when the plan stops. It names the moment, in plain words and UTC, rounded
// down to the minute so it never promises more than it keeps: seven days from
// when the subscription fell behind — or, when the invoice's event is handled
// before the subscription's own past_due event (they share a second, in either
// order), seven days from this failure. A later failure, once the seven days
// are over, says when the plan stopped. A failure with no grace behind it — a
// first payment, an invoice of no subscription — says nothing about it, and the
// email is otherwise what it was.
//
// Driven through the real StripeWebhooksService, AccountLifecycleService and
// email service, with the Drizzle repos on a Postgres rebuilt from the
// migrations. Only Postmark is a double.

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
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_failure_notice_grace';
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

const DAY_S = 24 * 60 * 60;

/**
 * The oracle, written apart from the code under test: "September 30, 2026 at
 * 03:00 UTC", the minute rounded down.
 */
function when(epochSec: number): string {
  const d = new Date(Math.floor(epochSec / 60) * 60_000);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
  const time = d.toISOString().slice(11, 16);
  return `${date} at ${time} UTC`;
}

class RecordingPostmark implements PostmarkSendApi {
  readonly sent: Array<{ text: string; html: string }> = [];
  sendEmail(input: { TextBody?: string; HtmlBody?: string }): Promise<unknown> {
    this.sent.push({ text: input.TextBody ?? '', html: input.HtmlBody ?? '' });
    return Promise.resolve({ ErrorCode: 0, Message: 'OK' });
  }
}

interface Harness {
  webhooks: StripeWebhooksService;
  postmark: RecordingPostmark;
  customerId: string;
  subId: string;
}

async function harness(): Promise<Harness> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
  await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
             VALUES (${accountId}::uuid, ${`notice-${accountId}@example.test`},
                     'free'::account_tier, ${customerId})`;
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
    { shouldSend: () => Promise.resolve(false) } as unknown as EmailPreferencesService,
    silent,
    {
      docsBaseUrl: 'https://docs.driftstack.io',
      billingPortalUrl: 'https://app.driftstack.io/billing',
      dashboardUrl: 'https://app.driftstack.io',
    },
  );
  const webhooks = new StripeWebhooksService(
    new DrizzleStripeWebhooksRepo(database()),
    { logger: silent, priceToTier: MAPS.priceToTier, priceToInterval: MAPS.priceToInterval },
    lifecycle,
  );
  return { webhooks, postmark, customerId, subId: `sub_${randomUUID()}` };
}

async function deliver(h: Harness, event: StripeEvent): Promise<void> {
  expect(await h.webhooks.handle(event, JSON.stringify(event))).toBe('handled');
}

function subscriptionEvent(h: Harness, createdSec: number, status: string): StripeEvent {
  return {
    id: `evt_notice_sub_${randomUUID()}`,
    type: status === 'active' ? 'customer.subscription.created' : 'customer.subscription.updated',
    created: createdSec,
    livemode: false,
    data: {
      object: {
        id: h.subId,
        object: 'subscription',
        customer: h.customerId,
        status,
        cancel_at_period_end: false,
        current_period_start: createdSec,
        current_period_end: createdSec + 30 * DAY_S,
        items: { data: [{ id: 'si_1', price: { id: 'price_starter_m' } }] },
      },
    },
  };
}

function paymentFailed(
  h: Harness,
  createdSec: number,
  link: 'older' | 'newer' | 'none' = 'older',
): StripeEvent {
  const subscriptionLink =
    link === 'older'
      ? { subscription: h.subId }
      : link === 'newer'
        ? {
            parent: {
              type: 'subscription_details',
              subscription_details: { subscription: h.subId },
            },
          }
        : {};
  return {
    id: `evt_notice_failed_${randomUUID()}`,
    type: 'invoice.payment_failed',
    created: createdSec,
    livemode: false,
    data: {
      object: {
        id: `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        object: 'invoice',
        customer: h.customerId,
        amount_due: 14_900,
        currency: 'usd',
        next_payment_attempt: createdSec + 3 * DAY_S,
        ...subscriptionLink,
      },
    },
  };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

describe.skipIf(!RUN_DB_TESTS)(
  'the payment-failure notice says until when the paid plan stays',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const link of ['older', 'newer'] as const) {
      it(`CRITICAL [${link} invoice shape] the notice of the first failure says the plan stays until seven days after the subscription fell behind`, async () => {
        const h = await harness();
        const now = nowSec();
        await deliver(h, subscriptionEvent(h, now - 30 * DAY_S, 'active'));
        const fellBehind = now - 120;
        await deliver(h, subscriptionEvent(h, fellBehind, 'past_due'));
        await deliver(h, paymentFailed(h, now - 60, link));

        expect(h.postmark.sent).toHaveLength(1);
        const sentence = `Your paid plan stays active until ${when(fellBehind + 7 * DAY_S)}. If the payment still hasn't gone through by then, your account loses the plan's paid features.`;
        expect(h.postmark.sent[0]?.text).toContain(sentence);
        expect(h.postmark.sent[0]?.html).toContain(
          `<p>Your paid plan stays active until ${when(fellBehind + 7 * DAY_S)}.`,
        );
      });
    }

    it("CRITICAL when the invoice's event is handled before the subscription's own past_due one, the notice counts the seven days from this failure", async () => {
      const h = await harness();
      const now = nowSec();
      await deliver(h, subscriptionEvent(h, now - 30 * DAY_S, 'active'));
      const failedAt = now - 60;
      await deliver(h, paymentFailed(h, failedAt));
      expect(h.postmark.sent[0]?.text).toContain(
        `Your paid plan stays active until ${when(failedAt + 7 * DAY_S)}.`,
      );
    });

    it('CRITICAL a failure after the seven days are over says when the plan stopped', async () => {
      const h = await harness();
      const now = nowSec();
      await deliver(h, subscriptionEvent(h, now - 30 * DAY_S, 'active'));
      const fellBehind = now - 9 * DAY_S;
      await deliver(h, subscriptionEvent(h, fellBehind, 'past_due'));
      await deliver(h, paymentFailed(h, now - 60));
      expect(h.postmark.sent[0]?.text).toContain(
        `Because the payment hadn't gone through, your account lost the plan's paid features on ${when(fellBehind + 7 * DAY_S)}.`,
      );
      expect(h.postmark.sent[0]?.text).not.toContain('stays active until');
    });

    it('a failed first payment and an invoice of no subscription say nothing about the plan, and the email is otherwise what it was', async () => {
      const h = await harness();
      const now = nowSec();
      await deliver(h, {
        ...subscriptionEvent(h, now - 120, 'incomplete'),
        type: 'customer.subscription.created',
      });
      await deliver(h, paymentFailed(h, now - 60));
      await deliver(h, paymentFailed(h, now - 30, 'none'));
      const asBefore = (retrySec: number): string =>
        `We were unable to charge $149.00 on your Driftstack account.\n\nWe'll retry automatically at ${new Date(retrySec * 1000).toISOString()} (UTC). To update payment details, visit the billing portal:\n\nhttps://app.driftstack.io/billing\n\n— Driftstack`;
      expect(h.postmark.sent.map((m) => m.text)).toEqual([
        asBefore(now - 60 + 3 * DAY_S),
        asBefore(now - 30 + 3 * DAY_S),
      ]);
      for (const { html } of h.postmark.sent) expect(html).not.toContain('paid plan');
    });
  },
);
