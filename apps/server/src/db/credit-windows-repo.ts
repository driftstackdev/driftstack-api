// Reads and writes the month windows included AI credits are granted into
// (migration 0130): which paid coverage an account has right now, the window
// that coverage earns, the window's monthly lot, and the two "who needs
// attention" reads the background sweeps use.
//
// ⛔ EVERY BOUNDARY IS DRAWN BY THE DATABASE, ON THE DATABASE'S CLOCK. A window's
// start and end are compared with its neighbours' to the microsecond by the
// no-overlap constraint, and a JavaScript Date holds milliseconds: a boundary
// that passed through one would land up to 999 µs early, overlap the window
// before it, and be skipped as "already covered". So the month arithmetic, the
// "does it contain now()" test and the share of a partial month are all computed
// in SQL, and a boundary crosses this process only as text (`PgInstant`), exact
// to the microsecond, to be handed straight back.
//
// The natural month is the billing calendar `addUtcMonths` defines in
// @driftstack/api-types, in its Postgres form:
// `(anchor AT TIME ZONE 'UTC' + make_interval(months => k)) AT TIME ZONE 'UTC'`,
// always counted from the anchor. The two are held equal by
// `the-natural-month-calendar-agrees-with-postgres`, and
// `a-credit-window-is-drawn-on-the-shared-billing-calendar` holds the windows
// this file draws to that calendar.
//
// ⛔ THE DATABASE IS THE AUTHORITY, NOT THIS FILE. Windows never overlap, are
// never created ahead of their start, and change only their level; a window has
// one monthly lot; a lot is born empty. All of that is enforced in Postgres (see
// the notes beside `creditWindows` in schema.ts). The `WHERE` clauses here exist
// so an ordinary "nothing to do" is an empty result, not an exception.

import { sql, type SQL } from 'drizzle-orm';
import {
  AccountTierSchema,
  AI_PLAN_ENTITLEMENTS,
  planMonthlyCreditsMicro,
  type AccountTier,
} from '@driftstack/api-types';
import type { Database } from './client.js';
import { rowsOf, type CreditLedgerExecutor, type CreditLedgerTx } from './credit-ledger-repo.js';

/** What a window's coverage came from (`credit_windows_source`). */
export const CREDIT_WINDOW_SOURCES = [
  'stripe_invoice',
  'crypto_entitlement',
  'plan_override',
] as const;
export type CreditWindowSource = (typeof CREDIT_WINDOW_SOURCES)[number];

/**
 * Why a window's level changed (`credit_window_level_changes_reason`).
 * `plan_change` is written by `reconcileLevel`; the other three are a refund or
 * a dispute, which S17 writes.
 */
export const CREDIT_WINDOW_LEVEL_CHANGE_REASONS = [
  'plan_change',
  'refund',
  'dispute',
  'dispute_reinstated',
] as const;
export type CreditWindowLevelChangeReason = (typeof CREDIT_WINDOW_LEVEL_CHANGE_REASONS)[number];

/**
 * What took credits back (`credit_clawbacks_source`). `plan_change` is written
 * by a mid-month downgrade; the rest arrive with refunds and disputes (S17).
 */
export const CREDIT_CLAWBACK_SOURCES = [
  'plan_change',
  'stripe_refund',
  'stripe_dispute',
  'crypto_refund',
  'admin',
] as const;
export type CreditClawbackSource = (typeof CREDIT_CLAWBACK_SOURCES)[number];

/** Where a clawback stands (`credit_clawbacks_state`). */
export const CREDIT_CLAWBACK_STATES = ['applied', 'unmatched', 'reversed'] as const;
export type CreditClawbackState = (typeof CREDIT_CLAWBACK_STATES)[number];

/** The `source_ref` of every window that comes from a plan an admin set by hand. */
export const PLAN_OVERRIDE_SOURCE_REF = 'override';

/**
 * S17 — the level a paid line earns, after the share of it that has been
 * refunded or disputed is taken off (plan M8): a refund or a dispute of a
 * fraction `f` of an invoice lowers what that invoice covers by the same
 * fraction, rounded DOWN to whole credits (the level column accepts nothing
 * else). It is ONE expression used at every place coverage is computed, so the
 * level a clawback sets and the level a reconciliation would target are the
 * same number to the microcredit, and a refund is never re-granted as an
 * "upgrade" on the next refresh. A free invoice (`amount_paid_minor = 0`)
 * covers in full, as it always did.
 *
 * A top-level fragment with no interpolation of its own, referenced by name
 * inside each query: a fragment NESTED as an inline template would put a
 * backtick inside the query's text, which the guard that reads every raw
 * query for its ORDER BY cannot see past; and raw text splicing is refused by
 * the guard that keeps every query parameterised. Bigint arithmetic throughout.
 *
 * ⛔ AN UPGRADE LINE COVERS ITS INCREMENT, NOT THE WHOLE NEW PLAN (S17 audit
 * #5). A paid `proration_up` line is what a mid-month upgrade is: it pays for
 * the difference between the level the window was at and the new plan. So a
 * partly refunded upgrade line covers `from + (upper − from) × share`, where
 * `from` is the level its FIRST plan-change step started at (the step keyed to
 * that invoice, 0136) — not `upper × share`, which scaled the whole new plan by
 * the upgrade invoice's share and took back more than it bought. Written as
 * `(upper × still_paid + from × reversed) / paid`, which is the same number and
 * reads `from` once. Share 1 is `upper`, exactly as before; a line wholly
 * reversed is excluded by `STILL_PAID_FOR`, as before; a line with no step
 * keyed to it yet (the refresh has not run, or a row written before 0136) is
 * measured from 0, which is the old rule.
 */
const PAID_LINE_LEVEL = sql`CASE WHEN pay.amount_paid_minor = 0
       THEN LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro)
       ELSE ((LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro)
                * GREATEST(pay.amount_paid_minor - pay.refunded_minor - pay.disputed_minor, 0)
              + CASE WHEN pay.line_kind = 'proration_up'
                          AND pay.refunded_minor + pay.disputed_minor > 0
                     THEN LEAST(LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro),
                                COALESCE((SELECT first_step.from_level_micro
                                            FROM credit_window_level_changes first_step
                                            JOIN credit_windows first_window
                                              ON first_window.id = first_step.window_id
                                           WHERE first_window.account_id = pay.account_id
                                             AND first_step.reason = 'plan_change'
                                             AND first_step.source_ref = pay.stripe_invoice_id
                                           ORDER BY first_step.created_at, first_step.window_id,
                                                    first_step.seq
                                           LIMIT 1), 0))
                          * (pay.amount_paid_minor
                             - GREATEST(pay.amount_paid_minor - pay.refunded_minor - pay.disputed_minor, 0))
                     ELSE 0 END)
             / pay.amount_paid_minor / 1000000) * 1000000 END`;

/**
 * S17 — an invoice whose payment has been wholly refunded or disputed covers
 * nothing. Exported because the cutover's coverage read
 * (`credit-cutover-repo.ts`) must apply the same rule the grants do: a copy
 * that drifted would move accounts no grant covers.
 */
export const STILL_PAID_FOR = sql`(pay.refunded_minor + pay.disputed_minor < pay.amount_paid_minor OR pay.amount_paid_minor = 0)`;

/**
 * A `timestamptz`, as UTC text exact to the microsecond:
 * `2026-01-31T00:00:00.000000Z`. Fixed width, so two of them order as strings.
 */
export type PgInstant = string;

const PG_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function instant(what: string, value: unknown): PgInstant {
  if (typeof value !== 'string' || !PG_INSTANT.test(value)) {
    throw new RangeError(`${what} is not a microsecond UTC instant`);
  }
  return value;
}

/**
 * The first whole millisecond at or after `at`. For scheduling: a job due "at
 * the window's end" must not wake a fraction of a millisecond before it.
 */
export function firstMillisecondAtOrAfter(at: PgInstant): Date {
  const ms = Date.parse(`${instant('an instant', at).slice(0, 23)}Z`);
  return new Date(at.slice(23, 26) === '000' ? ms : ms + 1);
}

/** A window an account's paid coverage earns right now. Every boundary was drawn in SQL. */
export interface CreditWindowCandidate {
  readonly source: CreditWindowSource;
  /** The Stripe invoice id, the crypto order id, or `PLAN_OVERRIDE_SOURCE_REF`. */
  readonly sourceRef: string;
  readonly tier: AccountTier;
  /** The monthly level, in microcredits. */
  readonly levelMicro: number;
  readonly naturalStart: PgInstant;
  readonly naturalEnd: PgInstant;
  readonly windowStart: PgInstant;
  readonly windowEnd: PgInstant;
}

export type WriteWindowResult =
  /** The window was written now. */
  | { readonly outcome: 'created'; readonly windowId: string }
  /** This payment's window for this month was already there. */
  | { readonly outcome: 'existing'; readonly windowId: string }
  /**
   * Nothing was written and nothing is wrong: another window already covers
   * part of that time, or the candidate does not contain now().
   */
  | { readonly outcome: 'covered' };

export interface MonthlyLot {
  readonly lotId: string;
  readonly grantedMicro: number;
}

/**
 * S17 — one window a refund, dispute or crypto refund may claw from: every
 * window a given coverage source earned, granted so far (an annual invoice
 * earns one per month). `current` says whether it contains now(), which is
 * the only window whose LEVEL a clawback moves; a past window's lots may still
 * be clawed (what they held is what the payment bought), but its level is
 * history.
 */
