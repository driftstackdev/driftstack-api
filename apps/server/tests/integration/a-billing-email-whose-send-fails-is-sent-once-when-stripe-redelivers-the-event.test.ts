// A billing email whose send fails is sent once when Stripe redelivers the
// event (live-billing audit #8).
//
// The payment-failure notice, the receipt and the renewal reminder are each
// sent once per Stripe event: a claim row is taken, then the email is sent. The
// email service tried those templates ONCE and swallowed a failure, and the
// claim stayed — so a single Postmark blip lost the email for good. A Stripe
// redelivery found the claim and sent nothing; the event itself was already in
// the processed-events ledger, so Stripe never even redelivered. For the
// failure notice that meant a customer lost their tier with no explanation.
//
// Now a send that fails for a reason that can pass — the connection, Postmark
// being unavailable or rate-limiting — releases its claim, and the webhook
// fails the delivery as retryable: the ledger does not record the event, Stripe
// redelivers it, and the redelivery sends the email. Exactly once on success is
// kept on both paths: a failed-then-redelivered send reaches the customer once,
// and a normal send reaches them once however often the event is redelivered.
// A send refused for good (an address Postmark will never deliver to) is not
// retried for three days: the event is handled, as before.
//
// Driven through the real StripeWebhooksService, AccountLifecycleService and
// email service, with the Drizzle repos on a Postgres rebuilt from the
// migrations. Only Postmark is a scripted double.

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
import { buildInvoice, buildInvoiceEvent, sec } from './_helpers/stripe-invoice-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_live_billing_email_once';
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

/** Postmark, scripted: each queued failure is thrown by one send, in order. */
class ScriptedPostmark implements PostmarkSendApi {
  readonly delivered: Array<{ to: string; subject: string }> = [];
  attempts = 0;
  private readonly failures: Array<() => Error> = [];
  failNext(...makers: Array<() => Error>): void {
    this.failures.push(...makers);
  }
  sendEmail(input: { To: string; Subject: string }): Promise<unknown> {
    this.attempts += 1;
    const fail = this.failures.shift();
    if (fail !== undefined) return Promise.reject(fail());
    this.delivered.push({ to: input.To, subject: input.Subject });
    return Promise.resolve({ ErrorCode: 0, Message: 'OK' });
  }
}

/** The connection to Postmark dropped. */
const connectionReset = (): Error =>
  Object.assign(new Error('socket hang up'), { name: 'ECONNRESET' });
/** Postmark answered 503, as its client reports it. */
const postmarkUnavailable = (): Error =>
  Object.assign(new Error('Service unavailable'), {
    name: 'ServiceUnavailablerError',
    code: 0,
    statusCode: 503,
  });
/** Postmark refused the address for good (a hard-bounced recipient). */
const inactiveRecipient = (): Error =>
  Object.assign(new Error('You tried to send to recipient(s) that have been marked as inactive.'), {
    name: 'InactiveRecipientsError',
    code: 406,
    statusCode: 422,
  });

interface Harness {
  webhooks: StripeWebhooksService;
  postmark: ScriptedPostmark;
  accountId: string;
  customerId: string;
  email: string;
}

async function harness(): Promise<Harness> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
  const email = `billing-once-${accountId}@example.test`;
  await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
             VALUES (${accountId}::uuid, ${email}, 'api_starter'::account_tier, ${customerId})`;
  const postmark = new ScriptedPostmark();
  const emailService = createEmailService({
    config: {
      apiToken: 'pm-test',
      from: 'billing@driftstack.dev',
      replyTo: 'support@driftstack.dev',
    },
    logger: silent,
    client: postmark,
    retryDelayFn: () => Promise.resolve(),
  });
  const preferences = {
    shouldSend: () => Promise.resolve(true),
  } as unknown as EmailPreferencesService;
  const lifecycle = new AccountLifecycleService(
    new DrizzleAccountLifecycleRepo(database()),
    emailService,
    preferences,
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
  return { webhooks, postmark, accountId, customerId, email };
}

type Kind = 'billing-failure' | 'billing-receipt' | 'billing-renewal-reminder';

function eventFor(kind: Kind, h: Harness): StripeEvent {
  const invoiceId = `in_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const eventId = `evt_email_once_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'billing-receipt') {
    const invoice = buildInvoice('older', {
      invoiceId,
      customerId: h.customerId,
      subscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      amountPaid: 14_900,
      lines: [
        {
          priceId: 'price_starter_m',
          amount: 14_900,
          periodStartSec: sec('2026-09-01T00:00:00Z'),
          periodEndSec: sec('2026-10-01T00:00:00Z'),
        },
      ],
    });
    return buildInvoiceEvent({ eventId, type: 'invoice.payment_succeeded', invoice });
  }
  const object =
    kind === 'billing-failure'
      ? {
          id: invoiceId,
          object: 'invoice',
          customer: h.customerId,
          amount_due: 14_900,
          currency: 'usd',
          next_payment_attempt: now + 3 * 24 * 60 * 60,
        }
      : {
          id: invoiceId,
          object: 'invoice',
          customer: h.customerId,
          amount_due: 14_900,
          currency: 'usd',
          next_payment_attempt: now + 7 * 24 * 60 * 60,
        };
  return {
    id: eventId,
    type: kind === 'billing-failure' ? 'invoice.payment_failed' : 'invoice.upcoming',
    created: now,
    livemode: false,
    data: { object },
  };
}

async function claimsOf(eventId: string): Promise<number> {
  const [row] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM billing_email_sends WHERE stripe_event_id = ${eventId}`;
  return row?.n ?? 0;
}

