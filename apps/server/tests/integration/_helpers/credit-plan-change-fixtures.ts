// Fixtures for the MID-MONTH PLAN CHANGE tests: proration, clawbacks and the
// admin tier change (slice S6, on top of migration 0130).
//
// ⛔ THE PAID MONTH HERE IS 840 HOURS LONG, ON PURPOSE. A real Stripe monthly
// line runs `start → start + 1 month`, so its length is 28, 29, 30 or 31 days
// depending on the day the test runs, and no prorated share of it can be
// checked by hand. The lines below are 840 hours (35 days) — longer than any
// calendar month, so `natural_end = GREATEST(paid_end, start + 1 month)` is the
// PAID END exactly, the natural month and the window are the same stretch, and
// every share below is a fraction a reader can verify without a calendar.
// How a REAL Stripe month is drawn is S5's subject, and
// `a-credit-window-is-drawn-on-the-shared-billing-calendar` proves it; one arm
// here also re-checks the composition against an ordinary monthly line.
//
// ⛔ EVERY TIME IS SQL, AND EVERY OFFSET IS IN HOURS. The code under test judges
// everything on the DATABASE's clock, to the microsecond; a JavaScript Date
// would bring this process's clock and its milliseconds into a comparison made
// in microseconds. Offsets are hours rather than days because `timestamptz +
// interval '1 day'` is calendar arithmetic in the session's time zone — 23 or 25
// hours across a daylight-saving step — while hours are always hours. A test
// that ran on the wrong weekend would otherwise be out by an hour in a
// denominator, and report a proration defect that was really a fixture.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { AccountTier } from '@driftstack/api-types';
import { MICRO } from './credit-ledger-fixtures.js';
import { newAccountOn, subscription } from './credit-grant-fixtures.js';

type Sql = postgres.Sql | postgres.TransactionSql;

export { MICRO };

/** Midnight UTC today, as an SQL expression. Every offset below is measured from it. */
const TODAY_UTC = "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";

/** SQL for an instant `hours` from midnight UTC today. Negative is in the past. */
export function atHour(hours: number): string {
  return `(${TODAY_UTC} + interval '${String(hours)} hours')`;
}

/** The paid line's length, in hours: longer than any calendar month (see the header). */
export const MONTH_HOURS = 840;
/** 600 hours ago, so that now() is 600 hours into the paid month. */
export const MONTH_START = atHour(-MONTH_HOURS + 240);
/** 240 hours from now, so that now() is always inside the window. */
export const MONTH_END = atHour(240);

/**
 * The instant that leaves exactly `hours` of the window to run. The share of
 * the month a plan change from it earns is therefore `hours / 840`, which is
 * what each arm asserts.
 */
export function leaving(hours: number): string {
  return atHour(240 - hours);
}

export interface PaidMonth {
  readonly accountId: string;
  readonly subscriptionId: string;
  readonly invoiceId: string;
}

/**
 * An account on `tier` with an active subscription and ONE paid period line
 * covering now(): the ordinary paying customer, a month into their month.
 */
export async function paidMonth(sql: Sql, tier: AccountTier): Promise<PaidMonth> {
  const accountId = await newAccountOn(sql, tier);
  const subscriptionId = await subscription(sql, accountId, { tier });
  const invoiceId = await paidPeriodLine(sql, accountId, { subscriptionId, tier });
  return { accountId, subscriptionId, invoiceId };
}

/** A paid `period` line over `[MONTH_START, MONTH_END)`. Returns the invoice id. */
export async function paidPeriodLine(
  sql: Sql,
  accountId: string,
  spec: { subscriptionId: string; tier: AccountTier; start?: string; end?: string },
): Promise<string> {
  return insertPaidLine(sql, accountId, {
    ...spec,
    lineKind: 'period',
    start: spec.start ?? MONTH_START,
    end: spec.end ?? MONTH_END,
  });
}

/**
 * The paid `subscription_update` invoice an UPGRADE bills: a `proration_up`
 * line on the new plan, running from the moment the plan changed to the end of
 * the period. It is what §6.6 raises the level from, and (unlike a `period`
 * line) it never draws a window of its own.
 */
