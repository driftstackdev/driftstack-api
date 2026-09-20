// Fixtures for the monthly AI credits tests (migration 0130 and the grants
// service).
//
// Each file gets its own database, rebuilt from the migrations on every run
// (`openLedgerDatabase`): windows, lots and ledger rows cannot be deleted, so a
// kept database would carry every earlier run's grants into "this account has
// exactly one window".
//
// ⛔ PAID COVERAGE IS WRITTEN WITH RAW SQL, AND TIMES ARE SQL TEXT. The grants
// read what the billing events wrote, so a test states that directly rather than
// replaying webhooks; and every time is an SQL expression over the DATABASE's
// now() (`now() - interval '5 days'`), because the code under test judges
// everything on that clock. A JavaScript Date would bring this process's clock,
// and its milliseconds, into a comparison made in microseconds.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { AccountTier } from '@driftstack/api-types';
import { createDb, type Database } from '../../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../../src/db/credit-ledger-repo.js';
import { DrizzleCreditWindowsRepo } from '../../../src/db/credit-windows-repo.js';
import { CreditGrantsService } from '../../../src/services/credit-grants.js';
import type { ScheduledJobsService } from '../../../src/services/scheduled-jobs.js';
import { MICRO } from './credit-ledger-fixtures.js';

type Sql = postgres.Sql | postgres.TransactionSql;

export { MICRO };

/** What each plan grants a month, in credits: restated here on purpose, not imported. */
export const PLAN_CREDITS: Readonly<Record<string, number>> = {
  solo_manual: 1_500,
  api_starter: 3_000,
  team_manual: 5_000,
  api_builder: 10_000,
  agency_manual: 15_000,
  api_scale: 30_000,
};

export interface GrantsHarness {
  readonly database: Database;
  readonly ledger: DrizzleCreditLedgerRepo;
  readonly windows: DrizzleCreditWindowsRepo;
  readonly grants: CreditGrantsService;
}

/** The real repos and service over one connection pool on `url`. */
export function grantsHarness(
  url: string,
  opts: { max?: number; scheduledJobs?: ScheduledJobsService } = {},
): GrantsHarness {
  const database = createDb(url, { max: opts.max ?? 2 });
  const ledger = new DrizzleCreditLedgerRepo(database);
  const windows = new DrizzleCreditWindowsRepo(database);
  const grants = new CreditGrantsService({
    ledger,
    windows,
    ...(opts.scheduledJobs !== undefined ? { scheduledJobs: opts.scheduledJobs } : {}),
  });
  return { database, ledger, windows, grants };
}

