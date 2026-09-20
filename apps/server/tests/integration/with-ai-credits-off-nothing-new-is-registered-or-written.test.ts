// With AI credits off, nothing new is registered or written — and switched on,
// the jobs really are armed.
//
// AI credits ship dark. `DRIFTSTACK_AI_CREDITS_MODE` defaults to `off`, and off
// has to mean OFF: no credit job registered, no credit job enqueued, and a
// billing event that writes no window, lot, ledger row or credit row. A flag
// whose "off" still ran a sweep against production would be found by whoever
// reads the database bill.
//
// Proved by booting the REAL production dependency graph (the factory index.ts
// runs), twice, each time against a database of its own built from the
// migrations: once with the mode unset, once with it set to `shadow`. Then a real
// paid-invoice event is pushed through the webhook service that boot built.
// Reading bootstrap's text could say the jobs sit inside an `if`; only running
// it says what the `if` does.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductionDeps, type BootstrapResult } from '../../src/lib/bootstrap.js';
import { loadConfig } from '../../src/lib/config.js';
import { createTestLogger } from '../../src/lib/logger.js';
import {
  CREDITS_COVERAGE_SWEEP_JOB_TYPE,
  CREDITS_EXPIRY_SWEEP_JOB_TYPE,
  CREDITS_WINDOW_BOUNDARY_JOB_TYPE,
} from '../../src/services/credit-grant-jobs.js';
import { CREDITS_INVARIANT_AUDIT_JOB_TYPE } from '../../src/services/credit-invariant-audit.js';
import { MICRO } from './_helpers/credit-ledger-fixtures.js';
import {
  agedReservation,
  fundedTaskLot,
  lotState,
  newTaskAccount,
} from './_helpers/credit-reservation-fixtures.js';
import { ensureFreshIsolatedDatabase } from './_helpers/fresh-isolated-database.js';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { buildInvoice, buildInvoiceEvent } from './_helpers/stripe-invoice-fixtures.js';

const OFF_DB_NAME = 'driftstack_iso_ai_credits_mode_off';
const ON_DB_NAME = 'driftstack_iso_ai_credits_mode_shadow';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

interface Booted {
  boot: BootstrapResult;
  sql: postgres.Sql;
}

let off: Booted | null = null;
let on: Booted | null = null;

const TIER_PRICES = JSON.stringify({
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
});

async function bootOn(name: string, mode: string | undefined): Promise<Booted | null> {
  const url = await ensureFreshIsolatedDatabase(name);
  if (url === null) return null;
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  await assertIsolatedDatabase(sql, name);
  return { boot: await bootAgainst(url, mode), sql };
}

/**
 * Boot the real factory against a database that ALREADY EXISTS, so an arm can
 * put rows in front of the boot and ask what the boot did to them. Split out of
 * `bootOn` for the boot-pass arm, which boots the same database twice.
 */
async function bootAgainst(url: string, mode: string | undefined): Promise<BootstrapResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    STRIPE_WEBHOOK_SECRET: 'whsec_mode_test',
    DRIFTSTACK_TIER_PRICE_IDS: TIER_PRICES,
  };
  delete env.DRIFTSTACK_AI_CREDITS_MODE;
  if (mode !== undefined) env.DRIFTSTACK_AI_CREDITS_MODE = mode;
  return createProductionDeps(loadConfig(env), createTestLogger());
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  off = await bootOn(OFF_DB_NAME, undefined);
  on = await bootOn(ON_DB_NAME, ' Shadow\n');
}, 240_000);

afterAll(async () => {
  for (const b of [off, on]) {
    await b?.boot.teardown().catch(() => {});
    await b?.sql.end({ timeout: 5 }).catch(() => {});
  }
}, 120_000);

function booted(b: Booted | null): Booted {
  if (b === null) throw new Error('isolated database unreachable, or the boot failed');
  return b;
}

async function pendingCreditJobs(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<Array<{ job_type: string }>>`
    SELECT job_type FROM scheduled_jobs
     WHERE job_type LIKE 'credits.%' AND completed_at IS NULL AND failed_at IS NULL
     ORDER BY job_type`;
  return rows.map((r) => r.job_type);
}

