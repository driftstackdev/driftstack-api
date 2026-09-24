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
// ⛔ TWO LEVELS PER WINDOW (0139). A window SHOWS the level its paid coverage
// earns now — refunds AND standing disputes taken off (`level_micro`) — and it
// is MEASURED on the level the same coverage earns with standing disputes left
// out (`undisputed_level_micro`). Every amount a new month or a plan change
// grants or takes is computed on the undisputed level, so the account a won
// dispute leaves behind is exactly the one it would have had without the
// dispute: a dispute takes its share of the payment's credit as a reversal of
// its own (credit-clawbacks.ts), never by changing what the month was worth.
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
 * The level a paid `proration_up` line stepped up FROM: the undisputed level
 * its first plan-change step started at (0136, 0139), or 0 when no step names
 * the invoice yet. A top-level fragment of its own so the two level
 * expressions below can each name it rather than nest it.
 */
const UP_LINE_FROM = sql`COALESCE((SELECT COALESCE(first_step.undisputed_from_micro, first_step.from_level_micro)
                                    FROM credit_window_level_changes first_step
                                    JOIN credit_windows first_window ON first_window.id = first_step.window_id
                                   WHERE first_window.account_id = pay.account_id
                                     AND first_step.reason = 'plan_change'
                                     AND first_step.source_ref = pay.stripe_invoice_id
                                   ORDER BY first_step.created_at, first_step.window_id, first_step.seq
                                   LIMIT 1), 0)`;

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
 * A top-level fragment with no interpolation but the named one it reads,
 * referenced by name inside each query: a fragment NESTED as an inline
 * template would put a backtick inside the query's text, which the guard that
 * reads every raw query for its ORDER BY cannot see past; and raw text
 * splicing is refused by the guard that keeps every query parameterised.
 * Bigint arithmetic throughout.
 *
 * ⛔ AN UPGRADE LINE COVERS ITS INCREMENT, NOT THE WHOLE NEW PLAN (S17 audit
 * #5). A paid `proration_up` line is what a mid-month upgrade is: it pays for
 * the difference between the level the window was at and the new plan. So a
 * partly refunded upgrade line covers `from + (upper − from) × share`, where
 * `from` is the UNDISPUTED level its first plan-change step started at
 * (`UP_LINE_FROM`) — not `upper × share`, which scaled the whole new plan by
 * the upgrade invoice's share and took back more than it bought. Written as
 * `(upper × still_paid + from × reversed) / paid`, which is the same number and
 * reads `from` once. Share 1 is `upper`, exactly as before; a line wholly
 * reversed is excluded by `STILL_PAID_FOR`, as before.
 */
const PAID_LINE_LEVEL = sql`CASE WHEN pay.amount_paid_minor = 0
       THEN LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro)
       ELSE ((LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro)
                * GREATEST(pay.amount_paid_minor - pay.refunded_minor - pay.disputed_minor, 0)
              + CASE WHEN pay.line_kind = 'proration_up'
                          AND pay.refunded_minor + pay.disputed_minor > 0
                     THEN LEAST(LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro),
                                ${UP_LINE_FROM})
                          * (pay.amount_paid_minor
                             - GREATEST(pay.amount_paid_minor - pay.refunded_minor - pay.disputed_minor, 0))
                     ELSE 0 END)
             / pay.amount_paid_minor / 1000000) * 1000000 END`;

/**
 * 0139 — `PAID_LINE_LEVEL` with every standing dispute left out: what the
 * paid line earns once its refunds are taken off, whatever is disputed. The
 * level every grant and every plan change is measured on (see the header).
 */
const PAID_LINE_LEVEL_UNDISPUTED = sql`CASE WHEN pay.amount_paid_minor = 0
       THEN LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro)
       ELSE ((LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro)
                * GREATEST(pay.amount_paid_minor - pay.refunded_minor, 0)
              + CASE WHEN pay.line_kind = 'proration_up' AND pay.refunded_minor > 0
                     THEN LEAST(LEAST(line_plan.allowance_micro, mirror_plan.allowance_micro),
                                ${UP_LINE_FROM})
                          * (pay.amount_paid_minor
                             - GREATEST(pay.amount_paid_minor - pay.refunded_minor, 0))
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
 * 0139 — an invoice whose payment has been wholly REFUNDED covers nothing; a
 * standing dispute does not stop it drawing its month (the dispute then takes
 * its share of that month as a reversal of its own).
 */
const STILL_PAID_FOR_UNDISPUTED = sql`(pay.refunded_minor < pay.amount_paid_minor OR pay.amount_paid_minor = 0)`;

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
  /** The monthly level the window shows, standing disputes taken off, in microcredits. */
  readonly levelMicro: number;
  /**
   * 0139 — the monthly level with standing disputes left out: what the window
   * is drawn at and its monthly lot granted from. Absent means `levelMicro`.
   */
  readonly undisputedLevelMicro?: number;
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
 * the only window whose LEVEL a reversal moves; a past window's lots may still
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
 * One paid coverage over now() as the window containing now() sees it: the
 * level it earns (shown and undisputed), where a change it drives would be
 * measured from, and whether it covers at all or only still has its payment
 * (a canceled subscription's invoice keeps the month it paid for).
 *
 * Every boundary here was drawn by the DATABASE. The durations are whole
 * MICROSECONDS, because that is the unit Postgres keeps a `timestamptz` in: a
 * duration that crossed this process as a JavaScript Date would be rounded to
 * the millisecond, and the proration would be a different number from the one
 * the same instants produce in SQL.
 */
export interface WindowCover {
  readonly source: CreditWindowSource;
  /** The Stripe invoice id, the crypto order id, or `PLAN_OVERRIDE_SOURCE_REF`. */
  readonly sourceRef: string;
  /** A Stripe line's kind; null for a crypto term or an override. */
  readonly lineKind: 'period' | 'proration_up' | null;
  /** A Stripe line's subscription; null for a crypto term or an override. */
  readonly subscriptionId: string | null;
  /**
   * Whether it COVERS now: a Stripe line whose subscription is active, any
   * live crypto term or override. A Stripe line whose subscription is not
   * active is listed only for what its payment still covers.
   */
  readonly active: boolean;
  /** The level it earns, refunds and standing disputes taken off; null when nothing is still paid. */
  readonly levelMicro: number | null;
  /** The level it earns, refunds taken off and disputes left out; null when all of it was refunded. */
  readonly undisputedLevelMicro: number | null;
  /** A Stripe payment's amount less its refunds, in its minor units; null otherwise. */
  readonly stillPaidMinor: number | null;
  /** A Stripe payment with a dispute standing on it; absent or false otherwise. */
  readonly disputed?: boolean;
  /** Where an upgrade it drives is measured from: its start, clamped to `[window_start, now()]`. */
  readonly upAt: PgInstant;
  /** `window_end − upAt`, in whole microseconds. */
  readonly upMicroseconds: number;
  /** Where a downgrade it drives is measured from: `tier_since` (a term's start), clamped. */
  readonly downAt: PgInstant;
  /** `window_end − downAt`, in whole microseconds. */
  readonly downMicroseconds: number;
}

/** The window containing now(), its two levels, and every paid coverage over now(). */
export interface WindowCovers {
  readonly windowId: string;
  /** The coverage the window was drawn from. */
  readonly source: CreditWindowSource;
  readonly sourceRef: string;
  /** The level shown (`level_micro`). */
  readonly levelMicro: number;
  /** The level measured on (`undisputed_level_micro`, or the level shown before 0139). */
  readonly undisputedLevelMicro: number;
  /** Whether the window records its undisputed level (false: written before 0139; absent: it does). */
  readonly undisputedRecorded?: boolean;
  readonly levelSeq: number;
  readonly windowEnd: PgInstant;
  /** `natural_end − natural_start`, in whole microseconds. */
  readonly naturalMicroseconds: number;
  /** now(), and `window_end − now()` in whole microseconds. */
  readonly nowAt: PgInstant;
  readonly nowMicroseconds: number;
  readonly covers: readonly WindowCover[];
}

/** One level change, as `setWindowLevel` writes it. */
export interface CreditWindowLevelChange {
  readonly accountId: string;
  readonly windowId: string;
  /** The window's `level_seq` AFTER the change. The first change is 1. */
  readonly seq: number;
  readonly reason: CreditWindowLevelChangeReason;
  /** The level shown, before and after. */
  readonly fromLevelMicro: number;
  readonly toLevelMicro: number;
  /**
   * 0139 — the undisputed level, before and after. Absent means the same as
   * the level shown (before and after respectively).
   */
  readonly undisputedFromMicro?: number;
  readonly undisputedToMicro?: number;
  readonly effectiveAt: PgInstant;
  /**
   * Credits granted (positive) or taken back (negative) for the rest of the
   * window by a plan change, measured on the undisputed level. A refund,
   * dispute or won dispute records 0: the credits it moved are its reversal's
   * rows, not a second amount here.
   */
  readonly deltaMicro: number;
  /**
   * 0136 — the coverage the change is attributed to: for a plan change the
   * coverage that supplies the new level, for a reversal the invoice or order
   * whose payment moved. Every writer in this codebase passes it; absent or
   * null records no attribution, which is what a row written before 0136 has.
   */
  readonly sourceRef?: string | null;
  /**
   * 0139 — what that coverage's payment still paid, refunds taken off, when
   * the change was made; null for a change that names no Stripe payment.
   */
  readonly stillPaidMinor?: number | null;
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

/**
 * S17 — one lot of one credit UNIT: what one payment (an invoice, a crypto
 * order, the override) bought or was given back in one window. The unit's own
 * lots are the window's monthly lot when the window was drawn from it, the
 * proration lots of the level changes attributed to it, and the lots a
 * reconciliation gave back to it (`reinstate:<unit>:…`).
 */
export interface UnitLot extends ClawbackTargetLot {
  readonly kind: string;
  /**
   * What left the lot on the customer's work: task charges, debt repaid from
   * it, and claims that clawbacks of OTHER units collected from it — less what
   * a reconciliation of another unit RETURNED to it (debt this lot had repaid
   * for that unit, given back). Claims the unit's own clawbacks collected are
   * not spending: they are the unit's own takes, already out of what it holds.
   */
  readonly consumedMicro: number;
  /**
   * What clawbacks took out of the lot (a reversal's or a plan change's take,
   * and the claims the unit's own clawbacks collected from it), less what a
   * reconciliation of this unit has already put back into it: how much a
   * give-back may return to this very lot.
   */
  readonly takenMicro: number;
  /** 0137 — what the unit's payment still paid when the lot was granted; null before 0137. */
  readonly stillPaidMinor: number | null;
  readonly expiresAt: PgInstant;
  /**
   * Started, not revoked, and not past its term on the DATABASE's clock. A lot
   * that is not live holds nothing that is the customer's any more: what is
   * left in it expires (or is released by the task holding it, and expires).
   */
  readonly live: boolean;
  /** The lot's place in the spend order: `spend_rank`, then `expires_at`, `created_at`, `id`. */
  readonly spendRank: number;
  readonly createdAt: PgInstant;
}

/** S17 — one level change attributed to a unit: what the unit bought or gave up there. */
export interface UnitStep {
  readonly seq: number;
  readonly reason: CreditWindowLevelChangeReason;
  readonly deltaMicro: number;
  /** 0139 — what the unit's payment still paid when it was made; null before 0139. */
  readonly stillPaidMinor: number | null;
}

/** S17 — one clawback charged against a unit, as its position reads it. */
export interface UnitClawback {
  readonly id: string;
  readonly source: CreditClawbackSource;
  readonly sourceRef: string;
  readonly targetKey: string;
  readonly state: CreditClawbackState;
  readonly debtMicro: number;
  readonly pendingMicro: number;
  /** 0140 — the account's newest ledger row id when it was measured; null before 0140. */
  readonly ledgerMark: number | null;
  /** What it took out of the unit's lots' free credit. */
  readonly clawedMicro: number;
  /** When it was measured, on the database's clock. */
  readonly createdAt: PgInstant;
  /** What it asked for; null for a record measured as a share. */
  readonly amountMicro: number | null;
}

/**
 * S17 audit 4 — one ledger row that moved the account's debt, oldest first: a
 * debt incurred, a repayment out of a lot, or a forgiveness. What a won
 * dispute or a give-back reads to learn what became of the debt a clawback
 * wrote (`debtFates` in credit-grants.ts).
 */
export interface LedgerDebtEvent {
  readonly id: number;
  /** When it was written (its transaction's clock): rows of one transaction share it. */
  readonly at: PgInstant;
  readonly kind: string;
  readonly key: string;
  readonly lotId: string | null;
  /** Positive: debt incurred. Negative: repaid (with a lot) or forgiven (without one). */
  readonly debtDeltaMicro: number;
}

/** S17 audit 4 — one row a reconciliation wrote under a unit's give-back prefix. */
export interface UnitGivebackRow {
  readonly key: string;
  readonly lotId: string | null;
  readonly lotDeltaMicro: number;
  readonly debtDeltaMicro: number;
}

/** S17 audit 4 — what a clawback is, for telling whose a debt row is. */
export interface AccountClawback {
  readonly id: string;
  readonly source: CreditClawbackSource;
  readonly sourceRef: string;
  readonly targetKey: string;
  readonly state: CreditClawbackState;
}

/** S17 R10 — one hold of a task, in the spend order, with what it was charged (0 while open). */
export interface ReservationHold {
  readonly lotId: string;
  readonly heldMicro: number;
  readonly chargedMicro: number;
  readonly spendRank: number;
  readonly expiresAt: PgInstant;
  readonly lotCreatedAt: PgInstant;
}

/** S17 R10 — one enforced task, as a give-back walks where the customer's tasks fell through to. */
export interface ReservationForRedirect {
  readonly reservationId: string;
  readonly startedAt: PgInstant;
  readonly open: boolean;
  readonly holds: readonly ReservationHold[];
}

/** S17 — one claim a clawback collected from the credit a settling task released. */
export interface CollectedClaim {
  readonly clawbackId: string;
  /** The task whose settlement paid it. */
  readonly reservationId: string;
  readonly lotId: string;
  readonly micro: number;
  /** The ledger row that collected it, and when. */
  readonly id: number;
  readonly at: PgInstant;
}

/** S17 audit 4 — a clawback whose claim on held credit still stands (`standingClaims`). */
export interface StandingClaim {
  readonly id: string;
  readonly source: CreditClawbackSource;
  readonly pendingMicro: number;
  /** The account's newest ledger row when it was measured; null on rows before 0140. */
  readonly ledgerMark: number | null;
  readonly createdAt: PgInstant;
}

/** S17 — the amounts of a Stripe payment the credit arithmetic reads. */
export interface InvoicePaymentFacts {
  readonly stripeInvoiceId: string;
  readonly accountId: string;
  readonly amountPaidMinor: number;
  readonly refundedMinor: number;
  /** The SUM of the payment's standing disputes (S17 R2). */
  readonly disputedMinor: number;
  readonly lineKind: string | null;
  readonly lineInterval: string | null;
  readonly lineTier: string | null;
  readonly linePeriodStart: PgInstant | null;
  readonly linePeriodEnd: PgInstant | null;
  /** The undisputed level the FIRST plan-change step keyed to this invoice started from. */
  readonly upgradeFromMicro: number | null;
}

/** S17 — a lot credit may be returned to: its room below its grant, its term, and whether it is live. */
export interface ReturnLot {
  readonly lotId: string;
  readonly roomMicro: number;
  readonly expiresAt: PgInstant;
  readonly live: boolean;
  /** Past its term and not revoked: credit given to it expires at once. */
  readonly expired: boolean;
  readonly spendRank: number;
  readonly createdAt: PgInstant;
}

/** S17 — one dispute standing on a payment, and the amount it took. */
export interface StandingDispute {
  readonly disputeId: string;
  readonly amountMinor: number;
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

/** The target key of one credit unit: one payment's credit in one window. */
export function unitTargetKey(windowId: string, coverageRef: string): string {
  return `window:${windowId}:${coverageRef}`;
}

/**
 * The prefix of every lot and ledger key a reconciliation gives back to one
 * unit (`reinstate:window:<window>:<coverage>:…`). The colon after the
 * coverage keeps one invoice's prefix from matching a longer invoice id.
 */
export function unitGivebackPrefix(targetKey: string): string {
  return `reinstate:${targetKey}:`;
}

/**
 * 0140 — every key that starts with `prefix` (which ends in `:`) as a byte
 * range: from the prefix itself up to, not including, the prefix with that
 * last `:` raised to `;`. Compared with the pattern operators (`~>=~`,
 * `~<~`), which order text byte by byte whatever the collation, and which a
 * `text_pattern_ops` index serves; the collation's own order does not keep
 * punctuation in byte order, so `>=`/`<` would not bound a prefix.
 */
export function keyPrefixRange(prefix: string): { readonly from: string; readonly below: string } {
  if (!prefix.endsWith(':')) throw new Error('a key prefix ends in a colon');
  return { from: prefix, below: `${prefix.slice(0, -1)};` };
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
 * ⛔ A MONTH IS DRAWN ON ITS UNDISPUTED LEVEL (0139). A standing dispute does
 * not decide whether a month is drawn or what it is worth — a payment wholly
 * disputed still draws its month — and the window's shown level is the same
 * coverage with its disputes taken off. The dispute then takes its share of the
 * month as a reversal of its own, which a win gives back whole.
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
             ${PAID_LINE_LEVEL_UNDISPUTED} AS undisputed_level_micro,
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
         AND ${STILL_PAID_FOR_UNDISPUTED}
         AND sub.status = 'active'${onlyPaid}
      UNION ALL
      SELECT ce.account_id, 'crypto_entitlement', ce.order_id, crypto_plan.tier,
             crypto_plan.allowance_micro, crypto_plan.allowance_micro, false, ce.starts_at, ce.expires_at
        FROM crypto_entitlements ce
        JOIN plan crypto_plan ON crypto_plan.tier = ce.tier::text
       CROSS JOIN clock
       WHERE ce.starts_at <= clock.t AND clock.t < ce.expires_at${onlyCrypto}
      UNION ALL
      SELECT o.account_id, 'plan_override', ${PLAN_OVERRIDE_SOURCE_REF}, a.tier::text,
             o.monthly_credits::bigint * 1000000, o.monthly_credits::bigint * 1000000, true, o.anchor_at,
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
           cand.undisputed_level_micro::text AS undisputed_level_micro,
           to_char(cand.natural_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS natural_start,
           to_char(cand.natural_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS natural_end,
           to_char(cand.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
           to_char(cand.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end
      FROM cand
     CROSS JOIN clock
     WHERE cand.window_start <= clock.t AND clock.t < cand.window_end
     ORDER BY cand.undisputed_level_micro DESC, cand.window_start, cand.source, cand.source_ref`;
}