/** A new account on `tier`. */
export async function newAccountOn(sql: Sql, tier: AccountTier = 'free'): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO accounts (id, email, tier)
    VALUES (${id}::uuid, ${`grants-${id}@example.test`}, ${tier}::account_tier)`;
  return id;
}

export interface SubscriptionSpec {
  readonly subscriptionId?: string;
  readonly tier: AccountTier;
  /** Default 'active'. */
  readonly status?:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused';
}

/** A subscription mirror row. Returns its Stripe subscription id. */
export async function subscription(
  sql: Sql,
  accountId: string,
  spec: SubscriptionSpec,
): Promise<string> {
  const id = spec.subscriptionId ?? `sub_${randomUUID()}`;
  await sql`
    INSERT INTO subscriptions (account_id, stripe_subscription_id, stripe_price_id, tier, status)
    VALUES (${accountId}::uuid, ${id}, ${`price_${spec.tier}`}, ${spec.tier}::account_tier,
            ${spec.status ?? 'active'}::subscription_status)`;
  return id;
}

export interface PaidLineSpec {
  readonly invoiceId?: string;
  readonly subscriptionId: string;
  /** The plan of the paid line; null for a price the configuration does not name. */
  readonly tier: AccountTier | null;
  /** Default 'month'. */
  readonly interval?: 'month' | 'year' | null;
  /** SQL for the line's period start. Default five days ago, on the second. */
  readonly start?: string;
  /** SQL for the line's period end. Default one month after the default start. */
  readonly end?: string;
  /** Default 'period'. */
  readonly lineKind?: 'period' | 'proration_up';
  /** Minor units. Default 4900. */
  readonly amountPaid?: number;
  /** Minor units. Default 0. */
  readonly refunded?: number;
}

export const FIVE_DAYS_AGO = "date_trunc('second', now()) - interval '5 days'";
export const A_MONTH_FROM_FIVE_DAYS_AGO = `((${FIVE_DAYS_AGO}) AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC'`;

/** A PAID invoice row naming a subscription line. Returns the invoice id. */
export async function paidLine(sql: Sql, accountId: string, spec: PaidLineSpec): Promise<string> {
  const id = spec.invoiceId ?? `in_${randomUUID()}`;
  const interval = spec.interval === undefined ? 'month' : spec.interval;
  await sql.unsafe(
    `INSERT INTO billing_invoice_payments
       (stripe_invoice_id, account_id, stripe_subscription_id, billing_reason, amount_paid_minor, currency,
        line_kind, line_stripe_price_id, line_tier, line_interval, line_period_start, line_period_end,
        paid_at, refunded_minor)
     VALUES ($1, $2, $3, 'subscription_cycle', $4, 'usd', $5, $6, $7::account_tier, $8,
             ${spec.start ?? FIVE_DAYS_AGO}, ${spec.end ?? A_MONTH_FROM_FIVE_DAYS_AGO}, now(), $9)`,
    [
      id,
      accountId,
      spec.subscriptionId,
      spec.amountPaid ?? 4900,
      spec.lineKind ?? 'period',
      spec.tier === null ? 'price_unmapped' : `price_${spec.tier}`,
      spec.tier,
      interval,
      spec.refunded ?? 0,
    ],
  );
  return id;
}

/** An active subscription with a paid monthly line over now(): the ordinary paying customer. */
export async function payingCustomer(
  sql: Sql,
  tier: AccountTier,
  line: Partial<PaidLineSpec> = {},
): Promise<{ accountId: string; subscriptionId: string; invoiceId: string }> {
  const accountId = await newAccountOn(sql, tier);
  const subscriptionId = await subscription(sql, accountId, { tier });
  const invoiceId = await paidLine(sql, accountId, { subscriptionId, tier, ...line });
  return { accountId, subscriptionId, invoiceId };
}

/** A crypto entitlement. Times are SQL. Returns the order id. */
export async function cryptoEntitlement(
  sql: Sql,
  accountId: string,
  spec: { tier: AccountTier; starts?: string; expires?: string; orderId?: string },
): Promise<string> {
  const orderId = spec.orderId ?? `ord_${randomUUID()}`;
  const starts = spec.starts ?? "date_trunc('second', now()) - interval '3 days'";
  await sql.unsafe(
    `INSERT INTO crypto_entitlements (account_id, order_id, tier, starts_at, expires_at)
     VALUES ($1, $2, $3::account_tier, ${starts}, ${spec.expires ?? `(${starts}) + interval '31 days'`})`,
    [accountId, orderId, spec.tier],
  );
  return orderId;
}

/** A plan an admin set by hand. Times are SQL. */
export async function planOverride(
  sql: Sql,
  accountId: string,
  spec: { monthlyCredits: number; anchor?: string; ends?: string | null; reason?: string },
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO credit_plan_overrides (account_id, monthly_credits, anchor_at, ends_at, reason)
     VALUES ($1, $2, ${spec.anchor ?? "date_trunc('second', now()) - interval '40 days'"},
             ${spec.ends ?? 'NULL'}, $3)`,
    [accountId, spec.monthlyCredits, spec.reason ?? 'contract'],
  );
}

export interface RawWindow {
  readonly source?: 'stripe_invoice' | 'crypto_entitlement' | 'plan_override';
  readonly sourceRef?: string;
  /** SQL. Default ten days ago. */
  readonly start?: string;
  /** SQL. Default twenty days on. */
  readonly end?: string;
  /** SQL for the natural month; default the window itself. */
  readonly naturalStart?: string;
  readonly naturalEnd?: string;
  readonly tier?: AccountTier;
  readonly credits?: number;
}

/** A window written with raw SQL: what the DATABASE accepts, with no service in the way. */
export async function insertWindow(
  sql: Sql,
  accountId: string,
  w: RawWindow = {},
): Promise<string> {
  const start = w.start ?? "now() - interval '10 days'";
  const end = w.end ?? "now() + interval '20 days'";
  const [row] = await sql.unsafe<Array<{ id: string }>>(
    `INSERT INTO credit_windows
       (account_id, source, source_ref, natural_start, natural_end, window_start, window_end, tier, level_micro)
     VALUES ($1, $2, $3, ${w.naturalStart ?? start}, ${w.naturalEnd ?? end}, ${start}, ${end},
             $4::account_tier, $5)
     RETURNING id`,
    [
      accountId,
      w.source ?? 'stripe_invoice',
      w.sourceRef ?? `in_${randomUUID()}`,
      w.tier ?? 'api_starter',
      (w.credits ?? 3_000) * MICRO,
    ],
  );
  if (row === undefined) throw new Error('window insert returned nothing');
  return row.id;
}

export interface WindowRow {
  id: string;
  source: string;
  source_ref: string;
  tier: string;
  level_micro: string;
  level_seq: number;
  natural_start: Date;
  natural_end: Date;
  window_start: Date;
  window_end: Date;
  /** Whether the window contains the database's now(). */
  current: boolean;
}

export async function windowsOf(sql: Sql, accountId: string): Promise<WindowRow[]> {
  return sql<WindowRow[]>`
    SELECT id, source, source_ref, tier::text AS tier, level_micro::text AS level_micro, level_seq,
           natural_start, natural_end, window_start, window_end,
           (window_start <= now() AND now() < window_end) AS current
      FROM credit_windows WHERE account_id = ${accountId}::uuid ORDER BY window_start`;
}

export interface LotRow {
  id: string;
  kind: string;
  window_id: string | null;
  grant_key: string;
  granted_micro: string;
  remaining_micro: string;
  starts_at: Date;
  expires_at: Date;
}

export async function lotsOf(sql: Sql, accountId: string): Promise<LotRow[]> {
  return sql<LotRow[]>`
    SELECT id, kind, window_id, grant_key, granted_micro::text AS granted_micro,
           remaining_micro::text AS remaining_micro, starts_at, expires_at
      FROM credit_lots WHERE account_id = ${accountId}::uuid ORDER BY starts_at, id`;
}

export interface LedgerRow {
  kind: string;
  lot_id: string | null;
  lot_delta_micro: string;
  debt_delta_micro: string;
  idempotency_key: string;
}

export async function ledgerOf(sql: Sql, accountId: string): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    SELECT kind, lot_id, lot_delta_micro::text AS lot_delta_micro,
           debt_delta_micro::text AS debt_delta_micro, idempotency_key
      FROM credit_ledger WHERE account_id = ${accountId}::uuid ORDER BY id`;
}

/** Windows, lots and ledger rows the account has: the three things a grant writes. */
export async function grantCounts(
  sql: Sql,
  accountId: string,
): Promise<{ windows: number; lots: number; ledger: number }> {
  const [row] = await sql<Array<{ windows: number; lots: number; ledger: number }>>`
    SELECT (SELECT count(*)::int FROM credit_windows WHERE account_id = ${accountId}::uuid) AS windows,
           (SELECT count(*)::int FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
           (SELECT count(*)::int FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger`;
  if (row === undefined) throw new Error('count query returned nothing');
  return row;
}