export async function paidProrationUpLine(
  sql: Sql,
  accountId: string,
  spec: { subscriptionId: string; tier: AccountTier; from: string; end?: string },
): Promise<string> {
  return insertPaidLine(sql, accountId, {
    subscriptionId: spec.subscriptionId,
    tier: spec.tier,
    lineKind: 'proration_up',
    start: spec.from,
    end: spec.end ?? MONTH_END,
  });
}

async function insertPaidLine(
  sql: Sql,
  accountId: string,
  spec: {
    subscriptionId: string;
    tier: AccountTier;
    lineKind: 'period' | 'proration_up';
    start: string;
    end: string;
    invoiceId?: string;
  },
): Promise<string> {
  const id = spec.invoiceId ?? `in_${randomUUID()}`;
  await sql.unsafe(
    `INSERT INTO billing_invoice_payments
       (stripe_invoice_id, account_id, stripe_subscription_id, billing_reason, amount_paid_minor, currency,
        line_kind, line_stripe_price_id, line_tier, line_interval, line_period_start, line_period_end,
        paid_at, refunded_minor)
     VALUES ($1, $2, $3, $4, 4900, 'usd', $5, $6, $7::account_tier, 'month',
             ${spec.start}, ${spec.end}, now(), 0)`,
    [
      id,
      accountId,
      spec.subscriptionId,
      spec.lineKind === 'period' ? 'subscription_cycle' : 'subscription_update',
      spec.lineKind,
      `price_${spec.tier}`,
      spec.tier,
    ],
  );
  return id;
}

/**
 * Move the subscription MIRROR to `tier` — what Stripe's `customer.subscription.updated`
 * writes. `since` is `tier_since`, the moment the plan actually changed, which is
 * what a DOWNGRADE is prorated from however late the event arrives.
 */
export async function mirrorMovedTo(
  sql: Sql,
  subscriptionId: string,
  tier: AccountTier,
  since: string,
): Promise<void> {
  await sql.unsafe(
    `UPDATE subscriptions
        SET tier = $2::account_tier, stripe_price_id = $3, tier_since = ${since}
      WHERE stripe_subscription_id = $1`,
    [subscriptionId, tier, `price_${tier}`],
  );
}

/** Cancel the subscription mirror: coverage ends, and with it the target level. */
export async function mirrorCanceled(sql: Sql, subscriptionId: string): Promise<void> {
  await sql`
    UPDATE subscriptions SET status = 'canceled'::subscription_status
     WHERE stripe_subscription_id = ${subscriptionId}`;
}

/**
 * Spend `credits` out of a lot, as a task would: a `task_charge` row, which the
 * ledger's apply trigger takes off the lot. `nth` distinguishes repeated charges
 * on one lot, because the ledger refuses a repeated idempotency key.
 */
export async function spendFromLot(
  sql: Sql,
  accountId: string,
  lotId: string,
  credits: number,
  nth = 1,
): Promise<void> {
  await sql`
    INSERT INTO credit_ledger
      (account_id, kind, lot_id, lot_delta_micro, idempotency_key, reservation_id,
       rate_card_version, model, actor)
    VALUES (${accountId}::uuid, 'task_charge', ${lotId}::uuid, ${String(-credits * MICRO)}::bigint,
            ${`task:${lotId}:${String(nth)}`}, ${randomUUID()}::uuid, 1, 'claude-sonnet-4-6', 'system')`;
}

/**
 * ⚠️ A FORGED HOLD. `credit_lots.held_micro` moves only through
 * `credit_reservation_holds`, and that table arrives with the reservations in
 * S7 — so there is no legal way yet to make a lot's credit "held by a running
 * task". This writes the column directly, with the lot guard switched off for
 * the one statement, so that the CLAWBACK's reading of held credit can be
 * exercised against the real database before S7 exists.
 *
 * ⛔ S7 OWES THE REAL PROOF: the same property driven through an actual
 * reservation, where the hold is taken and released by the code that will do it
 * in production. What is proved here is that `clawBack` reads `held_micro`,
 * leaves it alone, and books the shortfall it covers as a PENDING CLAIM rather
 * than debt — not that a reservation puts the right number there.
 *
 * Safe where it is used: an isolated database, rebuilt from the migrations on
 * every run, and the guard is switched back on before the function returns.
 */