interface CandidateRow {
  account_id: string;
  source: string;
  source_ref: string;
  tier: string;
  level_micro: string;
  undisputed_level_micro: string;
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

/** A bigint column that may hold a negative amount (a plan change's delta). */
function signedMicro(what: string, text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} is not a safe integer of microcredits`);
  }
  return value;
}

function nullableMicro(what: string, text: string | null): number | null {
  return text === null ? null : exactMicro(what, text);
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
    undisputedLevelMicro: exactMicro('an undisputed window level', r.undisputed_level_micro),
    naturalStart: instant('natural_start', r.natural_start),
    naturalEnd: instant('natural_end', r.natural_end),
    windowStart: instant('window_start', r.window_start),
    windowEnd: instant('window_end', r.window_end),
  };
}

/**
 * The window containing now(), its two levels, and every paid coverage over
 * now(), each with the level it earns shown and undisputed and the two
 * instants a change it drives would be prorated from. One row per coverage
 * (one row with the coverage columns NULL when nothing covers now); no row at
 * all when the account has no window over now().
 *
 *   w      the window containing now(). An account's windows never overlap, so
 *          there is at most one.
 *   cover  every paid coverage over now(). Unlike the grant query this one
 *          reads BOTH invoice line kinds — a paid `proration_up` line is what a
 *          mid-month upgrade is, and it raises the level from ITS OWN line
 *          start — and it lists a Stripe line whose subscription is no longer
 *          active too, flagged, for what its payment still covers: a canceled
 *          subscription keeps the month it paid for.
 *
 * `u`, the point a change is measured from, comes from the DIRECTION (decided
 * by the caller): an upgrade runs from the paid line's start (a crypto term
 * and an override from when they began), and a downgrade from `tier_since` —
 * when the subscription's plan actually changed, which is NOT when the event
 * announcing it arrived. Both are clamped here to `[window_start, now()]`.
 * Which coverage a downgrade is measured from is the caller's decision too: ⛔
 * a downgrade's `u` is only evidence when it comes from the coverage this
 * window was drawn from (see `CreditGrantsService.reconcileLevel`).
 */
function windowCoversSql(accountId: string): SQL {
  return sql`
    WITH clock AS (SELECT now() AS t),
    plan AS (
      SELECT p.tier, p.allowance_micro
        FROM jsonb_to_recordset(${planAllowancesJson()}::jsonb) AS p(tier text, allowance_micro bigint)
    ),
    w AS (
      SELECT cw.id, cw.source, cw.source_ref, cw.level_micro,
             COALESCE(cw.undisputed_level_micro, cw.level_micro) AS undisputed_level_micro,
             (cw.undisputed_level_micro IS NOT NULL) AS undisputed_recorded,
             cw.level_seq, cw.window_start, cw.window_end, cw.natural_start, cw.natural_end
        FROM credit_windows cw
       CROSS JOIN clock
       WHERE cw.account_id = ${accountId}::uuid
         AND cw.window_start <= clock.t AND clock.t < cw.window_end
    ),
    cover AS (
      SELECT 'stripe_invoice'::text AS source,
             pay.stripe_invoice_id AS source_ref,
             pay.line_kind AS line_kind,
             pay.stripe_subscription_id AS subscription_id,
             (sub.status = 'active') AS active,
             CASE WHEN ${STILL_PAID_FOR} THEN ${PAID_LINE_LEVEL} END AS level_micro,
             CASE WHEN ${STILL_PAID_FOR_UNDISPUTED} THEN ${PAID_LINE_LEVEL_UNDISPUTED} END
               AS undisputed_level_micro,
             CASE WHEN pay.amount_paid_minor > 0
                  THEN GREATEST(pay.amount_paid_minor - pay.refunded_minor, 0) END AS still_paid_minor,
             (pay.disputed_minor > 0) AS disputed,
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
      UNION ALL
      SELECT 'crypto_entitlement', ce.order_id, NULL, NULL, true,
             crypto_plan.allowance_micro, crypto_plan.allowance_micro, NULL, false,
             ce.starts_at, ce.starts_at
        FROM crypto_entitlements ce
        JOIN plan crypto_plan ON crypto_plan.tier = ce.tier::text
       CROSS JOIN clock
       WHERE ce.account_id = ${accountId}::uuid
         AND ce.starts_at <= clock.t AND clock.t < ce.expires_at
      UNION ALL
      SELECT 'plan_override', ${PLAN_OVERRIDE_SOURCE_REF}, NULL, NULL, true,
             o.monthly_credits::bigint * 1000000, o.monthly_credits::bigint * 1000000, NULL, false,
             o.effective_since, o.effective_since
        FROM credit_plan_overrides o
       CROSS JOIN clock
       WHERE o.account_id = ${accountId}::uuid
         AND o.anchor_at <= clock.t AND o.effective_since <= clock.t
         AND (o.ends_at IS NULL OR clock.t < o.ends_at)
         AND o.monthly_credits > 0
    )
    SELECT w.id,
           w.source AS window_source,
           w.source_ref AS window_source_ref,
           w.level_micro::text AS level_micro,
           w.undisputed_level_micro::text AS undisputed_level_micro,
           w.undisputed_recorded,
           w.level_seq,
           to_char(w.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
           to_char(clock.t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now_at,
           (extract(epoch FROM (w.natural_end - w.natural_start)) * 1000000)::bigint::text AS natural_us,
           (extract(epoch FROM (w.window_end - clock.t)) * 1000000)::bigint::text AS now_us,
           cover.source,
           cover.source_ref,
           cover.line_kind,
           cover.subscription_id,
           cover.active,
           cover.level_micro::text AS cover_level_micro,
           cover.undisputed_level_micro::text AS cover_undisputed_level_micro,
           cover.still_paid_minor::text AS cover_still_paid_minor,
           cover.disputed AS cover_disputed,
           to_char(up.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS up_at,
           (extract(epoch FROM (w.window_end - up.at)) * 1000000)::bigint::text AS up_us,
           to_char(down.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS down_at,
           (extract(epoch FROM (w.window_end - down.at)) * 1000000)::bigint::text AS down_us
      FROM w
      LEFT JOIN cover ON true
     CROSS JOIN clock
     CROSS JOIN LATERAL (SELECT LEAST(GREATEST(cover.up_from, w.window_start), clock.t) AS at) up
     CROSS JOIN LATERAL (SELECT LEAST(GREATEST(cover.down_from, w.window_start), clock.t) AS at) down
     ORDER BY cover.source, cover.source_ref`;
}

interface WindowCoversRow {
  id: string;
  window_source: string;
  window_source_ref: string;
  level_micro: string;
  undisputed_level_micro: string;
  undisputed_recorded: boolean;
  level_seq: number;
  window_end: string;
  now_at: string;
  natural_us: string;
  now_us: string;
  /** Null, with every column after it, when nothing covers now(). */
  source: string | null;
  source_ref: string | null;
  line_kind: string | null;
  subscription_id: string | null;
  active: boolean | null;
  cover_level_micro: string | null;
  cover_undisputed_level_micro: string | null;
  cover_still_paid_minor: string | null;
  cover_disputed: boolean | null;
  up_at: string | null;
  up_us: string | null;
  down_at: string | null;
  down_us: string | null;
}

function windowSource(what: string, source: string): CreditWindowSource {
  if (!(CREDIT_WINDOW_SOURCES as readonly string[]).includes(source)) {
    throw new RangeError(`${what} names an unknown source`);
  }
  return source as CreditWindowSource;
}

function toCover(r: WindowCoversRow): WindowCover | null {
  if (r.source === null || r.source_ref === null) return null;
  const lineKind = r.line_kind;
  if (lineKind !== null && lineKind !== 'period' && lineKind !== 'proration_up') {
    throw new RangeError('a coverage row names an unknown line kind');
  }
  return {
    source: windowSource('a coverage row', r.source),
    sourceRef: r.source_ref,
    lineKind,
    subscriptionId: r.subscription_id,
    active: r.active === true,
    levelMicro: nullableMicro('a covered level', r.cover_level_micro),
    undisputedLevelMicro: nullableMicro(
      'an undisputed covered level',
      r.cover_undisputed_level_micro,
    ),
    stillPaidMinor: nullableMicro('what a payment still pays', r.cover_still_paid_minor),
    disputed: r.cover_disputed === true,
    upAt: instant('up_at', r.up_at),
    upMicroseconds: exactMicro('the rest of a window', r.up_us ?? 'missing'),
    downAt: instant('down_at', r.down_at),
    downMicroseconds: exactMicro('the rest of a window', r.down_us ?? 'missing'),
  };
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

function clawbackState(value: string): CreditClawbackState {
  if (!(CREDIT_CLAWBACK_STATES as readonly string[]).includes(value)) {
    throw new RangeError('credit_clawbacks.state holds an unknown value');
  }
  return value as CreditClawbackState;
}

function clawbackSource(value: string): CreditClawbackSource {
  if (!(CREDIT_CLAWBACK_SOURCES as readonly string[]).includes(value)) {
    throw new RangeError('credit_clawbacks.source holds an unknown value');
  }
  return value as CreditClawbackSource;
}

function toClawbackRecord(r: ClawbackRow): CreditClawbackRecord {
  if (!(CREDIT_CLAWBACK_SOURCES as readonly string[]).includes(r.source)) {
    throw new RangeError('credit_clawbacks.source holds an unknown value');
  }
  return {
    id: r.id,
    accountId: r.account_id,
    source: r.source as CreditClawbackSource,
    sourceRef: r.source_ref,
    targetKey: r.target_key,
    state: clawbackState(r.state),
    amountMicro: r.amount_micro === null ? null : exactMicro('a clawback amount', r.amount_micro),
    clawedMicro: r.clawed_micro === null ? 0 : exactMicro('clawed credit', r.clawed_micro),
    pendingMicro: exactMicro('a pending claim', r.pending_micro),
    debtMicro: r.debt_micro === null ? 0 : exactMicro('clawback debt', r.debt_micro),
  };
}

/** An optional whole number as the text a `::bigint` parameter takes; null stays null. */
function optionalBigint(value: number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('a stored figure is a whole non-negative number');
  }
  return String(value);
}

/** A comma-joined list, the way a list of ids crosses into `string_to_array` as ONE parameter. */
function listParam(values: readonly string[]): string {
  for (const v of values) {
    if (v.includes(',')) throw new RangeError('a listed key holds a comma');
  }
  return values.join(',');
}

/**
 * S17 audit 4 #11 (R14) — the account carries a dispute recorded before
 * migration 0139, which the reversal arithmetic cannot read exactly: a
 * dispute's own row with no amount, or a window whose level a dispute lowered
 * with no undisputed level beside it. Refused rather than guessed; every
 * caller records the failure and alerts (a reversal's webhook, a refresh's
 * `reportCreditsRefreshFailed`). Not transient: a person reviews the account.
 */
export class CreditLegacyDisputeError extends Error {
  constructor() {
    super(
      'an AI credits account carries a dispute recorded before migration 0139 (no disputed ' +
        'amount, or no undisputed window level); it needs a person to review it',
    );
    this.name = 'CreditLegacyDisputeError';
  }
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
    const undisputed = c.undisputedLevelMicro ?? c.levelMicro;
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO credit_windows
        (account_id, source, source_ref, natural_start, natural_end, window_start, window_end, tier,
         level_micro, undisputed_level_micro)
      SELECT ${accountId}::uuid, ${c.source}, ${c.sourceRef},
             ${c.naturalStart}::timestamptz, ${c.naturalEnd}::timestamptz,
             ${c.windowStart}::timestamptz, ${c.windowEnd}::timestamptz,
             ${c.tier}::account_tier, ${String(c.levelMicro)}::bigint, ${String(undisputed)}::bigint
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
   * UNDISPUTED level × the window's share of its natural month, floored to
   * whole credits, with the window's own start and end as its term. Null when
   * that share floors to nothing (a window of a few minutes); such a window has
   * no lot.
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
    // reversal measures what it keeps against (S17 re-audit #5). Refunds taken
    // off, standing disputes left out: the lot is the undisputed month (0139).
    await tx.execute(sql`
      INSERT INTO credit_lots
        (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at,
         still_paid_minor)
      SELECT w.account_id, 'monthly', 0, w.id, 'window:' || w.id, share.micro, w.window_start, w.window_end,
             paid.still
        FROM credit_windows w
       CROSS JOIN LATERAL (
         SELECT div(
                  COALESCE(w.undisputed_level_micro, w.level_micro)::numeric
                    * (extract(epoch FROM (w.window_end - w.window_start)) * 1000000),
                  (extract(epoch FROM (w.natural_end - w.natural_start)) * 1000000) * 1000000
                )::bigint * 1000000 AS micro
       ) share
        LEFT JOIN LATERAL (
          SELECT GREATEST(pay.amount_paid_minor - pay.refunded_minor, 0) AS still
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
   * The window containing now(), its two levels, and every paid coverage over
   * now() (see `windowCoversSql`). Null when the account has no window over
   * now(). Run under the account's credit lock.
   */
  async windowCovers(tx: CreditLedgerExecutor, accountId: string): Promise<WindowCovers | null> {
    const result = await tx.execute<Record<string, unknown>>(windowCoversSql(accountId));
    const rows = rowsOf<WindowCoversRow>(result);
    const first = rows[0];
    if (first === undefined) return null;
    const covers: WindowCover[] = [];
    for (const r of rows) {
      const cover = toCover(r);
      if (cover !== null) covers.push(cover);
    }
    return {
      windowId: first.id,
      source: windowSource('a window', first.window_source),
      sourceRef: first.window_source_ref,
      levelMicro: exactMicro('a window level', first.level_micro),
      undisputedLevelMicro: exactMicro('an undisputed window level', first.undisputed_level_micro),
      undisputedRecorded: first.undisputed_recorded === true,
      levelSeq: first.level_seq,
      windowEnd: instant('window_end', first.window_end),
      naturalMicroseconds: exactMicro('a natural month', first.natural_us),
      nowAt: instant('now', first.now_at),
      nowMicroseconds: exactMicro('the rest of a window', first.now_us),
      covers,
    };
  }

  /**
   * Move a window to a new level and record the change, in that order and in
   * one transaction the caller holds.
   *
   * ⛔ THE UPDATE IS CONDITIONAL ON THE LEVELS AND THE STEP IT WAS READ AT. The
   * account's credit lock is what makes two reconciliations of one account run
   * one after the other; this is what makes a lost update IMPOSSIBLE rather
   * than merely unlikely — a second writer that somehow read the same `level_seq`
   * updates nothing and throws, instead of overwriting the first writer's level
   * and leaving its lot or clawback behind with nothing to answer to.
   *
   * The level-change row then carries the same step. The database's own guard
   * requires `level_seq` to rise by exactly one with the pair of levels, so a
   * window cannot skip a step; the primary key `(window_id, seq)` refuses a
   * second row for the same one.
   */
  async setWindowLevel(tx: CreditLedgerTx, change: CreditWindowLevelChange): Promise<void> {
    const undisputedFrom = change.undisputedFromMicro ?? change.fromLevelMicro;
    const undisputedTo = change.undisputedToMicro ?? change.toLevelMicro;
    const moved = await tx.execute<{ level_seq: number }>(sql`
      UPDATE credit_windows
         SET level_micro = ${String(change.toLevelMicro)}::bigint,
             undisputed_level_micro = ${String(undisputedTo)}::bigint,
             level_seq = level_seq + 1
       WHERE id = ${change.windowId}::uuid
         AND account_id = ${change.accountId}::uuid
         AND level_seq = ${change.seq - 1}
         AND level_micro = ${String(change.fromLevelMicro)}::bigint
         AND COALESCE(undisputed_level_micro, level_micro) = ${String(undisputedFrom)}::bigint
      RETURNING level_seq`);
    if (rowsOf<{ level_seq: number }>(moved).length !== 1) {
      throw new Error('a credit window moved under a level change that had already read it');
    }
    await tx.execute(sql`
      INSERT INTO credit_window_level_changes
        (window_id, seq, reason, from_level_micro, to_level_micro, effective_at, delta_micro,
         source_ref, undisputed_from_micro, undisputed_to_micro, still_paid_minor)
      VALUES (${change.windowId}::uuid, ${change.seq}, ${change.reason},
              ${String(change.fromLevelMicro)}::bigint, ${String(change.toLevelMicro)}::bigint,
              ${change.effectiveAt}::timestamptz, ${String(change.deltaMicro)}::bigint,
              ${change.sourceRef ?? null}::text,
              ${String(undisputedFrom)}::bigint, ${String(undisputedTo)}::bigint,
              ${change.stillPaidMinor === undefined || change.stillPaidMinor === null ? null : String(change.stillPaidMinor)}::bigint)`);
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
    // 0137 — what the payment the step is attributed to still paid when the
    // lot was granted: the step records it (0139); a step written before 0139
    // records nothing, and the lot then reads the payment as it stands. The
    // step is written before its lot, so it is there to be read.
    await tx.execute(sql`
      INSERT INTO credit_lots
        (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at,
         still_paid_minor)
      SELECT w.account_id, 'proration', 0, w.id, ${grantKey},
             ${String(grantedMicro)}::bigint, now(), w.window_end,
             COALESCE(step.still_paid_minor, paid.still)
        FROM credit_windows w
        LEFT JOIN credit_window_level_changes step ON step.window_id = w.id AND step.seq = ${seq}
        LEFT JOIN LATERAL (
          SELECT GREATEST(pay.amount_paid_minor - pay.refunded_minor, 0) AS still
            FROM billing_invoice_payments pay
           WHERE pay.stripe_invoice_id = step.source_ref AND pay.account_id = w.account_id
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
   * The lots a PLAN CHANGE over one window may take from, NEWEST FIRST — so
   * the credits given last are the ones taken back first — each with what it
   * was granted, what has already expired out of it, what is left and what a
   * running task holds.
   *
   * `expired` is what the lot gave up UNSPENT when its term ended. It is
   * subtracted from what the clawback may ask of the lot, because credit that
   * expired was never used: asking for it back would turn a refund of an
   * untouched month into debt.
   *
   * ⛔ THE WINDOW'S LOTS INCLUDE WHAT A RECONCILIATION GAVE BACK FOR IT (S17
   * re-audit #11). A won dispute gives back what it took as a lot with no
   * window (`reinstate:window:<this window>:<payment>:…`), and that credit IS
   * the month's: without it here, a downgrade after the win found the month's
   * own lots empty, wrote its share as debt, repaid that debt from the
   * given-back lot, and a later refund then counted the repayment as spending
   * and charged the customer for credit nobody used.
   */
  async clawbackTargets(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
  ): Promise<ClawbackTargetLot[]> {
    const givebackPrefix = `reinstate:window:${windowId}:`;
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
                  AND starts_with(l.grant_key, ${givebackPrefix})))
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
      /** 0139 — the disputed amount, on a row a dispute writes under its own id. */
      disputedMinor?: number | null;
      /** 0140 — the interim cap's frozen consumption this reversal was measured on. */
      capSpentMicro?: number | null;
      /** 0140 — the account's newest ledger row id when it was measured. */
      ledgerMark?: number | null;
      /** 0140 — how much more may be spent before an unpaid claim is no longer owed. */
      claimForgiveAfterMicro?: number | null;
    },
  ): Promise<CreditClawbackRecord> {
    const disputed =
      input.disputedMinor === undefined || input.disputedMinor === null
        ? null
        : String(input.disputedMinor);
    const capSpent = optionalBigint(input.capSpentMicro);
    const mark = optionalBigint(input.ledgerMark);
    const forgiveAfter = optionalBigint(input.claimForgiveAfterMicro);
    const written = await tx.execute<Record<string, unknown>>(sql`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, amount_micro, state,
         clawed_micro, pending_micro, debt_micro, disputed_minor,
         cap_spent_micro, ledger_mark, claim_forgive_after_micro)
      VALUES (${input.accountId}::uuid, ${input.source}, ${input.sourceRef}, ${input.targetKey},
              ${String(input.amountMicro)}::bigint, 'applied',
              ${String(input.clawedMicro)}::bigint, ${String(input.pendingMicro)}::bigint,
              ${String(input.debtMicro)}::bigint, ${disputed}::bigint,
              ${capSpent}::bigint, ${mark}::bigint, ${forgiveAfter}::bigint)
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
   * windows where a level change is keyed to it (0136) — the month a paid
   * upgrade raised. Newest first because that is the order a reversal takes
   * them in: the window that is still live gives up its free credit before an
   * older one's shortfall is written as debt, so no debt is repaid from credit
   * the same reversal is about to take.
   */
  async windowsOfCoverage(
    tx: CreditLedgerTx,
    accountId: string,
    source: CreditWindowSource,
    sourceRef: string,
  ): Promise<SourcedCreditWindow[]> {
    // A window where this coverage holds credit it was HANDED — a stand-alone
    // payment's share above the payment the window was drawn from — may carry
    // no level change keyed to it: the share can arrive as a given-back lot of
    // its unit alone (`reinstate:window:<window>:<coverage>:…`, S17 audit 4 #1).
    const handedSuffix = `:${sourceRef}:`;
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
                            AND step.source_ref = ${sourceRef})
              OR EXISTS (SELECT 1 FROM credit_lots handed
                          WHERE handed.account_id = w.account_id AND handed.window_id IS NULL
                            AND handed.kind = 'adjustment'
                            AND starts_with(handed.grant_key, 'reinstate:window:' || w.id::text || ${handedSuffix})))
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
   * S17 R11 (audit 4 #7) — the stand-alone Stripe payments (a resubscription's
   * `period` line) that hold a share of these windows they were HANDED — a
   * level change keyed to them, or a given-back lot of their unit — other than
   * the payment each window was drawn from. A win of the window's own payment
   * reconciles each of them there too, not only in the window running now.
   */
  async handedStripePayments(
    tx: CreditLedgerTx,
    accountId: string,
    windowIds: readonly string[],
  ): Promise<{ readonly windowId: string; readonly stripeInvoiceId: string }[]> {
    if (windowIds.length === 0) return [];
    const result = await tx.execute<{ window_id: string; ref: string }>(sql`
      SELECT DISTINCT held.window_id::text AS window_id, held.ref
        FROM (SELECT step.window_id, step.source_ref AS ref
                FROM credit_window_level_changes step
               WHERE step.window_id = ANY(string_to_array(${listParam(windowIds)}, ',')::uuid[])
                 AND step.reason = 'plan_change' AND step.source_ref IS NOT NULL
              UNION
              SELECT w.id, split_part(l.grant_key, ':', 4)
                FROM credit_windows w
                JOIN credit_lots l
                  ON l.account_id = w.account_id AND l.window_id IS NULL AND l.kind = 'adjustment'
                 AND starts_with(l.grant_key, 'reinstate:window:' || w.id::text || ':')
               WHERE w.id = ANY(string_to_array(${listParam(windowIds)}, ',')::uuid[])) held
        JOIN credit_windows w ON w.id = held.window_id AND w.account_id = ${accountId}::uuid
        JOIN billing_invoice_payments pay
          ON pay.stripe_invoice_id = held.ref AND pay.account_id = w.account_id
       WHERE held.ref <> w.source_ref AND pay.line_kind = 'period'
       ORDER BY 1, 2`);
    return rowsOf<{ window_id: string; ref: string }>(result).map((r) => ({
      windowId: r.window_id,
      stripeInvoiceId: r.ref,
    }));
  }

  /**
   * S17 audit 4 — the account's windows with these ids, newest first, locked
   * like `windowsOfCoverage`'s: the windows of the units a won dispute's
   * clawbacks charged, which may be another payment's (the share of a month a
   * resubscription was handed while the dispute stood).
   */
  async windowsByIds(
    tx: CreditLedgerTx,
    accountId: string,
    ids: readonly string[],
  ): Promise<SourcedCreditWindow[]> {
    if (ids.length === 0) return [];
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT w.id, w.source_ref, w.level_micro::text AS level_micro, w.level_seq,
             to_char(w.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
             to_char(w.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
             (w.window_start <= now() AND now() < w.window_end) AS current
        FROM credit_windows w
       WHERE w.account_id = ${accountId}::uuid
         AND w.id = ANY(string_to_array(${listParam(ids)}, ',')::uuid[])
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
   * S17 — the level changes of one window attributed to one coverage: a
   * change keyed to it (0136), or — written before 0136 — to the coverage the
   * window was drawn from. What a unit bought (an upgrade's grant) and gave up
   * (a downgrade's take) there, and which proration lots are its own.
   */
  async unitSteps(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
    coverageRef: string,
  ): Promise<UnitStep[]> {
    const result = await tx.execute<{
      seq: number;
      reason: string;
      delta: string;
      still_paid: string | null;
    }>(sql`
      SELECT s.seq, s.reason, s.delta_micro::text AS delta, s.still_paid_minor::text AS still_paid
        FROM credit_window_level_changes s
        JOIN credit_windows w ON w.id = s.window_id
       WHERE w.id = ${windowId}::uuid AND w.account_id = ${accountId}::uuid
         AND COALESCE(s.source_ref, w.source_ref) = ${coverageRef}
       ORDER BY s.seq`);
    return rowsOf<{ seq: number; reason: string; delta: string; still_paid: string | null }>(
      result,
    ).map((r) => {
      if (!(CREDIT_WINDOW_LEVEL_CHANGE_REASONS as readonly string[]).includes(r.reason)) {
        throw new RangeError('a level change names an unknown reason');
      }
      return {
        seq: r.seq,
        reason: r.reason as CreditWindowLevelChangeReason,
        deltaMicro: signedMicro('a level change delta', r.delta),
        stillPaidMinor: nullableMicro('what a payment still paid', r.still_paid),
      };
    });
  }

  /**
   * S17 — every clawback charged against one unit, in any state, oldest
   * first: the refunds, disputes, crypto refunds and reconciliations that
   * target it (`targetKey`), and the window's plan-change clawbacks of the
   * level changes attributed to it (`planChangeRefs`, `<window>:<seq>`; S17
   * re-audit #4: a downgrade's shortfall is debt the customer already owes for
   * spending the month).
   */
  async unitClawbacks(
    tx: CreditLedgerTx,
    accountId: string,
    input: {
      readonly windowId: string;
      readonly targetKey: string;
      readonly planChangeRefs: readonly string[];
    },
  ): Promise<UnitClawback[]> {
    const windowTarget = `window:${input.windowId}`;
    const result = await tx.execute<{
      id: string;
      source: string;
      source_ref: string;
      target_key: string;
      state: string;
      debt: string | null;
      pending: string;
      mark: string | null;
      clawed: string;
      amount: string | null;
      created_at: string;
    }>(sql`
      SELECT c.id, c.source, c.source_ref, c.target_key, c.state, c.debt_micro::text AS debt,
             c.pending_micro::text AS pending, c.ledger_mark::text AS mark,
             COALESCE(c.clawed_micro, 0)::text AS clawed, c.amount_micro::text AS amount,
             to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid
         AND c.state IN ('applied', 'reversed')
         AND (c.target_key = ${input.targetKey}
              OR (c.source = 'plan_change' AND c.target_key = ${windowTarget}
                  AND c.source_ref = ANY(string_to_array(${listParam(input.planChangeRefs)}, ','))))
       ORDER BY c.created_at, c.id`);
    return rowsOf<{
      id: string;
      source: string;
      source_ref: string;
      target_key: string;
      state: string;
      debt: string | null;
      pending: string;
      mark: string | null;
      clawed: string;
      amount: string | null;
      created_at: string;
    }>(result).map((r) => ({
      id: r.id,
      source: clawbackSource(r.source),
      sourceRef: r.source_ref,
      targetKey: r.target_key,
      state: clawbackState(r.state),
      debtMicro: r.debt === null ? 0 : exactMicro('clawback debt', r.debt),
      pendingMicro: exactMicro('a pending claim', r.pending),
      ledgerMark: nullableMicro('a ledger mark', r.mark),
      clawedMicro: exactMicro('clawed credit', r.clawed),
      createdAt: instant('created_at', r.created_at),
      amountMicro: nullableMicro('a clawback amount', r.amount),
    }));
  }

  /**
   * S17 audit 4 — every clawback of the account, in any state, oldest first:
   * what a debt row's key names (the clawback that wrote it, and so the unit
   * it charged), for following the account's debt through its repayments.
   * Clawbacks are few per account, next to its ledger rows.
   */
  async accountClawbacks(tx: CreditLedgerTx, accountId: string): Promise<AccountClawback[]> {
    const result = await tx.execute<{
      id: string;
      source: string;
      source_ref: string;
      target_key: string;
      state: string;
    }>(sql`
      SELECT c.id, c.source, c.source_ref, c.target_key, c.state
        FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid
       ORDER BY c.created_at, c.id`);
    return rowsOf<{
      id: string;
      source: string;
      source_ref: string;
      target_key: string;
      state: string;
    }>(result).map((r) => ({
      id: r.id,
      source: clawbackSource(r.source),
      sourceRef: r.source_ref,
      targetKey: r.target_key,
      state: clawbackState(r.state),
    }));
  }

  /**
   * S17 audit 4 — every ledger row of the account that moved its debt, OLDEST
   * first (`credit_ledger_debt_idx`, 0140): the order debt is incurred, repaid
   * and forgiven in.
   */
  async debtEvents(tx: CreditLedgerTx, accountId: string): Promise<LedgerDebtEvent[]> {
    const result = await tx.execute<{
      id: string;
      at: string;
      kind: string;
      key: string;
      lot_id: string | null;
      debt: string;
    }>(sql`
      SELECT x.id::text AS id,
             to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
             x.kind, x.idempotency_key AS key, x.lot_id, x.debt_delta_micro::text AS debt
        FROM credit_ledger x
       WHERE x.account_id = ${accountId}::uuid AND x.debt_delta_micro <> 0
       ORDER BY x.id`);
    return rowsOf<{
      id: string;
      at: string;
      kind: string;
      key: string;
      lot_id: string | null;
      debt: string;
    }>(result).map((r) => ({
      id: exactMicro('a ledger row id', r.id),
      at: instant('created_at', r.at),
      kind: r.kind,
      key: r.key,
      lotId: r.lot_id,
      debtDeltaMicro: signedMicro('a debt movement', r.debt),
    }));
  }

  /**
   * S17 audit 4 — every row a reconciliation wrote under one unit's give-back
   * prefix (`credit_ledger_giveback_window_idx`, 0140, by the window id inside
   * the key), oldest first: debt forgiven, credit returned or moved to other
   * lots, and credit put back into the unit's own lots.
   */
  async unitGivebackRows(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
    givebackPrefix: string,
  ): Promise<UnitGivebackRow[]> {
    const range = keyPrefixRange(givebackPrefix);
    if (!givebackPrefix.startsWith(`reinstate:window:${windowId}:`)) {
      throw new Error('a unit give-back prefix names its own window');
    }
    const result = await tx.execute<{
      key: string;
      lot_id: string | null;
      lot_delta: string;
      debt_delta: string;
    }>(sql`
      SELECT x.idempotency_key AS key, x.lot_id, x.lot_delta_micro::text AS lot_delta,
             x.debt_delta_micro::text AS debt_delta
        FROM credit_ledger x
       WHERE x.account_id = ${accountId}::uuid
         AND x.kind = 'adjustment' AND starts_with(x.idempotency_key, 'reinstate:')
         AND x.idempotency_key ~>=~ ${range.from} AND x.idempotency_key ~<~ ${range.below}
       ORDER BY x.id`);
    return rowsOf<{ key: string; lot_id: string | null; lot_delta: string; debt_delta: string }>(
      result,
    ).map((r) => ({
      key: r.key,
      lotId: r.lot_id,
      lotDeltaMicro: signedMicro('a given-back row', r.lot_delta),
      debtDeltaMicro: signedMicro('a given-back row', r.debt_delta),
    }));
  }

  /**
   * S17 R10 — every enforced task (a reservation: a running task, or a spend,
   * which is a task settled at once) the account started at or after `since`
   * and before `before` (the end of an ended window; null: no end), in the
   * order they were started, each with its holds in the spend order and what
   * each hold was charged. What a give-back walks to find where the
   * customer's tasks fell through to while a unit's credit stood taken
   * (`credit_reservations_account_created_idx`, 0140).
   */
  async reservationsSince(
    tx: CreditLedgerTx,
    accountId: string,
    input: { readonly since: PgInstant; readonly before: PgInstant | null },
  ): Promise<ReservationForRedirect[]> {
    const before = input.before ?? 'infinity';
    const result = await tx.execute<{
      id: string;
      at: string;
      open: boolean;
      lot_id: string;
      held: string;
      charged: string | null;
      spend_rank: number;
      expires_at: string;
      lot_created_at: string;
    }>(sql`
      SELECT r.id::text AS id,
             to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
             (r.state = 'open') AS open,
             h.lot_id::text AS lot_id, h.held_micro::text AS held, h.charged_micro::text AS charged,
             l.spend_rank::int AS spend_rank,
             to_char(l.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
             to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lot_created_at
        FROM credit_reservations r
        JOIN credit_reservation_holds h ON h.reservation_id = r.id
        JOIN credit_lots l ON l.id = h.lot_id
       WHERE r.account_id = ${accountId}::uuid AND r.mode = 'enforce'
         AND r.created_at >= ${input.since}::timestamptz AND r.created_at < ${before}::timestamptz
       ORDER BY r.created_at, r.id, l.spend_rank, l.expires_at, l.created_at, l.id`);
    const out: ReservationForRedirect[] = [];
    for (const row of rowsOf<{
      id: string;
      at: string;
      open: boolean;
      lot_id: string;
      held: string;
      charged: string | null;
      spend_rank: number;
      expires_at: string;
      lot_created_at: string;
    }>(result)) {
      let r = out[out.length - 1];
      if (r === undefined || r.reservationId !== row.id) {
        r = {
          reservationId: row.id,
          startedAt: instant('created_at', row.at),
          open: row.open === true,
          holds: [],
        };
        out.push(r);
      }
      (r.holds as ReservationHold[]).push({
        lotId: row.lot_id,
        heldMicro: exactMicro('held credit', row.held),
        chargedMicro: row.charged === null ? 0 : exactMicro('charged credit', row.charged),
        spendRank: Number(row.spend_rank),
        expiresAt: instant('expires_at', row.expires_at),
        lotCreatedAt: instant('created_at', row.lot_created_at),
      });
    }
    return out;
  }

  /**
   * S17 R10 — record what a give-back moved to where a task fell through to,
   * for one reservation (`hold:<reservation>:<event>` against the unit): a
   * row with nothing clawed, no claim and no debt, whose amount is the share
   * of the task's holds the unit's taken credit sent elsewhere. `open` — the
   * task still runs — leaves it applied, for the task's settlement to finish
   * (`applyHoldRedirects` in credit-reservations.ts); otherwise it is written
   * reversed, done. Either way a later give-back passes the task by.
   */
  async recordHoldRedirect(
    tx: CreditLedgerTx,
    input: {
      readonly accountId: string;
      readonly source: CreditClawbackSource;
      readonly reservationId: string;
      readonly eventRef: string;
      readonly targetKey: string;
      readonly amountMicro: number;
      readonly open: boolean;
      readonly ledgerMark: number;
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, amount_micro, state,
         clawed_micro, pending_micro, debt_micro, ledger_mark)
      VALUES (${input.accountId}::uuid, ${input.source},
              ${`hold:${input.reservationId}:${input.eventRef}`}, ${input.targetKey},
              ${String(input.amountMicro)}::bigint, ${input.open ? 'applied' : 'reversed'},
              0, 0, 0, ${optionalBigint(input.ledgerMark)}::bigint)
      ON CONFLICT DO NOTHING`);
  }

  /**
   * S17 R8 — the frozen consumption the newest STANDING reversal of one
   * payment was measured on (0140): its rows against the payment's units or
   * its dispute record, newest first. Null when no standing reversal carries
   * one (none stands, or every one predates 0140).
   */
  async standingCapSpent(
    tx: CreditLedgerTx,
    accountId: string,
    coverageRef: string,
  ): Promise<number | null> {
    const invoiceTarget = `invoice:${coverageRef}`;
    const unitSuffix = `:${coverageRef}`;
    const result = await tx.execute<{ spent: string }>(sql`
      SELECT c.cap_spent_micro::text AS spent
        FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid AND c.state = 'applied'
         AND c.source IN ('stripe_refund', 'stripe_dispute')
         AND c.cap_spent_micro IS NOT NULL
         AND (c.target_key = ${invoiceTarget}
              OR (starts_with(c.target_key, 'window:')
                  AND right(c.target_key, ${unitSuffix.length}) = ${unitSuffix}))
       ORDER BY c.ledger_mark DESC NULLS LAST, c.created_at DESC, c.id DESC
       LIMIT 1`);
    const row = rowsOf<{ spent: string }>(result)[0];
    return row === undefined ? null : exactMicro('a frozen consumption', row.spent);
  }

  /**
   * S17 — one unit's own lots, NEWEST first (the order a clawback takes them
   * in), locked: the window's MONTHLY lot when the window was drawn from the
   * unit's coverage, the PRORATION lots of the level changes attributed to it
   * (`prorationKeys`), and every lot a reconciliation gave back to it
   * (`reinstate:<unit>:…`). Each carries what expired out of it unspent, what
   * left it on the customer's work (see `UnitLot.consumedMicro`, where the
   * unit's own clawbacks are `ownClawbackIds`), and what its payment still paid
   * when it was granted.
   */
  async unitLots(
    tx: CreditLedgerTx,
    accountId: string,
    input: {
      readonly windowId: string;
      readonly drawnFromUnit: boolean;
      readonly prorationKeys: readonly string[];
      readonly givebackPrefix: string;
      readonly ownClawbackIds: readonly string[];
    },
  ): Promise<UnitLot[]> {
    // ⛔ ONLY THE LOT'S FEW NON-TASK ROWS ARE READ (S17 audit 4 #10). A monthly
    // lot carries one `task_charge` row per task, which is most of an active
    // account's ledger; what they and the debt repayments took out is the lot's
    // funding and its other movements less what it has left (every movement of
    // a lot is a ledger row, and a lot is born empty), so the sums below walk
    // `credit_ledger_lot_idx` for the other kinds only.
    //
    // What left the lot on the customer's work (`consumed`): task charges and
    // debt repayments, claims of OTHER units' clawbacks, less credit given back
    // INTO it for someone else's charge — a return of debt it repaid or a claim
    // it paid, and credit moved to it from a unit whose take sent the spending
    // here (R10; a settlement that takes part of that back, `:back:`, is signed
    // the other way). What the unit's own clawbacks took out of it (`taken`):
    // its takes and its own claims, less what the unit's reconciliations restored.
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT l.id, l.kind,
             l.granted_micro::text AS granted,
             l.remaining_micro::text AS remaining,
             l.held_micro::text AS held,
             l.still_paid_minor::text AS still_paid,
             l.spend_rank::int AS spend_rank,
             to_char(l.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
             to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
             (l.revoked_at IS NULL AND l.starts_at <= now() AND now() < l.expires_at) AS live,
             COALESCE(agg.expired, 0)::text AS expired,
             (COALESCE(agg.non_task, 0) - l.remaining_micro + COALESCE(agg.others_claims, 0)
                - COALESCE(agg.given_in, 0))::text AS consumed,
             COALESCE(agg.taken, 0)::text AS taken
        FROM credit_lots l
        LEFT JOIN LATERAL (
          SELECT sum(x.lot_delta_micro) AS non_task,
                 sum(CASE WHEN x.kind = 'expiry' THEN -x.lot_delta_micro ELSE 0 END) AS expired,
                 sum(CASE WHEN starts_with(x.idempotency_key, 'claim:')
                               AND NOT (split_part(x.idempotency_key, ':', 2)
                                        = ANY(string_to_array(${listParam(input.ownClawbackIds)}, ',')))
                            THEN -x.lot_delta_micro ELSE 0 END) AS others_claims,
                 sum(CASE WHEN x.kind = 'adjustment'
                               AND starts_with(x.idempotency_key, 'reinstate:')
                               AND (NOT starts_with(x.idempotency_key, ${input.givebackPrefix})
                                    OR strpos(x.idempotency_key, ':returned:') > 0
                                    OR strpos(x.idempotency_key, ':unclaimed:') > 0
                                    OR strpos(x.idempotency_key, ':paid:') > 0)
                            THEN x.lot_delta_micro ELSE 0 END) AS given_in,
                 sum(CASE WHEN starts_with(x.idempotency_key, 'claim:')
                            THEN CASE WHEN split_part(x.idempotency_key, ':', 2)
                                           = ANY(string_to_array(${listParam(input.ownClawbackIds)}, ','))
                                      THEN -x.lot_delta_micro ELSE 0 END
                          WHEN x.kind IN ('refund_clawback', 'proration_clawback') THEN -x.lot_delta_micro
                          WHEN x.kind = 'adjustment' AND x.lot_delta_micro > 0
                               AND starts_with(x.idempotency_key, ${input.givebackPrefix})
                               AND strpos(x.idempotency_key, ':returned:') = 0
                               AND strpos(x.idempotency_key, ':unclaimed:') = 0
                            THEN -x.lot_delta_micro
                          ELSE 0 END) AS taken
            FROM credit_ledger x
           WHERE x.lot_id = l.id
             AND x.kind = ANY(ARRAY['grant', 'proration_grant', 'top_up', 'expiry',
                                    'proration_clawback', 'refund_clawback', 'adjustment'])
        ) agg ON true
       WHERE l.account_id = ${accountId}::uuid
         AND ((l.window_id = ${input.windowId}::uuid AND l.kind = 'monthly'
               AND ${input.drawnFromUnit ? 1 : 0}::int = 1)
              OR (l.window_id = ${input.windowId}::uuid AND l.kind = 'proration'
                  AND l.grant_key = ANY(string_to_array(${listParam(input.prorationKeys)}, ',')))
              OR (l.window_id IS NULL AND l.kind = 'adjustment'
                  AND starts_with(l.grant_key, ${input.givebackPrefix})))
       ORDER BY l.created_at DESC, l.id DESC
         FOR UPDATE OF l`);
    return rowsOf<{
      id: string;
      kind: string;
      granted: string;
      remaining: string;
      held: string;
      still_paid: string | null;
      spend_rank: number;
      expires_at: string;
      created_at: string;
      live: boolean;
      expired: string;
      consumed: string;
      taken: string;
    }>(result).map((r) => ({
      lotId: r.id,
      kind: r.kind,
      grantedMicro: exactMicro('a lot grant', r.granted),
      expiredMicro: exactMicro('expired credit', r.expired),
      remainingMicro: exactMicro('remaining credit', r.remaining),
      heldMicro: exactMicro('held credit', r.held),
      consumedMicro: signedMicro('consumed credit', r.consumed),
      takenMicro: Math.max(0, signedMicro('taken credit', r.taken)),
      stillPaidMinor: nullableMicro('what a payment still paid', r.still_paid),
      expiresAt: instant('expires_at', r.expires_at),
      live: r.live === true,
      spendRank: Number(r.spend_rank),
      createdAt: instant('created_at', r.created_at),
    }));
  }

  /**
   * S17 — the claims the given clawbacks collected from the credit a settling
   * task released, oldest first.
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
    clawbackIds: readonly string[],
  ): Promise<CollectedClaim[]> {
    if (clawbackIds.length === 0) return [];
    const result = await tx.execute<{
      clawback_id: string;
      reservation_id: string;
      lot_id: string;
      micro: string;
      id: string;
      at: string;
    }>(sql`
      SELECT split_part(x.idempotency_key, ':', 2) AS clawback_id,
             split_part(x.idempotency_key, ':', 3) AS reservation_id, x.lot_id,
             (-x.lot_delta_micro)::text AS micro, x.id::text AS id,
             to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM unnest(string_to_array(${listParam(clawbackIds)}, ',')) AS c(id)
        JOIN credit_ledger x
          ON x.account_id = ${accountId}::uuid
         AND starts_with(x.idempotency_key, 'claim:')
         AND x.idempotency_key ~>=~ ('claim:' || c.id || ':')
         AND x.idempotency_key ~<~ ('claim:' || c.id || ';')
       ORDER BY x.id`);
    return rowsOf<{
      clawback_id: string;
      reservation_id: string;
      lot_id: string;
      micro: string;
      id: string;
      at: string;
    }>(result).map((r) => ({
      clawbackId: r.clawback_id,
      reservationId: r.reservation_id,
      lotId: r.lot_id,
      micro: exactMicro('a collected claim', r.micro),
      id: exactMicro('a ledger row id', r.id),
      at: instant('created_at', r.at),
    }));
  }

  /**
   * S17 — the given lots as a give-back reads them: what room each has below
   * its grant, when it expires, and whether it can still be spent from now.
   */
  async lotsForReturn(
    tx: CreditLedgerTx,
    accountId: string,
    lotIds: readonly string[],
  ): Promise<ReturnLot[]> {
    if (lotIds.length === 0) return [];
    const result = await tx.execute<{
      id: string;
      room: string;
      expires_at: string;
      live: boolean;
      expired: boolean;
      spend_rank: number;
      created_at: string;
    }>(sql`
      SELECT l.id, (l.granted_micro - l.remaining_micro)::text AS room,
             to_char(l.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
             (l.revoked_at IS NULL AND l.starts_at <= now() AND now() < l.expires_at) AS live,
             (l.revoked_at IS NULL AND l.expires_at <= now()) AS expired,
             l.spend_rank::int AS spend_rank,
             to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM credit_lots l
       WHERE l.account_id = ${accountId}::uuid
         AND l.id = ANY(string_to_array(${listParam(lotIds)}, ',')::uuid[])
       ORDER BY l.id
         FOR UPDATE OF l`);
    return rowsOf<{
      id: string;
      room: string;
      expires_at: string;
      live: boolean;
      expired: boolean;
      spend_rank: number;
      created_at: string;
    }>(result).map((r) => ({
      lotId: r.id,
      roomMicro: exactMicro('room in a lot', r.room),
      expiresAt: instant('expires_at', r.expires_at),
      live: r.live === true,
      expired: r.expired === true,
      spendRank: Number(r.spend_rank),
      createdAt: instant('created_at', r.created_at),
    }));
  }

  /**
   * S17 — lower one standing clawback's pending claim: a reconciliation that
   * finds the unit charged beyond what it now owes gives the claim up first,
   * before any debt is forgiven or credit returned. The guard lets a claim
   * fall and never rise.
   */
  /**
   * S17 audit 4 — every clawback of the account whose claim on held credit
   * still stands, oldest first (the order a settlement pays them in), locked:
   * what a won dispute's undo reads to pay, out of credit the dispute's own
   * claim collected, the claims a twin without the dispute paid with it.
   */
  async standingClaims(tx: CreditLedgerTx, accountId: string): Promise<StandingClaim[]> {
    const result = await tx.execute<{
      id: string;
      source: string;
      pending: string;
      mark: string | null;
      created_at: string;
    }>(sql`
      SELECT c.id::text AS id, c.source, c.pending_micro::text AS pending,
             c.ledger_mark::text AS mark,
             to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid AND c.state = 'applied' AND c.pending_micro > 0
       ORDER BY c.created_at, c.id
         FOR UPDATE`);
    return rowsOf<{
      id: string;
      source: string;
      pending: string;
      mark: string | null;
      created_at: string;
    }>(result).map((r) => ({
      id: r.id,
      source: r.source as CreditClawbackSource,
      pendingMicro: exactMicro('a pending claim', r.pending),
      ledgerMark: r.mark === null ? null : exactMicro('a ledger mark', r.mark),
      createdAt: instant('created_at', r.created_at),
    }));
  }

  async releasePendingClaim(tx: CreditLedgerTx, clawbackId: string, micro: number): Promise<void> {
    const released = await tx.execute<{ id: string }>(sql`
      UPDATE credit_clawbacks SET pending_micro = pending_micro - ${String(micro)}::bigint
       WHERE id = ${clawbackId}::uuid AND state = 'applied' AND pending_micro >= ${String(micro)}::bigint
      RETURNING id`);
    if (rowsOf<{ id: string }>(released).length !== 1) {
      throw new Error('a pending claim could not be released: it no longer owes that much');
    }
  }

  /**
   * S17 — the amounts of one Stripe payment the credit arithmetic reads, with
   * the undisputed level its first plan-change step started from. Null when
   * the invoice is not the account's.
   */
  async invoicePayment(
    tx: CreditLedgerExecutor,
    accountId: string,
    stripeInvoiceId: string,
  ): Promise<InvoicePaymentFacts | null> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT pay.stripe_invoice_id, pay.account_id,
             pay.amount_paid_minor::text AS amount_paid_minor,
             pay.refunded_minor::text AS refunded_minor, pay.disputed_minor::text AS disputed_minor,
             pay.line_kind, pay.line_interval, pay.line_tier::text AS line_tier,
             to_char(pay.line_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS line_period_start,
             to_char(pay.line_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS line_period_end,
             (SELECT COALESCE(first_step.undisputed_from_micro, first_step.from_level_micro)::text
                FROM credit_window_level_changes first_step
                JOIN credit_windows first_window ON first_window.id = first_step.window_id
               WHERE first_window.account_id = pay.account_id
                 AND first_step.reason = 'plan_change'
                 AND first_step.source_ref = pay.stripe_invoice_id
               ORDER BY first_step.created_at, first_step.window_id, first_step.seq
               LIMIT 1) AS upgrade_from_micro
        FROM billing_invoice_payments pay
       WHERE pay.stripe_invoice_id = ${stripeInvoiceId} AND pay.account_id = ${accountId}::uuid
       ORDER BY pay.stripe_invoice_id`);
    return invoicePaymentOf(result);
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
   * S17 — the APPLIED clawbacks one dispute wrote, locked, for the win that
   * reverses them: its own (`<dispute>`) and the ones it took while it stood
   * from a month drawn or changed after it (`<dispute>:<event>`) — never the
   * win's own (`<dispute>:won…`). ⛔ Call AFTER the account's credit lock, the
   * order a settlement takes the same rows in (audit #13).
   */
  async appliedDisputeClawbacks(
    tx: CreditLedgerTx,
    disputeId: string,
  ): Promise<CreditClawbackRecord[]> {
    const takenWhileStanding = `${disputeId}:`;
    const won = `${disputeId}:won`;
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT id, account_id, source, source_ref, target_key, state,
             amount_micro::text AS amount_micro, clawed_micro::text AS clawed_micro,
             pending_micro::text AS pending_micro, debt_micro::text AS debt_micro
        FROM credit_clawbacks
       WHERE source = 'stripe_dispute' AND state = 'applied'
         AND (source_ref = ${disputeId}
              OR (starts_with(source_ref, ${takenWhileStanding})
                  AND NOT starts_with(source_ref, ${won})))
       ORDER BY created_at, id
         FOR UPDATE`);
    return rowsOf<ClawbackRow>(result).map(toClawbackRecord);
  }

  /**
   * S17 — the newest dispute still standing on one invoice: what a month
   * drawn, or a level changed, while it stands is taken under, so the win
   * that ends it reverses that take too. Null when none stands.
   */
  async newestStandingDispute(
    tx: CreditLedgerTx,
    accountId: string,
    stripeInvoiceId: string,
  ): Promise<string | null> {
    const invoiceTarget = `invoice:${stripeInvoiceId}`;
    const windowTargetSuffix = `:${stripeInvoiceId}`;
    const result = await tx.execute<{ source_ref: string }>(sql`
      SELECT c.source_ref FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid AND c.source = 'stripe_dispute' AND c.state = 'applied'
         AND strpos(c.source_ref, ':') = 0 AND c.disputed_minor IS NOT NULL
         AND (c.target_key = ${invoiceTarget}
              OR right(c.target_key, ${windowTargetSuffix.length}) = ${windowTargetSuffix})
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT 1`);
    return rowsOf<{ source_ref: string }>(result)[0]?.source_ref ?? null;
  }

  /** The database's clock, as the microsecond UTC text every instant here is compared in. */
  async databaseNow(tx: CreditLedgerTx): Promise<PgInstant> {
    const result = await tx.execute<{ t: string }>(sql`
      SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
       ORDER BY 1`);
    return instant('now', rowsOf<{ t: string }>(result)[0]?.t);
  }

  /**
   * The account's newest ledger row id, 0 when it has none: a mark that only
   * rises, read off `credit_ledger_account_idx` in one step whatever the size
   * of the ledger (S17 audit 4 #10 — the count(*) it replaced walked every
   * row). A refresh's own keys are tagged with it, and a clawback records it
   * as the point "spent since the take" is counted from.
   */
  async ledgerMark(tx: CreditLedgerTx, accountId: string): Promise<number> {
    const result = await tx.execute<{ n: string | null }>(sql`
      SELECT x.id::text AS n FROM credit_ledger x
       WHERE x.account_id = ${accountId}::uuid
       ORDER BY x.id DESC
       LIMIT 1`);
    return exactMicro('a ledger mark', rowsOf<{ n: string | null }>(result)[0]?.n ?? '0');
  }

  /**
   * S17 — a clawback is reversed exactly once (the database's own guard refuses
   * any other state change), and its pending claim goes with it in the SAME
   * statement (the guard lets a claim fall): a won dispute owes nothing, so a
   * task that settles afterwards pays it nothing (audit #3). The row's amounts
   * stay as the record of what was taken; the reconciliation after the win
   * gives it back.
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
      /** 0139 — the disputed amount, in the payment's minor units; null when unknown. */
      readonly disputedMinor: number | null;
      /** 0140 — the interim cap's frozen consumption the dispute was measured on. */
      readonly capSpentMicro?: number | null;
      /** 0140 — the account's newest ledger row id when it was measured. */
      readonly ledgerMark?: number | null;
    },
  ): Promise<void> {
    const capSpent = optionalBigint(input.capSpentMicro);
    const mark = optionalBigint(input.ledgerMark);
    await tx.execute(sql`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, fraction_ppm, state,
         clawed_micro, pending_micro, debt_micro, disputed_minor, cap_spent_micro, ledger_mark)
      VALUES (${input.accountId}::uuid, 'stripe_dispute', ${input.disputeId}, ${input.targetKey},
              ${Math.min(1_000_000, Math.max(1, Math.round(input.fractionPpm)))}, ${input.state},
              0, 0, 0, ${input.disputedMinor === null ? null : String(input.disputedMinor)}::bigint,
              ${capSpent}::bigint, ${mark}::bigint)
      ON CONFLICT DO NOTHING`);
  }

  /**
   * S17 R8 — the RECORD of a refund that took nothing while a dispute stood on
   * its payment: one row keyed like the refund's own (`<charge>:<cumulative>`),
   * targeting the invoice rather than a window (no read of a window's clawbacks
   * sees it), with nothing clawed, no claim and no debt, carrying the frozen
   * consumption the refund was measured on. The win of that dispute — and a
   * refresh drawing a month while it stands — then reads the refund's figure,
   * not an older reversal's. (A refund that took nothing while no dispute stood
   * writes no row: nothing reads its figure before a later reversal records one.)
   */
  async recordRefund(
    tx: CreditLedgerTx,
    input: {
      readonly accountId: string;
      readonly sourceRef: string;
      readonly targetKey: string;
      readonly fractionPpm: number;
      readonly capSpentMicro: number;
      readonly ledgerMark: number;
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO credit_clawbacks
        (account_id, source, source_ref, target_key, fraction_ppm, state,
         clawed_micro, pending_micro, debt_micro, cap_spent_micro, ledger_mark)
      VALUES (${input.accountId}::uuid, 'stripe_refund', ${input.sourceRef}, ${input.targetKey},
              ${Math.min(1_000_000, Math.max(1, Math.round(input.fractionPpm)))}, 'applied',
              0, 0, 0, ${optionalBigint(input.capSpentMicro)}::bigint,
              ${optionalBigint(input.ledgerMark)}::bigint)
      ON CONFLICT DO NOTHING`);
  }

  /**
   * S17 R2 — the disputes still standing on one invoice, each by its id with
   * the amount it took (0139): what the invoice has disputed is their SUM. A
   * dispute stands while any row it wrote under its own id against the
   * invoice's own credit is applied — its window rows, or its record: the rows
   * that carry its amount. (A row the same event wrote against ANOTHER
   * payment's share of a month — the stand-alone cover's — carries none.)
   */
  async standingDisputes(
    tx: CreditLedgerTx,
    accountId: string,
    stripeInvoiceId: string,
  ): Promise<StandingDispute[]> {
    const invoiceTarget = `invoice:${stripeInvoiceId}`;
    const windowTargetSuffix = `:${stripeInvoiceId}`;
    // A row with no amount is one of two things. A dispute's take from ANOTHER
    // payment's share of a month (the stand-alone cover's) carries none by
    // design, and is not this payment's dispute; it is written with a ledger
    // mark (0140). A dispute's own row written before 0139 carries neither.
    const result = await tx.execute<{
      dispute_id: string;
      amount: string | null;
      legacy: boolean;
    }>(sql`
      SELECT c.source_ref AS dispute_id, max(c.disputed_minor)::text AS amount,
             bool_or(c.disputed_minor IS NULL AND c.ledger_mark IS NULL) AS legacy
        FROM credit_clawbacks c
       WHERE c.account_id = ${accountId}::uuid AND c.source = 'stripe_dispute' AND c.state = 'applied'
         AND strpos(c.source_ref, ':') = 0
         AND (c.target_key = ${invoiceTarget}
              OR right(c.target_key, ${windowTargetSuffix.length}) = ${windowTargetSuffix})
       GROUP BY c.source_ref
       ORDER BY c.source_ref`);
    const rows = rowsOf<{ dispute_id: string; amount: string | null; legacy: boolean }>(result);
    // ⛔ A DISPUTE WRITTEN BEFORE 0139 CARRIES NO AMOUNT (S17 audit 4 #11, R14).
    // Its amount is the payment row's whole disputed figure, and the window it
    // lowered records no undisputed level — neither of which the arithmetic
    // here can recover exactly. Production's credit tables were empty when
    // 0139 shipped, so such a row is not expected; if one exists it is refused
    // loudly rather than read as "no dispute" (which moved credit on the next
    // dispute and on every refresh).
    if (rows.some((r) => r.legacy === true && r.amount === null)) {
      throw new CreditLegacyDisputeError();
    }
    return rows
      .filter((r) => r.amount !== null)
      .map((r) => ({
        disputeId: r.dispute_id,
        amountMinor: exactMicro('a disputed amount', r.amount ?? 'missing'),
      }));
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

/** `window:<window uuid>:<invoice or order>` — a credit unit's target (`unitTargetKey`). The
 *  uuid is spelled 8-4-4-4-12, never 36 hex-or-dash characters. */
const UNIT_TARGET =
  /^window:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([^:]+)$/;

/** The window and coverage a unit's target names; null for any other target. */
export function parseUnitTargetKey(
  targetKey: string,
): { readonly windowId: string; readonly coverageRef: string } | null {
  const m = UNIT_TARGET.exec(targetKey);
  if (m === null) return null;
  return { windowId: m[1] ?? '', coverageRef: m[2] ?? '' };
}

/**
 * S17 R8 (audit 4 #3) — what the customer's tasks took out of ONE credit
 * unit's own lots since the ledger row `sinceMark`: task charges and debt
 * repayments on the window's monthly lot (when the window was drawn from the
 * unit's coverage), on the proration lots of the level changes attributed to
 * it, and on the lots a reconciliation gave back to it. A standalone read, so
 * a task's settlement — which holds no windows repository — can ask how far
 * the unit's credit has been spent since a clawback claimed what the task held.
 */
export async function unitSpentSinceMicro(
  tx: CreditLedgerTx,
  accountId: string,
  input: { readonly targetKey: string; readonly sinceMark: number },
): Promise<number> {
  const unit = parseUnitTargetKey(input.targetKey);
  if (unit === null) return 0;
  const givebackPrefix = unitGivebackPrefix(input.targetKey);
  const result = await tx.execute<{ spent: string }>(sql`
    SELECT COALESCE(sum(-x.lot_delta_micro), 0)::text AS spent
      FROM credit_ledger x
      JOIN credit_lots l ON l.id = x.lot_id
      JOIN credit_windows w ON w.id = ${unit.windowId}::uuid AND w.account_id = ${accountId}::uuid
     WHERE x.account_id = ${accountId}::uuid AND x.kind IN ('task_charge', 'debt_repayment')
       AND x.id > ${String(input.sinceMark)}::bigint
       AND ((l.window_id = w.id AND l.kind = 'monthly' AND w.source_ref = ${unit.coverageRef})
            OR (l.window_id = w.id AND l.kind = 'proration'
                AND EXISTS (SELECT 1 FROM credit_window_level_changes s
                             WHERE s.window_id = w.id
                               AND l.grant_key = 'proration:' || w.id::text || ':' || s.seq::text
                               AND COALESCE(s.source_ref, w.source_ref) = ${unit.coverageRef}))
            OR (l.window_id IS NULL AND l.kind = 'adjustment'
                AND starts_with(l.grant_key, ${givebackPrefix})))
     ORDER BY 1`);
  return exactMicro('spent credit', rowsOf<{ spent: string }>(result)[0]?.spent ?? '0');
}

/** S17 R10 — a give-back's record of a running task's holds it sent elsewhere (`recordHoldRedirect`). */
export interface HoldRedirect {
  readonly id: string;
  readonly targetKey: string;
  readonly amountMicro: number;
}

/**
 * S17 R10 — the records a give-back left for ONE task still running when it
 * was made (`hold:<reservation>:…`, applied), locked: what the task's
 * settlement must finish (`credit_clawbacks_hold_idx`, 0140). A standalone
 * read, for the settlement, which holds no windows repository.
 */
export async function holdRedirectsOf(
  tx: CreditLedgerTx,
  accountId: string,
  reservationId: string,
): Promise<HoldRedirect[]> {
  const range = keyPrefixRange(`hold:${reservationId}:`);
  const result = await tx.execute<{ id: string; target_key: string; amount: string }>(sql`
    SELECT c.id::text AS id, c.target_key, c.amount_micro::text AS amount
      FROM credit_clawbacks c
     WHERE c.account_id = ${accountId}::uuid AND starts_with(c.source_ref, 'hold:')
       AND c.source_ref ~>=~ ${range.from} AND c.source_ref ~<~ ${range.below}
       AND c.state = 'applied'
     ORDER BY c.created_at, c.id
       FOR UPDATE`);
  return rowsOf<{ id: string; target_key: string; amount: string }>(result).map((r) => ({
    id: r.id,
    targetKey: r.target_key,
    amountMicro: exactMicro('a redirected hold', r.amount),
  }));
}

/**
 * S17 R10 — the lots a give-back made beside one task's holds for one unit
 * (`hold:<task>:<lot>:<unit>`), each with the lot it stands beside and what it
 * holds free, locked. A standalone read, for the task's settlement.
 */
export async function holdOverflowLotsOf(
  tx: CreditLedgerTx,
  accountId: string,
  reservationId: string,
  targetKey: string,
): Promise<{ readonly lotId: string; readonly besideLotId: string; readonly freeMicro: number }[]> {
  const prefix = `hold:${reservationId}:`;
  const suffix = `:${targetKey}`;
  const result = await tx.execute<{ id: string; grant_key: string; free: string }>(sql`
    SELECT l.id::text AS id, l.grant_key, (l.remaining_micro - l.held_micro)::text AS free
      FROM credit_lots l
     WHERE l.account_id = ${accountId}::uuid AND l.kind = 'adjustment' AND l.window_id IS NULL
       AND starts_with(l.grant_key, ${prefix})
       AND right(l.grant_key, ${suffix.length}) = ${suffix}
     ORDER BY l.created_at, l.id
       FOR UPDATE OF l`);
  return rowsOf<{ id: string; grant_key: string; free: string }>(result).map((r) => ({
    lotId: r.id,
    besideLotId: r.grant_key.slice(prefix.length, r.grant_key.length - suffix.length),
    freeMicro: exactMicro('free credit', r.free),
  }));
}

/** S17 R10 — a running task's redirect is finished: its record is reversed, once. */
export async function finishHoldRedirect(tx: CreditLedgerTx, id: string): Promise<void> {
  await tx.execute(sql`
    UPDATE credit_clawbacks SET state = 'reversed'
     WHERE id = ${id}::uuid AND state = 'applied'`);
}

/** S17 R10 — one lot of a unit, or one hold of a task, as a settlement moves credit between them. */
export interface SettleLot {
  readonly lotId: string;
  readonly live: boolean;
  /** Below its grant: what may be given back into it. */
  readonly roomMicro: number;
  /** Free now: what may be taken out of it. */
  readonly freeMicro: number;
}

/**
 * S17 R10 — one credit unit's own lots (see `unitSpentSinceMicro`), in the
 * spend order, locked. A standalone read, for a task's settlement.
 */
export async function unitLotsForSettle(
  tx: CreditLedgerTx,
  accountId: string,
  targetKey: string,
): Promise<SettleLot[]> {
  const unit = parseUnitTargetKey(targetKey);
  if (unit === null) return [];
  const givebackPrefix = unitGivebackPrefix(targetKey);
  const result = await tx.execute<{ id: string; live: boolean; room: string; free: string }>(sql`
    SELECT l.id::text AS id,
           (l.revoked_at IS NULL AND l.starts_at <= now() AND now() < l.expires_at) AS live,
           (l.granted_micro - l.remaining_micro)::text AS room,
           (l.remaining_micro - l.held_micro)::text AS free
      FROM credit_lots l
      JOIN credit_windows w ON w.id = ${unit.windowId}::uuid AND w.account_id = ${accountId}::uuid
     WHERE l.account_id = ${accountId}::uuid
       AND ((l.window_id = w.id AND l.kind = 'monthly' AND w.source_ref = ${unit.coverageRef})
            OR (l.window_id = w.id AND l.kind = 'proration'
                AND EXISTS (SELECT 1 FROM credit_window_level_changes s
                             WHERE s.window_id = w.id
                               AND l.grant_key = 'proration:' || w.id::text || ':' || s.seq::text
                               AND COALESCE(s.source_ref, w.source_ref) = ${unit.coverageRef}))
            OR (l.window_id IS NULL AND l.kind = 'adjustment'
                AND starts_with(l.grant_key, ${givebackPrefix})))
     ORDER BY l.spend_rank, l.expires_at, l.created_at, l.id
       FOR UPDATE OF l`);
  return rowsOf<{ id: string; live: boolean; room: string; free: string }>(result).map((r) => ({
    lotId: r.id,
    live: r.live === true,
    roomMicro: exactMicro('room in a lot', r.room),
    freeMicro: exactMicro('free credit', r.free),
  }));
}

/**
 * S17 R10 — one task's holds, in the spend order, with what each was
 * charged and the lot's free credit now (the task has released them all when
 * its settlement asks), locked. A standalone read, for the settlement.
 */
export async function reservationHoldsForSettle(
  tx: CreditLedgerTx,
  reservationId: string,
): Promise<(SettleLot & { readonly chargedMicro: number })[]> {
  const result = await tx.execute<{
    id: string;
    live: boolean;
    room: string;
    free: string;
    charged: string | null;
  }>(sql`
    SELECT l.id::text AS id,
           (l.revoked_at IS NULL AND l.starts_at <= now() AND now() < l.expires_at) AS live,
           (l.granted_micro - l.remaining_micro)::text AS room,
           (l.remaining_micro - l.held_micro)::text AS free,
           h.charged_micro::text AS charged
      FROM credit_reservation_holds h
      JOIN credit_lots l ON l.id = h.lot_id
     WHERE h.reservation_id = ${reservationId}::uuid
     ORDER BY l.spend_rank, l.expires_at, l.created_at, l.id
       FOR UPDATE OF l`);
  return rowsOf<{ id: string; live: boolean; room: string; free: string; charged: string | null }>(
    result,
  ).map((r) => ({
    lotId: r.id,
    live: r.live === true,
    roomMicro: exactMicro('room in a lot', r.room),
    freeMicro: exactMicro('free credit', r.free),
    chargedMicro: r.charged === null ? 0 : exactMicro('charged credit', r.charged),
  }));
}

function invoicePaymentOf(result: unknown): InvoicePaymentFacts | null {
  const row = rowsOf<{
    stripe_invoice_id: string;
    account_id: string;
    amount_paid_minor: string;
    refunded_minor: string;
    disputed_minor: string;
    line_kind: string | null;
    line_interval: string | null;
    line_tier: string | null;
    line_period_start: string | null;
    line_period_end: string | null;
    upgrade_from_micro: string | null;
  }>(result)[0];
  if (row === undefined) return null;
  return {
    stripeInvoiceId: row.stripe_invoice_id,
    accountId: row.account_id,
    amountPaidMinor: exactMicro('an amount paid', row.amount_paid_minor),
    refundedMinor: exactMicro('an amount refunded', row.refunded_minor),
    disputedMinor: exactMicro('an amount disputed', row.disputed_minor),
    lineKind: row.line_kind,
    lineInterval: row.line_interval,
    lineTier: row.line_tier,
    linePeriodStart: row.line_period_start,
    linePeriodEnd: row.line_period_end,
    upgradeFromMicro: nullableMicro('an upgrade level', row.upgrade_from_micro),
  };
}