export interface SourcedCreditWindow {
  readonly id: string;
  /** The coverage the window was drawn from (an invoice, an order, the override marker). */
  readonly sourceRef: string;
  readonly levelMicro: number;
  readonly levelSeq: number;
  readonly windowStart: PgInstant;
  readonly windowEnd: PgInstant;
  readonly current: boolean;
}

export interface CurrentCreditWindow {
  readonly id: string;
  readonly windowEnd: PgInstant;
  /** S13 — the old status route's `month_started_at`. Added alongside
   *  `levelMicro`; `refreshCreditsIn` (the only other caller) reads neither. */
  readonly windowStart: PgInstant;
  /** S13 — the monthly rate this window is levelled at right now (§4.4's
   *  `credit_windows.level_micro`), for the old status route's `cap_cents`.
   *  NOT the same as the window's monthly LOT's `granted_micro`: a short
   *  first window prorates that lot down, while the level is the full rate a
   *  later, full-length window would grant. */
  readonly levelMicro: number;
}

/**
 * What the current window's level should be, and everything the prorated
 * difference is computed from. Null from `levelReconciliation` when there is
 * nothing to do.
 *
 * Every boundary here was drawn by the DATABASE. The two durations are whole
 * MICROSECONDS, because that is the unit Postgres keeps a `timestamptz` in: a
 * duration that crossed this process as a JavaScript Date would be rounded to
 * the millisecond, and the proration would be a different number from the one
 * the same instants produce in SQL.
 */
export interface CreditLevelReconciliation {
  readonly windowId: string;
  /** The level the window is at now, in microcredits. */
  readonly levelMicro: number;
  /** The window's `level_seq` now; the change about to be written is `levelSeq + 1`. */
  readonly levelSeq: number;
  /** The level the account's paid coverage earns at now(). Never 0 and never equal to `levelMicro`. */
  readonly targetMicro: number;
  /** Which coverage supplies the target. */
  readonly source: CreditWindowSource;
  /**
   * S17 — WHICH coverage of that kind: the Stripe invoice id, the crypto order
   * id, or `PLAN_OVERRIDE_SOURCE_REF`. Recorded on the level change (0136), so
   * the proration lot an upgrade grants belongs to the invoice that paid for it.
   */
  readonly sourceRef: string;
  /**
   * `u`: when the change takes effect, clamped to `[window_start, now()]`. An
   * upgrade's comes from the paid line that earns the target; a downgrade's
   * from the coverage the window was drawn from, or from now() when that
   * coverage is gone (see `levelReconciliationSql`).
   */
  readonly effectiveAt: PgInstant;
  /** `window_end − u`, in whole microseconds. */
  readonly remainingMicroseconds: number;
  /** `natural_end − natural_start`, in whole microseconds. */
  readonly naturalMicroseconds: number;
}

/** One level change, as `setWindowLevel` writes it. */
export interface CreditWindowLevelChange {
  readonly accountId: string;
  readonly windowId: string;
  /** The window's `level_seq` AFTER the change. The first change is 1. */
  readonly seq: number;
  readonly reason: CreditWindowLevelChangeReason;
  readonly fromLevelMicro: number;
  readonly toLevelMicro: number;
  readonly effectiveAt: PgInstant;
  /**
   * Credits granted (positive) or taken back (negative) for the rest of the
   * window by a plan change. A refund, dispute or won dispute records 0: the
   * credits it moved are its clawback's rows, not a second amount here.
   */
  readonly deltaMicro: number;
  /**
   * 0136 — the coverage the change is attributed to: for a plan change the
   * coverage that supplies the new level, for a reversal the invoice or order
   * whose payment moved. Every writer in this codebase passes it; absent or
   * null records no attribution, which is what a row written before 0136 has.
   */
  readonly sourceRef?: string | null;
}

/**
 * S17 — the window containing now() and the level the account's paid coverage
 * earns at now(), read with the SAME query `levelReconciliation` uses: what a
 * reversal levels the window to is exactly what the next reconciliation would
 * target, so the refresh after it finds nothing to do.
 */
export interface CreditCoverNow {
  readonly windowId: string;
  readonly levelMicro: number;
  readonly levelSeq: number;
  /** The best coverage's level at now(); null when nothing covers now(). */
  readonly targetMicro: number | null;
  /** WHICH coverage supplies the target (an invoice, an order, the override marker); null with it. */
  readonly sourceRef: string | null;
  /**
   * Whether that coverage is a paid `proration_up` line: an upgrade that pays
   * for the step above the level beneath it, not for a month of its own. A
   * reversal of another invoice never treats it as cover that could take the
   * month over (see `levelAfterReversal` in credit-clawbacks.ts).
   */
  readonly upgradeLine: boolean;
}

/**
 * S17 — one lot a reversal of one invoice (or crypto order) may take from in
 * one window, with what the state-based arithmetic needs. The lots are the
 * invoice's OWN: the window's monthly lot when the window was drawn from it,
 * the proration lots of the plan-change steps keyed to it, and the lots a won
 * dispute of it re-granted. Never another invoice's lot, never a goodwill or
 * bought lot.
 */
export interface ReversalLot extends ClawbackTargetLot {
  /**
   * What left the lot on work the customer had done: task charges, debt repaid
   * from it, and claims that OTHER clawbacks — another invoice's reversal, a
   * reversal of another month — collected from it (S17 re-audit #12). Claims
   * this invoice's own reversals of this month or a plan change collected are
   * not spending: those are what the reversal arithmetic's O accounts for.
   */
  readonly consumedMicro: number;
  /**
   * A lot a won dispute gave back: what it re-granted of what it took, or the
   * credit it granted to raise a month drawn while it stood (a
   * `dispute_reinstated` step's lot). Its credit counts as held or spent credit
   * of the invoice, but its grant is NOT more of what the invoice paid for.
   */
  readonly regrant: boolean;
  /**
   * 0137 — what the paying invoice still paid when the lot was granted, in its
   * minor units; null for a lot written before 0137 (read as the whole payment).
   */
  readonly stillPaidMinor: number | null;
}

/**
 * S17 — a clawback that still stands against one invoice's credit in one
 * window, as the state-based arithmetic reads it: a refund, dispute or crypto
 * refund of that invoice there, or a plan change of that window whose step is
 * attributed to the invoice (S17 re-audit #4).
 */
export interface StandingReversal {
  readonly id: string;
  readonly amountMicro: number;
  readonly clawedMicro: number;
}

/** S17 — one claim a clawback collected from the credit a settling task released. */
export interface CollectedClaim {
  readonly clawbackId: string;
  readonly lotId: string;
  readonly micro: number;
}

/** One lot a clawback may take from, with everything the arithmetic needs. */
export interface ClawbackTargetLot {
  readonly lotId: string;
  readonly grantedMicro: number;
  /** What has already left the lot unspent because its term ended, as a positive magnitude. */
  readonly expiredMicro: number;
  readonly remainingMicro: number;
  readonly heldMicro: number;
}

export interface CreditClawbackKey {
  readonly source: CreditClawbackSource;
  /** What caused it: `<window>:<seq>` for a plan change, a charge and its cumulative refund for a refund. */
  readonly sourceRef: string;
  /** What it claws from: `window:<window>` for a plan change. */
  readonly targetKey: string;
}

export interface CreditClawbackRecord extends CreditClawbackKey {
  readonly id: string;
  readonly accountId: string;
  readonly state: CreditClawbackState;
  /** The amount asked for, in microcredits; null for a clawback measured as a fraction. */
  readonly amountMicro: number | null;
  /** What was actually taken from lots. */
  readonly clawedMicro: number;
  /** The shortfall that credits held by running tasks cover; paid from them at settle (S7). */
  readonly pendingMicro: number;
  /** The shortfall that nothing covers: the account now owes it. */
  readonly debtMicro: number;
}

/** The grant key of a window's proration lot for one level change. */
export function prorationGrantKey(windowId: string, seq: number): string {
  return `proration:${windowId}:${String(seq)}`;
}

/**
 * Each plan's own monthly allowance, as the JSON the coverage query joins on.
 * Plans with no plan-wide number (a contract) and plans with none at all are
 * absent, so a paid line or crypto term on one of them covers nothing: only an
 * override an admin set can grant it credits.
 */
export function planAllowancesJson(): string {
  const rows: Array<{ tier: AccountTier; allowance_micro: number }> = [];
  for (const tier of AccountTierSchema.options) {
    if (!Object.hasOwn(AI_PLAN_ENTITLEMENTS, tier)) continue;
    const micro = planMonthlyCreditsMicro(tier);
    if (micro !== null && micro > 0) rows.push({ tier, allowance_micro: micro });
  }
  return JSON.stringify(rows);
}