async function ledgerHas(eventId: string): Promise<boolean> {
  const [row] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM processed_stripe_events WHERE event_id = ${eventId}`;
  return (row?.n ?? 0) > 0;
}

const KINDS: readonly Kind[] = ['billing-failure', 'billing-receipt', 'billing-renewal-reminder'];

describe.skipIf(!RUN_DB_TESTS)(
  'a billing email whose send fails is sent once when stripe redelivers the event',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const kind of KINDS) {
      it(`CRITICAL ${kind}: a send that fails on a dropped connection fails the delivery as retryable, keeps the event out of the ledger and releases its claim; Stripe's redelivery sends it ONCE and a further redelivery sends nothing`, async () => {
        const h = await harness();
        const event = eventFor(kind, h);
        const raw = JSON.stringify(event);
        h.postmark.failNext(connectionReset);

        await expect(
          h.webhooks.handle(event, raw),
          'the failed send was swallowed — Stripe would never redeliver it',
        ).rejects.toThrow();
        expect(await ledgerHas(event.id), 'the event was recorded as processed').toBe(false);
        expect(await claimsOf(event.id), 'the send-once claim was kept').toBe(0);
        expect(h.postmark.delivered).toEqual([]);

        expect(await h.webhooks.handle(event, raw)).toBe('handled');
        expect(h.postmark.delivered.map((d) => d.to)).toEqual([h.email]);
        expect(await claimsOf(event.id)).toBe(1);

        expect(await h.webhooks.handle(event, raw)).toBe('duplicate');
        expect(h.postmark.delivered).toHaveLength(1);
      });

      it(`CONTROL ${kind}: a normal send reaches the customer once, and a redelivery sends nothing`, async () => {
        const h = await harness();
        const event = eventFor(kind, h);
        const raw = JSON.stringify(event);

        expect(await h.webhooks.handle(event, raw)).toBe('handled');
        expect(await h.webhooks.handle(event, raw)).toBe('duplicate');

        expect(h.postmark.delivered.map((d) => d.to)).toEqual([h.email]);
        expect(h.postmark.attempts).toBe(1);
        expect(await claimsOf(event.id)).toBe(1);
      });
    }

    it('CRITICAL Postmark answering 503 is a failure that can pass: the delivery is retried and the notice goes out once', async () => {
      const h = await harness();
      const event = eventFor('billing-failure', h);
      const raw = JSON.stringify(event);
      h.postmark.failNext(postmarkUnavailable);

      await expect(h.webhooks.handle(event, raw)).rejects.toThrow();
      expect(await h.webhooks.handle(event, raw)).toBe('handled');
      expect(h.postmark.delivered).toHaveLength(1);
    });

    it('a send Postmark refuses for good is not retried for three days: the event is handled, the claim stays, and a redelivery sends nothing', async () => {
      const h = await harness();
      const event = eventFor('billing-failure', h);
      const raw = JSON.stringify(event);
      h.postmark.failNext(inactiveRecipient);

      expect(await h.webhooks.handle(event, raw)).toBe('handled');
      expect(await ledgerHas(event.id)).toBe(true);
      expect(await claimsOf(event.id)).toBe(1);
      expect(await h.webhooks.handle(event, raw)).toBe('duplicate');
      expect(h.postmark.attempts).toBe(1);
      expect(h.postmark.delivered).toEqual([]);
    });
  },
);
