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
 * Spend `credits` out of a lot, as a task really does: a reservation that held
 * exactly that much, one model call that cost it, the hold released for the
 * whole of it, the `task_charge` row that takes it off the lot, and the
 * reservation settled. One transaction. `nth` distinguishes repeated charges on
 * one lot, because the ledger refuses a repeated idempotency key.
 *
 * ⛔ IT USED TO BE THE LEDGER ROW ALONE, NAMING A RESERVATION THAT DID NOT
 * EXIST. Migration 0131 gives `credit_ledger.reservation_id` its foreign key, so
 * that row is now refused (23503) — which is the point of the key, and was
 * predicted when 0128 landed without it. Writing the whole task instead also
 * puts the fixture under the COMMIT-time balance check: a settled task whose
 * charge is not equal across its calls, its holds and its ledger rows is
 * refused, so the fixture cannot drift into describing a state production
 * cannot reach.
 */
export async function spendFromLot(
  sql: postgres.Sql,
  accountId: string,
  lotId: string,
  credits: number,
  nth = 1,
): Promise<string> {
  const reservationId = randomUUID();
  const micro = String(credits * MICRO);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, slot, reserved_micro, committed_micro, lease_owner,
                                       lease_expires_at, max_until)
      SELECT ${reservationId}::uuid, ${accountId}::uuid, ${`as_${reservationId}`},
             'claude-sonnet-4-6', 1, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             ${micro}::bigint, ${micro}::bigint, 'fixture-boot',
             now() + interval '90 seconds', now() + interval '30 minutes'`;
    await tx`
      INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
      VALUES (${reservationId}::uuid, ${lotId}::uuid, ${accountId}::uuid, ${micro}::bigint)`;
    await tx`
      INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                      input_bound_tokens, input_bound_basis, input_bound_micro,
                                      max_output_tokens, bound_micro, sent, state, settle_basis,
                                      charged_micro, settled_at)
      VALUES (${randomUUID()}::uuid, ${reservationId}::uuid, ${accountId}::uuid, 1, 'plan',
              'claude-sonnet-4-6', 1000, 'region_bytes', 1, 4096, ${micro}::bigint,
              true, 'settled', 'provider_usage', ${micro}::bigint, now())`;
    // The release comes before the charge: `held_micro` counts against what the
    // lot has left, so charging first would leave it holding more than it has.
    await tx`
      UPDATE credit_reservation_holds SET released_at = now(), charged_micro = ${micro}::bigint
       WHERE reservation_id = ${reservationId}::uuid`;
    await tx`
      INSERT INTO credit_ledger
        (account_id, kind, lot_id, lot_delta_micro, idempotency_key, reservation_id,
         rate_card_version, model, actor)
      VALUES (${accountId}::uuid, 'task_charge', ${lotId}::uuid, ${`-${micro}`}::bigint,
              ${`task:${lotId}:${String(nth)}`}, ${reservationId}::uuid, 1,
              'claude-sonnet-4-6', 'system')`;
    await tx`
      UPDATE credit_reservations
         SET state = 'settled', charged_micro = ${micro}::bigint, settled_at = now(),
             settle_reason = 'completed'
       WHERE id = ${reservationId}::uuid`;
  });
  return reservationId;
}

/**
 * A RUNNING TASK holding `credits` of one lot: a real reservation and a real
 * `credit_reservation_holds` row, in one transaction.
 *
 * ⛔ IT REPLACES A FORGERY. Before migration 0131 existed there was no legal way
 * to make a lot's credit "held by a running task", so these arms wrote
 * `credit_lots.held_micro` directly with the lot guard switched OFF for one
 * statement. That proved what `clawBack` does with a number, and nothing about
 * whether anything could put the number there. Now the hold is written the only
 * way production writes one: the trigger moves `held_micro` itself, it refuses a
 * lot that is not started, live, unrevoked and this account's, and the
 * COMMIT-time check refuses a reservation whose holds do not sum to what it
 * reserved. No trigger is disabled anywhere in this file.
 *
 * The amounts here are whole months of credits, far above any model's
 * `max_reserve`, so the reservation is written directly rather than through
 * `reserve()` — which is what the reservation tests drive. What this needs is a
 * lot with credit genuinely held, not a realistic task.
 */
export async function holdOnLot(
  sql: postgres.Sql,
  accountId: string,
  lotId: string,
  credits: number,
): Promise<string> {
  const reservationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, slot, reserved_micro, lease_owner,
                                       lease_expires_at, max_until)
      SELECT ${reservationId}::uuid, ${accountId}::uuid, ${`as_${reservationId}`},
             'claude-sonnet-5', 1, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             ${String(credits * MICRO)}::bigint, 'fixture-boot',
             now() + interval '90 seconds', now() + interval '30 minutes'`;
    await tx`
      INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
      VALUES (${reservationId}::uuid, ${lotId}::uuid, ${accountId}::uuid,
              ${String(credits * MICRO)}::bigint)`;
  });
  return reservationId;
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