/**
 * The windows paid coverage earns at now(), for one account or (null) for every
 * account: one row per source that covers now() and whose window would contain
 * now(). An account that already has a window over now() yields nothing.
 *
 *   src     what covers now(), its monthly level, and the end of what was paid
 *   months  the natural month of each that contains now()
 *   cand    the window: from the later of the month's start and the end of the
 *           account's latest window, to the earlier of the month's end and the
 *           end of what was paid
 *
 * COVERAGE IS PAID COVERAGE:
 *   · Stripe — a paid invoice's subscription line (`line_kind = 'period'`) whose
 *     period contains now(), not fully refunded (a $0 invoice was paid), on a
 *     subscription that is `active` right now: not trialing, past_due, unpaid or
 *     paused. A renewal whose invoice is not paid yet has no such row, so it
 *     grants nothing however active the subscription says it is. The level is
 *     the LOWER of the paid line's plan and the subscription's current plan: an
 *     upgrade that has not been paid for does not raise it, a downgrade lowers it.
 *   · Crypto — an entitlement whose term contains now().
 *   · Override — a plan an admin set, live at now(), granting more than nothing.
 *
 * THE NATURAL MONTH. A yearly line and an override run month by month from
 * their anchor. A monthly line and a crypto term are one month in themselves —
 * Stripe draws a monthly period with its own calendar (Feb 28 → Mar 31 for a
 * subscription anchored on the 31st), so the paid period is the month, not
 * `start + 1 month`. A natural month is never SHORTER than one calendar month
 * from its start, though: a paid line of a few days is the window, and gets a
 * few days' share of the level, not the whole of it.
 */
function coverageCandidatesSql(accountId: string | null): SQL {
  // One optional filter per source, each its own parameterised fragment: the
  // query text below is a literal, with nothing spliced into it but parameters.
  const onlyPaid = accountId === null ? sql`` : sql` AND pay.account_id = ${accountId}::uuid`;
  const onlyCrypto = accountId === null ? sql`` : sql` AND ce.account_id = ${accountId}::uuid`;
  const onlyOverride = accountId === null ? sql`` : sql` AND o.account_id = ${accountId}::uuid`;
  // `anchor + k months` is always `((anchor AT TIME ZONE 'UTC') + make_interval(months => k))
  // AT TIME ZONE 'UTC'`: counted from the anchor in UTC, so Jan 31 + 1 is Feb 28 (29) and + 2 is
  // Mar 31 again. `est.k0` is the calendar-field estimate of k; the true k is k0 or k0 - 1
  // (the day or time of day has not come round yet), and k0 + 1 is tried for safety.
  return sql`
    WITH clock AS (SELECT now() AS t),
    plan AS (
      SELECT p.tier, p.allowance_micro
        FROM jsonb_to_recordset(${planAllowancesJson()}::jsonb) AS p(tier text, allowance_micro bigint)
    ),
    src AS (
      SELECT pay.account_id,
             'stripe_invoice'::text AS source,
             pay.stripe_invoice_id AS source_ref,
             CASE WHEN mirror_plan.allowance_micro < line_plan.allowance_micro
                  THEN mirror_plan.tier ELSE line_plan.tier END AS tier,
             ${PAID_LINE_LEVEL} AS level_micro,
             (pay.line_interval = 'year') AS by_month,
             pay.line_period_start AS starts,
             pay.line_period_end AS paid_end
        FROM billing_invoice_payments pay
        JOIN subscriptions sub
          ON sub.stripe_subscription_id = pay.stripe_subscription_id AND sub.account_id = pay.account_id
        JOIN plan line_plan ON line_plan.tier = pay.line_tier::text
        JOIN plan mirror_plan ON mirror_plan.tier = sub.tier::text
       CROSS JOIN clock
       WHERE pay.line_kind = 'period'
         AND pay.line_interval IS NOT NULL
         AND pay.line_period_start <= clock.t AND clock.t < pay.line_period_end
         AND ${STILL_PAID_FOR}
         AND sub.status = 'active'${onlyPaid}
      UNION ALL
      SELECT ce.account_id, 'crypto_entitlement', ce.order_id, crypto_plan.tier,
             crypto_plan.allowance_micro, false, ce.starts_at, ce.expires_at
        FROM crypto_entitlements ce
        JOIN plan crypto_plan ON crypto_plan.tier = ce.tier::text
       CROSS JOIN clock
       WHERE ce.starts_at <= clock.t AND clock.t < ce.expires_at${onlyCrypto}
      UNION ALL
      SELECT o.account_id, 'plan_override', ${PLAN_OVERRIDE_SOURCE_REF}, a.tier::text,
             o.monthly_credits::bigint * 1000000, true, o.anchor_at,
             COALESCE(o.ends_at, 'infinity'::timestamptz)
        FROM credit_plan_overrides o
        JOIN accounts a ON a.id = o.account_id
       CROSS JOIN clock
       WHERE o.anchor_at <= clock.t AND o.effective_since <= clock.t
         AND (o.ends_at IS NULL OR clock.t < o.ends_at)
         AND o.monthly_credits > 0${onlyOverride}
    ),
    months AS (
      SELECT src.*, n.natural_start, n.natural_end
        FROM src
       CROSS JOIN clock
       CROSS JOIN LATERAL (
         SELECT src.starts AS natural_start,
                GREATEST(
                  src.paid_end,
                  ((src.starts AT TIME ZONE 'UTC') + make_interval(months => 1)) AT TIME ZONE 'UTC'
                ) AS natural_end
          WHERE NOT src.by_month
         UNION ALL
         SELECT m.natural_start, m.natural_end
           FROM (
             SELECT (extract(year FROM clock.t AT TIME ZONE 'UTC')::int
                       - extract(year FROM src.starts AT TIME ZONE 'UTC')::int) * 12
                    + extract(month FROM clock.t AT TIME ZONE 'UTC')::int
                    - extract(month FROM src.starts AT TIME ZONE 'UTC')::int AS k0
           ) est
          CROSS JOIN LATERAL generate_series(GREATEST(0, est.k0 - 1), est.k0 + 1) AS k(k)
          CROSS JOIN LATERAL (
             SELECT ((src.starts AT TIME ZONE 'UTC') + make_interval(months => k.k))
                      AT TIME ZONE 'UTC' AS natural_start,
                    ((src.starts AT TIME ZONE 'UTC') + make_interval(months => k.k + 1))
                      AT TIME ZONE 'UTC' AS natural_end
          ) m
          WHERE src.by_month AND m.natural_start <= clock.t AND clock.t < m.natural_end
       ) n
    ),
    cand AS (
      SELECT months.*,
             GREATEST(months.natural_start, COALESCE(latest.ended, months.natural_start)) AS window_start,
             LEAST(months.natural_end, months.paid_end) AS window_end
        FROM months
        LEFT JOIN LATERAL (
          SELECT max(w.window_end) AS ended FROM credit_windows w WHERE w.account_id = months.account_id
        ) latest ON true
    )
    SELECT cand.account_id, cand.source, cand.source_ref, cand.tier, cand.level_micro::text AS level_micro,
           to_char(cand.natural_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS natural_start,
           to_char(cand.natural_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS natural_end,
           to_char(cand.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
           to_char(cand.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end
      FROM cand
     CROSS JOIN clock
     WHERE cand.window_start <= clock.t AND clock.t < cand.window_end
     ORDER BY cand.level_micro DESC, cand.window_start, cand.source, cand.source_ref`;
}

interface CandidateRow {
  account_id: string;
  source: string;
  source_ref: string;
  tier: string;
  level_micro: string;
  natural_start: string;
  natural_end: string;
  window_start: string;
  window_end: string;
}

