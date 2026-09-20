// The period backfill is resumable, and writes nothing twice.
//
// It pages 13 months of paid invoices out of Stripe and walks the subscription
// mirror for rows with no period start. It will be run by hand, against a live
// Stripe account, and it WILL be interrupted: a timeout, a deploy, a rate limit.
// What has to be true afterwards:
//
//   · nothing it already wrote is written again — not a second row, and not a
//     rewrite of the same row (each row's xmin is compared across runs);
//   · handing back the cursor it reported resumes AFTER the last finished page,
//     in the same 13-month window, instead of starting over;
//   · an interruption in the MIDDLE of a page loses nothing: the cursor stays at
//     the end of the page before, and the re-read invoices come back unchanged;
//   · a subscription's start is filled ONLY where none is stored, and a start
//     Stripe could not supply is derived from the period's end and marked so;
//   · a Stripe outage is never mistaken for "Stripe does not know it".
//
// Driven against the real Drizzle repo on a Postgres rebuilt from the
// migrations, with a fake Stripe that pages exactly as the real list endpoint
// does (newest first, `starting_after`, `has_more`).

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import {
  BACKFILL_WINDOW_MONTHS,
  StripePeriodBackfillInterrupted,
  runStripePeriodBackfill,
  type StripePeriodBackfillDeps,
  type StripePeriodBackfillReport,
  type StripePeriodBackfillStripe,
} from '../../src/services/stripe-period-backfill.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { buildInvoice, sec, type InvoiceSpec } from './_helpers/stripe-invoice-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_period_backfill';
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

// The subscription walk reads the WHOLE table, so each arm starts from an empty
// one. Whole-table deletes: proven to be on this file's own database first.
beforeEach(async () => {
  if (client === null) return;
  await assertIsolatedDatabase(client, ISOLATED_DB_NAME);
  await client`DELETE FROM billing_invoice_payments`;
  await client`DELETE FROM subscriptions`;
});

const NOW = new Date('2026-09-15T12:00:00Z');
const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
});
const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const stripeApiError = (status: number): Error =>
  Object.assign(new Error('Stripe request failed'), {
    name: 'StripeApiError',
    status,
    stripeError: { type: status === 404 ? 'invalid_request_error' : 'api_error' },
  });

interface ListCall {
  status: string;
  createdGte: string;
  limit: number;
  startingAfter: string | null;
}

/** Stripe's invoice list, faithfully: newest first, `starting_after`, `has_more`. */
class FakeStripe implements StripePeriodBackfillStripe {
  readonly listCalls: ListCall[] = [];
  readonly invoiceGets: string[] = [];
  readonly subscriptionGets: string[] = [];
  /** 1-based list call numbers that fail, once each. */
  failListCalls = new Set<number>();
  subscriptions = new Map<string, Record<string, unknown> | Error>();

  constructor(private readonly invoices: Array<Record<string, unknown>>) {}

  listInvoices(args: {
    status: 'paid';
    createdGte: Date;
    limit: number;
    startingAfter?: string;
  }): Promise<{ data: Array<Record<string, unknown>>; hasMore: boolean }> {
    this.listCalls.push({
      status: args.status,
      createdGte: args.createdGte.toISOString(),
      limit: args.limit,
      startingAfter: args.startingAfter ?? null,
    });
    if (this.failListCalls.delete(this.listCalls.length)) {
      return Promise.reject(stripeApiError(503));
    }
    const inWindow = this.invoices.filter(
      (i) => (i.created as number) * 1000 >= args.createdGte.getTime(),
    );
    const from =
      args.startingAfter === undefined
        ? 0
        : inWindow.findIndex((i) => i.id === args.startingAfter) + 1;
    const data = inWindow.slice(from, from + args.limit);
    return Promise.resolve({ data, hasMore: from + args.limit < inWindow.length });
  }

  getInvoice(invoiceId: string): Promise<Record<string, unknown>> {
    this.invoiceGets.push(invoiceId);
    const found = this.invoices.find((i) => i.id === invoiceId);
    return found === undefined ? Promise.reject(stripeApiError(404)) : Promise.resolve(found);
  }

  getSubscription(subscriptionId: string): Promise<Record<string, unknown>> {
    this.subscriptionGets.push(subscriptionId);
    const found = this.subscriptions.get(subscriptionId) ?? stripeApiError(404);
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
  }
}