/** A real paying customer's two events, through the webhook service the boot built. */
async function payThroughTheWebhook(b: Booted): Promise<string> {
  const stripe = b.boot.deps.stripeWebhooksService;
  if (stripe === undefined) throw new Error('the boot built no Stripe webhook service');
  const accountId = randomUUID();
  const customerId = `cus_${accountId}`;
  await b.sql`
    INSERT INTO accounts (id, email, stripe_customer_id)
    VALUES (${accountId}::uuid, ${`mode-${accountId}@example.test`}, ${customerId})`;
  const start = Math.floor(Date.now() / 1000) - 60;
  const end = start + 30 * 24 * 60 * 60;
  const sub = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.created',
    created: start + 60,
    data: {
      object: {
        id: `sub_${accountId}`,
        customer: customerId,
        status: 'active',
        cancel_at_period_end: false,
        current_period_start: start,
        current_period_end: end,
        items: { data: [{ price: { id: 'price_builder_m' } }] },
      },
    },
  };
  expect(await stripe.handle(sub, JSON.stringify(sub))).toBe('handled');
  const paid = buildInvoiceEvent({
    eventId: `evt_${randomUUID()}`,
    type: 'invoice.paid',
    invoice: buildInvoice('older', {
      invoiceId: `in_${accountId}`,
      customerId,
      subscriptionId: `sub_${accountId}`,
      amountPaid: 14900,
      lines: [
        { priceId: 'price_builder_m', amount: 14900, periodStartSec: start, periodEndSec: end },
      ],
    }),
  });
  expect(await stripe.handle(paid, JSON.stringify(paid))).toBe('handled');
  return accountId;
}

async function creditRows(sql: postgres.Sql): Promise<Record<string, number>> {
  const [row] = await sql<Array<Record<string, number>>>`
    SELECT (SELECT count(*)::int FROM credit_accounts) AS credit_accounts,
           (SELECT count(*)::int FROM credit_windows) AS windows,
           (SELECT count(*)::int FROM credit_lots) AS lots,
           (SELECT count(*)::int FROM credit_ledger) AS ledger,
           (SELECT count(*)::int FROM billing_invoice_payments) AS payments`;
  if (row === undefined) throw new Error('count query returned nothing');
  return row;
}

