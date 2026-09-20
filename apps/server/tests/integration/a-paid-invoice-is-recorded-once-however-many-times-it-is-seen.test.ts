// A paid invoice is recorded ONCE, however many times it is seen — including by
// two connections at the same moment.
//
// Stripe sends two events for one paid invoice, retries each for days, and the
// webhook service runs its handlers BEFORE it records the event as processed, so
// two deliveries of one invoice really do reach `upsertInvoicePayment` together.
// The backfill reads the same invoices again later. None of that may write a
// second row, and none of it may rewrite a fact already recorded; a later
// sighting may only complete a record that was missing something.
//
// Three layers, each proven here:
//
//   1. THE CONTRACT, run against BOTH implementations — the Drizzle repo on a
//      real Postgres and the in-memory double the rest of the suite runs on. They
//      share the merge rule by import, so this pins the plumbing around it.
//   2. WHAT IS ACTUALLY STORED, read back with raw SQL, and that an 'unchanged'
//      sighting writes nothing at all (the row's xmin does not move).
//   3. CONCURRENCY, with two real connections: a free race over many invoices,
//      and an explicit interleaving in which the second writer is OBSERVED
//      blocked on the first before the first commits.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { InvoicePaymentRecord } from '../../src/lib/invoice-payment-record.js';
import type { PaidInvoiceLine } from '../../src/lib/stripe-billing-facts.js';
import type { StripeWebhooksRepo } from '../../src/services/stripe-webhooks.js';
import {
  gate,
  newAccount,
  openLedgerDatabase,
  waitUntilBlocked,
} from './_helpers/credit-ledger-fixtures.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const ISOLATED_DB_NAME = 'driftstack_iso_paid_invoice_upsert';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
const pools: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  for (let i = 0; i < 2; i += 1) pools.push(createDb(opened.url, { max: 1 }));
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(pools.map((p) => p.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function pool(i: 0 | 1): Database {
  const p = pools[i];
  if (p === undefined) throw new Error('isolated database unreachable');
  return p;
}

async function pidOf(p: Database): Promise<number> {
  const [row] = await p.client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

const MARCH: PaidInvoiceLine = {
  kind: 'period',
  stripePriceId: 'price_starter_m',
  tier: 'api_starter',
  interval: 'month',
  periodStart: new Date('2026-03-01T00:00:00Z'),
  periodEnd: new Date('2026-04-01T00:00:00Z'),
};

function sighting(
  accountId: string,
  overrides: Partial<InvoicePaymentRecord> = {},
): InvoicePaymentRecord {
  return {
    stripeInvoiceId: `in_${randomUUID()}`,
    accountId,
    stripeSubscriptionId: 'sub_1',
    billingReason: 'subscription_cycle',
    amountPaidMinor: 14900,
    currency: 'usd',
    stripePaymentIntentId: 'pi_1',
    stripeChargeId: 'ch_1',
    line: MARCH,
    paidAt: new Date('2026-03-01T01:00:00Z'),
    ...overrides,
  };
}

/** An error's SQLSTATE, whether Postgres raised it bare or drizzle wrapped it. */
function sqlStateOf(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === 'string') return e.code;
  return typeof e.cause?.code === 'string' ? e.cause.code : null;
}

interface Subject {
  name: string;
  repo: Pick<StripeWebhooksRepo, 'upsertInvoicePayment'>;
  newAccount: () => Promise<string>;
  /** The stored record for an invoice, in the merge rule's own terms. */
  stored: (stripeInvoiceId: string) => Promise<{
    accountId: string;
    amountPaidMinor: number;
    subscriptionId: string | null;
    lineKind: string | null;
    lineTier: string | null;
    linePeriodStart: string | null;
  } | null>;
}

function drizzleSubject(): Subject {
  return {
    name: 'Drizzle on Postgres',
    repo: new DrizzleStripeWebhooksRepo(pool(0)),
    newAccount: () => newAccount(db()),
    stored: async (id) => {
      const [row] = await db()<
        Array<{
          account_id: string;
          amount_paid_minor: string;
          stripe_subscription_id: string | null;
          line_kind: string | null;
          line_tier: string | null;
          line_period_start: Date | null;
        }>
      >`SELECT account_id, amount_paid_minor::text, stripe_subscription_id, line_kind,
               line_tier::text, line_period_start
          FROM billing_invoice_payments WHERE stripe_invoice_id = ${id}`;
      if (row === undefined) return null;
      return {
        accountId: row.account_id,
        amountPaidMinor: Number(row.amount_paid_minor),
        subscriptionId: row.stripe_subscription_id,
        lineKind: row.line_kind,
        lineTier: row.line_tier,
        linePeriodStart: row.line_period_start?.toISOString() ?? null,
      };
    },
  };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryStripeWebhooksRepo();
  return {
    name: 'the in-memory double',
    repo,
    newAccount: () => {
      const accountId = randomUUID();
      repo.registerAccount({ accountId, stripeCustomerId: `cus_${accountId}` });
      return Promise.resolve(accountId);
    },
    stored: (id) => {
      const r = repo.listInvoicePayments().find((p) => p.stripeInvoiceId === id);
      if (r === undefined) return Promise.resolve(null);
      return Promise.resolve({
        accountId: r.accountId,
        amountPaidMinor: r.amountPaidMinor,
        subscriptionId: r.stripeSubscriptionId,
        lineKind: r.line?.kind ?? null,
        lineTier: r.line?.tier ?? null,
        linePeriodStart: r.line?.periodStart.toISOString() ?? null,
      });
    },
  };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a paid invoice is recorded once, however many times it is seen',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable, with two separate connections — otherwise every arm below would fail on setup, not on what it proves', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(await pidOf(pool(0))).not.toBe(await pidOf(pool(1)));
    });

    for (const makeSubject of [drizzleSubject, inMemorySubject]) {
      const label = makeSubject === drizzleSubject ? 'Drizzle on Postgres' : 'the in-memory double';

      it(`CRITICAL [${label}] the first sighting writes the row; the same invoice seen again writes nothing and says so`, async () => {
        const s = makeSubject();
        const first = sighting(await s.newAccount());
        expect(await s.repo.upsertInvoicePayment(first)).toEqual({
          outcome: 'inserted',
          linked: true,
        });
        for (let i = 0; i < 3; i += 1) {
          expect(await s.repo.upsertInvoicePayment({ ...first })).toEqual({
            outcome: 'unchanged',
            linked: true,
          });
        }
        expect(await s.stored(first.stripeInvoiceId)).toEqual({
          accountId: first.accountId,
          amountPaidMinor: 14900,
          subscriptionId: 'sub_1',
          lineKind: 'period',
          lineTier: 'api_starter',
          linePeriodStart: '2026-03-01T00:00:00.000Z',
        });
      });

      it(`CRITICAL [${label}] a record that named no line is completed by a sighting that can read it, and a known period is never moved afterwards`, async () => {
        const s = makeSubject();
        const accountId = await s.newAccount();
        const unread = sighting(accountId, {
          line: null,
          stripeSubscriptionId: null,
          stripePaymentIntentId: null,
        });
        expect(await s.repo.upsertInvoicePayment(unread)).toEqual({
          outcome: 'inserted',
          linked: false,
        });
        expect((await s.stored(unread.stripeInvoiceId))?.lineKind).toBeNull();

        const readable = sighting(accountId, { stripeInvoiceId: unread.stripeInvoiceId });
        expect(await s.repo.upsertInvoicePayment(readable)).toEqual({
          outcome: 'completed',
          linked: true,
        });
        expect(await s.stored(unread.stripeInvoiceId)).toMatchObject({
          subscriptionId: 'sub_1',
          lineKind: 'period',
          linePeriodStart: '2026-03-01T00:00:00.000Z',
        });

        // A LATER sighting that reads a different period changes nothing.
        const april: PaidInvoiceLine = {
          ...MARCH,
          tier: 'api_scale',
          periodStart: new Date('2026-04-01T00:00:00Z'),
          periodEnd: new Date('2026-05-01T00:00:00Z'),
        };
        expect(await s.repo.upsertInvoicePayment({ ...readable, line: april })).toEqual({
          outcome: 'unchanged',
          linked: true,
        });
        expect(await s.stored(unread.stripeInvoiceId)).toMatchObject({
          lineTier: 'api_starter',
          linePeriodStart: '2026-03-01T00:00:00.000Z',
        });
        // Nor does a sighting that can read NO line erase the one recorded.
        expect(await s.repo.upsertInvoicePayment({ ...readable, line: null })).toEqual({
          outcome: 'unchanged',
          linked: true,
        });
      });

      it(`CRITICAL [${label}] an invoice already recorded against one account is never re-attributed to another`, async () => {
        const s = makeSubject();
        const owner = await s.newAccount();
        const other = await s.newAccount();
        const first = sighting(owner, { line: null });
        await s.repo.upsertInvoicePayment(first);
        // The other account's sighting even carries MORE (a line): still refused.
        expect(
          await s.repo.upsertInvoicePayment(
            sighting(other, { stripeInvoiceId: first.stripeInvoiceId }),
          ),
        ).toEqual({ outcome: 'account_mismatch', linked: false });
        expect(await s.stored(first.stripeInvoiceId)).toMatchObject({
          accountId: owner,
          lineKind: null,
        });
      });

      it(`[${label}] the amount paid rises with a later sighting and never falls`, async () => {
        const s = makeSubject();
        const first = sighting(await s.newAccount(), { amountPaidMinor: 5000 });
        await s.repo.upsertInvoicePayment(first);
        expect(
          (await s.repo.upsertInvoicePayment({ ...first, amountPaidMinor: 100 })).outcome,
        ).toBe('unchanged');
        expect((await s.stored(first.stripeInvoiceId))?.amountPaidMinor).toBe(5000);
        expect(
          (await s.repo.upsertInvoicePayment({ ...first, amountPaidMinor: 14900 })).outcome,
        ).toBe('completed');
        expect((await s.stored(first.stripeInvoiceId))?.amountPaidMinor).toBe(14900);
      });

      it(`[${label}] a payment for an account that does not exist is refused as a foreign-key violation, not recorded`, async () => {
        const s = makeSubject();
        const orphan = sighting(randomUUID());
        let code: string | null = 'accepted';
        try {
          await s.repo.upsertInvoicePayment(orphan);
        } catch (err) {
          code = sqlStateOf(err);
        }
        expect(code).toBe('23503');
        expect(await s.stored(orphan.stripeInvoiceId)).toBeNull();
      });
    }

    it('CRITICAL what is stored, column by column: the line’s period and plan, the payment references, when it was paid — and refunds untouched at zero', async () => {
      const repo = new DrizzleStripeWebhooksRepo(pool(0));
      const accountId = await newAccount(db());
      const linked = sighting(accountId, { stripeInvoiceId: 'in_columns_linked' });
      const unlinked = sighting(accountId, {
        stripeInvoiceId: 'in_columns_unlinked',
        line: null,
        stripeSubscriptionId: null,
        billingReason: 'manual',
        amountPaidMinor: 0,
      });
      await repo.upsertInvoicePayment(linked);
      await repo.upsertInvoicePayment(unlinked);
      const rows = await db()<Array<Record<string, unknown>>>`
        SELECT stripe_invoice_id, stripe_subscription_id, billing_reason,
               amount_paid_minor::text AS amount_paid_minor, currency,
               stripe_payment_intent_id, stripe_charge_id, line_kind, line_stripe_price_id,
               line_tier::text AS line_tier, line_interval,
               to_char(line_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS line_period_start,
               to_char(line_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS line_period_end,
               to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS paid_at,
               refunded_minor::text AS refunded_minor, disputed_minor::text AS disputed_minor
          FROM billing_invoice_payments
         WHERE account_id = ${accountId}::uuid ORDER BY stripe_invoice_id`;
      expect(rows.map((r) => ({ ...r }))).toEqual([
        {
          stripe_invoice_id: 'in_columns_linked',
          stripe_subscription_id: 'sub_1',
          billing_reason: 'subscription_cycle',
          amount_paid_minor: '14900',
          currency: 'usd',
          stripe_payment_intent_id: 'pi_1',
          stripe_charge_id: 'ch_1',
          line_kind: 'period',
          line_stripe_price_id: 'price_starter_m',
          line_tier: 'api_starter',
          line_interval: 'month',
          line_period_start: '2026-03-01T00:00:00',
          line_period_end: '2026-04-01T00:00:00',
          paid_at: '2026-03-01T01:00:00',
          refunded_minor: '0',
          disputed_minor: '0',
        },
        {
          stripe_invoice_id: 'in_columns_unlinked',
          stripe_subscription_id: null,
          billing_reason: 'manual',
          amount_paid_minor: '0',
          currency: 'usd',
          stripe_payment_intent_id: 'pi_1',
          stripe_charge_id: 'ch_1',
          line_kind: null,
          line_stripe_price_id: null,
          line_tier: null,
          line_interval: null,
          line_period_start: null,
          line_period_end: null,
          paid_at: '2026-03-01T01:00:00',
          refunded_minor: '0',
          disputed_minor: '0',
        },
      ]);
    });

    it('CRITICAL an unchanged sighting writes NOTHING: the row’s xmin does not move. A completing one moves it once. "Idempotent" here means no write, not a write of the same values.', async () => {
      const repo = new DrizzleStripeWebhooksRepo(pool(0));
      const first = sighting(await newAccount(db()), { line: null });
      const xmin = async (): Promise<string> => {
        const [row] = await db()<Array<{ xmin: string }>>`
          SELECT xmin::text AS xmin FROM billing_invoice_payments
           WHERE stripe_invoice_id = ${first.stripeInvoiceId}`;
        if (row === undefined) throw new Error('row missing');
        return row.xmin;
      };
      await repo.upsertInvoicePayment(first);
      const written = await xmin();
      for (let i = 0; i < 3; i += 1) await repo.upsertInvoicePayment({ ...first });
      expect(await xmin(), 'an unchanged sighting rewrote the row').toBe(written);

      await repo.upsertInvoicePayment({ ...first, line: MARCH });
      const completed = await xmin();
      expect(completed, 'the completing sighting did not write').not.toBe(written);
      await repo.upsertInvoicePayment({ ...first, line: MARCH });
      expect(await xmin()).toBe(completed);
    });

    it('CRITICAL a sighting never touches what was refunded or disputed, and cannot push a recorded refund above what was paid', async () => {
      const repo = new DrizzleStripeWebhooksRepo(pool(0));
      const first = sighting(await newAccount(db()), { line: null });
      await repo.upsertInvoicePayment(first);
      // As the refund handler will one day write it: refunded in full.
      await db()`UPDATE billing_invoice_payments SET refunded_minor = 14900, disputed_minor = 700
                  WHERE stripe_invoice_id = ${first.stripeInvoiceId}`;
      // A late, LOWER-amount sighting that also completes the line. Were the
      // amount lowered to 100, the amounts CHECK would refuse the whole update.
      expect(
        await repo.upsertInvoicePayment({ ...first, amountPaidMinor: 100, line: MARCH }),
      ).toEqual({ outcome: 'completed', linked: true });
      const [row] = await db()<Array<{ paid: string; refunded: string; disputed: string }>>`
        SELECT amount_paid_minor::text AS paid, refunded_minor::text AS refunded,
               disputed_minor::text AS disputed
          FROM billing_invoice_payments WHERE stripe_invoice_id = ${first.stripeInvoiceId}`;
      expect(row).toEqual({ paid: '14900', refunded: '14900', disputed: '700' });
    });

    it('CRITICAL CONCURRENCY — two connections racing the same invoices: every invoice ends as exactly one row, one writer inserted it and the other found it, and nobody errors', async () => {
      const a = new DrizzleStripeWebhooksRepo(pool(0));
      const b = new DrizzleStripeWebhooksRepo(pool(1));
      const accountId = await newAccount(db());
      const invoices = Array.from({ length: 40 }, () => sighting(accountId));

      const outcomes = await Promise.all(
        invoices.map(async (inv) => {
          const pair = await Promise.all([
            a.upsertInvoicePayment({ ...inv }),
            b.upsertInvoicePayment({ ...inv }),
          ]);
          return pair.map((r) => r.outcome).sort();
        }),
      );
      for (const pair of outcomes) expect(pair).toEqual(['inserted', 'unchanged']);

      const [count] = await db()<Array<{ rows: number; invoices: number }>>`
        SELECT count(*)::int AS rows, count(DISTINCT stripe_invoice_id)::int AS invoices
          FROM billing_invoice_payments WHERE account_id = ${accountId}::uuid`;
      expect(count).toEqual({ rows: 40, invoices: 40 });
    });

    it('CRITICAL CONCURRENCY — interleaved by hand: while one connection holds the invoice’s row uncommitted, the second writer is OBSERVED blocked on it; once the first commits, the second completes that row instead of writing its own', async () => {
      const repoB = new DrizzleStripeWebhooksRepo(pool(1));
      const accountId = await newAccount(db());
      const invoiceId = `in_${randomUUID()}`;
      const release = gate();
      const inserted = gate();

      // Connection A: the first delivery, which could NOT read the line, holding
      // its transaction open.
      const first = pool(0).client.begin(async (tx) => {
        await tx`
          INSERT INTO billing_invoice_payments
            (stripe_invoice_id, account_id, amount_paid_minor, currency, paid_at)
          VALUES (${invoiceId}, ${accountId}::uuid, 14900, 'usd', '2026-03-01T01:00:00Z')`;
        inserted.open();
        await release.opened;
      });
      await inserted.opened;

      // Connection B: the sibling delivery, which CAN read the line.
      const pidB = await pidOf(pool(1));
      let settled = false;
      const second = repoB
        .upsertInvoicePayment(sighting(accountId, { stripeInvoiceId: invoiceId }))
        .finally(() => {
          settled = true;
        });
      await waitUntilBlocked(db(), pidB);
      expect(settled, 'the second writer did not wait for the first').toBe(false);

      release.open();
      await first;
      expect(await second).toEqual({ outcome: 'completed', linked: true });

      const rows = await db()<Array<{ line_kind: string | null; pi: string | null }>>`
        SELECT line_kind, stripe_payment_intent_id AS pi
          FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}`;
      expect(rows.map((r) => ({ ...r }))).toEqual([{ line_kind: 'period', pi: 'pi_1' }]);
    });

    it('CRITICAL CONCURRENCY — two COMPLETING sightings of a row that already exists: the second reads the row only after the first has committed, so neither erases what the other added. Without the row lock the second would merge from a stale read and write the line back to NULL.', async () => {
      const repoB = new DrizzleStripeWebhooksRepo(pool(1));
      const accountId = await newAccount(db());
      const stored = sighting(accountId, { line: null, stripeChargeId: null });
      await new DrizzleStripeWebhooksRepo(pool(0)).upsertInvoicePayment(stored);

      const release = gate();
      const locked = gate();
      // Connection A: a completer that has read the row under its lock and is
      // about to tie it to its line.
      const first = pool(0).client.begin(async (tx) => {
        await tx`SELECT 1 FROM billing_invoice_payments
                  WHERE stripe_invoice_id = ${stored.stripeInvoiceId} FOR UPDATE`;
        locked.open();
        await release.opened;
        await tx`
          UPDATE billing_invoice_payments
             SET line_kind = 'period', line_stripe_price_id = 'price_starter_m',
                 line_tier = 'api_starter', line_interval = 'month',
                 line_period_start = '2026-03-01T00:00:00Z',
                 line_period_end = '2026-04-01T00:00:00Z'
           WHERE stripe_invoice_id = ${stored.stripeInvoiceId}`;
      });
      await locked.opened;

      // Connection B: a completer that can read NO line, but brings the charge.
      const pidB = await pidOf(pool(1));
      const second = repoB.upsertInvoicePayment({ ...stored, stripeChargeId: 'ch_late' });
      await waitUntilBlocked(db(), pidB);
      release.open();
      await first;
      expect(await second).toEqual({ outcome: 'completed', linked: true });

      const [row] = await db()<Array<{ line_kind: string | null; charge: string | null }>>`
        SELECT line_kind, stripe_charge_id AS charge
          FROM billing_invoice_payments WHERE stripe_invoice_id = ${stored.stripeInvoiceId}`;
      expect({ ...row }, 'one completer erased what the other added').toEqual({
        line_kind: 'period',
        charge: 'ch_late',
      });
    });

    it('CONCURRENCY — and when the first writer rolls back instead, the blocked second writer inserts the row itself: nothing is lost', async () => {
      const repoB = new DrizzleStripeWebhooksRepo(pool(1));
      const accountId = await newAccount(db());
      const invoiceId = `in_${randomUUID()}`;
      const release = gate();
      const inserted = gate();
      class Abandon extends Error {}

      const first = pool(0)
        .client.begin(async (tx) => {
          await tx`
            INSERT INTO billing_invoice_payments
              (stripe_invoice_id, account_id, amount_paid_minor, currency, paid_at)
            VALUES (${invoiceId}, ${accountId}::uuid, 14900, 'usd', '2026-03-01T01:00:00Z')`;
          inserted.open();
          await release.opened;
          throw new Abandon('roll back');
        })
        .catch((err: unknown) => {
          if (!(err instanceof Abandon)) throw err;
        });
      await inserted.opened;

      const pidB = await pidOf(pool(1));
      const second = repoB.upsertInvoicePayment(
        sighting(accountId, { stripeInvoiceId: invoiceId }),
      );
      await waitUntilBlocked(db(), pidB);
      release.open();
      await first;
      expect(await second).toEqual({ outcome: 'inserted', linked: true });
    });
  },
);