async function newCustomer(): Promise<{ accountId: string; customerId: string }> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId}`;
  await db()`INSERT INTO accounts (id, email, stripe_customer_id)
             VALUES (${accountId}::uuid, ${`backfill-${accountId}@example.test`}, ${customerId})`;
  return { accountId, customerId };
}

/** `count` monthly invoices for one customer, NEWEST FIRST, as Stripe lists them. */
function monthlyInvoices(customerId: string, count: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    // i = 0 is the newest: the period that started 2026-09-01.
    const start = new Date(Date.UTC(2026, 8 - i, 1));
    const end = new Date(Date.UTC(2026, 9 - i, 1));
    const spec: InvoiceSpec = {
      invoiceId: `in_${String(100 - i)}`,
      customerId,
      subscriptionId: 'sub_backfill',
      amountPaid: 14900,
      paymentIntentId: `pi_${String(100 - i)}`,
      paidAtSec: start.getTime() / 1000 + 3600,
      lines: [
        {
          priceId: 'price_starter_m',
          amount: 14900,
          periodStartSec: start.getTime() / 1000,
          periodEndSec: end.getTime() / 1000,
        },
      ],
    };
    out.push(buildInvoice(i % 2 === 0 ? 'older' : 'newer', spec));
  }
  return out;
}

function deps(stripe: FakeStripe, extra: Partial<StripePeriodBackfillDeps> = {}) {
  if (pool === null) throw new Error('isolated database unreachable');
  return {
    stripe,
    repo: new DrizzleStripeWebhooksRepo(pool),
    maps: MAPS,
    logger: silent,
    ...extra,
  };
}

async function storedInvoices(): Promise<
  Array<{ id: string; xmin: string; kind: string | null; start: string | null }>
> {
  const rows = await db()<
    Array<{ id: string; xmin: string; kind: string | null; start: Date | null }>
  >`SELECT stripe_invoice_id AS id, xmin::text AS xmin, line_kind AS kind,
           line_period_start AS start
      FROM billing_invoice_payments ORDER BY stripe_invoice_id DESC`;
  return rows.map((r) => ({
    id: r.id,
    xmin: r.xmin,
    kind: r.kind,
    start: r.start?.toISOString() ?? null,
  }));
}

describe.skipIf(!RUN_DB_TESTS)('the period backfill is resumable and writes nothing twice', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL it reads PAID invoices of the last 13 months, page by page, and records each with its line’s period and plan — skipping customers that are no account here', async () => {
    const { accountId, customerId } = await newCustomer();
    const invoices = monthlyInvoices(customerId, 5);
    const strangers = monthlyInvoices('cus_not_an_account_here', 1).map((i) => ({
      ...i,
      id: 'in_stranger',
    }));
    // One invoice older than the window: Stripe is asked not to return it.
    const ancient = buildInvoice('older', {
      invoiceId: 'in_ancient',
      customerId,
      subscriptionId: 'sub_backfill',
      amountPaid: 14900,
      paidAtSec: sec('2025-01-01T01:00:00Z'),
      lines: [
        {
          priceId: 'price_starter_m',
          amount: 14900,
          periodStartSec: sec('2025-01-01T00:00:00Z'),
          periodEndSec: sec('2025-02-01T00:00:00Z'),
        },
      ],
    });
    const stripe = new FakeStripe([...strangers, ...invoices, ancient]);

    const report = await runStripePeriodBackfill(deps(stripe), { now: NOW, invoicePageSize: 2 });

    expect(BACKFILL_WINDOW_MONTHS).toBe(13);
    expect(stripe.listCalls).toEqual([
      { status: 'paid', createdGte: '2025-08-15T12:00:00.000Z', limit: 2, startingAfter: null },
      { status: 'paid', createdGte: '2025-08-15T12:00:00.000Z', limit: 2, startingAfter: 'in_100' },
      { status: 'paid', createdGte: '2025-08-15T12:00:00.000Z', limit: 2, startingAfter: 'in_98' },
    ]);
    expect(report.invoices).toEqual({
      seen: 6,
      inserted: 5,
      completed: 0,
      unchanged: 0,
      notPaid: 0,
      unknownCustomer: 1,
      unreadable: 0,
      accountMismatch: 0,
      unlinked: 0,
    });
    expect(report.cursor.invoices).toEqual({ done: true, after: 'in_96' });

    const rows = await db()<Array<Record<string, unknown>>>`
      SELECT stripe_invoice_id, account_id, line_kind, line_tier::text AS line_tier, line_interval,
             stripe_payment_intent_id,
             to_char(line_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS starts,
             to_char(line_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS ends,
             to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS paid_at
        FROM billing_invoice_payments ORDER BY stripe_invoice_id DESC`;
    expect(rows.map((r) => ({ ...r }))).toEqual(
      [
        ['in_99', 'pi_99', '2026-08-01', '2026-09-01'],
        ['in_98', 'pi_98', '2026-07-01', '2026-08-01'],
        ['in_97', 'pi_97', '2026-06-01', '2026-07-01'],
        ['in_96', 'pi_96', '2026-05-01', '2026-06-01'],
        ['in_100', 'pi_100', '2026-09-01', '2026-10-01'],
      ].map(([id, pi, starts, ends]) => ({
        stripe_invoice_id: id,
        account_id: accountId,
        line_kind: 'period',
        line_tier: 'api_starter',
        line_interval: 'month',
        stripe_payment_intent_id: pi,
        starts,
        ends,
        paid_at: `${String(starts)}T01:00`,
      })),
    );
  });

  it('CRITICAL RESUMABLE — interrupted between pages: it throws with the cursor of the last finished page; resuming from that cursor asks Stripe for the NEXT page in the SAME window, finishes the job, and rewrites nothing it had written', async () => {
    const { customerId } = await newCustomer();
    const stripe = new FakeStripe(monthlyInvoices(customerId, 7));
    stripe.failListCalls.add(3);
    const progress: StripePeriodBackfillReport[] = [];

    const interrupted = await runStripePeriodBackfill(deps(stripe), {
      now: NOW,
      invoicePageSize: 2,
      onProgress: (r) => {
        progress.push(r);
      },
    }).catch((err: unknown) => err);

    expect(interrupted).toBeInstanceOf(StripePeriodBackfillInterrupted);
    const cursor = (interrupted as StripePeriodBackfillInterrupted).report.cursor;
    expect(cursor).toEqual({
      windowStart: '2025-08-15T12:00:00.000Z',
      invoices: { done: false, after: 'in_97' },
      subscriptions: { done: false, after: null },
    });
    // The progress callback had already been handed that same cursor.
    expect(progress.map((r) => r.cursor.invoices.after)).toEqual(['in_99', 'in_97']);
    const afterFirstRun = await storedInvoices();
    expect(afterFirstRun.map((r) => r.id)).toEqual(['in_99', 'in_98', 'in_97', 'in_100']);

    // Resume — a day later, which must NOT move the window.
    const resumed = await runStripePeriodBackfill(deps(stripe), {
      now: new Date('2026-09-16T12:00:00Z'),
      invoicePageSize: 2,
      resumeFrom: cursor,
    });
    expect(stripe.listCalls.slice(3)).toEqual([
      { status: 'paid', createdGte: '2025-08-15T12:00:00.000Z', limit: 2, startingAfter: 'in_97' },
      { status: 'paid', createdGte: '2025-08-15T12:00:00.000Z', limit: 2, startingAfter: 'in_95' },
    ]);
    expect(resumed.invoices).toMatchObject({ seen: 3, inserted: 3, completed: 0, unchanged: 0 });
    expect(resumed.cursor.invoices).toEqual({ done: true, after: 'in_94' });

    const afterResume = await storedInvoices();
    expect(afterResume).toHaveLength(7);
    // Nothing written by the first run was touched by the second.
    for (const before of afterFirstRun) {
      expect(afterResume.find((r) => r.id === before.id)?.xmin, before.id).toBe(before.xmin);
    }
    // The caller's cursor object was not written to.
    expect(cursor.invoices).toEqual({ done: false, after: 'in_97' });
  });

  it('CRITICAL WRITES NOTHING TWICE — a whole second run on top of a finished one inserts nothing, completes nothing, and leaves every row’s xmin where it was', async () => {
    const { customerId } = await newCustomer();
    const stripe = new FakeStripe(monthlyInvoices(customerId, 6));
    const first = await runStripePeriodBackfill(deps(stripe), { now: NOW, invoicePageSize: 4 });
    expect(first.invoices).toMatchObject({ seen: 6, inserted: 6 });
    const before = await storedInvoices();

    const second = await runStripePeriodBackfill(deps(stripe), { now: NOW, invoicePageSize: 4 });
    expect(second.invoices).toEqual({
      seen: 6,
      inserted: 0,
      completed: 0,
      unchanged: 6,
      notPaid: 0,
      unknownCustomer: 0,
      unreadable: 0,
      accountMismatch: 0,
      unlinked: 0,
    });
    expect(await storedInvoices()).toEqual(before);
  });

  it('CRITICAL an interruption in the MIDDLE of a page loses nothing: the cursor stays at the end of the page before, and the resumed run re-reads the broken page — its already-written invoice comes back unchanged, and every invoice ends up stored exactly once', async () => {
    const { customerId } = await newCustomer();
    const stripe = new FakeStripe(monthlyInvoices(customerId, 6));
    const base = deps(stripe);
    const repo = base.repo;
    const real = repo.upsertInvoicePayment.bind(repo);
    let failed = false;
    // Page 2 is [in_98, in_97]: in_98 is written, then in_97's write fails once.
    repo.upsertInvoicePayment = (args) => {
      if (args.stripeInvoiceId === 'in_97' && !failed) {
        failed = true;
        return Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      }
      return real(args);
    };

    const interrupted = await runStripePeriodBackfill(base, {
      now: NOW,
      invoicePageSize: 2,
    }).catch((err: unknown) => err);
    expect(interrupted).toBeInstanceOf(StripePeriodBackfillInterrupted);
    const report = (interrupted as StripePeriodBackfillInterrupted).report;
    expect(report.cursor.invoices).toEqual({ done: false, after: 'in_99' });
    expect((interrupted as Error).cause).toMatchObject({ code: 'ECONNRESET' });
    const partial = await storedInvoices();
    expect(partial.map((r) => r.id)).toEqual(['in_99', 'in_98', 'in_100']);

    const resumed = await runStripePeriodBackfill(base, {
      now: NOW,
      invoicePageSize: 2,
      resumeFrom: report.cursor,
    });
    expect(resumed.invoices).toMatchObject({ seen: 4, inserted: 3, unchanged: 1 });
    const complete = await storedInvoices();
    expect(complete.map((r) => r.id)).toEqual([
      'in_99',
      'in_98',
      'in_97',
      'in_96',
      'in_95',
      'in_100',
    ]);
    for (const before of partial) {
      expect(complete.find((r) => r.id === before.id)?.xmin, before.id).toBe(before.xmin);
    }
  });

  it('it COMPLETES a payment the webhook recorded with no period, and never moves a period that is already known', async () => {
    const { accountId, customerId } = await newCustomer();
    const [newest, older] = monthlyInvoices(customerId, 2);
    // The webhook saw `in_100` in a shape it could not read...
    await db()`INSERT INTO billing_invoice_payments
                 (stripe_invoice_id, account_id, amount_paid_minor, currency, paid_at)
               VALUES ('in_100', ${accountId}::uuid, 14900, 'usd', '2026-09-01T01:00:00Z')`;
    // ...and recorded `in_99` against a period that is NOT what Stripe says now.
    await db()`INSERT INTO billing_invoice_payments
                 (stripe_invoice_id, account_id, stripe_subscription_id, amount_paid_minor,
                  currency, line_kind, line_stripe_price_id, line_tier, line_interval,
                  line_period_start, line_period_end, paid_at)
               VALUES ('in_99', ${accountId}::uuid, 'sub_backfill', 14900, 'usd', 'period',
                       'price_starter_m', 'api_starter', 'month',
                       '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-08-01T01:00:00Z')`;
    const stripe = new FakeStripe([newest ?? {}, older ?? {}]);

    const report = await runStripePeriodBackfill(deps(stripe), { now: NOW });
    expect(report.invoices).toMatchObject({ seen: 2, inserted: 0, completed: 2, unchanged: 0 });
    const stored = await storedInvoices();
    expect(stored.map((r) => [r.id, r.kind, r.start])).toEqual([
      ['in_99', 'period', '2026-01-01T00:00:00.000Z'],
      ['in_100', 'period', '2026-09-01T00:00:00.000Z'],
    ]);
  });

  it('an invoice that still names no line is recorded, counted, and raised as ONE alert for the run, with the count and no identifier', async () => {
    const { customerId } = await newCustomer();
    const unlinkable = monthlyInvoices(customerId, 3).map((i) => {
      const copy = { ...i };
      delete copy.subscription;
      delete copy.parent;
      return copy;
    });
    const alerts: SentryMessage[] = [];
    const report = await runStripePeriodBackfill(
      deps(new FakeStripe(unlinkable), {
        sentry: { captureMessage: (m) => void alerts.push(m) },
      }),
      { now: NOW },
    );
    expect(report.invoices).toMatchObject({ seen: 3, inserted: 3, unlinked: 3 });
    expect((await storedInvoices()).map((r) => r.kind)).toEqual([null, null, null]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.extra).toEqual({ reason: 'no_subscription', source: 'backfill', count: 3 });
    expect(JSON.stringify(alerts[0])).not.toMatch(/in_\d+|cus_/);
  });

  it('CRITICAL a paid invoice that cannot be read, or that is already recorded against ANOTHER account, is counted and stepped past: nothing is written for it, the row it collided with is not touched, its neighbours are recorded, and the run ends. Only the collision is an alert; both leave the invoice id in the log, which is where the operator finds it.', async () => {
    const other = await newCustomer();
    const { accountId, customerId } = await newCustomer();
    const invoices = monthlyInvoices(customerId, 4);
    // in_99: paid, but its amount is not a whole number of minor units.
    const unreadable = invoices[1];
    if (unreadable === undefined) throw new Error('fixture: no second invoice');
    unreadable.amount_paid = 12.5;
    // in_98: already on record, for a different account.
    await db()`INSERT INTO billing_invoice_payments
                 (stripe_invoice_id, account_id, amount_paid_minor, currency, paid_at)
               VALUES ('in_98', ${other.accountId}::uuid, 14900, 'usd', now())`;
    const [before] = await db()<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin FROM billing_invoice_payments WHERE stripe_invoice_id = 'in_98'`;

    const alerts: SentryMessage[] = [];
    const errors: Array<Record<string, unknown>> = [];
    const logger = {
      ...silent,
      error: (fields: Record<string, unknown>) => void errors.push(fields),
    } as unknown as Logger;
    const report = await runStripePeriodBackfill(
      deps(new FakeStripe(invoices), {
        logger,
        sentry: { captureMessage: (m) => void alerts.push(m) },
      }),
      { now: NOW, invoicePageSize: 2 },
    );

    expect(report.invoices).toEqual({
      seen: 4,
      inserted: 2,
      completed: 0,
      unchanged: 0,
      notPaid: 0,
      unknownCustomer: 0,
      unreadable: 1,
      accountMismatch: 1,
      unlinked: 0,
    });
    // The walk stepped past both, to the end: neither can be retried into a loop.
    expect(report.cursor.invoices).toEqual({ done: true, after: 'in_97' });

    const stored = await db()<Array<{ id: string; account: string; xmin: string }>>`
      SELECT stripe_invoice_id AS id, account_id::text AS account, xmin::text AS xmin
        FROM billing_invoice_payments`;
    expect(Object.fromEntries(stored.map((r) => [r.id, r.account]))).toEqual({
      in_100: accountId,
      in_98: other.accountId,
      in_97: accountId,
    });
    expect(
      stored.find((r) => r.id === 'in_98')?.xmin,
      'the row recorded for the other account was rewritten',
    ).toBe(before?.xmin);

    expect(errors.map((e) => e.stripeInvoiceId)).toEqual(['in_99', 'in_98']);
    expect(alerts.map((a) => a.extra)).toEqual([
      { reason: 'account_mismatch', source: 'backfill', count: 1 },
    ]);
    expect(JSON.stringify(alerts)).not.toMatch(/in_\d+|cus_|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('CRITICAL a subscription’s period start is filled ONLY where none is stored: from Stripe when Stripe knows it, DERIVED from the period’s end when Stripe does not — and a start a webhook wrote is never touched', async () => {
    const { accountId } = await newCustomer();
    const row = (
      id: string,
      priceId: string,
      end: string | null,
      start: string | null = null,
    ): Promise<unknown> => db()`
      INSERT INTO subscriptions
        (account_id, stripe_subscription_id, stripe_price_id, tier, status,
         current_period_end, current_period_start, period_start_source)
      VALUES (${accountId}::uuid, ${id}, ${priceId}, 'api_starter', 'active', ${end}, ${start},
              ${start === null ? null : 'stripe'})`;
    await row('sub_a_stripe_knows', 'price_starter_m', '2026-10-01T00:00:00Z');
    await row('sub_b_monthly_gone', 'price_starter_m', '2026-03-31T00:00:00Z');
    await row('sub_c_annual_gone', 'price_starter_y', '2027-02-28T00:00:00Z');
    await row(
      'sub_d_webhook_wrote',
      'price_starter_m',
      '2026-10-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
    );
    await row('sub_e_custom_price', 'price_custom', '2026-10-01T00:00:00Z');
    await row('sub_f_no_end', 'price_starter_m', null);

    const stripe = new FakeStripe([]);
    stripe.subscriptions.set('sub_a_stripe_knows', {
      id: 'sub_a_stripe_knows',
      // The newer shape: the start lives on the item.
      items: { data: [{ current_period_start: sec('2026-09-01T00:00:00Z') }] },
    });
    // Stripe would say something different for D; it must never be asked.
    stripe.subscriptions.set('sub_d_webhook_wrote', {
      id: 'sub_d_webhook_wrote',
      current_period_start: sec('2020-01-01T00:00:00Z'),
    });

    const report = await runStripePeriodBackfill(deps(stripe), {
      now: NOW,
      subscriptionPageSize: 2,
    });

    expect(report.subscriptions).toEqual({
      seen: 5,
      filledFromStripe: 1,
      filledDerived: 2,
      notFilled: 2,
    });
    expect(stripe.subscriptionGets).not.toContain('sub_d_webhook_wrote');

    const rows = await db()<Array<Record<string, unknown>>>`
      SELECT stripe_subscription_id AS id,
             to_char(current_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS starts,
             period_start_source AS source, billing_interval AS interval
        FROM subscriptions ORDER BY stripe_subscription_id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { id: 'sub_a_stripe_knows', starts: '2026-09-01', source: 'stripe', interval: 'month' },
      // One month before 31 March is the LAST day of February, not 3 March.
      { id: 'sub_b_monthly_gone', starts: '2026-02-28', source: 'derived', interval: 'month' },
      { id: 'sub_c_annual_gone', starts: '2026-02-28', source: 'derived', interval: 'year' },
      { id: 'sub_d_webhook_wrote', starts: '2026-09-01', source: 'stripe', interval: null },
      { id: 'sub_e_custom_price', starts: null, source: null, interval: null },
      { id: 'sub_f_no_end', starts: null, source: null, interval: null },
    ]);

    // And a second run fills nothing more and asks only about the two it could not fill.
    const again = await runStripePeriodBackfill(deps(stripe), { now: NOW });
    expect(again.subscriptions).toEqual({
      seen: 2,
      filledFromStripe: 0,
      filledDerived: 0,
      notFilled: 2,
    });
  });

  it('CRITICAL a Stripe OUTAGE is not "Stripe does not know this subscription": it interrupts the run, with a cursor, and derives nothing', async () => {
    const { accountId } = await newCustomer();
    for (const id of ['sub_1_fine', 'sub_2_outage', 'sub_3_never_reached']) {
      await db()`INSERT INTO subscriptions
                   (account_id, stripe_subscription_id, stripe_price_id, tier, status,
                    current_period_end)
                 VALUES (${accountId}::uuid, ${id}, 'price_starter_m', 'api_starter', 'active',
                         '2026-10-01T00:00:00Z')`;
    }
    const stripe = new FakeStripe([]);
    stripe.subscriptions.set('sub_1_fine', {
      id: 'sub_1_fine',
      current_period_start: sec('2026-09-01T00:00:00Z'),
    });
    stripe.subscriptions.set('sub_2_outage', stripeApiError(503));

    const interrupted = await runStripePeriodBackfill(deps(stripe), {
      now: NOW,
      subscriptionPageSize: 1,
    }).catch((err: unknown) => err);
    expect(interrupted).toBeInstanceOf(StripePeriodBackfillInterrupted);
    const report = (interrupted as StripePeriodBackfillInterrupted).report;
    expect(report.cursor.invoices.done).toBe(true);
    expect(report.cursor.subscriptions).toEqual({ done: false, after: 'sub_1_fine' });

    const rows = await db()<Array<{ id: string; source: string | null }>>`
      SELECT stripe_subscription_id AS id, period_start_source AS source
        FROM subscriptions ORDER BY stripe_subscription_id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { id: 'sub_1_fine', source: 'stripe' },
      { id: 'sub_2_outage', source: null },
      { id: 'sub_3_never_reached', source: null },
    ]);

    // Stripe recovers; resuming skips the invoice phase and the row already done.
    stripe.subscriptions.set('sub_2_outage', {
      id: 'sub_2_outage',
      current_period_start: sec('2026-09-01T00:00:00Z'),
    });
    const calls = stripe.listCalls.length;
    const resumed = await runStripePeriodBackfill(deps(stripe), {
      now: NOW,
      subscriptionPageSize: 1,
      resumeFrom: report.cursor,
    });
    expect(stripe.listCalls.length, 'the finished invoice phase was run again').toBe(calls);
    expect(resumed.subscriptions).toEqual({
      seen: 2,
      filledFromStripe: 1,
      filledDerived: 1,
      notFilled: 0,
    });
  });

  it('named invoices are read one by one with getInvoice, without paging the window or walking subscriptions', async () => {
    const { customerId } = await newCustomer();
    const stripe = new FakeStripe(monthlyInvoices(customerId, 4));
    const report = await runStripePeriodBackfill(deps(stripe), {
      now: NOW,
      invoiceIds: ['in_98', 'in_100'],
    });
    expect(stripe.invoiceGets).toEqual(['in_98', 'in_100']);
    expect(stripe.listCalls).toEqual([]);
    expect(stripe.subscriptionGets).toEqual([]);
    expect(report.invoices).toMatchObject({ seen: 2, inserted: 2 });
    expect((await storedInvoices()).map((r) => r.id)).toEqual(['in_98', 'in_100']);
  });

  it('CRITICAL a page size that is not a positive whole number cannot make the walk SPIN. A page of 0 rows is "fewer than none" to no loop: read as it was given, the subscription walk would ask the database for the same empty page for ever. Such a size falls back to the default, and the walk ends.', async () => {
    const { accountId } = await newCustomer();
    for (const id of ['sub_spin_1', 'sub_spin_2', 'sub_spin_3']) {
      await db()`INSERT INTO subscriptions
                   (account_id, stripe_subscription_id, stripe_price_id, tier, status,
                    current_period_end)
                 VALUES (${accountId}::uuid, ${id}, 'price_starter_m', 'api_starter', 'active',
                         '2026-10-01T00:00:00Z')`;
    }
    for (const size of [0, -3, Number.NaN, 0.5, Number.POSITIVE_INFINITY]) {
      await db()`UPDATE subscriptions SET current_period_start = NULL, period_start_source = NULL`;
      const base = deps(new FakeStripe([]));
      let reads = 0;
      const limits: number[] = [];
      const repo: StripePeriodBackfillDeps['repo'] = {
        findAccountIdFromCustomerOrRef: (a) => base.repo.findAccountIdFromCustomerOrRef(a),
        upsertInvoicePayment: (a) => base.repo.upsertInvoicePayment(a),
        fillSubscriptionPeriodStart: (a) => base.repo.fillSubscriptionPeriodStart(a),
        listSubscriptionsMissingPeriodStart: (a) => {
          reads += 1;
          limits.push(a.limit);
          // The tripwire: a walk over three rows has no business reading 25 pages.
          if (reads > 25) throw new Error(`the walk is spinning (page size ${String(size)})`);
          return base.repo.listSubscriptionsMissingPeriodStart(a);
        },
      };
      const report = await runStripePeriodBackfill(
        { ...base, repo },
        { now: NOW, subscriptionPageSize: size, invoicePageSize: size },
      );
      expect(report.subscriptions, String(size)).toEqual({
        seen: 3,
        filledFromStripe: 0,
        filledDerived: 3,
        notFilled: 0,
      });
      expect(report.cursor.subscriptions.done, String(size)).toBe(true);
      for (const limit of limits) {
        expect(
          Number.isInteger(limit) && limit >= 1,
          `${String(size)} reached the database as ${String(limit)}`,
        ).toBe(true);
      }
    }
  });
});