describe.skipIf(!RUN_DB_TESTS)('with AI credits off nothing new is registered or written', () => {
  it('both production boots came up, each on its own freshly built database — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(off, 'the boot with the mode unset').not.toBeNull();
    expect(on, 'the boot with the mode set to shadow').not.toBeNull();
    expect(booted(off).boot.deps.stripeWebhooksService).toBeDefined();
  });

  it('CRITICAL mode unset: the boot armed its ordinary chains and NOT ONE credits job — none enqueued, so none can run', async () => {
    const { sql } = booted(off);
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(DISTINCT job_type)::int AS n FROM scheduled_jobs
       WHERE completed_at IS NULL AND failed_at IS NULL`;
    // Anti-vacuity: this really is a boot that arms chains.
    expect(row?.n, 'pending job types after the boot').toBeGreaterThan(10);
    expect(await pendingCreditJobs(sql)).toEqual([]);
  });

  it('CRITICAL mode unset: a paid invoice through the real webhook service is recorded as always, and writes no credit row of any kind', async () => {
    const b = booted(off);
    await payThroughTheWebhook(b);
    expect(await creditRows(b.sql)).toEqual({
      credit_accounts: 0,
      windows: 0,
      lots: 0,
      ledger: 0,
      payments: 1,
    });
    expect(await pendingCreditJobs(b.sql), 'the event armed a credits job').toEqual([]);
  });

  it('CRITICAL mode " Shadow\\n" (as a secret store would hand it over): both sweeps and the daily invariant audit are armed at boot, and the window-boundary job is not — it has no account to wait for yet', async () => {
    expect(await pendingCreditJobs(booted(on).sql)).toEqual([
      CREDITS_COVERAGE_SWEEP_JOB_TYPE,
      CREDITS_EXPIRY_SWEEP_JOB_TYPE,
      CREDITS_INVARIANT_AUDIT_JOB_TYPE,
    ]);
  });

  it('CRITICAL mode shadow: the same paid invoice grants the month, and arms that account’s window-boundary job for the instant the window ends', async () => {
    const b = booted(on);
    const accountId = await payThroughTheWebhook(b);
    expect(await creditRows(b.sql)).toEqual({
      credit_accounts: 1,
      windows: 1,
      lots: 1,
      ledger: 1,
      payments: 1,
    });
    const [job] = await b.sql<Array<{ account_id: string; on_time: boolean; boundary_at: string }>>`
      SELECT j.account_id, (j.run_at = date_trunc('milliseconds', w.window_end)) AS on_time,
             j.payload ->> 'boundary_at' AS boundary_at
        FROM scheduled_jobs j
        JOIN credit_windows w ON w.account_id = j.account_id
       WHERE j.job_type = ${CREDITS_WINDOW_BOUNDARY_JOB_TYPE} AND j.completed_at IS NULL`;
    expect(job?.account_id).toBe(accountId);
    expect(job?.on_time, 'the boundary job is due when the window ends').toBe(true);
    expect(Number.isFinite(Date.parse(job?.boundary_at ?? ''))).toBe(true);
  });

  it('CRITICAL S9 the BOOT PASS runs no query while the mode is off, proved by putting an abandoned task in front of it: the boot with the mode unset leaves it open with its credit still held, and the SAME database booted again in shadow settles it. Two boots, one seed, one difference — which is the only way to tell "the `if` is false" apart from "there was nothing to find".', async () => {
    const url = await ensureFreshIsolatedDatabase('driftstack_iso_ai_credits_boot_pass');
    if (url === null) throw new Error('isolated database unreachable');
    const sql = postgres(url, { max: 2, onnotice: () => undefined });
    const boots: BootstrapResult[] = [];
    try {
      await assertIsolatedDatabase(sql, 'driftstack_iso_ai_credits_boot_pass');
      // An abandoned task, exactly as a process that died mid-turn leaves one:
      // open, past its hard ceiling, holding the customer's credit and one of
      // their three slots. The keeper's boot pass is what frees it.
      const accountId = await newTaskAccount(sql);
      const lotId = await fundedTaskLot(sql, accountId, { credits: 100 });
      const reservationId = await agedReservation(sql, {
        accountId,
        lotId,
        reservedMicro: 10 * MICRO,
      });
      expect((await lotState(sql, lotId)).held, 'the abandoned task holds credit').toBe(10 * MICRO);

      boots.push(await bootAgainst(url, undefined));
      const [afterOff] = await sql<Array<{ state: string; settle_reason: string | null }>>`
          SELECT state, settle_reason FROM credit_reservations WHERE id = ${reservationId}::uuid`;
      expect(
        { state: afterOff?.state, reason: afterOff?.settle_reason },
        'with the mode off the boot pass does not exist, so the task is untouched',
      ).toEqual({ state: 'open', reason: null });
      expect(
        (await lotState(sql, lotId)).held,
        'and its credit is still held — nothing was released, so nothing was queried',
      ).toBe(10 * MICRO);

      // ⛔ THE POSITIVE CONTROL, ON THE SAME ROW. Without it this arm would
      // pass just as happily against a boot pass that was deleted outright.
      boots.push(await bootAgainst(url, 'shadow'));
      const [afterOn] = await sql<Array<{ state: string; settle_reason: string | null }>>`
          SELECT state, settle_reason FROM credit_reservations WHERE id = ${reservationId}::uuid`;
      expect(
        { state: afterOn?.state, reason: afterOn?.settle_reason },
        'switched on, the very next boot finishes it from what it recorded',
      ).toEqual({ state: 'settled', reason: 'max_age' });
      expect(
        (await lotState(sql, lotId)).held,
        'and the customer has their credit and their slot back',
      ).toBe(0);
    } finally {
      for (const b of boots) await b.teardown().catch(() => {});
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }, 240_000);
});