function exactMicro(what: string, text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} is not a safe non-negative integer of microcredits`);
  }
  return value;
}

function toCandidate(r: CandidateRow): CreditWindowCandidate {
  if (!(CREDIT_WINDOW_SOURCES as readonly string[]).includes(r.source)) {
    throw new RangeError('a coverage row names an unknown source');
  }
  return {
    source: r.source as CreditWindowSource,
    sourceRef: r.source_ref,
    tier: AccountTierSchema.parse(r.tier),
    levelMicro: exactMicro('a window level', r.level_micro),
    naturalStart: instant('natural_start', r.natural_start),
    naturalEnd: instant('natural_end', r.natural_end),
    windowStart: instant('window_start', r.window_start),
    windowEnd: instant('window_end', r.window_end),
  };
}

/**
 * What the window containing now() should be levelled at, and what the prorated
 * difference is computed from. One row, or none when there is nothing to do.
 *
 *   w      the window containing now(). An account's windows never overlap, so
 *          there is at most one.
 *   cover  every paid coverage over now(), at the level it earns. Unlike the
 *          grant query this one reads BOTH invoice line kinds: a paid
 *          `proration_up` line is what a mid-month upgrade is, and it raises the
 *          target from ITS OWN line start.
 *   best   the highest of them. It supplies the TARGET.
 *   mine   the coverage the window itself was drawn from, if it still covers
 *          now(). It supplies `u` for a downgrade; see below.
 *
 * `u`, the point the difference is measured from, comes from the DIRECTION:
 * an upgrade runs from the paid line's start (a crypto term and an override
 * from when they began), and a downgrade from `tier_since` — when the
 * subscription's plan actually changed, which is NOT when the event announcing
 * it arrived. `u` is then clamped to `[window_start, now()]`.
 *
 * ⛔ A DOWNGRADE'S `u` IS ONLY EVIDENCE WHEN IT COMES FROM THE COVERAGE THIS
 * WINDOW WAS DRAWN FROM, which is why it is read from `mine` and not from
 * `best`. An upgrade's `u` is backed by a PAYMENT — a line the customer has
 * paid for from that instant — so it is good whichever source it is on. A
 * downgrade's is backed by an assumption: that `tier_since` (or a term's start)
 * says when the account stopped earning the level the window is AT. For the
 * window's own coverage that is true. For any OTHER coverage it is not, and it
 * is usually much older than the window, so the clamp below would drag `u` back
 * to `window_start` and take the WHOLE month's difference back — charging the
 * customer for time they were served, and writing debt for credits they had
 * already spent under the plan that was live. The shape is reachable, and S6
 * itself makes it: an admin tier change ENDS an `admin_tier` override (M7), and
 * what is left covering now() is a cheaper subscription whose `tier_since` has
 * nothing to do with this window. When the window's own coverage is gone — the
 * override that ended, a term that lapsed — nothing in the database records the
 * instant it stopped, so the change is dated to NOW: the refresh that observes
 * it. Every path into a refresh runs within minutes of the change, and erring
 * this way leaves credit with the customer rather than taking back what they
 * were entitled to.
 *
 * ⛔ THE ORDER THAT PICKS `best` IS TOTAL, because it decides an amount of money.
 * Two coverages can earn the same level — a renewal's `period` line beside the
 * `proration_up` line of the upgrade it renews, say — and they carry DIFFERENT
 * starts, so an order that stopped at the level would prorate from whichever
 * row Postgres happened to return first. The proration line is preferred, which
 * is what §6.6 names for an upgrade, and every remaining tie is broken on the
 * two instants themselves.
 *
 * ⛔ NOTHING TO DO IS ORDINARY, NOT AN ERROR. Nothing covers now() (a lapse),
 * or the coverage already agrees with the level. A lapse must NOT drop the
 * level: the month was paid for, and what stops the account spending is its
 * tier. The query returns the current window whether or not anything covers it
 * (`best` is joined LEFT), and `levelReconciliation` decides there is nothing
 * to do; `coverNow` (S17) reads the same row for the target a reversal levels
 * the window to, which is why it is one query and not two.
 */
function levelReconciliationSql(accountId: string): SQL {
  return sql`
    WITH clock AS (SELECT now() AS t),
    plan AS (
      SELECT p.tier, p.allowance_micro
        FROM jsonb_to_recordset(${planAllowancesJson()}::jsonb) AS p(tier text, allowance_micro bigint)
    ),
    w AS (
      SELECT cw.id, cw.source, cw.source_ref, cw.level_micro, cw.level_seq,
             cw.window_start, cw.window_end, cw.natural_start, cw.natural_end
        FROM credit_windows cw
       CROSS JOIN clock
       WHERE cw.account_id = ${accountId}::uuid
         AND cw.window_start <= clock.t AND clock.t < cw.window_end
    ),
    cover AS (
      SELECT 'stripe_invoice'::text AS source,
             pay.stripe_invoice_id AS source_ref,
             -- A paid proration line is the upgrade itself; a period line that
             -- earns the same level is the month it sits in.
             CASE WHEN pay.line_kind = 'proration_up' THEN 0 ELSE 1 END AS kind_rank,
             ${PAID_LINE_LEVEL} AS level_micro,
             pay.line_period_start AS up_from,
             COALESCE(sub.tier_since, clock.t) AS down_from
        FROM billing_invoice_payments pay
        JOIN subscriptions sub
          ON sub.stripe_subscription_id = pay.stripe_subscription_id AND sub.account_id = pay.account_id
        JOIN plan line_plan ON line_plan.tier = pay.line_tier::text
        JOIN plan mirror_plan ON mirror_plan.tier = sub.tier::text
       CROSS JOIN clock
       WHERE pay.account_id = ${accountId}::uuid
         AND pay.line_kind IN ('period', 'proration_up')
         AND pay.line_period_start <= clock.t AND clock.t < pay.line_period_end
         AND ${STILL_PAID_FOR}
         AND sub.status = 'active'
      UNION ALL
      SELECT 'crypto_entitlement', ce.order_id, 1, crypto_plan.allowance_micro,
             ce.starts_at, ce.starts_at
        FROM crypto_entitlements ce
        JOIN plan crypto_plan ON crypto_plan.tier = ce.tier::text
       CROSS JOIN clock
       WHERE ce.account_id = ${accountId}::uuid
         AND ce.starts_at <= clock.t AND clock.t < ce.expires_at
      UNION ALL
      SELECT 'plan_override', ${PLAN_OVERRIDE_SOURCE_REF}, 1,
             o.monthly_credits::bigint * 1000000, o.effective_since, o.effective_since
        FROM credit_plan_overrides o
       CROSS JOIN clock
       WHERE o.account_id = ${accountId}::uuid
         AND o.anchor_at <= clock.t AND o.effective_since <= clock.t
         AND (o.ends_at IS NULL OR clock.t < o.ends_at)
         AND o.monthly_credits > 0
    ),
    best AS (
      SELECT cover.* FROM cover
       ORDER BY cover.level_micro DESC, cover.kind_rank, cover.source, cover.source_ref,
                cover.up_from, cover.down_from
       LIMIT 1
    )
    SELECT w.id,
           w.level_micro::text AS level_micro,
           w.level_seq,
           best.source,
           best.source_ref,
           best.kind_rank,
           best.level_micro::text AS target_micro,
           to_char(u.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at,
           (extract(epoch FROM (w.window_end - u.at)) * 1000000)::bigint::text AS remaining_us,
           (extract(epoch FROM (w.natural_end - w.natural_start)) * 1000000)::bigint::text AS natural_us
      FROM w
      LEFT JOIN best ON true
     CROSS JOIN clock
     CROSS JOIN LATERAL (
       SELECT max(own.down_from) AS at
         FROM cover own
        WHERE own.source = w.source AND own.source_ref = w.source_ref
     ) mine
     CROSS JOIN LATERAL (
       SELECT LEAST(
                GREATEST(
                  CASE WHEN best.level_micro > w.level_micro THEN best.up_from
                       ELSE COALESCE(mine.at, clock.t) END,
                  w.window_start),
                clock.t) AS at
     ) u`;
}

interface ReconciliationRow {
  id: string;
  level_micro: string;
  level_seq: number;
  /** Null, with the five columns after it, when nothing covers now(). */
  source: string | null;
  source_ref: string | null;
  /** 0 for a paid `proration_up` line, 1 for every other coverage. */
  kind_rank: number | null;
  target_micro: string | null;
  effective_at: string | null;
  remaining_us: string | null;
  natural_us: string | null;
}

interface ClawbackRow {
  id: string;
  account_id: string;
  source: string;
  source_ref: string;
  target_key: string;
  state: string;
  amount_micro: string | null;
  clawed_micro: string | null;
  pending_micro: string;
  debt_micro: string | null;
}

function toClawbackRecord(r: ClawbackRow): CreditClawbackRecord {
  if (!(CREDIT_CLAWBACK_SOURCES as readonly string[]).includes(r.source)) {
    throw new RangeError('credit_clawbacks.source holds an unknown value');
  }
  if (!(CREDIT_CLAWBACK_STATES as readonly string[]).includes(r.state)) {
    throw new RangeError('credit_clawbacks.state holds an unknown value');
  }
  return {
    id: r.id,
    accountId: r.account_id,
    source: r.source as CreditClawbackSource,
    sourceRef: r.source_ref,
    targetKey: r.target_key,
    state: r.state as CreditClawbackState,
    amountMicro: r.amount_micro === null ? null : exactMicro('a clawback amount', r.amount_micro),
    clawedMicro: r.clawed_micro === null ? 0 : exactMicro('clawed credit', r.clawed_micro),
    pendingMicro: exactMicro('a pending claim', r.pending_micro),
    debtMicro: r.debt_micro === null ? 0 : exactMicro('clawback debt', r.debt_micro),
  };
}

/** `after` for a walk in account-id order; the zero uuid sorts before every real one. */
const BEFORE_EVERY_ACCOUNT = '00000000-0000-0000-0000-000000000000';

function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('a sweep reads 1 to 1000 accounts at a time');
  }
  return limit;
}

export class DrizzleCreditWindowsRepo {
  constructor(private readonly database: Database) {}

  /**
   * The windows this account's paid coverage earns at now(): at most one per
   * source, each containing now(). Empty when nothing covers now(), or when a
   * window already does. Run under the account's credit lock, so "the latest
   * window" is still the latest when the chosen one is written.
   */
  async coverageCandidates(
    tx: CreditLedgerExecutor,
    accountId: string,
  ): Promise<CreditWindowCandidate[]> {
    const result = await tx.execute<Record<string, unknown>>(coverageCandidatesSql(accountId));
    return rowsOf<CandidateRow>(result).map(toCandidate);
  }

  /**
   * Write one window. Nothing is written — and NOTHING FAILS — when the window
   * does not contain now(), when this payment's window for this month already
   * exists, or when another window overlaps it.
   *
   * ⛔ `ON CONFLICT DO NOTHING` WITH NO CONFLICT TARGET. That is the only form
   * that arbitrates the no-overlap EXCLUDE constraint as well as the unique
   * index. With a target, an overlapping insert raises 23P01, which aborts the
   * caller's whole transaction: every later statement in it fails, and the
   * caller is a webhook, a sweep or a task about to run.
   */
  async writeWindow(
    tx: CreditLedgerTx,
    accountId: string,
    c: CreditWindowCandidate,
  ): Promise<WriteWindowResult> {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO credit_windows
        (account_id, source, source_ref, natural_start, natural_end, window_start, window_end, tier, level_micro)
      SELECT ${accountId}::uuid, ${c.source}, ${c.sourceRef},
             ${c.naturalStart}::timestamptz, ${c.naturalEnd}::timestamptz,
             ${c.windowStart}::timestamptz, ${c.windowEnd}::timestamptz,
             ${c.tier}::account_tier, ${String(c.levelMicro)}::bigint
       WHERE ${c.windowStart}::timestamptz <= now() AND now() < ${c.windowEnd}::timestamptz
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const created = rowsOf<{ id: string }>(inserted)[0];
    if (created !== undefined) return { outcome: 'created', windowId: created.id };

    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM credit_windows
       WHERE account_id = ${accountId}::uuid AND source = ${c.source}
         AND source_ref = ${c.sourceRef} AND natural_start = ${c.naturalStart}::timestamptz`);
    const found = rowsOf<{ id: string }>(existing)[0];
    return found === undefined
      ? { outcome: 'covered' }
      : { outcome: 'existing', windowId: found.id };
  }

  /**
   * The window's monthly lot, inserted EMPTY if it is not there: the window's
   * level × the window's share of its natural month, floored to whole credits,
   * with the window's own start and end as its term. Null when that share floors
   * to nothing (a window of a few minutes); such a window has no lot.
   *
   * The share is integer arithmetic on microseconds (`div` truncates), the same
   * rule as `windowShareMicro` in @driftstack/api-types: never rounded up.
   */
  async ensureMonthlyLot(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
  ): Promise<MonthlyLot | null> {
    // 0137 — the lot remembers what its invoice still paid when it was granted
    // (NULL for a window no Stripe invoice drew), which is what a later
    // reversal measures what it keeps against (S17 re-audit #5).
    await tx.execute(sql`
      INSERT INTO credit_lots
        (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at,
         still_paid_minor)
      SELECT w.account_id, 'monthly', 0, w.id, 'window:' || w.id, share.micro, w.window_start, w.window_end,
             paid.still
        FROM credit_windows w
       CROSS JOIN LATERAL (
         SELECT div(
                  w.level_micro::numeric
                    * (extract(epoch FROM (w.window_end - w.window_start)) * 1000000),
                  (extract(epoch FROM (w.natural_end - w.natural_start)) * 1000000) * 1000000
                )::bigint * 1000000 AS micro
       ) share
        LEFT JOIN LATERAL (
          SELECT GREATEST(pay.amount_paid_minor - pay.refunded_minor - pay.disputed_minor, 0) AS still
            FROM billing_invoice_payments pay
           WHERE w.source = 'stripe_invoice' AND pay.stripe_invoice_id = w.source_ref
             AND pay.account_id = w.account_id
        ) paid ON true
       WHERE w.id = ${windowId}::uuid AND w.account_id = ${accountId}::uuid AND share.micro > 0
      ON CONFLICT DO NOTHING`);
    const lots = await tx.execute<{ id: string; granted: string }>(sql`
      SELECT id, granted_micro::text AS granted FROM credit_lots
       WHERE window_id = ${windowId}::uuid AND account_id = ${accountId}::uuid AND kind = 'monthly'`);
    const lot = rowsOf<{ id: string; granted: string }>(lots)[0];
    return lot === undefined
      ? null
      : { lotId: lot.id, grantedMicro: exactMicro('a monthly lot', lot.granted) };
  }

  /**
   * What the window containing now() should be levelled at, with the two
   * durations the prorated difference is measured over. Null when the account
   * has no current window, when nothing covers now(), or when the coverage
   * already agrees with the level — all three ordinary. Run under the account's
   * credit lock.
   */
  async levelReconciliation(
    tx: CreditLedgerExecutor,
    accountId: string,
  ): Promise<CreditLevelReconciliation | null> {
    const result = await tx.execute<Record<string, unknown>>(levelReconciliationSql(accountId));
    const row = rowsOf<ReconciliationRow>(result)[0];
    // No current window; nothing covers now(); or the coverage already agrees.
    if (row === undefined || row.source === null || row.target_micro === null) return null;
    const levelMicro = exactMicro('a window level', row.level_micro);
    const targetMicro = exactMicro('a target level', row.target_micro);
    if (targetMicro <= 0 || targetMicro === levelMicro) return null;
    if (!(CREDIT_WINDOW_SOURCES as readonly string[]).includes(row.source)) {
      throw new RangeError('a coverage row names an unknown source');
    }
    if (row.source_ref === null) throw new RangeError('a coverage row names no source reference');
    return {
      windowId: row.id,
      levelMicro,
      levelSeq: row.level_seq,
      targetMicro,
      source: row.source as CreditWindowSource,
      sourceRef: row.source_ref,
      effectiveAt: instant('effective_at', row.effective_at),
      remainingMicroseconds: exactMicro('the rest of a window', row.remaining_us ?? 'missing'),
      naturalMicroseconds: exactMicro('a natural month', row.natural_us ?? 'missing'),
    };
  }

  /**
   * S17 — the window containing now(), its level, and the level the account's
   * paid coverage earns at now() over ALL coverage (null when nothing covers
   * now()). The same query as `levelReconciliation`, read for a different
   * question: a reversal moves the window to this target, so the level it
   * leaves is the level the next reconciliation computes. Null when the
   * account has no current window. Run under the account's credit lock.
   */
  async coverNow(tx: CreditLedgerExecutor, accountId: string): Promise<CreditCoverNow | null> {
    const result = await tx.execute<Record<string, unknown>>(levelReconciliationSql(accountId));
    const row = rowsOf<ReconciliationRow>(result)[0];
    if (row === undefined) return null;
    return {
      windowId: row.id,
      levelMicro: exactMicro('a window level', row.level_micro),
      levelSeq: row.level_seq,
      targetMicro:
        row.target_micro === null ? null : exactMicro('a target level', row.target_micro),
      sourceRef: row.target_micro === null ? null : row.source_ref,
      upgradeLine: row.target_micro !== null && Number(row.kind_rank) === 0,
    };
  }

  /**
   * Move a window to a new level and record the change, in that order and in
   * one transaction the caller holds.
   *
   * ⛔ THE UPDATE IS CONDITIONAL ON THE LEVEL AND THE STEP IT WAS READ AT. The
   * account's credit lock is what makes two reconciliations of one account run
   * one after the other; this is what makes a lost update IMPOSSIBLE rather
   * than merely unlikely — a second writer that somehow read the same `level_seq`
   * updates nothing and throws, instead of overwriting the first writer's level
   * and leaving its lot or clawback behind with nothing to answer to.
   *
   * The level-change row then carries the same step. The database's own guard
   * requires `level_seq` to rise by exactly one with the level, so a window
   * cannot skip a step; the primary key `(window_id, seq)` refuses a second row
   * for the same one.
   */
  async setWindowLevel(tx: CreditLedgerTx, change: CreditWindowLevelChange): Promise<void> {
    const moved = await tx.execute<{ level_seq: number }>(sql`
      UPDATE credit_windows
         SET level_micro = ${String(change.toLevelMicro)}::bigint,
             level_seq = level_seq + 1
       WHERE id = ${change.windowId}::uuid
         AND account_id = ${change.accountId}::uuid
         AND level_seq = ${change.seq - 1}
         AND level_micro = ${String(change.fromLevelMicro)}::bigint
      RETURNING level_seq`);
    if (rowsOf<{ level_seq: number }>(moved).length !== 1) {
      throw new Error('a credit window moved under a level change that had already read it');
    }
    await tx.execute(sql`
      INSERT INTO credit_window_level_changes
        (window_id, seq, reason, from_level_micro, to_level_micro, effective_at, delta_micro,
         source_ref)
      VALUES (${change.windowId}::uuid, ${change.seq}, ${change.reason},
              ${String(change.fromLevelMicro)}::bigint, ${String(change.toLevelMicro)}::bigint,
              ${change.effectiveAt}::timestamptz, ${String(change.deltaMicro)}::bigint,
              ${change.sourceRef ?? null}::text)`);
  }

  /**
   * The window's proration lot for one level change, inserted EMPTY if it is
   * not there: spendable from now() and expiring with the window, so a
   * mid-month upgrade's credits die with the month they belong to and never
   * outlive it. Keyed `proration:<window>:<seq>`, so the same level change
   * inserts one lot however many times it is replayed.
   */
  async ensureProrationLot(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
    seq: number,
    grantedMicro: number,
  ): Promise<MonthlyLot> {
    const grantKey = prorationGrantKey(windowId, seq);
    // 0137 — what the invoice the step is attributed to still paid, when the
    // step names a Stripe invoice (NULL otherwise). The step is written before
    // its lot, so it is there to be read.
    await tx.execute(sql`
      INSERT INTO credit_lots
        (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at,
         still_paid_minor)
      SELECT w.account_id, 'proration', 0, w.id, ${grantKey},
             ${String(grantedMicro)}::bigint, now(), w.window_end, paid.still
        FROM credit_windows w
        LEFT JOIN LATERAL (
          SELECT GREATEST(pay.amount_paid_minor - pay.refunded_minor - pay.disputed_minor, 0) AS still
            FROM credit_window_level_changes step
            JOIN billing_invoice_payments pay
              ON pay.stripe_invoice_id = step.source_ref AND pay.account_id = w.account_id
           WHERE step.window_id = w.id AND step.seq = ${seq}
        ) paid ON true
       WHERE w.id = ${windowId}::uuid AND w.account_id = ${accountId}::uuid AND now() < w.window_end
      ON CONFLICT DO NOTHING`);
    const lots = await tx.execute<{ id: string; granted: string }>(sql`
      SELECT id, granted_micro::text AS granted FROM credit_lots WHERE grant_key = ${grantKey}`);
    const lot = rowsOf<{ id: string; granted: string }>(lots)[0];
    if (lot === undefined)
      throw new Error('a proration lot was written and then could not be read');
    return { lotId: lot.id, grantedMicro: exactMicro('a proration lot', lot.granted) };
  }

  /**
   * The lots a clawback over one window may take from, NEWEST FIRST — the
   * order a plan change takes them in, so the credits given last are the ones
   * taken back first — each with what it was granted, what has already expired
   * out of it, what is left and what a running task holds.
   *
   * `expired` is what the lot gave up UNSPENT when its term ended. It is
   * subtracted from what the clawback may ask of the lot, because credit that
   * expired was never used: asking for it back would turn a refund of an
   * untouched month into debt.
   *
   * ⛔ THE WINDOW'S LOTS INCLUDE WHAT A WON DISPUTE GAVE BACK FOR IT (S17
   * re-audit #11). A won dispute re-grants what it clawed as a lot with no
   * window (`reinstate:<clawback>`, where the reversed clawback's target is
   * `window:<this window>:<invoice>`), and that credit IS the month's: without
   * it here, a downgrade after the win found the month's own lots empty, wrote
   * its share as debt, repaid that debt from the re-granted lot, and a later
   * refund of the invoice then counted the repayment as spending and charged
   * the customer for credit nobody used. The credit a win returns that belongs
   * to no invoice (`reinstate:<clawback>:returned`) is not the month's and is
   * not taken.
   */
  async clawbackTargets(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
  ): Promise<ClawbackTargetLot[]> {
    const windowPrefix = `window:${windowId}:%`;
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT l.id,
             l.granted_micro::text AS granted,
             l.remaining_micro::text AS remaining,
             l.held_micro::text AS held,
             COALESCE((SELECT -sum(x.lot_delta_micro) FROM credit_ledger x
                        WHERE x.lot_id = l.id AND x.kind = 'expiry'), 0)::text AS expired
        FROM credit_lots l
       WHERE l.account_id = ${accountId}::uuid
         AND (l.window_id = ${windowId}::uuid
              OR (l.window_id IS NULL AND l.kind = 'adjustment'
                  AND EXISTS (SELECT 1 FROM credit_clawbacks c
                               WHERE c.account_id = l.account_id AND c.source = 'stripe_dispute'
                                 AND c.state = 'reversed' AND c.target_key LIKE ${windowPrefix}
                                 AND l.grant_key = 'reinstate:' || c.id::text)))
       ORDER BY l.created_at DESC, l.id DESC
         FOR UPDATE OF l`);
    return rowsOf<{
      id: string;
      granted: string;
      remaining: string;
      held: string;
      expired: string;
    }>(result).map((r) => ({
      lotId: r.id,
      grantedMicro: exactMicro('a lot grant', r.granted),
      expiredMicro: exactMicro('expired credit', r.expired),
      remainingMicro: exactMicro('remaining credit', r.remaining),
      heldMicro: exactMicro('held credit', r.held),
    }));
  }

  /**
   * What earlier clawbacks are still owed out of credit that running tasks hold.
   *
   * ⛔ IT IS SUBTRACTED FROM HELD CREDIT BEFORE A NEW CLAWBACK MAKES A CLAIM OF
   * ITS OWN. Without it, two clawbacks landing while one task runs each record a
   * pending claim over the SAME held credit, and at settlement only one of them
   * can be paid: the second's share silently becomes nothing, or — if it is
   * turned into debt later — debt for credit the first claim already took.
   *
   * ⛔ ONLY A CLAWBACK THAT STILL STANDS HAS A CLAIM (S17 audit #3). A won
   * dispute reverses its clawback and zeroes its claim in the same statement;
   * a reversed row that still carries one (written before that rule) is not
   * owed anything, and counting it would shrink what a new clawback may claim.
   */
  async pendingClaimTotalMicro(tx: CreditLedgerExecutor, accountId: string): Promise<number> {
    const result = await tx.execute<{ micro: string }>(sql`
      SELECT COALESCE(SUM(pending_micro), 0)::text AS micro FROM credit_clawbacks
       WHERE account_id = ${accountId}::uuid AND pending_micro > 0 AND state = 'applied'`);
    return exactMicro('a standing claim', rowsOf<{ micro: string }>(result)[0]?.micro ?? '0');
  }

  /**
   * S14 — {@link pendingClaimTotalMicro} against the pool rather than a
   * caller's transaction, for `GET /v1/account/me/ai`'s
   * `balance.pending_claims_credits` (§4.4: the tier/source read may run with
   * no lock, and this is the same kind of read). Every existing caller holds
   * a transaction already and keeps using the method above directly; this
   * exists only for a route that has none open.
   */
  async pendingClaimTotalMicroNoLock(accountId: string): Promise<number> {
    return this.pendingClaimTotalMicro(this.database.db, accountId);
  }

  /** The clawback already recorded for this key, if there is one. */
  async findClawback(
    tx: CreditLedgerExecutor,
    key: CreditClawbackKey,
  ): Promise<CreditClawbackRecord | null> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT id, account_id, source, source_ref, target_key, state,
             amount_micro::text AS amount_micro, clawed_micro::text AS clawed_micro,
             pending_micro::text AS pending_micro, debt_micro::text AS debt_micro
        FROM credit_clawbacks
       WHERE source = ${key.source} AND source_ref = ${key.sourceRef}
         AND target_key = ${key.targetKey}`);
    const row = rowsOf<ClawbackRow>(result)[0];
    return row === undefined ? null : toClawbackRecord(row);
  }

  /**
   * Record one applied clawback. The unique index over
   * `(source, source_ref, target_key)` is what makes the same plan change or
   * refund countable once, so an insert that conflicts reads the earlier row
   * back rather than failing.
   */
  async insertClawback(
    tx: CreditLedgerTx,
    input: CreditClawbackKey & {
      accountId: string;
      amountMicro: number;
      clawedMicro: number;
      pendingMicro: number;
      debtMicro: number;
    },
  ): Promise<CreditClawbackRecord> {
    const written = await tx.execute<Record<string, unknown>>(sql`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, amount_micro, state,
         clawed_micro, pending_micro, debt_micro)
      VALUES (${input.accountId}::uuid, ${input.source}, ${input.sourceRef}, ${input.targetKey},
              ${String(input.amountMicro)}::bigint, 'applied',
              ${String(input.clawedMicro)}::bigint, ${String(input.pendingMicro)}::bigint,
              ${String(input.debtMicro)}::bigint)
      ON CONFLICT DO NOTHING
      RETURNING id, account_id, source, source_ref, target_key, state,
                amount_micro::text AS amount_micro, clawed_micro::text AS clawed_micro,
                pending_micro::text AS pending_micro, debt_micro::text AS debt_micro`);
    const row = rowsOf<ClawbackRow>(written)[0];
    if (row !== undefined) return toClawbackRecord(row);
    const existing = await this.findClawback(tx, input);
    if (existing === null) throw new Error('a clawback conflicted and then could not be read');
    return existing;
  }

  /**
   * S17 — every window one coverage source earned for the account, NEWEST
   * first, locked for the rest of the transaction: the windows drawn from it
   * (a monthly invoice earns one, an annual invoice one a month), and the
   * windows where a plan-change step is keyed to it (0136) — the month a paid
   * upgrade, or a new subscription after a refund (M8), raised. Newest first
   * because that is the order a reversal takes them in: the window that is
   * still live gives up its free credit before an older one's shortfall is
   * written as debt, so no debt is repaid from credit the same reversal is
   * about to take.
   */
  async windowsOfCoverage(
    tx: CreditLedgerTx,
    accountId: string,
    source: CreditWindowSource,
    sourceRef: string,
  ): Promise<SourcedCreditWindow[]> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT w.id, w.source_ref, w.level_micro::text AS level_micro, w.level_seq,
             to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
             to_char(w.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
             (w.window_start <= now() AND now() < w.window_end) AS current
        FROM credit_windows w
       WHERE w.account_id = ${accountId}::uuid
         AND ((w.source = ${source} AND w.source_ref = ${sourceRef})
              OR EXISTS (SELECT 1 FROM credit_window_level_changes step
                          WHERE step.window_id = w.id
                            AND step.reason IN ('plan_change', 'dispute_reinstated')
                            AND step.source_ref = ${sourceRef}))
       ORDER BY w.window_start DESC, w.id DESC
         FOR UPDATE OF w`);
    return rowsOf<{
      id: string;
      source_ref: string;
      level_micro: string;
      level_seq: number;
      window_start: string;
      window_end: string;
      current: boolean;
    }>(result).map((r) => ({
      id: r.id,
      sourceRef: r.source_ref,
      levelMicro: exactMicro('a window level', r.level_micro),
      levelSeq: r.level_seq,
      windowStart: instant('window_start', r.window_start),
      windowEnd: instant('window_end', r.window_end),
      current: r.current === true,
    }));
  }

  /**
   * S17 — the lots of one window that one coverage source paid for, NEWEST
   * first (the order a clawback takes them in), locked:
   *
   *   · the window's MONTHLY lot, when the window was drawn from that source;
   *   · every PRORATION lot whose step is keyed to that source
   *     (`proration:<window>:<seq>`, the step's `source_ref`, 0136): a
   *     plan-change step's lot — a paid upgrade's belongs to the upgrade
   *     invoice, never to the base month — and a `dispute_reinstated` step's
   *     lot, the credit a won dispute granted to raise a month drawn while it
   *     stood (re-audit #6), which is a give-back (`regrant`);
   *   · every lot a WON DISPUTE of that source re-granted for this window
   *     (`reinstate:<clawback>`, where the reversed clawback's target is
   *     `targetKey`): it replaces what the dispute took from the lots above.
   *
   * Never another invoice's lot, and never a goodwill or bought lot — nor the
   * credit a win returns that belongs to no invoice
   * (`reinstate:<clawback>:returned`, which the exact key match leaves out).
   * Each lot carries what expired out of it unspent, what left it on the
   * customer's work (see `ReversalLot.consumedMicro`), and what its invoice
   * still paid when it was granted (0137).
   */
  async reversalLots(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
    coverage: { readonly source: CreditWindowSource; readonly sourceRef: string },
    targetKey: string,
  ): Promise<ReversalLot[]> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT l.id,
             l.granted_micro::text AS granted,
             l.remaining_micro::text AS remaining,
             l.held_micro::text AS held,
             l.still_paid_minor::text AS still_paid,
             (l.window_id IS NULL
              OR EXISTS (SELECT 1 FROM credit_window_level_changes back
                          WHERE back.window_id = l.window_id AND back.reason = 'dispute_reinstated'
                            AND l.grant_key = 'proration:' || back.window_id::text || ':' || back.seq::text))
               AS regrant,
             COALESCE((SELECT -sum(x.lot_delta_micro) FROM credit_ledger x
                        WHERE x.lot_id = l.id AND x.kind = 'expiry'), 0)::text AS expired,
             COALESCE((SELECT -sum(x.lot_delta_micro) FROM credit_ledger x
                        WHERE x.lot_id = l.id
                          AND (x.kind IN ('task_charge', 'debt_repayment')
                               OR (x.idempotency_key LIKE 'claim:%'
                                   AND NOT EXISTS (
                                     SELECT 1 FROM credit_clawbacks own
                                      WHERE own.account_id = x.account_id
                                        AND own.id::text = split_part(x.idempotency_key, ':', 2)
                                        AND (own.source = 'plan_change'
                                             OR own.target_key = ${targetKey}))))), 0)::text
               AS consumed
        FROM credit_lots l
        JOIN credit_windows w ON w.id = ${windowId}::uuid AND w.account_id = l.account_id
       WHERE l.account_id = ${accountId}::uuid
         AND ((l.window_id = w.id AND l.kind = 'monthly'
               AND w.source = ${coverage.source} AND w.source_ref = ${coverage.sourceRef})
              OR (l.window_id = w.id AND l.kind = 'proration'
                  AND EXISTS (SELECT 1 FROM credit_window_level_changes step
                               WHERE step.window_id = w.id
                                 AND step.reason IN ('plan_change', 'dispute_reinstated')
                                 AND step.source_ref = ${coverage.sourceRef}
                                 AND l.grant_key = 'proration:' || w.id::text || ':' || step.seq::text))
              OR (l.window_id IS NULL AND l.kind = 'adjustment'
                  AND EXISTS (SELECT 1 FROM credit_clawbacks c
                               WHERE c.account_id = l.account_id AND c.source = 'stripe_dispute'
                                 AND c.state = 'reversed' AND c.target_key = ${targetKey}
                                 AND l.grant_key = 'reinstate:' || c.id::text)))
       ORDER BY l.created_at DESC, l.id DESC
         FOR UPDATE OF l`);
    return rowsOf<{
      id: string;
      granted: string;
      remaining: string;
      held: string;
      still_paid: string | null;
      regrant: boolean;
      expired: string;
      consumed: string;
    }>(result).map((r) => ({
      lotId: r.id,
      grantedMicro: exactMicro('a lot grant', r.granted),
      expiredMicro: exactMicro('expired credit', r.expired),
      remainingMicro: exactMicro('remaining credit', r.remaining),
      heldMicro: exactMicro('held credit', r.held),
      consumedMicro: exactMicro('consumed credit', r.consumed),
      regrant: r.regrant === true,
      stillPaidMinor:
        r.still_paid === null ? null : exactMicro('what a payment still paid', r.still_paid),
    }));
  }

  /**
   * S17 — the clawbacks that still stand against one invoice's credit in one
   * window, oldest first: what earlier takes already charged beyond that
   * credit.
   *
   *   · the refund, dispute and crypto-refund clawbacks of the invoice there
   *     (`targetKey`, `window:<window>:<coverage>`), applied;
   *   · ⛔ the window's PLAN-CHANGE clawbacks whose step is attributed to the
   *     invoice (S17 re-audit #4): a downgrade's shortfall is debt the
   *     customer already owes for spending the month, and a later refund that
   *     did not count it charged the same spend twice (a builder month spent,
   *     downgraded halfway and refunded owed 13,500 for 10,000 spent). The step
   *     `<window>:<seq>` names the coverage that supplied its new level (0136);
   *     a step written before 0136 names none and is attributed to the
   *     coverage the window was drawn from.
   */
  async standingReversals(
    tx: CreditLedgerTx,
    accountId: string,
    target: { readonly windowId: string; readonly targetKey: string; readonly coverageRef: string },
  ): Promise<StandingReversal[]> {
    const windowTarget = `window:${target.windowId}`;
    const result = await tx.execute<{
      id: string;
      amount: string | null;
      clawed: string | null;
    }>(sql`
      SELECT c.id, c.amount_micro::text AS amount, c.clawed_micro::text AS clawed
        FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid AND c.state = 'applied'
         AND ((c.target_key = ${target.targetKey}
               AND c.source IN ('stripe_refund', 'stripe_dispute', 'crypto_refund'))
              OR (c.source = 'plan_change' AND c.target_key = ${windowTarget}
                  AND EXISTS (SELECT 1 FROM credit_window_level_changes step
                                JOIN credit_windows w ON w.id = step.window_id
                               WHERE step.window_id = ${target.windowId}::uuid
                                 AND c.source_ref = step.window_id::text || ':' || step.seq::text
                                 AND COALESCE(step.source_ref, w.source_ref) = ${target.coverageRef})))
       ORDER BY c.created_at, c.id`);
    return rowsOf<{ id: string; amount: string | null; clawed: string | null }>(result).map(
      (r) => ({
        id: r.id,
        amountMicro: r.amount === null ? 0 : exactMicro('a clawback amount', r.amount),
        clawedMicro: r.clawed === null ? 0 : exactMicro('clawed credit', r.clawed),
      }),
    );
  }

  /**
   * S17 — the claims clawbacks collected from the credit a settling task
   * released, for one clawback or for every clawback against one target.
   *
   * A settlement pays a claim with one ledger row per lot, keyed
   * `claim:<clawback>:<reservation>:<lot>` (`CreditReservationsService.payClaims`),
   * and nothing else writes a key of that shape — a claim that became debt is
   * `claim_debt:…`, which the prefix does not match. So the rows under the
   * prefix are exactly what the claim collected, and the lot each row names is
   * where the credit came from.
   */
  async collectedClaims(
    tx: CreditLedgerTx,
    accountId: string,
    of: { readonly clawbackId: string } | { readonly targetKey: string },
  ): Promise<CollectedClaim[]> {
    const which =
      'clawbackId' in of ? sql`c.id = ${of.clawbackId}::uuid` : sql`c.target_key = ${of.targetKey}`;
    const result = await tx.execute<{ clawback_id: string; lot_id: string; micro: string }>(sql`
      SELECT c.id AS clawback_id, x.lot_id, (-x.lot_delta_micro)::text AS micro
        FROM credit_clawbacks c
        JOIN credit_ledger x
          ON x.account_id = c.account_id AND x.idempotency_key LIKE 'claim:' || c.id::text || ':%'
       WHERE c.account_id = ${accountId}::uuid AND ${which}
       ORDER BY x.id`);
    return rowsOf<{ clawback_id: string; lot_id: string; micro: string }>(result).map((r) => ({
      clawbackId: r.clawback_id,
      lotId: r.lot_id,
      micro: exactMicro('a collected claim', r.micro),
    }));
  }

  /**
   * S17 — the level one paid invoice covers RIGHT NOW, after the share of it
   * that has been refunded or disputed is taken off: the same expression
   * (`PAID_LINE_LEVEL`) the coverage reads use. Null when the invoice covers
   * nothing now — its period is over, its plan is unknown, or it has been
   * wholly refunded or disputed.
   *
   * `requireActive: false` reads it WITHOUT requiring the subscription to be
   * active: what the invoice's own payment still covers, for a won dispute
   * whose subscription was canceled in the meantime (audit #16), where no
   * coverage over now() says what level the month was paid for.
   */
  async coverageLevelForInvoice(
    tx: CreditLedgerExecutor,
    accountId: string,
    stripeInvoiceId: string,
    opts: { readonly requireActive: boolean } = { requireActive: true },
  ): Promise<number | null> {
    const activeOnly = opts.requireActive ? sql` AND sub.status = 'active'` : sql``;
    const result = await tx.execute<{ level_micro: string }>(sql`
      WITH plan AS (
        SELECT p.tier, p.allowance_micro
          FROM jsonb_to_recordset(${planAllowancesJson()}::jsonb) AS p(tier text, allowance_micro bigint)
      )
      SELECT ${PAID_LINE_LEVEL}::text AS level_micro
        FROM billing_invoice_payments pay
        JOIN subscriptions sub
          ON sub.stripe_subscription_id = pay.stripe_subscription_id AND sub.account_id = pay.account_id
        JOIN plan line_plan ON line_plan.tier = pay.line_tier::text
        JOIN plan mirror_plan ON mirror_plan.tier = sub.tier::text
       WHERE pay.account_id = ${accountId}::uuid AND pay.stripe_invoice_id = ${stripeInvoiceId}
         AND pay.line_kind IN ('period', 'proration_up')
         AND pay.line_period_start <= now() AND now() < pay.line_period_end
         AND ${STILL_PAID_FOR}${activeOnly}
       ORDER BY level_micro DESC
       LIMIT 1`);
    const row = rowsOf<{ level_micro: string }>(result)[0];
    return row === undefined ? null : exactMicro('a covered level', row.level_micro);
  }

  /**
   * S17 — every clawback one source wrote (a dispute's, by its id), in any
   * state, WITHOUT a lock: how a reinstatement finds the account to lock
   * before it locks any clawback row, and how a redelivered dispute learns it
   * was already applied (a row reversed by a win counts: the dispute was
   * applied, and then undone).
   */
  async clawbacksForSource(
    tx: CreditLedgerTx,
    source: CreditClawbackSource,
    sourceRef: string,
  ): Promise<CreditClawbackRecord[]> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT id, account_id, source, source_ref, target_key, state,
             amount_micro::text AS amount_micro, clawed_micro::text AS clawed_micro,
             pending_micro::text AS pending_micro, debt_micro::text AS debt_micro
        FROM credit_clawbacks
       WHERE source = ${source} AND source_ref = ${sourceRef}
       ORDER BY created_at, id`);
    return rowsOf<ClawbackRow>(result).map(toClawbackRecord);
  }

  /**
   * S17 — the APPLIED clawbacks one source wrote (a dispute's, by its id), for
   * the reinstatement a won dispute performs. Locked, since each will be moved
   * to `reversed`. ⛔ Call AFTER the account's credit lock, the order a
   * settlement takes the same rows in (audit #13).
   */
  async appliedClawbacksForSource(
    tx: CreditLedgerTx,
    source: CreditClawbackSource,
    sourceRef: string,
  ): Promise<CreditClawbackRecord[]> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT id, account_id, source, source_ref, target_key, state,
             amount_micro::text AS amount_micro, clawed_micro::text AS clawed_micro,
             pending_micro::text AS pending_micro, debt_micro::text AS debt_micro
        FROM credit_clawbacks
       WHERE source = ${source} AND source_ref = ${sourceRef} AND state = 'applied'
       ORDER BY created_at, id
         FOR UPDATE`);
    return rowsOf<ClawbackRow>(result).map(toClawbackRecord);
  }

  /**
   * S17 — a clawback is reversed exactly once (the database's own guard refuses
   * any other state change), and its pending claim goes with it in the SAME
   * statement (the guard lets a claim fall): a won dispute owes nothing, so a
   * task that settles afterwards pays it nothing (audit #3). The row's amounts
   * stay as the record of what was taken, which the reinstatement re-grants
   * beside it.
   */
  async markClawbackReversed(tx: CreditLedgerTx, clawbackId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE credit_clawbacks SET state = 'reversed', pending_micro = 0
       WHERE id = ${clawbackId}::uuid AND state = 'applied'`);
  }

  /**
   * S17 re-audit #13 — the RECORD of a dispute that took nothing itself: one
   * clawback row keyed by the dispute id, targeting the invoice rather than a
   * window (`invoice:<invoice>`), measured as the share of the payment the
   * dispute reversed, with nothing clawed and no debt. It is written when the
   * dispute leaves no other row — it earned no window, or no window gave
   * anything up — and, `reversed`, when a win arrives for a dispute nothing
   * recorded (the win came first). So a dispute is remembered by its id
   * whatever it took: a `created` or `funds_withdrawn` delivered after the win
   * finds it and changes nothing.
   *
   * Every reader of clawbacks by target, and every reader of pending claims,
   * passes it by: its target names no window and it carries no claim.
   */
  async recordDispute(
    tx: CreditLedgerTx,
    input: {
      readonly accountId: string;
      readonly disputeId: string;
      readonly targetKey: string;
      readonly fractionPpm: number;
      readonly state: 'applied' | 'reversed';
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, fraction_ppm, state,
         clawed_micro, pending_micro, debt_micro)
      VALUES (${input.accountId}::uuid, 'stripe_dispute', ${input.disputeId}, ${input.targetKey},
              ${Math.min(1_000_000, Math.max(1, Math.round(input.fractionPpm)))}, ${input.state},
              0, 0, 0)
      ON CONFLICT DO NOTHING`);
  }

  /**
   * S17 re-audit #6 — how far disputes of one invoice lowered one window's
   * level and wins have not yet put back: the level drops recorded with reason
   * `dispute` and that invoice, less the raises recorded with reason
   * `dispute_reinstated` and that invoice. A win restores this much of the
   * level as a plain move (the credit comes back with the re-grant); any raise
   * beyond it is a month drawn while the dispute stood, and is granted.
   */
  async unrestoredDisputeDropMicro(
    tx: CreditLedgerTx,
    windowId: string,
    invoiceId: string,
  ): Promise<number> {
    const result = await tx.execute<{ micro: string }>(sql`
      SELECT GREATEST(COALESCE(SUM(from_level_micro - to_level_micro), 0), 0)::text AS micro
        FROM credit_window_level_changes
       WHERE window_id = ${windowId}::uuid AND source_ref = ${invoiceId}
         AND reason IN ('dispute', 'dispute_reinstated')
       ORDER BY 1`);
    return exactMicro('an unrestored level', rowsOf<{ micro: string }>(result)[0]?.micro ?? '0');
  }

  /**
   * The whole window and its natural month, in microseconds: the durations a
   * level raise from the window's start is prorated over (the same arithmetic
   * that granted its monthly lot). Null when the window is not the account's.
   */
  async wholeWindowMicroseconds(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
  ): Promise<{ readonly windowMicroseconds: number; readonly naturalMicroseconds: number } | null> {
    const result = await tx.execute<{ window_us: string; natural_us: string }>(sql`
      SELECT (extract(epoch FROM (window_end - window_start)) * 1000000)::bigint::text AS window_us,
             (extract(epoch FROM (natural_end - natural_start)) * 1000000)::bigint::text AS natural_us
        FROM credit_windows
       WHERE id = ${windowId}::uuid AND account_id = ${accountId}::uuid
       ORDER BY id`);
    const row = rowsOf<{ window_us: string; natural_us: string }>(result)[0];
    return row === undefined
      ? null
      : {
          windowMicroseconds: exactMicro('a window', row.window_us),
          naturalMicroseconds: exactMicro('a natural month', row.natural_us),
        };
  }

  /**
   * The window that contains now(), if the account has one.
   *
   * S13 widened this to carry `windowStart` and `levelMicro` too, for the old
   * status route's `month_started_at` and `cap_cents` (§8.6). The one other
   * caller, `refreshCreditsIn`, reads only `windowEnd` from what this returns,
   * so the wider shape costs it nothing.
   */
  async currentWindow(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CurrentCreditWindow | null> {
    const result = await on.execute<{
      id: string;
      window_start: string;
      window_end: string;
      level_micro: string;
    }>(sql`
      SELECT id, level_micro::text AS level_micro,
             to_char(window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
             to_char(window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end
        FROM credit_windows
       WHERE account_id = ${accountId}::uuid AND window_start <= now() AND now() < window_end`);
    const row = rowsOf<{
      id: string;
      window_start: string;
      window_end: string;
      level_micro: string;
    }>(result)[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          windowStart: instant('window_start', row.window_start),
          windowEnd: instant('window_end', row.window_end),
          levelMicro: exactMicro('a window level', row.level_micro),
        };
  }

  /**
   * Accounts whose paid coverage earns a window right now and that have none:
   * exactly the accounts a refresh would grant to. In account-id order after
   * `afterAccountId`, so a walk moves on past an account that keeps failing.
   */
  async accountsOwedAWindow(opts: {
    afterAccountId: string | null;
    limit: number;
  }): Promise<string[]> {
    const after = opts.afterAccountId ?? BEFORE_EVERY_ACCOUNT;
    const result = await this.database.db.execute<{ account_id: string }>(sql`
      SELECT DISTINCT owed.account_id
        FROM (${coverageCandidatesSql(null)}) owed
       WHERE owed.account_id > ${after}::uuid
       ORDER BY owed.account_id
       LIMIT ${checkedLimit(opts.limit)}`);
    return rowsOf<{ account_id: string }>(result).map((r) => r.account_id);
  }

  /**
   * Accounts holding a lot whose term has ended with credit still in it that no
   * task holds. In account-id order after `afterAccountId`.
   */
  async accountsWithDueLots(opts: {
    afterAccountId: string | null;
    limit: number;
  }): Promise<string[]> {
    const after = opts.afterAccountId ?? BEFORE_EVERY_ACCOUNT;
    const result = await this.database.db.execute<{ account_id: string }>(sql`
      SELECT DISTINCT account_id
        FROM credit_lots
       WHERE expires_at <= now() AND remaining_micro > held_micro AND account_id > ${after}::uuid
       ORDER BY account_id
       LIMIT ${checkedLimit(opts.limit)}`);
    return rowsOf<{ account_id: string }>(result).map((r) => r.account_id);
  }
}