export async function forgeHoldOnLot(sql: Sql, lotId: string, credits: number): Promise<void> {
  await sql`ALTER TABLE credit_lots DISABLE TRIGGER credit_lots_guard_trigger`;
  try {
    await sql`
      UPDATE credit_lots SET held_micro = ${String(credits * MICRO)}::bigint
       WHERE id = ${lotId}::uuid`;
  } finally {
    await sql`ALTER TABLE credit_lots ENABLE TRIGGER credit_lots_guard_trigger`;
  }
}

export interface LevelChangeRow {
  seq: number;
  reason: string;
  from_level_micro: string;
  to_level_micro: string;
  delta_micro: string;
  effective_at: Date;
}

/** Every recorded level change of one window, oldest first. */
export async function levelChangesOf(sql: Sql, windowId: string): Promise<LevelChangeRow[]> {
  return sql<LevelChangeRow[]>`
    SELECT seq, reason, from_level_micro::text AS from_level_micro,
           to_level_micro::text AS to_level_micro, delta_micro::text AS delta_micro, effective_at
      FROM credit_window_level_changes WHERE window_id = ${windowId}::uuid ORDER BY seq`;
}

export interface ClawbackRow {
  source: string;
  source_ref: string;
  target_key: string;
  state: string;
  amount_micro: string | null;
  clawed_micro: string | null;
  pending_micro: string;
  debt_micro: string | null;
}

/** Every clawback recorded against one account, oldest first. */
export async function clawbacksOf(sql: Sql, accountId: string): Promise<ClawbackRow[]> {
  return sql<ClawbackRow[]>`
    SELECT source, source_ref, target_key, state, amount_micro::text AS amount_micro,
           clawed_micro::text AS clawed_micro, pending_micro::text AS pending_micro,
           debt_micro::text AS debt_micro
      FROM credit_clawbacks WHERE account_id = ${accountId}::uuid ORDER BY created_at, source_ref`;
}

/** A live plan an admin set by hand, with `effective_since` and `anchor_at` in the past. */
export async function adminOverride(
  sql: Sql,
  accountId: string,
  spec: {
    monthlyCredits: number;
    reason: 'contract' | 'admin_tier';
    anchor?: string;
    /** Default true, as the column's own default is. */
    ownKeyAllowed?: boolean;
    note?: string;
  },
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO credit_plan_overrides
       (account_id, monthly_credits, anchor_at, effective_since, reason, own_key_allowed, note)
     VALUES ($1, $2, ${spec.anchor ?? atHour(-MONTH_HOURS)}, ${spec.anchor ?? atHour(-MONTH_HOURS)}, $3, $4, $5)`,
    [accountId, spec.monthlyCredits, spec.reason, spec.ownKeyAllowed ?? true, spec.note ?? ''],
  );
}

export interface OverrideRow {
  monthly_credits: number;
  reason: string;
  ends_at: Date | null;
  set_by_key_id: string | null;
  /**
   * The day of the month the credits reset on. Read back because an amendment
   * writes the row with an UPSERT, and an upsert that forgets a column silently
   * moves the whole month calendar (`coverageCandidatesSql` counts from it).
   */
  anchor_at: Date;
  /** When THIS figure began to apply: an amendment must move it. */
  effective_since: Date;
  own_key_allowed: boolean;
  note: string;
  /** Whether the override is live on the database's clock. */
  live: boolean;
}

export async function overrideOf(sql: Sql, accountId: string): Promise<OverrideRow | null> {
  const [row] = await sql<OverrideRow[]>`
    SELECT monthly_credits, reason, ends_at, set_by_key_id,
           anchor_at, effective_since, own_key_allowed, note,
           (anchor_at <= now() AND (ends_at IS NULL OR now() < ends_at)) AS live
      FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`;
  return row ?? null;
}

/** Put the account on credits, which is what makes the Enterprise rule apply to it. */
export async function onCredits(sql: Sql, accountId: string): Promise<void> {
  await sql`
    INSERT INTO credit_accounts (account_id, billing_mode) VALUES (${accountId}::uuid, 'credits')
    ON CONFLICT (account_id) DO UPDATE SET billing_mode = 'credits'`;
}

/** The account's tier, read back from the row the admin change writes. */
export async function tierOf(sql: Sql, accountId: string): Promise<string> {
  const [row] = await sql<Array<{ tier: string }>>`
    SELECT tier::text AS tier FROM accounts WHERE id = ${accountId}::uuid`;
  if (row === undefined) throw new Error(`account ${accountId} not found`);
  return row.tier;
}
