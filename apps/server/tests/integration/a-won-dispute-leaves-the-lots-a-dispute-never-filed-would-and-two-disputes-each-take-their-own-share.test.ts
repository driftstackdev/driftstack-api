// A won dispute leaves the account holding the LOTS a dispute never filed
// would have left — not only the same total — and two disputes of one charge
// each take their own share, even when together they pass what was paid. The
// third audit of S17 wrote the twin property test that holds the first half
// over random sequences; these arms pin the pieces of it the property only
// reaches by chance, each by one behaviour:
//
//   · the credit a win gives back goes INTO the lot it was taken from, so the
//     month is spent in the order it would have been (a separate goodwill lot
//     is spent after every other included credit, which moved what a later
//     refund of an annual invoice left under the interim cap);
//   · a month drawn while a dispute takes the whole payment is drawn at its
//     full level and taken by the dispute, so the win has nothing to draw and
//     the next refresh writes nothing (R4, the audit's bar 5);
//   · two disputes that together dispute more than was paid are both recorded
//     by their ids, and a win takes only its own dispute's share off (R2);
//   · debt that a lot repaid and that has since expired, with no month
//     running, comes back as one new lot valid for a month from the win
//     (reversal policy v2, rule 6 — it was "not returned" under R1');
//   · a downgrade made while a dispute takes the whole month leaves nothing
//     owed while the dispute stands (a guard: the downgrade is measured on the
//     undisputed month, and the dispute's share of it follows at once).
//
// Every arm runs the real repos and services against an isolated Postgres
// database rebuilt from the migrations.

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { CreditClawbacksService, floorToPriorMinute } from '../../src/services/credit-clawbacks.js';
import { CreditGrantsService } from '../../src/services/credit-grants.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  lotsOf,
  payingCustomer,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  leaving,
  mirrorMovedTo,
  paidMonth,
  paidProrationUpLine,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s17_round3';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4_900;
const ANNUAL = 58_800;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let grants: CreditGrantsService | null = null;
let service: CreditClawbacksService | null = null;
const alerts: SentryMessage[] = [];
const warnings: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url, { max: 3 });
  const logger = {
    info: () => {},
    warn: (fields: Record<string, unknown>) => {
      warnings.push(fields);
    },
    debug: () => {},
    error: () => {},
  } as unknown as Logger;
  // The grants service with a logger, so what it logs can be read back.
  grants = new CreditGrantsService({ ledger: harness.ledger, windows: harness.windows, logger });
  service = new CreditClawbacksService({
    ledger: harness.ledger,
    windows: harness.windows,
    grants,
    logger,
    sentry: {
      captureMessage: (msg) => {
        alerts.push(msg);
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}
function g(): CreditGrantsService {
  if (grants === null) throw new Error('isolated database unreachable');
  return grants;
}
function svc(): CreditClawbacksService {
  if (service === null) throw new Error('isolated database unreachable');
  return service;
}

const credits = (micro: number): number => micro / MICRO;

async function charge(invoiceId: string, chargeId: string): Promise<void> {
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${invoiceId}`;
}

function dispute(disputeId: string, chargeId: string, amountMinor = PAID) {
  return { disputeId, chargeId, stripeInvoiceId: null, amountMinor };
}

async function remainingOf(lotId: string): Promise<number> {
  const [row] = await db()<Array<{ r: string }>>`
    SELECT remaining_micro::text AS r FROM credit_lots WHERE id = ${lotId}::uuid`;
  return credits(Number(row?.r ?? '-1'));
}

async function spendable(accountId: string): Promise<number> {
  return credits(await h().ledger.spendableMicro(accountId));
}

async function levelNow(accountId: string): Promise<number | null> {
  const [row] = await db()<Array<{ level: string }>>`
    SELECT level_micro::text AS level FROM credit_windows
     WHERE account_id = ${accountId}::uuid AND window_start <= now() AND now() < window_end`;
  return row === undefined ? null : credits(Number(row.level));
}

async function disputedOf(invoiceId: string): Promise<number> {
  const [row] = await db()<Array<{ d: string }>>`
    SELECT disputed_minor::text AS d FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}`;
  return Number(row?.d ?? '-1');
}

/** Everything a refresh could write, counted, with the balances. */
async function footprint(accountId: string) {
  const [row] = await db()<Array<Record<string, string>>>`
    SELECT (SELECT count(*)::text FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
           (SELECT count(*)::text FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger,
           (SELECT count(*)::text FROM credit_clawbacks WHERE account_id = ${accountId}::uuid) AS clawbacks,
           (SELECT count(*)::text FROM credit_window_level_changes s
              JOIN credit_windows w ON w.id = s.window_id
             WHERE w.account_id = ${accountId}::uuid) AS steps,
           (SELECT count(*)::text FROM credit_windows WHERE account_id = ${accountId}::uuid) AS windows`;
  return { ...row, spendable: String(await spendable(accountId)) };
}

/** Spend `amount` credits the way the product does: lots in spend order. */
async function spendInOrder(accountId: string, amount: number, from: number): Promise<void> {
  let left = amount * MICRO;
  let nth = from;
  const lots = await db()<Array<{ id: string; free: string }>>`
    SELECT id, (remaining_micro - held_micro)::text AS free FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY spend_rank, expires_at, created_at, id`;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.free));
    nth += 1;
    await spendFromLot(db(), accountId, lot.id, take / MICRO, nth);
    left = left - take;
  }
  if (left > 0) throw new Error('setup: the account could not spend that much');
}

/** An instant `seconds` ahead of the database's clock, whole seconds, as UTC text. */
async function boundaryIn(seconds: number): Promise<string> {
  const [row] = await db()<Array<{ t: string }>>`
    SELECT to_char((date_trunc('second', now()) + make_interval(secs => ${seconds})) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
  if (row === undefined) throw new Error('setup: no clock');
  return row.t;
}
function monthBefore(instant: string): string {
  return `(('${instant}'::timestamptz AT TIME ZONE 'UTC' - interval '1 month') AT TIME ZONE 'UTC')`;
}
async function waitPast(instant: string): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    const [row] = await db()<
      Array<{ past: boolean }>
    >`SELECT now() > ${instant}::timestamptz AS past`;
    if (row?.past === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the database clock never passed the boundary');
}

describe.skipIf(!RUN_DB_TESTS)(
  'a won dispute leaves the lots a dispute never filed would, and two disputes each take their own share',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL the credit a win gives back goes into the month’s own lot, so the month is spent before an upgrade’s lot, as it would have been with no dispute', async () => {
      const m = await paidMonth(db(), 'api_starter');
      await charge(m.invoiceId, 'ch_r3_order');
      await g().refreshCredits(m.accountId);
      const monthly = (await lotsOf(db(), m.accountId)).find((l) => l.kind === 'monthly');
      if (monthly === undefined) throw new Error('setup: no monthly lot');
      await svc().applyStripeDispute(dispute('dp_r3_order', 'ch_r3_order', PAID / 2));
      expect(await remainingOf(monthly.id)).toBe(1_500);
      await svc().reinstateDispute(dispute('dp_r3_order', 'ch_r3_order', PAID / 2));
      // Back in the month's own lot: no lot of goodwill beside it.
      expect(await remainingOf(monthly.id)).toBe(3_000);
      expect((await lotsOf(db(), m.accountId)).map((l) => l.kind)).toEqual(['monthly']);

      // An upgrade for the second half of the month, then 3,000 spent.
      await mirrorMovedTo(db(), m.subscriptionId, 'api_builder', leaving(420));
      await paidProrationUpLine(db(), m.accountId, {
        subscriptionId: m.subscriptionId,
        tier: 'api_builder',
        from: leaving(420),
      });
      await g().refreshCredits(m.accountId);
      const upgrade = (await lotsOf(db(), m.accountId)).find((l) => l.kind === 'proration');
      if (upgrade === undefined) throw new Error('setup: no upgrade lot');
      await spendInOrder(m.accountId, 3_000, 0);
      // The month's credit is what was spent; the upgrade's lot is whole.
      expect(await remainingOf(monthly.id)).toBe(0);
      expect(await remainingOf(upgrade.id)).toBe(3_500);
    });

    it('CRITICAL two disputes of one charge that together dispute more than was paid are both recorded, and a win takes off only its own dispute (R2)', async () => {
      const c = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
      await charge(c.invoiceId, 'ch_r3_two');
      await g().refreshCredits(c.accountId);
      await svc().applyStripeDispute(dispute('dp_r3_two_a', 'ch_r3_two', PAID));
      await svc().applyStripeDispute(dispute('dp_r3_two_b', 'ch_r3_two', PAID / 2));
      // The payment row holds the sum capped at what was paid.
      expect(await disputedOf(c.invoiceId)).toBe(PAID);
      expect(await spendable(c.accountId)).toBe(0);

      // The whole-payment dispute is won, twice over: half the payment stays disputed.
      await svc().reinstateDispute(dispute('dp_r3_two_a', 'ch_r3_two', PAID));
      await svc().reinstateDispute(dispute('dp_r3_two_a', 'ch_r3_two', PAID));
      expect(await disputedOf(c.invoiceId)).toBe(PAID / 2);
      expect(await spendable(c.accountId)).toBe(1_500);
      expect(await levelNow(c.accountId)).toBe(1_500);

      await svc().reinstateDispute(dispute('dp_r3_two_b', 'ch_r3_two', PAID / 2));
      expect(await disputedOf(c.invoiceId)).toBe(0);
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await levelNow(c.accountId)).toBe(3_000);
    });

    it('CRITICAL a month that starts while a dispute takes the whole payment is drawn in full and taken by the dispute, so the win draws nothing and the next refresh writes nothing (R4)', async () => {
      const boundary = await boundaryIn(10);
      const a = await payingCustomer(db(), 'api_starter', {
        amountPaid: ANNUAL,
        interval: 'year',
        start: monthBefore(boundary),
        end: `((${monthBefore(boundary)} AT TIME ZONE 'UTC' + interval '1 year') AT TIME ZONE 'UTC')`,
      });
      await charge(a.invoiceId, 'ch_r3_draw');
      await g().refreshCredits(a.accountId);
      await svc().applyStripeDispute(dispute('dp_r3_draw', 'ch_r3_draw', ANNUAL));
      await waitPast(boundary);
      const drawn = await g().refreshCredits(a.accountId);
      // The new month exists, shows nothing, and holds nothing: the dispute took it.
      expect(drawn.window.outcome).toBe('created');
      expect(await levelNow(a.accountId)).toBe(0);
      expect(await spendable(a.accountId)).toBe(0);

      await svc().reinstateDispute(dispute('dp_r3_draw', 'ch_r3_draw', ANNUAL));
      expect(await spendable(a.accountId)).toBe(3_000);
      expect(await levelNow(a.accountId)).toBe(3_000);
      const before = await footprint(a.accountId);
      await g().refreshCredits(a.accountId);
      expect(await footprint(a.accountId), 'the refresh after the win wrote something').toEqual(
        before,
      );
    }, 60_000);

    it('CRITICAL debt a lot repaid, when that lot has expired and no month is running, comes back at the win as one lot valid for a month from the win — and no alert (policy v2, rule 6)', async () => {
      const boundary = await boundaryIn(10);
      const c = await payingCustomer(db(), 'api_starter', {
        amountPaid: PAID,
        start: monthBefore(boundary),
        end: `'${boundary}'::timestamptz`,
      });
      await charge(c.invoiceId, 'ch_r3_past');
      await g().refreshCredits(c.accountId);
      const monthly = (await lotsOf(db(), c.accountId)).find((l) => l.kind === 'monthly');
      if (monthly === undefined) throw new Error('setup: no monthly lot');
      await spendFromLot(db(), c.accountId, monthly.id, 3_000);
      await svc().applyStripeDispute(dispute('dp_r3_past', 'ch_r3_past'));
      expect(await debtOf(db(), c.accountId)).toBe(3_000 * MICRO);
      // Goodwill that ends with the month repays the dispute's debt.
      await h().ledger.transaction(async (tx) => {
        await h().ledger.lockAccount(tx, c.accountId);
        const lot = await h().ledger.insertLot(
          {
            accountId: c.accountId,
            kind: 'adjustment',
            grantKey: `goodwill:r3_past:${c.accountId}`,
            grantedMicro: 3_000 * MICRO,
            startsAt: floorToPriorMinute(new Date()),
            expiresAt: new Date(boundary),
          },
          tx,
        );
        await tx.execute(sql`
          INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
          VALUES (${c.accountId}::uuid, 'grant', ${lot.lot.id}::uuid, ${String(3_000 * MICRO)}::bigint,
                  ${`goodwill:r3_past:${lot.lot.id}`}, 'admin')`);
        await h().ledger.settleDebtFromFree(tx, c.accountId);
      });
      expect(await debtOf(db(), c.accountId)).toBe(0);

      await waitPast(boundary);
      await g().refreshCredits(c.accountId);
      const alertsBefore = alerts.length;
      const [clock] = await db()<Array<{ t: string }>>`SELECT now()::text AS t`;
      const won = await svc().reinstateDispute(dispute('dp_r3_past', 'ch_r3_past'));
      expect(won).toMatchObject({ kind: 'reinstated' });
      // Rule 6: the 3,000 the goodwill paid cannot go back into it (expired), so
      // it comes back as one new lot. None of "the end of the current month"
      // (no month runs), "the expiry of the lots it came from" (the goodwill's)
      // or "the expiry of any lot used or held while the dispute stood" (the
      // month's and the goodwill's) is in the future: it is valid one month
      // from the win.
      expect(await spendable(c.accountId)).toBe(3_000);
      expect(await debtOf(db(), c.accountId)).toBe(0);
      const [returned] = await db()<Array<{ ok: boolean; n: number }>>`
        SELECT count(*)::int AS n,
               bool_and(expires_at BETWEEN (${clock?.t ?? ''}::timestamptz + interval '1 month' - interval '2 minutes')
                                       AND (now() + interval '1 month' + interval '2 minutes')) AS ok
          FROM credit_lots
         WHERE account_id = ${c.accountId}::uuid AND revoked_at IS NULL
           AND starts_at <= now() AND now() < expires_at AND remaining_micro > held_micro`;
      expect(returned, 'one lot, valid a month from the win').toEqual({ ok: true, n: 1 });
      expect(alerts.length - alertsBefore, 'no alert: the win put back what it should').toBe(0);
    }, 60_000);

    it('a downgrade made while a dispute takes the whole month leaves nothing owed while the dispute stands (a guard)', async () => {
      const m = await paidMonth(db(), 'api_builder');
      await charge(m.invoiceId, 'ch_r3_lost');
      await g().refreshCredits(m.accountId);
      await svc().applyStripeDispute(dispute('dp_r3_lost', 'ch_r3_lost'));
      await mirrorMovedTo(db(), m.subscriptionId, 'api_starter', leaving(420));
      await g().refreshCredits(m.accountId);
      expect(await debtOf(db(), m.accountId)).toBe(0);
      expect(await spendable(m.accountId)).toBe(0);
      const before = await footprint(m.accountId);
      await g().refreshCredits(m.accountId);
      expect(await footprint(m.accountId)).toEqual(before);
    });
  },
);
