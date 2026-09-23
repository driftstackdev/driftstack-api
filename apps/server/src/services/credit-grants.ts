// Monthly AI credits, granted from PAID coverage.
//
// `refreshCredits(accountId)` is the ONE entry point. Whoever calls it — a
// billing event, a background job, an admin action — gets the same steps, in
// one transaction, under the account's credit lock:
//
//   1. expire    what is left of every lot whose term has ended (never the part
//                a running task still holds), one ledger row per lot;
//   2. grant     the month window the account's paid coverage earns RIGHT NOW,
//                if it has none: the window, its monthly lot, and the grant row
//                that funds the lot;
//   3. reconcile the current window's level with a plan that changed mid-month:
//                an upgrade's prorated share arrives in a lot of its own, a
//                downgrade takes its share back out of the window's lots;
//   4. settle    the window's credit UNITS (below) that a standing dispute or
//                a second payment makes follow the facts;
//   5. repay     any debt from whatever credit is now free. The database refuses
//                to commit debt beside spendable credit, so this is what lets a
//                grant to an account in debt commit at all.
//
// WHAT GRANTS CREDITS IS A PAYMENT, NOT A STATUS. A subscription that says
// "active" has not necessarily been paid for: a renewal's payment is attempted
// after the period rolls over, and a plan change may be billed later. So Stripe
// coverage is a PAID invoice's subscription line (and the subscription must also
// be active right now), crypto coverage is a paid order's entitlement, and the
// third kind is a plan an admin set by hand. `credit-windows-repo.ts` holds the
// exact rule. The account's tier decides whether it may SPEND; it grants nothing.
//
// ⛔ A WINDOW MUST CONTAIN NOW. The month after this one is never granted ahead
// of time, however certain it looks: credits that exist can be spent, and a
// payment refunded before its month began would already be gone. The next month
// is granted when it starts, by the boundary job, the sweep, or the next event.
//
// ⛔ A WINDOW'S CREDIT FOLLOWS ITS FACTS, BY CONSTRUCTION (S17 round 3). Every
// amount a month or a plan change grants or takes is measured on the window's
// UNDISPUTED level (0139): standing disputes do not change what a month is
// worth. The credit in a window is split into UNITS — one per payment: the
// payment the window was drawn from, each upgrade line, and the best
// stand-alone cover above them (a resubscription, a crypto term, an override)
// — and each unit has a TARGET computed from the facts alone:
//
//   · a payment's own unit keeps what it bought at what the payment still
//     pays: every grant (the month, an upgrade) and every take (a downgrade)
//     attributed to it, each scaled by what is still paid now over what was
//     still paid when it was made, summed UNFLOORED and rounded to whole
//     credits once (R3) — with standing disputes counted as not paid;
//   · the stand-alone cover earns the part of the month its level stands above
//     what the window's own payment still covers (the hand-over of S17
//     re-audit #7, decided against it rather than against an upgrade line,
//     R5), prorated from its start.
//
// `reconcileUnit` brings a unit's position — what it still holds, what left it
// on the customer's work, less what its clawbacks charged beyond it — to its
// target: it takes the difference (free credit first, held credit as a claim,
// the rest as debt), or gives it back (a claim released, debt forgiven, repaid
// debt returned as credit that lasts as long as the credit that repaid it, the
// rest into the month while it runs). Because the target is a function of the
// facts and every event moves every affected unit to it, the order of events
// does not change where the account ends: a won dispute leaves exactly what the
// account would hold had the dispute never been filed.
//
// ⛔ NOTHING HERE MAY ABORT THE CALLER'S TRANSACTION OVER AN ORDINARY OUTCOME.
// "Another window already covers that time" is ordinary. The window insert is
// therefore ON CONFLICT DO NOTHING with no conflict target (the only form that
// arbitrates the no-overlap constraint), and an empty result reads as covered.
//
// IDEMPOTENT, AND SAFE TWICE AT ONCE. Two refreshes of one account run one after
// the other (the credit lock); the second finds the first's window over now()
// and has no candidate at all. Behind that, the database refuses a second window
// over the same time, a second window for the same payment and month, a second
// monthly lot for a window, a second lot with the same grant key, a second
// funding row for a lot, and a second ledger row with the same key. So a billing
// event delivered twice, or handled on two connections at once, grants once.
//
// DARK UNLESS SWITCHED ON. Bootstrap constructs this service only when
// `creditGrantsRun(mode)` says so and otherwise holds null, and every caller is
// wired to that one value: while DRIFTSTACK_AI_CREDITS_MODE is `off` no event
// refreshes anything and no job is registered.

import {
  AccountTierSchema,
  AI_PLAN_ENTITLEMENTS,
  addUtcMonths,
  ceilMicroToWholeCredits,
  floorMicroToWholeCredits,
  planMonthlyCreditsMicro,
  proratedWholeCreditsMicro,
  type AiDebtReason,
} from '@driftstack/api-types';
import type { DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import type {
  CreditDebtRepayment,
  CreditLedgerTx,
  ExpiredCreditLot,
} from '../db/credit-ledger-repo.js';
import {
  CREDIT_WINDOW_SOURCES,
  prorationGrantKey,
  unitGivebackPrefix,
  unitTargetKey,
  type ClawbackTargetLot,
  type CreditClawbackKey,
  type CreditClawbackRecord,
  type CreditClawbackSource,
  type CreditWindowCandidate,
  type CreditWindowLevelChangeReason,
  type CreditWindowSource,
  type DrizzleCreditWindowsRepo,
  type InvoicePaymentFacts,
  type PgInstant,
  type SourcedCreditWindow,
  type UnitClawback,
  type UnitLot,
  type WindowCover,
  type WindowCovers,
} from '../db/credit-windows-repo.js';
import type { AiCreditsMode } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';
import { isTransientInfraError } from '../lib/transient-error.js';
import { enqueueNextCreditsWindowBoundary } from './credit-grant-jobs.js';
import type { ScheduledJobsService } from './scheduled-jobs.js';

/** What step 2 did. */
export type CreditWindowGrant =
  /** Nothing covers now(), or a window already does. */
  | { readonly outcome: 'none' }
  /** A window was due and another already covered part of its time. Nothing was written. */
  | { readonly outcome: 'covered' }
  | {
      readonly outcome: 'created' | 'existing';
      readonly windowId: string;
      readonly source: CreditWindowCandidate['source'];
      readonly sourceRef: string;
      /** What the window's monthly lot holds; 0 when its share of the month floors to nothing. */
      readonly grantedMicro: number;
    };

/** What step 3 did: the current window's level moved to match a plan that changed mid-month. */
export interface CreditLevelReconciled {
  readonly windowId: string;
  readonly fromLevelMicro: number;
  readonly toLevelMicro: number;
  /** The window's `level_seq` after the change. */
  readonly seq: number;
  /** Credits granted (positive) or taken back (negative) for the rest of the window. */
  readonly deltaMicro: number;
  /** The upgrade's lot; null for a downgrade or when the share floored to nothing. */
  readonly prorationLotId: string | null;
  /** The downgrade's record of what it took; null for an upgrade. */
  readonly clawback: CreditClawbackRecord | null;
}

export interface CreditsRefreshResult {
  readonly expired: readonly ExpiredCreditLot[];
  readonly window: CreditWindowGrant;
  /** Null when the level already matched what the coverage earns, which is the usual case. */
  readonly level: CreditLevelReconciled | null;
  readonly repaid: readonly CreditDebtRepayment[];
  /** The end of the window that contains now() once the refresh is done; null when there is none. */
  readonly currentWindowEnd: PgInstant | null;
}

/** One clawback's arithmetic: what comes out of which lot, and what is left over. */
export interface ClawbackArithmetic {
  /** What each lot gives up, in the order the lots were offered. Lots that give nothing are absent. */
  readonly takes: readonly { readonly lotId: string; readonly micro: number }[];
  /** The sum of `takes`. */
  readonly clawedMicro: number;
  /** What was asked of the lots and could not be taken, because it is spent or held. */
  readonly shortfallMicro: number;
  /** The part of the shortfall that credits running tasks hold cover; paid from them at settle. */
  readonly pendingMicro: number;
  /** The rest of the shortfall: credit that is gone, which the account now owes. */
  readonly debtMicro: number;
}

/**
 * How a clawback of a fixed amount lands on a window's lots.
 *
 * Pure, because it is the part that decides whether a customer ends up in debt,
 * and it is worth being able to state every case of it without a database.
 *
 * ⛔ WHAT THE LOTS NEVER HELD IS NOT ASKED FOR AT ALL. The ceiling on the whole
 * clawback is what the lots between them EVER HELD — what they were granted,
 * less what expired out of them unspent (H2). Credit that expired was never
 * used, so counting it would turn an untouched month into debt; credit that was
 * never granted is not the customer's to owe, so an amount larger than the
 * ceiling is simply not clawed, and leaves no debt behind either.
 *
 * Under that ceiling it walks the lots in the order given (newest first for a
 * plan change) and takes each one's FREE credit — what is left, less what a
 * running task holds. A task's credit is not taken out from under it. A lot
 * that can give nothing is stepped over, NOT charged: what it could not give is
 * asked of the next lot. ⚠️ The earlier form of this walk fixed each lot's
 * share before asking it, so a spent lot absorbed the whole amount and older
 * lots that still held free credit were never reached — which wrote debt (or,
 * with a task running, a pending claim) for credit the account still had. That
 * shape is reachable, because a clawback spends lots NEWEST first while every
 * other consumer spends them oldest first, so a second clawback starts on a lot
 * the first one emptied.
 *
 * What could not be taken from any lot is the SHORTFALL. As much of it as the
 * account's total held credit covers becomes a PENDING CLAIM, paid from those
 * credits when the tasks holding them settle (S7); only the rest is debt (M5).
 * Without that split a downgrade landing during a long task would refuse the
 * customer's next task over credit they still have.
 */
export function planClawbackOfAmount(
  lots: readonly ClawbackTargetLot[],
  amountMicro: number,
  heldTotalMicro: number,
): ClawbackArithmetic {
  if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
    throw new RangeError('a clawback amount must be a positive safe integer of microcredits');
  }
  if (!Number.isSafeInteger(heldTotalMicro) || heldTotalMicro < 0) {
    throw new RangeError('held credit must be a non-negative safe integer of microcredits');
  }
  const everHeld = (lot: ClawbackTargetLot): number =>
    Math.max(0, lot.grantedMicro - lot.expiredMicro);
  let askable = 0;
  for (const lot of lots) askable = askable + everHeld(lot);
  const want = Math.min(amountMicro, askable);

  const takes: { lotId: string; micro: number }[] = [];
  let clawed = 0;
  for (const lot of lots) {
    if (clawed >= want) break;
    // ⚠️ A lot's own ceiling is DEFENCE, not a case that can happen today:
    // `credit_lots_remaining_bounds` (0128) refuses `remaining_micro` above
    // `granted_micro`, so even a positive `adjustment` row cannot refill a lot
    // past what its grant ever held. It is kept because the cap is what says
    // WHOSE credit is being taken — a clawback of a plan change may take back
    // what that plan granted and nothing support added — and because dropping
    // it would leave that rule resting on a CHECK one migration away.
    const free = Math.min(Math.max(0, lot.remainingMicro - lot.heldMicro), everHeld(lot));
    const take = Math.min(want - clawed, free);
    if (take <= 0) continue;
    takes.push({ lotId: lot.lotId, micro: take });
    clawed = clawed + take;
  }
  const shortfall = want - clawed;
  const pending = Math.min(shortfall, heldTotalMicro);
  return {
    takes,
    clawedMicro: clawed,
    shortfallMicro: shortfall,
    pendingMicro: pending,
    debtMicro: shortfall - pending,
  };
}

// ── the unit arithmetic (pure) ───────────────────────────────────────────

const MICRO_PER_CREDIT = 1_000_000n;

/** One grant (positive) or take (negative) a unit's target is made of. */
export interface UnitKeepTerm {
  readonly micro: number;
  /** What the unit's payment still paid (refunds off) when it was made; null is the whole payment. */
  readonly stillPaidAtMinor: number | null;
}

/**
 * What one unit keeps at what its payment still pays (`stillPaidMinor`,
 * refunds AND standing disputes taken off): every grant and take attributed to
 * it, each scaled by what is still paid now over what was still paid when it
 * was made, summed UNFLOORED and rounded DOWN to whole credits once (S17 R3: a
 * customer never loses a credit to a double floor), never below nothing. A
 * payment of nothing reverses nothing: the unit keeps the sum as it stands. A
 * term made when nothing was still paid keeps all of itself or none of it.
 */
export function unitKeepMicro(input: {
  readonly amountPaidMinor: number;
  readonly stillPaidMinor: number;
  readonly terms: readonly UnitKeepTerm[];
}): number {
  const paid = wholeNonNegative('a payment', input.amountPaidMinor);
  const still = Math.min(paid, wholeNonNegative('what is still paid', input.stillPaidMinor));
  // An exact rational sum: Σ micro × still / at, over the product of the
  // distinct denominators, so no term is rounded before the one floor.
  let numerator = 0n;
  let denominator = 1n;
  for (const term of input.terms) {
    if (!Number.isSafeInteger(term.micro)) throw new RangeError('a term is whole microcredits');
    if (paid === 0) {
      numerator = numerator + BigInt(term.micro) * denominator;
      continue;
    }
    const at =
      term.stillPaidAtMinor === null
        ? paid
        : wholeNonNegative('what was still paid', term.stillPaidAtMinor);
    let termNumerator: bigint;
    let termDenominator: bigint;
    if (at === 0) {
      termNumerator = still > 0 ? BigInt(term.micro) : 0n;
      termDenominator = 1n;
    } else {
      termNumerator = BigInt(term.micro) * BigInt(still);
      termDenominator = BigInt(at);
    }
    if (termDenominator === denominator) {
      numerator = numerator + termNumerator;
    } else {
      numerator = numerator * termDenominator + termNumerator * denominator;
      denominator = denominator * termDenominator;
    }
  }
  if (numerator <= 0n) return 0;
  const micro = numerator / denominator;
  return Number((micro / MICRO_PER_CREDIT) * MICRO_PER_CREDIT);
}

/**
 * Where a unit should stand — what it holds plus what it spent, less what its
 * clawbacks charged beyond it: what it keeps (`unitKeepMicro`), or — when the
 * customer spent more than that — what they spent less the debt the payment
 * may still create for it (`allowedDebtMicro`; null is no cap).
 */
export function unitTargetMicro(
  keepMicro: number,
  consumedMicro: number,
  allowedDebtMicro: number | null,
): number {
  if (allowedDebtMicro === null) return keepMicro;
  return Math.max(keepMicro, consumedMicro - Math.max(0, allowedDebtMicro));
}

/**
 * The interim annual cap, pending the owner (see credit-clawbacks.ts): the
 * debt a payment may leave across ALL of its windows is what was spent there
 * less what the payment still pays for (`paidForKeepMicro`, whole credits),
 * shared out NEWEST window first — the order a reversal takes them in — each
 * window at most its own shortfall. `paidForKeepMicro` null: no cap.
 */
export function allowedDebtByUnit(
  units: readonly { readonly keepMicro: number; readonly consumedMicro: number }[],
  paidForKeepMicro: number | null,
): (number | null)[] {
  if (paidForKeepMicro === null) return units.map(() => null);
  let spent = 0;
  for (const u of units) spent = spent + u.consumedMicro;
  let left = Math.max(0, spent - paidForKeepMicro);
  return units.map((u) => {
    const shortfall = Math.max(0, u.consumedMicro - u.keepMicro);
    const allowed = Math.min(shortfall, left);
    left = left - allowed;
    return allowed;
  });
}

/**
 * What the stand-alone cover earns in a window (the hand-over, S17 re-audit
 * #7 and R5): its level above what stands beneath it, prorated from its own
 * start, in whole credits — the same arithmetic an upgrade from that level
 * would grant.
 */
export function envelopeKeepMicro(
  coverLevelMicro: number,
  baseLevelMicro: number,
  portionMicroseconds: number,
  wholeMicroseconds: number,
): number {
  if (coverLevelMicro <= baseLevelMicro) return 0;
  return proratedWholeCreditsMicro(
    coverLevelMicro - baseLevelMicro,
    Math.min(portionMicroseconds, wholeMicroseconds),
    wholeMicroseconds,
  );
}

/** What a window's facts say its two levels should be, and which coverage says it. */
export interface WindowTargets {
  /** The coverage the window was drawn from, as listed over now(); null when it is not listed. */
  readonly own: WindowCover | null;
  /**
   * What the drawing coverage's payment covers on its own, active or not (a
   * canceled subscription keeps the month it paid for); null when nothing
   * says — an override that ended, a plan no allowance names.
   */
  readonly ownAlone: { readonly levelMicro: number; readonly undisputedLevelMicro: number } | null;
  /** The drawing coverage and every upgrade line: what the undisputed level follows. */
  readonly line: readonly WindowCover[];
  /** The undisputed level the line earns; null when nothing says. */
  readonly undisputedLevelMicro: number | null;
  /** The level to show: the best of every coverage; null when nothing says. */
  readonly levelMicro: number | null;
  /** The line coverage an undisputed change is attributed to and measured from. */
  readonly lineBest: WindowCover | null;
  /** The best stand-alone cover above the window's own payment, and what it earns there. */
  readonly envelope: { readonly cover: WindowCover; readonly keepMicro: number } | null;
}

function sourceRank(source: CreditWindowSource): number {
  return CREDIT_WINDOW_SOURCES.indexOf(source);
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The two targets of the window containing now: the UNDISPUTED level (the
 * line — the coverage the window was drawn from and every upgrade line) and
 * the level SHOWN (the best of every coverage), plus the stand-alone cover
 * above the window's own payment and what it earns. Pure.
 *
 * ⛔ THE ORDER THAT PICKS THE LINE'S BEST IS TOTAL, because it decides an
 * amount of money. Two coverages can earn the same level — a renewal's
 * `period` line beside the `proration_up` line of the upgrade it renews, say —
 * and they carry DIFFERENT starts, so an order that stopped at the level would
 * prorate from whichever row Postgres happened to return first. The proration
 * line is preferred, which is what §6.6 names for an upgrade, and every
 * remaining tie is broken on the source, the reference and the two instants.
 *
 * When the window was drawn from an override that has since ENDED, there is no
 * payment of its own left beneath the other coverage: the other coverage IS the
 * line (a downgrade to it is prorated from now), and nothing stands alone.
 */
export function windowTargets(wc: WindowCovers): WindowTargets {
  const own = wc.covers.find((c) => c.source === wc.source && c.sourceRef === wc.sourceRef) ?? null;
  let ownAlone: WindowTargets['ownAlone'] = null;
  if (own !== null) {
    ownAlone = {
      levelMicro: own.levelMicro ?? 0,
      undisputedLevelMicro: own.undisputedLevelMicro ?? 0,
    };
  } else if (wc.source === 'crypto_entitlement') {
    // A crypto term not listed over now() was refunded (its entitlement
    // revoked): nothing of it is paid for any more.
    ownAlone = { levelMicro: 0, undisputedLevelMicro: 0 };
  }
  const overrideEnded = wc.source === 'plan_override' && own === null;
  const active = wc.covers.filter((c) => c.active);
  const line = overrideEnded
    ? active
    : active.filter((c) => c === own || c.lineKind === 'proration_up');
  const standing = overrideEnded ? [] : active.filter((c) => !line.includes(c));

  let undisputed: number | null = ownAlone?.undisputedLevelMicro ?? null;
  for (const c of line) {
    if (c.undisputedLevelMicro === null) continue;
    if (undisputed === null || c.undisputedLevelMicro > undisputed)
      undisputed = c.undisputedLevelMicro;
  }
  let shown: number | null = ownAlone?.levelMicro ?? null;
  for (const c of active) {
    if (c.levelMicro === null) continue;
    if (shown === null || c.levelMicro > shown) shown = c.levelMicro;
  }

  const lineCandidates = line.filter((c) => c.undisputedLevelMicro !== null);
  if (own !== null && !lineCandidates.includes(own)) lineCandidates.push(own);
  const kindRank = (c: WindowCover): number => (c.lineKind === 'proration_up' ? 0 : 1);
  lineCandidates.sort(
    (a, b) =>
      (b.undisputedLevelMicro ?? 0) - (a.undisputedLevelMicro ?? 0) ||
      kindRank(a) - kindRank(b) ||
      sourceRank(a.source) - sourceRank(b.source) ||
      byKey(a.sourceRef, b.sourceRef) ||
      byKey(a.upAt, b.upAt) ||
      byKey(a.downAt, b.downAt),
  );
  const lineBest = lineCandidates[0] ?? null;

  const envelopeCandidates = standing.filter((c) => c.levelMicro !== null);
  envelopeCandidates.sort(
    (a, b) =>
      (b.levelMicro ?? 0) - (a.levelMicro ?? 0) ||
      sourceRank(a.source) - sourceRank(b.source) ||
      byKey(a.sourceRef, b.sourceRef),
  );
  const top = envelopeCandidates[0];
  let envelope: WindowTargets['envelope'] = null;
  if (top !== undefined && top.levelMicro !== null) {
    // What stands beneath it: the window's own payment, and any upgrade line
    // that stops below it (an upgrade line above it covers the step above the
    // month, not the month the stand-alone cover pays for).
    let base = ownAlone?.levelMicro ?? 0;
    for (const c of line) {
      if (c.lineKind !== 'proration_up' || c.levelMicro === null) continue;
      if (c.levelMicro < top.levelMicro && c.levelMicro > base) base = c.levelMicro;
    }
    envelope = {
      cover: top,
      keepMicro: envelopeKeepMicro(
        top.levelMicro,
        base,
        top.upMicroseconds,
        wc.naturalMicroseconds,
      ),
    };
  }
  return {
    own,
    ownAlone,
    line,
    undisputedLevelMicro: undisputed,
    levelMicro: shown,
    lineBest,
    envelope,
  };
}

// ── what a Stripe payment bought, for the interim annual cap ────────────────

/**
 * What the payment bought, in microcredits, for the interim cap: a PERIOD
 * line's plan allowance × the months it pays for; an ANNUAL UPGRADE line's step
 * up `(upper − from)` × the calendar months its line spans (re-audit #8). Null —
 * no cap beyond the per-window rule — for a monthly upgrade line (it bought its
 * prorated lot, nothing more), a line on a plan with no plan-wide allowance, or
 * one whose interval or period is unknown.
 */
export function paidForMicro(payment: InvoicePaymentFacts): number | null {
  if (payment.lineTier === null) return null;
  const tier = AccountTierSchema.safeParse(payment.lineTier);
  if (!tier.success || !Object.hasOwn(AI_PLAN_ENTITLEMENTS, tier.data)) return null;
  const monthly = planMonthlyCreditsMicro(tier.data);
  if (monthly === null || monthly <= 0) return null;
  if (payment.lineKind === 'period') {
    const months =
      payment.lineInterval === 'year' ? 12 : payment.lineInterval === 'month' ? 1 : null;
    return months === null ? null : monthly * months;
  }
  if (payment.lineKind === 'proration_up' && payment.lineInterval === 'year') {
    const months = monthsSpanned(payment.linePeriodStart, payment.linePeriodEnd);
    if (months === null) return null;
    const step = monthly - Math.min(monthly, payment.upgradeFromMicro ?? 0);
    return step > 0 ? step * months : null;
  }
  return null;
}

/**
 * The calendar months a line spans, counted UP: the fewest whole months from
 * its start that reach its end (the billing calendar `addUtcMonths` draws). A
 * line of seven and a half months spans eight. Null when the period is unknown.
 */
function monthsSpanned(start: PgInstant | null, end: PgInstant | null): number | null {
  if (start === null || end === null) return null;
  const from = new Date(`${start.slice(0, 23)}Z`);
  const to = new Date(`${end.slice(0, 23)}Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  // The calendar-field estimate is the answer or one short of it (the day or
  // time of day of the end may lie past the start's).
  const estimate = Math.max(
    1,
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()),
  );
  if (estimate > 1 && addUtcMonths(from, estimate - 1) >= to) return estimate - 1;
  return addUtcMonths(from, estimate) >= to ? estimate : estimate + 1;
}

const MINUTE_MS = 60_000;

/**
 * The start of the whole UTC minute BEFORE the one `at` falls in — the rule a
 * goodwill grant and every given-back lot use for a lot's `starts_at`: a lot
 * compared against the database's frozen `now()` must not start a hair after
 * it, and a replay of the same request must compute the same instant.
 */
export function floorToPriorMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
}

/** The lot a reconciliation gives back to a unit for one event (`reinstate:<unit>:<event>`). */
export function reinstateGrantKey(ref: string): string {
  return `reinstate:${ref}`;
}

/**
 * The lot a reconciliation gives back to a unit for debt that later credit
 * already repaid (`reinstate:<unit>:<event>:returned`): it lasts as long as the
 * credit that repaid it (S17 R1), so it is a lot of its own. The suffix keeps
 * it apart from the event's other give-back lot.
 */
export function returnedGrantKey(ref: string): string {
  return `reinstate:${ref}:returned`;
}

// ── the event a unit is reconciled at ────────────────────────────────────

/** Why a unit is reconciled now: what a take is recorded under and a give-back keyed by. */
export interface CreditUnitEvent {
  /** The clawback source a take at this event is recorded under. */
  readonly source: CreditClawbackSource;
  /**
   * The event's reference, unique to it: a refund's `charge:cumulative`, a
   * dispute's id, `<dispute>:won`, a crypto order's id, or a refresh's tag.
   */
  readonly ref: string;
  /** The ledger kind a take's rows are written as. */
  readonly ledgerKind: 'refund_clawback' | 'proration_clawback';
  readonly debtReason: AiDebtReason;
  /** The reason a give-back's rows record. */
  readonly label: string;
  /**
   * 0139 — a dispute's own event: the amount it disputed, recorded on every
   * row it writes under its own id (what a payment has disputed is the sum of
   * its standing disputes, R2).
   */
  readonly disputedMinor?: number;
}

/** What a payment still pays and bought, as a unit's target reads it. */
export interface UnitPaymentTerms {
  /** The payment's amount, in its minor units; 0 is a free invoice (keeps everything). */
  readonly amountPaidMinor: number;
  /** What it still pays: refunds AND standing disputes taken off. */
  readonly stillPaidMinor: number;
  /** What the payment bought for the interim annual cap (`paidForMicro`); null is no cap. */
  readonly paidForMicro: number | null;
}

/** What a reconciliation of one payment's units did. */
export interface UnitReconcileSummary {
  /** How many windows the payment has credit in. */
  readonly windows: number;
  /** The clawbacks the event wrote (takes), one per unit that gave anything up. */
  readonly clawbacks: readonly CreditClawbackRecord[];
  /** Credit given back as lots (the month's give-back and returned debt), whole credits. */
  readonly regrantedMicro: number;
  /** Debt forgiven. */
  readonly forgivenMicro: number;
}

const NOTHING: UnitReconcileSummary = {
  windows: 0,
  clawbacks: [],
  regrantedMicro: 0,
  forgivenMicro: 0,
};

/** One unit, read for a reconciliation. */
interface UnitState {
  readonly windowId: string;
  readonly windowEnd: PgInstant;
  /** Whether the window still runs: only then does credit go back into it. */
  readonly live: boolean;
  readonly coverageRef: string;
  readonly targetKey: string;
  readonly lots: readonly UnitLot[];
  readonly clawbacks: readonly UnitClawback[];
  /** Claims the unit's clawbacks collected from lots that are not the unit's. */
  readonly collectedElsewhereMicro: number;
  /** Those claims, by the lot each was collected from: where a give-back returns them. */
  readonly collectedElsewhere: readonly { readonly lotId: string; readonly micro: number }[];
  /** What a reconciliation already released of the unit's charges (forgiven, or returned elsewhere). */
  readonly releasedMicro: number;
  /** The grants and takes the unit's target is made of. */
  readonly terms: readonly UnitKeepTerm[];
}

/** L + S − B: what the unit holds and spent, less what its clawbacks charged beyond it. */
function positionOf(u: UnitState): number {
  let held = 0;
  let spent = 0;
  for (const lot of u.lots) {
    held = held + lot.remainingMicro;
    spent = spent + lot.consumedMicro;
  }
  return held + spent - chargedOf(u);
}

/** What the unit's clawbacks charged beyond its lots and still stand charged for. */
function chargedOf(u: UnitState): number {
  let charged = u.collectedElsewhereMicro - u.releasedMicro;
  for (const c of u.clawbacks) charged = charged + c.debtMicro + c.pendingMicro;
  return charged;
}

function consumedOf(u: UnitState): number {
  let spent = 0;
  for (const lot of u.lots) spent = spent + lot.consumedMicro;
  return spent;
}

/**
 * What the unit's customer spent that no plan change has already made them
 * owe: the spend the interim cap weighs. A downgrade's debt is not debt a
 * REVERSAL created (the cap governs only that), so it is taken off before the
 * cap measures what a reversal may still charge — otherwise a won dispute,
 * moving the unit to the capped target, would forgive a downgrade's debt that
 * no reversal ever charged. What a reconciliation released is counted against
 * the reversals' charges first.
 */
function spentForCapOf(u: UnitState): number {
  let planChange = 0;
  for (const c of u.clawbacks) {
    if (c.source === 'plan_change') planChange = planChange + c.debtMicro + c.pendingMicro;
  }
  const owedByPlanChange = Math.min(planChange, Math.max(0, chargedOf(u)));
  return Math.max(0, consumedOf(u) - owedByPlanChange);
}

function wholeNonNegative(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} is a whole non-negative number`);
  }
  return value;
}

/** The later of two instants; fixed-width UTC text orders as a string. */
function laterOf(a: PgInstant | null, b: PgInstant | null): PgInstant | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * The candidate to grant: the highest monthly level (undisputed: a standing
 * dispute does not decide which payment a month is drawn from); between equals
 * the one that starts earliest; then by source and reference, so the choice
 * never depends on the order the database returned them in. Null for none.
 */
export function pickWindowCandidate(
  candidates: readonly CreditWindowCandidate[],
): CreditWindowCandidate | null {
  let best: CreditWindowCandidate | null = null;
  for (const c of candidates) {
    if (best === null || compareCandidates(c, best) < 0) best = c;
  }
  return best;
}

function compareCandidates(a: CreditWindowCandidate, b: CreditWindowCandidate): number {
  const la = a.undisputedLevelMicro ?? a.levelMicro;
  const lb = b.undisputedLevelMicro ?? b.levelMicro;
  if (la !== lb) return la > lb ? -1 : 1;
  // Fixed-width UTC text: string order is time order.
  if (a.windowStart !== b.windowStart) return a.windowStart < b.windowStart ? -1 : 1;
  const bySource =
    CREDIT_WINDOW_SOURCES.indexOf(a.source) - CREDIT_WINDOW_SOURCES.indexOf(b.source);
  if (bySource !== 0) return bySource;
  return a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0;
}

export interface CreditSweepResult {
  readonly visited: number;
  /** Accounts that were granted a window this tick. */
  readonly granted: number;
  /** Accounts whose lots gave up expired credit this tick. */
  readonly expired: number;
  readonly failed: number;
  /** Where the next tick's walk resumes; null when this one reached the end. */
  readonly nextAfterAccountId: string | null;
}

/** What a caller that only triggers a refresh needs. */
export interface CreditsRefresher {
  refreshCredits(accountId: string): Promise<CreditsRefreshResult>;
}

/**
 * One ledger row's key inside a clawback. Every row a clawback writes is keyed
 * off the clawback's own identity, so replaying it applies nothing twice even
 * before the clawback's row is there to be found.
 */
function clawbackLedgerKey(key: CreditClawbackKey, suffix: string): string {
  return `clawback:${key.source}:${key.sourceRef}:${suffix}`;
}

export interface CreditGrantsDeps {
  readonly ledger: DrizzleCreditLedgerRepo;
  readonly windows: DrizzleCreditWindowsRepo;
  /** Arms each account's window-boundary job once a refresh has committed. Optional: tests may omit it. */
  readonly scheduledJobs?: ScheduledJobsService;
  readonly logger?: Logger;
  /** Injectable clock for tests: when a given-back lot starts. */
  readonly now?: () => Date;
}

export class CreditGrantsService implements CreditsRefresher {
  constructor(private readonly deps: CreditGrantsDeps) {}

  /**
   * Refresh one account's credits in a transaction of its own, then arm the
   * account's window-boundary job for the window that is now current.
   *
   * The job is armed AFTER the commit and never fails the refresh: the grant
   * stands whether or not its alarm clock could be set, and the coverage sweep
   * is the backstop for a boundary nobody armed.
   */
  async refreshCredits(accountId: string): Promise<CreditsRefreshResult> {
    const result = await this.deps.ledger.transaction((tx) => this.refreshCreditsIn(tx, accountId));
    await this.armWindowBoundary(accountId, result.currentWindowEnd);
    return result;
  }

  /**
   * The refresh itself, inside a transaction the caller holds. It takes the
   * account's credit lock FIRST, before anything it reads, which is the lock
   * order every credit writer uses.
   */
  async refreshCreditsIn(tx: CreditLedgerTx, accountId: string): Promise<CreditsRefreshResult> {
    const { ledger, windows } = this.deps;
    await ledger.lockAccount(tx, accountId);
    const expired = await ledger.expireDueLots(tx, accountId);
    const window = await this.materializeWindows(tx, accountId);
    const level = await this.reconcileLevel(tx, accountId);
    await this.reconcileWindowUnits(tx, accountId, { event: null, exclude: [] });
    const repaid = await ledger.settleDebtFromFree(tx, accountId);
    const current = await windows.currentWindow(accountId, tx);
    return { expired, window, level, repaid, currentWindowEnd: current?.windowEnd ?? null };
  }

  /**
   * Grant the window the account's paid coverage earns right now, if any. The
   * caller holds the account's credit lock.
   */
  async materializeWindows(tx: CreditLedgerTx, accountId: string): Promise<CreditWindowGrant> {
    const { ledger, windows } = this.deps;
    const best = pickWindowCandidate(await windows.coverageCandidates(tx, accountId));
    if (best === null) return { outcome: 'none' };

    const written = await windows.writeWindow(tx, accountId, best);
    if (written.outcome === 'covered') return { outcome: 'covered' };

    // Also for a window that was already there: every write below applies once,
    // so this repairs a window whose lot or grant row is somehow missing and
    // does nothing to one that is whole.
    const lot = await windows.ensureMonthlyLot(tx, accountId, written.windowId);
    if (lot !== null) {
      await ledger.append(
        {
          accountId,
          kind: 'grant',
          lotId: lot.lotId,
          amountMicro: lot.grantedMicro,
          idempotencyKey: `grant:${lot.lotId}`,
        },
        tx,
      );
    }
    return {
      outcome: written.outcome,
      windowId: written.windowId,
      source: best.source,
      sourceRef: best.sourceRef,
      grantedMicro: lot?.grantedMicro ?? 0,
    };
  }

  /**
   * Bring the current window's level into line with a plan that changed
   * mid-month: more credits for the days left after a PAID upgrade, fewer after
   * a downgrade. The caller holds the account's credit lock.
   *
   * THE SHARE IS OF THE TIME THAT IS LEFT, measured from when the plan actually
   * changed. `u` is the paid proration line's start for an upgrade and
   * `tier_since` for a downgrade (never when the event arrived — a webhook
   * delivered a day late must not cost the customer a day), clamped into the
   * window; the difference between the two levels is then prorated over
   * `[u, window_end)` as a share of the whole natural month. That is the same
   * arithmetic, over the same denominator, that granted the month in the first
   * place, so an upgrade for the whole of a month grants exactly the difference
   * between the two plans.
   *
   * ⛔ MEASURED ON THE UNDISPUTED LEVEL (0139). A plan change made while a
   * dispute stands grants or takes exactly what it would have without the
   * dispute (the third audit's A3–A5): the dispute takes its share of the
   * result as a reversal of its own (`reconcileWindowUnits`), which a win gives
   * back whole. The level SHOWN moves to the best of all coverage in the same
   * step.
   *
   * ⛔ A DOWNGRADE'S `u` IS ONLY EVIDENCE WHEN IT COMES FROM THE COVERAGE THIS
   * WINDOW WAS DRAWN FROM. An upgrade's `u` is backed by a PAYMENT — a line the
   * customer has paid for from that instant — so it is good whichever source it
   * is on. A downgrade's is backed by an assumption: that `tier_since` (or a
   * term's start) says when the account stopped earning the level the window is
   * AT. For the window's own coverage that is true. For any OTHER coverage it is
   * not, and it is usually much older than the window, so the clamp would drag
   * `u` back to `window_start` and take the WHOLE month's difference back. When
   * the window's own coverage is gone — the override that ended, a term that
   * lapsed — nothing in the database records the instant it stopped, so the
   * change is dated to NOW: the refresh that observes it.
   *
   * ⛔ IDEMPOTENT BY THE LEVEL ITSELF, not by remembering. The window carries
   * the level it is at; once it has been moved to the target there is no
   * difference left to prorate, so a second refresh — a redelivered webhook, a
   * sweep, a task's lazy refresh — computes nothing and writes nothing. Behind
   * that, the proration lot's grant key, the level change's `(window, seq)` and
   * the clawback's `(source, source_ref, target)` each refuse a second copy.
   *
   * ⛔ A LAPSE NEVER LOWERS THE LEVEL. An account whose coverage has ended has
   * no target at all, and keeps the month it paid for — a canceled
   * subscription's invoice still covers what it paid for. What stops it
   * spending is its tier, which is not decided here.
   *
   * When only the level SHOWN rises — a stand-alone cover (a resubscription, a
   * crypto term, an override) now pays for more than the window's own payment
   * covers — the step carries that cover's share of the rest of the month (M8:
   * a new subscription after a refund gets its credits at once).
   */
  async reconcileLevel(
    tx: CreditLedgerTx,
    accountId: string,
  ): Promise<CreditLevelReconciled | null> {
    const { ledger, windows } = this.deps;
    const wc = await windows.windowCovers(tx, accountId);
    if (wc === null) return null;
    const t = windowTargets(wc);
    const seq = wc.levelSeq + 1;
    const shown = t.levelMicro !== null && t.levelMicro > 0 ? t.levelMicro : wc.levelMicro;

    const undisputed = t.undisputedLevelMicro;
    if (
      undisputed !== null &&
      undisputed > 0 &&
      undisputed !== wc.undisputedLevelMicro &&
      t.lineBest !== null
    ) {
      const best = t.lineBest;
      const up = undisputed > wc.undisputedLevelMicro;
      const ownActive = t.own !== null && t.own.active;
      const portion = up
        ? best.upMicroseconds
        : ownActive && t.own !== null
          ? t.own.downMicroseconds
          : wc.nowMicroseconds;
      const effectiveAt = up ? best.upAt : ownActive && t.own !== null ? t.own.downAt : wc.nowAt;
      const deltaMicro = proratedWholeCreditsMicro(
        undisputed - wc.undisputedLevelMicro,
        Math.min(portion, wc.naturalMicroseconds),
        wc.naturalMicroseconds,
      );
      // The level moves FIRST, and it moves whether or not the prorated share
      // rounds to a whole credit: the level is what the next reconciliation
      // measures against, so a change left unrecorded would be recomputed for
      // ever, and a plan change in the last minutes of a month is worth no
      // credits and is still a plan change.
      await windows.setWindowLevel(tx, {
        accountId,
        windowId: wc.windowId,
        seq,
        reason: 'plan_change',
        fromLevelMicro: wc.levelMicro,
        toLevelMicro: shown,
        undisputedFromMicro: wc.undisputedLevelMicro,
        undisputedToMicro: undisputed,
        effectiveAt,
        deltaMicro,
        // S17 (0136) — the coverage that supplies the new level. The proration lot
        // this step grants belongs to it, so a refund of that invoice takes back
        // exactly this lot, and a refund of any other invoice never touches it.
        sourceRef: best.sourceRef,
        stillPaidMinor: best.stillPaidMinor,
      });

      let prorationLotId: string | null = null;
      let clawback: CreditClawbackRecord | null = null;
      if (deltaMicro > 0) {
        const lot = await windows.ensureProrationLot(tx, accountId, wc.windowId, seq, deltaMicro);
        prorationLotId = lot.lotId;
        await ledger.append(
          {
            accountId,
            kind: 'proration_grant',
            lotId: lot.lotId,
            amountMicro: lot.grantedMicro,
            idempotencyKey: `proration_grant:${lot.lotId}`,
            reason: 'plan_change',
          },
          tx,
        );
      } else if (deltaMicro < 0) {
        clawback = await this.clawBack(tx, accountId, {
          source: 'plan_change',
          sourceRef: `${wc.windowId}:${String(seq)}`,
          targetKey: `window:${wc.windowId}`,
          windowId: wc.windowId,
          amountMicro: -deltaMicro,
          ledgerKind: 'proration_clawback',
          debtReason: 'plan_change',
        });
      }
      return {
        windowId: wc.windowId,
        fromLevelMicro: wc.levelMicro,
        toLevelMicro: shown,
        seq,
        deltaMicro,
        prorationLotId,
        clawback,
      };
    }

    if (shown === wc.levelMicro) return null;
    // Only the level SHOWN moves. When a stand-alone cover now shows above the
    // window, its share of the rest of the month rides this step.
    const env = t.envelope;
    const envelopeRises = env !== null && shown > wc.levelMicro && env.cover.levelMicro === shown;
    let deltaMicro = 0;
    if (envelopeRises) {
      const state = await this.unitState(tx, accountId, currentWindowOf(wc), {
        source: env.cover.source,
        sourceRef: env.cover.sourceRef,
      });
      const need = env.keepMicro - positionOf(state);
      deltaMicro = need > 0 ? ceilMicroToWholeCredits(need) : 0;
    }
    const attributed = envelopeRises ? env.cover : (t.lineBest ?? t.own);
    await windows.setWindowLevel(tx, {
      accountId,
      windowId: wc.windowId,
      seq,
      reason: 'plan_change',
      fromLevelMicro: wc.levelMicro,
      toLevelMicro: shown,
      undisputedFromMicro: wc.undisputedLevelMicro,
      undisputedToMicro: wc.undisputedLevelMicro,
      effectiveAt: envelopeRises ? env.cover.upAt : wc.nowAt,
      deltaMicro,
      sourceRef: attributed?.sourceRef ?? wc.sourceRef,
      stillPaidMinor: attributed?.stillPaidMinor ?? null,
    });
    let prorationLotId: string | null = null;
    if (deltaMicro > 0) {
      const lot = await windows.ensureProrationLot(tx, accountId, wc.windowId, seq, deltaMicro);
      prorationLotId = lot.lotId;
      await ledger.append(
        {
          accountId,
          kind: 'proration_grant',
          lotId: lot.lotId,
          amountMicro: lot.grantedMicro,
          idempotencyKey: `proration_grant:${lot.lotId}`,
          reason: 'plan_change',
        },
        tx,
      );
    }
    return {
      windowId: wc.windowId,
      fromLevelMicro: wc.levelMicro,
      toLevelMicro: shown,
      seq,
      deltaMicro,
      prorationLotId,
      clawback: null,
    };
  }

  /**
   * S17 — after a refund, a dispute or a win has changed what a payment still
   * pays, move the current window's two levels to what its coverage says,
   * recorded with the event's reason and a delta of 0: the credits the event
   * moved are its units' rows (audit #14), never a second amount here. When
   * nothing covers now the window keeps the level its own payment still pays
   * for (a canceled subscription, audit #16), and with nothing to say at all it
   * keeps the level it has. Returns whether a level moved.
   */
  async alignLevels(
    tx: CreditLedgerTx,
    accountId: string,
    input: { readonly reason: CreditWindowLevelChangeReason; readonly sourceRef: string },
  ): Promise<boolean> {
    const { windows } = this.deps;
    const wc = await windows.windowCovers(tx, accountId);
    if (wc === null) return false;
    const t = windowTargets(wc);
    const undisputed = t.undisputedLevelMicro ?? wc.undisputedLevelMicro;
    const shown = t.levelMicro ?? wc.levelMicro;
    if (undisputed === wc.undisputedLevelMicro && shown === wc.levelMicro) return false;
    await windows.setWindowLevel(tx, {
      accountId,
      windowId: wc.windowId,
      seq: wc.levelSeq + 1,
      reason: input.reason,
      fromLevelMicro: wc.levelMicro,
      toLevelMicro: shown,
      undisputedFromMicro: wc.undisputedLevelMicro,
      undisputedToMicro: undisputed,
      effectiveAt: wc.nowAt,
      deltaMicro: 0,
      sourceRef: input.sourceRef,
      stillPaidMinor: null,
    });
    return true;
  }

  /**
   * S17 — reconcile every unit one payment has credit in (every window it drew
   * or holds a level change of, newest first) to its target at what the
   * payment still pays now (see the header). `take` only takes — a refund, a
   * dispute or a crypto refund never adds credit — and `both` also gives back
   * (a win). `onlyWindowIds` limits what is moved (the interim annual cap is
   * still shared out over every window). The unit a window's stand-alone cover
   * holds in the CURRENT window is left to `reconcileWindowUnits`, which
   * measures it on what stands beneath it.
   */
  async reconcilePaymentUnits(
    tx: CreditLedgerTx,
    accountId: string,
    coverage: { readonly source: CreditWindowSource; readonly sourceRef: string },
    terms: UnitPaymentTerms,
    opts: {
      readonly mode: 'take' | 'both';
      readonly event: CreditUnitEvent;
      readonly onlyWindowIds?: readonly string[];
      /**
       * Whether the payment stands on its own — a month's line, a crypto term,
       * an override — rather than an upgrade line that pays for the step above
       * the month beneath it. What such a payment holds in a window drawn from
       * ANOTHER payment is its share above that payment
       * (`reconcileWindowUnits`), not what it bought there.
       */
      readonly standsAlone: boolean;
    },
  ): Promise<UnitReconcileSummary> {
    const { windows } = this.deps;
    const earned = await windows.windowsOfCoverage(
      tx,
      accountId,
      coverage.source,
      coverage.sourceRef,
    );
    if (earned.length === 0) return NOTHING;
    const states: UnitState[] = [];
    for (const w of earned) states.push(await this.unitState(tx, accountId, w, coverage));
    const keeps = states.map((s) =>
      unitKeepMicro({
        amountPaidMinor: terms.amountPaidMinor,
        stillPaidMinor: terms.stillPaidMinor,
        terms: s.terms,
      }),
    );
    const paidForKeep =
      terms.paidForMicro === null
        ? null
        : floorMicroToWholeCredits(
            stillPaidShareMicro(terms.paidForMicro, terms.amountPaidMinor, terms.stillPaidMinor),
          );
    const allowed = allowedDebtByUnit(
      states.map((s, i) => ({ keepMicro: keeps[i] ?? 0, consumedMicro: spentForCapOf(s) })),
      paidForKeep,
    );

    const clawbacks: CreditClawbackRecord[] = [];
    let regranted = 0;
    let forgiven = 0;
    for (const [i, w] of earned.entries()) {
      const state = states[i] as UnitState;
      if (opts.onlyWindowIds !== undefined && !opts.onlyWindowIds.includes(w.id)) continue;
      if (opts.standsAlone && w.sourceRef !== coverage.sourceRef) continue;
      const target = unitTargetMicro(keeps[i] ?? 0, spentForCapOf(state), allowed[i] ?? null);
      const done = await this.reconcileUnit(tx, accountId, w, coverage, state, target, opts);
      if (done.clawback !== null) clawbacks.push(done.clawback);
      regranted = regranted + done.regrantedMicro;
      forgiven = forgiven + done.forgivenMicro;
    }
    return {
      windows: earned.length,
      clawbacks,
      regrantedMicro: regranted,
      forgivenMicro: forgiven,
    };
  }

  /**
   * S17 — the units of the CURRENT window whose target the facts may have
   * moved without their own payment moving: the stand-alone cover above the
   * window's own payment (its share rises when that payment is refunded or
   * disputed, and falls back when a dispute is won), and — on a refresh — each
   * payment of the window that a dispute stands against, once a new month or a
   * plan change has changed what it bought. `event` null is a refresh; an
   * event's own payment is `exclude`d (the event reconciled it already).
   */
  async reconcileWindowUnits(
    tx: CreditLedgerTx,
    accountId: string,
    input: { readonly event: CreditUnitEvent | null; readonly exclude: readonly string[] },
  ): Promise<void> {
    const { windows } = this.deps;
    const wc = await windows.windowCovers(tx, accountId);
    if (wc === null) return;
    const t = windowTargets(wc);
    const window = currentWindowOf(wc);
    const tag =
      input.event === null ? `rf${String(await windows.ledgerRowCount(tx, accountId))}` : null;

    if (input.event === null) {
      // A dispute standing against a payment of this window: a new month drawn,
      // or a plan change measured on the undisputed level, changed what that
      // payment bought here, so the dispute takes its share of the new amount.
      const refs = new Set<string>();
      if (wc.source === 'stripe_invoice') refs.add(wc.sourceRef);
      for (const c of t.line) if (c.source === 'stripe_invoice') refs.add(c.sourceRef);
      for (const ref of refs) {
        if (input.exclude.includes(ref)) continue;
        if (t.envelope !== null && t.envelope.cover.sourceRef === ref) continue;
        const payment = await windows.invoicePayment(tx, accountId, ref);
        if (payment === null || payment.disputedMinor === 0) continue;
        const dispute = (await windows.newestStandingDispute(tx, accountId, ref)) ?? 'standing';
        await this.reconcilePaymentUnits(
          tx,
          accountId,
          { source: 'stripe_invoice', sourceRef: ref },
          invoiceTerms(payment),
          {
            mode: 'both',
            event: {
              source: 'stripe_dispute',
              ref: `${dispute}:${tag ?? 'rf'}`,
              ledgerKind: 'refund_clawback',
              debtReason: 'payment_reversed',
              label: 'dispute',
            },
            onlyWindowIds: [wc.windowId],
            standsAlone: payment.lineKind !== 'proration_up',
          },
        );
      }
    }

    const env = t.envelope;
    if (env === null || input.exclude.includes(env.cover.sourceRef)) return;
    const coverage = { source: env.cover.source, sourceRef: env.cover.sourceRef };
    const state = await this.unitState(tx, accountId, window, coverage);
    // The stand-alone cover's share is not the disputed payment's: a take from
    // it carries no disputed amount, whatever event moved it.
    const event: CreditUnitEvent =
      input.event !== null
        ? { ...input.event, disputedMinor: undefined }
        : {
            source: 'plan_change',
            ref: `${wc.windowId}:${tag ?? 'rf'}`,
            ledgerKind: 'proration_clawback',
            debtReason: 'plan_change',
            label: 'plan_change',
          };
    await this.reconcileUnit(tx, accountId, window, coverage, state, env.keepMicro, {
      mode: 'both',
      event,
    });
  }

  /**
   * Bring one unit to `target` (see the header): take the difference when it
   * stands above, give it back — `both` only — when it stands below. A take
   * is recorded once per event and unit (the clawback's key); a give-back is
   * keyed to the event and the unit too, and rounded UP to whole credits (a
   * lot holds nothing else), the rounding then taken straight back so the unit
   * stands exactly at its target.
   */
  private async reconcileUnit(
    tx: CreditLedgerTx,
    accountId: string,
    window: SourcedCreditWindow,
    coverage: { readonly source: CreditWindowSource; readonly sourceRef: string },
    state: UnitState,
    target: number,
    opts: { readonly mode: 'take' | 'both'; readonly event: CreditUnitEvent },
  ): Promise<{
    clawback: CreditClawbackRecord | null;
    regrantedMicro: number;
    forgivenMicro: number;
  }> {
    const delta = positionOf(state) - target;
    if (delta > 0) {
      const clawback = await this.takeFromUnit(tx, accountId, state, delta, opts.event, '');
      return { clawback, regrantedMicro: 0, forgivenMicro: 0 };
    }
    if (delta === 0 || opts.mode === 'take') {
      return { clawback: null, regrantedMicro: 0, forgivenMicro: 0 };
    }
    const given = await this.giveBack(tx, accountId, state, -delta, opts.event);
    // The whole-credit rounding of what was given back, taken straight back.
    const after = await this.unitState(tx, accountId, window, coverage);
    const over = positionOf(after) - target;
    const trim =
      over > 0 ? await this.takeFromUnit(tx, accountId, after, over, opts.event, ':trim') : null;
    return {
      clawback: trim,
      regrantedMicro: given.regrantedMicro,
      forgivenMicro: given.forgivenMicro,
    };
  }

  private async takeFromUnit(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    amountMicro: number,
    event: CreditUnitEvent,
    suffix: string,
  ): Promise<CreditClawbackRecord> {
    const sourceRef = `${event.ref}${suffix}`;
    return this.clawBack(tx, accountId, {
      source: event.source,
      sourceRef,
      targetKey: state.targetKey,
      windowId: state.windowId,
      amountMicro,
      ledgerKind: event.ledgerKind,
      debtReason: event.debtReason,
      ledgerKeyPrefix: `clawback:${event.source}:${sourceRef}:${state.targetKey}`,
      targets: state.lots,
      disputedMinor: suffix === '' ? (event.disputedMinor ?? null) : null,
    });
  }

  /**
   * Give `amountMicro` back to one unit, in the order the charge was made
   * beyond its lots and then into them — each part to the very lot it came
   * out of, so the account a give-back leaves is the one it would have held
   * had the charge never been made (the lots, not only their sum, and so the
   * order credit is spent in):
   *
   *   1. its standing claims on held credit are released;
   *   2. the debt its clawbacks created is forgiven, as far as the account
   *      still owes it;
   *   3. what later credit already repaid of that debt — and what its claims
   *      collected from other lots — goes back into the lots that paid it, as
   *      long as they last at least to the end of the account's current month;
   *      otherwise it comes back as a lot of its own lasting the LONGER of the
   *      two (S17 R1: a top-up's credit keeps the top-up's term), and not at all
   *      when both are already past (logged: nothing was lost that would not
   *      have been);
   *   4. the rest — credit the unit's own lots gave up — goes back into those
   *      lots, while the month runs. A month that has ENDED gets nothing of it
   *      back: it would have expired with the month (M6).
   *
   * A lot of its own holds whole credits only, so it is rounded UP; the caller
   * takes the rounding straight back.
   */
  private async giveBack(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    amountMicro: number,
    event: CreditUnitEvent,
  ): Promise<{ regrantedMicro: number; forgivenMicro: number }> {
    const { ledger, windows } = this.deps;
    const ref = `${state.targetKey}:${event.ref}`;
    let left = amountMicro;

    for (const c of state.clawbacks) {
      if (left <= 0) break;
      if (c.state !== 'applied' || c.pendingMicro <= 0) continue;
      const release = Math.min(left, c.pendingMicro);
      await windows.releasePendingClaim(tx, c.id, release);
      left = left - release;
    }

    let charged = state.collectedElsewhereMicro - state.releasedMicro;
    for (const c of state.clawbacks) charged = charged + c.debtMicro;
    charged = Math.max(0, charged);

    let forgivenMicro = 0;
    const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
    const forgive = Math.min(left, charged, owed);
    if (forgive > 0) {
      await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          forgiveDebtMicro: forgive,
          idempotencyKey: `${reinstateGrantKey(ref)}:forgive`,
          reason: event.label,
        },
        tx,
      );
      forgivenMicro = forgive;
      left = left - forgive;
      charged = charged - forgive;
    }

    let regrantedMicro = 0;
    const repaid = Math.min(left, charged);
    if (repaid > 0) {
      regrantedMicro =
        regrantedMicro + (await this.returnRepaid(tx, accountId, state, repaid, ref, event));
      left = left - repaid;
    }
    if (left > 0 && state.live) {
      regrantedMicro =
        regrantedMicro + (await this.restoreTaken(tx, accountId, state, left, ref, event));
    }
    return { regrantedMicro, forgivenMicro };
  }

  /**
   * Step 3 of a give-back: `micro` of the unit's charge that other credit
   * already paid — a claim collected from another lot, or debt a later lot
   * repaid (the account's newest repayments) — back into the lots that paid it.
   */
  private async returnRepaid(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    micro: number,
    ref: string,
    event: CreditUnitEvent,
  ): Promise<number> {
    const { ledger, windows } = this.deps;
    const sources: { lotId: string; micro: number }[] = [...state.collectedElsewhere];
    let listed = 0;
    for (const s of sources) listed = listed + s.micro;
    if (listed < micro) {
      for (const r of await windows.recentDebtRepayments(tx, accountId, 100)) {
        if (listed >= micro) break;
        sources.push({ lotId: r.lotId, micro: r.micro });
        listed = listed + r.micro;
      }
    }
    const lots = new Map(
      (await windows.lotsForReturn(tx, accountId, [...new Set(sources.map((s) => s.lotId))])).map(
        (l) => [l.lotId, l],
      ),
    );
    const month = await windows.currentWindow(accountId, tx);
    const monthEnd = month?.windowEnd ?? null;
    const into = new Map<string, number>();
    let left = micro;
    let lasts: PgInstant | null = monthEnd;
    for (const s of sources) {
      if (left <= 0) break;
      const lot = lots.get(s.lotId);
      if (lot === undefined) continue;
      const want = Math.min(left, s.micro);
      const already = into.get(s.lotId) ?? 0;
      // Back into the lot only while it lasts at least as long as the month:
      // otherwise the longer of the two is the month, and the credit comes
      // back as a lot of its own (below).
      const fits =
        lot.live && (monthEnd === null || lot.expiresAt >= monthEnd)
          ? Math.max(0, Math.min(want, lot.roomMicro - already))
          : 0;
      if (fits > 0) {
        into.set(s.lotId, already + fits);
        left = left - fits;
      }
      if (fits < want) lasts = laterOf(lasts, lot.expiresAt);
    }
    let given = 0;
    for (const [lotId, amount] of into) {
      await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          lotId,
          lotDeltaMicro: amount,
          idempotencyKey: `${returnedGrantKey(ref)}:${lotId}`,
          reason: event.label,
        },
        tx,
      );
      given = given + amount;
    }
    if (left > 0) {
      if (lasts === null || lasts <= pgInstantOf(this.now())) {
        this.deps.logger?.warn(
          { component: 'credit-grants', event: 'returned_credit_already_expired', accountId },
          'debt repaid from credit that has since expired was not returned; no month is running to hold it',
        );
      } else {
        given =
          given +
          (await this.grantLot(tx, accountId, returnedGrantKey(ref), left, lasts, event.label));
      }
    }
    return given;
  }

  /**
   * Step 4 of a give-back: `micro` of credit back into the unit's own lots
   * that gave it up, the lot taken from last first, each no more than was
   * taken out of it; anything left over (none, while every grant the unit
   * keeps came from those lots) as a lot of its own for the rest of the month.
   */
  private async restoreTaken(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    micro: number,
    ref: string,
    event: CreditUnitEvent,
  ): Promise<number> {
    const { ledger } = this.deps;
    let left = micro;
    let given = 0;
    for (const lot of state.lots) {
      if (left <= 0) break;
      if (lot.expiresAt <= pgInstantOf(this.now())) continue;
      const fits = Math.min(left, lot.takenMicro, lot.grantedMicro - lot.remainingMicro);
      if (fits <= 0) continue;
      await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          lotId: lot.lotId,
          lotDeltaMicro: fits,
          idempotencyKey: `${reinstateGrantKey(ref)}:${lot.lotId}`,
          reason: event.label,
        },
        tx,
      );
      given = given + fits;
      left = left - fits;
    }
    if (left > 0) {
      given =
        given +
        (await this.grantLot(
          tx,
          accountId,
          reinstateGrantKey(ref),
          left,
          state.windowEnd,
          event.label,
        ));
    }
    return given;
  }

  /** One given-back lot of `micro`, raised to whole credits, funded once. */
  private async grantLot(
    tx: CreditLedgerTx,
    accountId: string,
    grantKey: string,
    micro: number,
    expiresAt: PgInstant,
    reason: string,
  ): Promise<number> {
    if (micro <= 0) return 0;
    const { ledger } = this.deps;
    const amount = ceilMicroToWholeCredits(micro);
    const inserted = await ledger.insertLot(
      {
        accountId,
        kind: 'adjustment',
        grantKey,
        grantedMicro: amount,
        startsAt: floorToPriorMinute(this.now()),
        expiresAt: new Date(expiresAt),
      },
      tx,
    );
    if (!inserted.inserted) return 0;
    await ledger.append(
      {
        accountId,
        kind: 'grant',
        lotId: inserted.lot.id,
        amountMicro: amount,
        idempotencyKey: `${grantKey}:grant`,
        reason,
      },
      tx,
    );
    return amount;
  }

  /**
   * Read one unit: its lots (locked), the level changes that make up its
   * target, the clawbacks charged against it, what they collected elsewhere,
   * and the debt a reconciliation already forgave it.
   */
  private async unitState(
    tx: CreditLedgerTx,
    accountId: string,
    window: {
      readonly id: string;
      readonly sourceRef: string;
      readonly windowEnd: PgInstant;
      readonly current: boolean;
    },
    coverage: { readonly source: CreditWindowSource; readonly sourceRef: string },
  ): Promise<UnitState> {
    const { windows } = this.deps;
    const targetKey = unitTargetKey(window.id, coverage.sourceRef);
    const givebackPrefix = unitGivebackPrefix(targetKey);
    const steps = await windows.unitSteps(tx, accountId, window.id, coverage.sourceRef);
    const planChangeRefs = steps
      .filter((s) => s.reason === 'plan_change')
      .map((s) => `${window.id}:${String(s.seq)}`);
    const clawbacks = await windows.unitClawbacks(tx, accountId, {
      windowId: window.id,
      targetKey,
      planChangeRefs,
    });
    const ownIds = clawbacks.map((c) => c.id);
    const drawnFromUnit = window.sourceRef === coverage.sourceRef;
    const lots = await windows.unitLots(tx, accountId, {
      windowId: window.id,
      drawnFromUnit,
      prorationKeys: steps.map((s) => prorationGrantKey(window.id, s.seq)),
      givebackPrefix,
      ownClawbackIds: ownIds,
    });
    const lotIds = new Set(lots.map((l) => l.lotId));
    let collectedElsewhere = 0;
    const elsewhere = new Map<string, number>();
    for (const claim of await windows.collectedClaims(tx, accountId, ownIds)) {
      if (lotIds.has(claim.lotId)) continue;
      collectedElsewhere = collectedElsewhere + claim.micro;
      elsewhere.set(claim.lotId, (elsewhere.get(claim.lotId) ?? 0) + claim.micro);
    }
    const released = await windows.unitReleasedMicro(tx, accountId, givebackPrefix, [...lotIds]);
    const terms: UnitKeepTerm[] = [];
    if (drawnFromUnit) {
      const monthly = lots.find((l) => l.kind === 'monthly');
      if (monthly !== undefined) {
        terms.push({ micro: monthly.grantedMicro, stillPaidAtMinor: monthly.stillPaidMinor });
      }
    }
    for (const s of steps) {
      if (s.reason !== 'plan_change' || s.deltaMicro === 0) continue;
      terms.push({ micro: s.deltaMicro, stillPaidAtMinor: s.stillPaidMinor });
    }
    return {
      windowId: window.id,
      windowEnd: window.windowEnd,
      live: window.current,
      coverageRef: coverage.sourceRef,
      targetKey,
      lots,
      clawbacks,
      collectedElsewhereMicro: collectedElsewhere,
      collectedElsewhere: [...elsewhere].map(([lotId, micro]) => ({ lotId, micro })),
      releasedMicro: released,
      terms,
    };
  }

  /**
   * Take credits back from the lots of one window, and record what happened.
   * Shared: a mid-month downgrade calls it, and so does every reversal and
   * reconciliation (S17), which differ only in what they claw and why the debt
   * is owed.
   *
   * ⛔ COUNTED ONCE, BY THE RECORD RATHER THAN BY THE CALLER. The first thing
   * it does is look for its own row under `(source, source_ref, target_key)`; a
   * clawback that has already been applied returns that row and takes nothing
   * more. That is what makes a redelivered refund event, or a second pass over
   * the same plan change, safe.
   *
   * The arithmetic is `planClawbackOfAmount`, which is where the rules about
   * expired, spent and held credit live. What comes out of the lots is one
   * ledger row per lot; what is owed after that is one `debt_incurred` row; and
   * then the account's debt is paid down from whatever free credit it has left,
   * because the database refuses to COMMIT debt beside spendable credit.
   *
   * ⛔ THE PENDING CLAIM IS ASKED OF HELD CREDIT NO CLAIM ALREADY STANDS
   * AGAINST. `pending_micro` is the part of the shortfall that credits held by
   * running tasks cover, and a settlement pays it from the credit it releases.
   * Held credit is therefore a FINITE pot that earlier claims have already drawn
   * on: asking for it twice would let two claims stand over one credit, and at
   * settlement only one of them could be paid — the other silently becoming
   * nothing, or debt for credit the first claim had taken. So what earlier
   * clawbacks are still owed is subtracted before this one asks.
   */
  async clawBack(
    tx: CreditLedgerTx,
    accountId: string,
    input: CreditClawbackKey & {
      /** The window whose lots are clawed, newest lot first. */
      readonly windowId: string;
      readonly amountMicro: number;
      /**
       * The kind of ledger row each lot's loss is written as: `proration_clawback`
       * for a plan change, `refund_clawback` for a refund or a dispute (S17).
       */
      readonly ledgerKind: 'proration_clawback' | 'refund_clawback';
      readonly debtReason: AiDebtReason;
      /**
       * S17 — the prefix every ledger row of this clawback is keyed under.
       * Absent, it is `clawback:<source>:<source_ref>`, which a plan change
       * (one window per source reference) keys everything by. A reversal
       * claws SEVERAL units under one source reference, and each unit's `debt`
       * row needs a key of its own, so a reversal passes a prefix that names
       * the unit.
       */
      readonly ledgerKeyPrefix?: string;
      /**
       * S17 — the lots to take from, newest first, when they are not simply
       * every lot of the window: a reversal takes only the lots of the unit it
       * reconciles, read under the same lock just before this call. Absent, it
       * is every lot of the window, which is what a plan change takes from.
       */
      readonly targets?: readonly ClawbackTargetLot[];
      /** 0139 — the disputed amount, on a row a dispute writes under its own id. */
      readonly disputedMinor?: number | null;
    },
  ): Promise<CreditClawbackRecord> {
    const { ledger, windows } = this.deps;
    const already = await windows.findClawback(tx, input);
    if (already !== null) return already;
    const keyOf = (suffix: string): string =>
      input.ledgerKeyPrefix !== undefined
        ? `${input.ledgerKeyPrefix}:${suffix}`
        : clawbackLedgerKey(input, suffix);

    const lots = input.targets ?? (await windows.clawbackTargets(tx, accountId, input.windowId));
    const heldTotal = await ledger.heldMicro(accountId, tx);
    const standingClaims = await windows.pendingClaimTotalMicro(tx, accountId);
    const claimable = Math.max(0, heldTotal - standingClaims);
    const plan = planClawbackOfAmount(lots, input.amountMicro, claimable);

    for (const take of plan.takes) {
      await ledger.append(
        {
          accountId,
          kind: input.ledgerKind,
          lotId: take.lotId,
          amountMicro: take.micro,
          idempotencyKey: keyOf(take.lotId),
          reason: input.source,
        },
        tx,
      );
    }
    if (plan.debtMicro > 0) {
      await ledger.append(
        {
          accountId,
          kind: 'debt_incurred',
          amountMicro: plan.debtMicro,
          reason: input.debtReason,
          idempotencyKey: keyOf('debt'),
        },
        tx,
      );
    }
    const record = await windows.insertClawback(tx, {
      accountId,
      source: input.source,
      sourceRef: input.sourceRef,
      targetKey: input.targetKey,
      amountMicro: input.amountMicro,
      clawedMicro: plan.clawedMicro,
      pendingMicro: plan.pendingMicro,
      debtMicro: plan.debtMicro,
      disputedMinor: input.disputedMinor ?? null,
    });
    await ledger.settleDebtFromFree(tx, accountId);
    return record;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async armWindowBoundary(accountId: string, windowEnd: PgInstant | null): Promise<void> {
    const scheduledJobs = this.deps.scheduledJobs;
    if (scheduledJobs === undefined || windowEnd === null) return;
    try {
      await enqueueNextCreditsWindowBoundary({ scheduledJobs, accountId, windowEnd });
    } catch (err) {
      this.deps.logger?.error?.(
        {
          component: 'credit-grants',
          event: 'credits_window_boundary_not_armed',
          accountId,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'the window-boundary job could not be armed — the coverage sweep grants the next month instead',
      );
    }
  }

  /** One coverage-sweep tick: refresh every account that is owed a window, one at a time. */
  sweepCoverage(opts: {
    afterAccountId: string | null;
    limit: number;
  }): Promise<CreditSweepResult> {
    return this.sweep(opts, (o) => this.deps.windows.accountsOwedAWindow(o), 'coverage');
  }

  /**
   * One expiry-sweep tick: refresh every account holding expired credit, ONE AT
   * A TIME, each in its own transaction under its own credit lock — never one
   * statement over many accounts, which would hold all their locks at once and
   * write ledger rows for accounts it never locked.
   */
  sweepExpiry(opts: { afterAccountId: string | null; limit: number }): Promise<CreditSweepResult> {
    return this.sweep(opts, (o) => this.deps.windows.accountsWithDueLots(o), 'expiry');
  }

  private async sweep(
    opts: { afterAccountId: string | null; limit: number },
    find: (o: { afterAccountId: string | null; limit: number }) => Promise<string[]>,
    what: 'coverage' | 'expiry',
  ): Promise<CreditSweepResult> {
    const accountIds = await find(opts);
    let granted = 0;
    let expired = 0;
    let failed = 0;
    for (const accountId of accountIds) {
      try {
        const result = await this.refreshCredits(accountId);
        if (result.window.outcome === 'created') granted = granted + 1;
        if (result.expired.length > 0) expired = expired + 1;
      } catch (err) {
        failed = failed + 1;
        this.deps.logger?.error?.(
          {
            component: 'credit-grants',
            event: 'credits_sweep_account_failed',
            sweep: what,
            accountId,
            err: { message: err instanceof Error ? err.message : String(err) },
          },
          'a credits sweep could not refresh one account — moving on to the next',
        );
      }
    }
    const last = accountIds[accountIds.length - 1];
    return {
      visited: accountIds.length,
      granted,
      expired,
      failed,
      // A full batch: more may be waiting past the last one. A short batch
      // reached the end, and the next walk starts over.
      nextAfterAccountId: accountIds.length >= opts.limit && last !== undefined ? last : null,
    };
  }
}

/** The current window, as a unit read names it. */
function currentWindowOf(wc: WindowCovers): SourcedCreditWindow {
  return {
    id: wc.windowId,
    sourceRef: wc.sourceRef,
    levelMicro: wc.levelMicro,
    levelSeq: wc.levelSeq,
    windowStart: wc.nowAt,
    windowEnd: wc.windowEnd,
    current: true,
  };
}

/**
 * What a Stripe payment still pays and bought, as a unit's target reads it:
 * refunds and standing disputes taken off.
 */
export function invoiceTerms(payment: InvoicePaymentFacts): UnitPaymentTerms {
  return {
    amountPaidMinor: payment.amountPaidMinor,
    stillPaidMinor: Math.max(
      0,
      payment.amountPaidMinor - payment.refundedMinor - payment.disputedMinor,
    ),
    paidForMicro: paidForMicro(payment),
  };
}

/** `floor(micro × still / paid)`, exact; a payment of nothing keeps everything. */
function stillPaidShareMicro(micro: number, paidMinor: number, stillMinor: number): number {
  if (paidMinor === 0) return micro;
  return Number((BigInt(micro) * BigInt(Math.min(stillMinor, paidMinor))) / BigInt(paidMinor));
}

/** A Date as the microsecond UTC text the windows repo hands the database. */
function pgInstantOf(at: Date): PgInstant {
  return `${at.toISOString().slice(0, -1)}000Z`;
}

/**
 * Whether this deployment runs monthly grants at all. Bootstrap constructs the
 * grants service only when this says so, and leaves it NULL otherwise; every
 * caller and every job registration hangs off that one value. So `off` means
 * nothing new runs anywhere, by construction rather than by each call site
 * remembering to ask. `shadow` and `enforce` grant alike: they differ in how AI
 * turns are paid for, which is not decided here.
 */
export function creditGrantsRun(mode: AiCreditsMode): boolean {
  return mode !== 'off';
}

/** Where a refresh was triggered from. A closed set, so it is safe as a tag. */
export type CreditsRefreshTrigger =
  | 'stripe_webhook'
  | 'crypto_activation'
  | 'crypto_refund'
  | 'admin_tier_change'
  /** The lazy refresh a task does inside `reserve`, under a savepoint (H5). */
  | 'task_reserve';

/**
 * Record a refresh that failed, in the log and in the error reporter.
 *
 * ⛔ THE ALERT CARRIES THE TRIGGER AND NOTHING ELSE: no account, no invoice, no
 * amount. The account id is in the log line beside it, which is where customer
 * data is allowed to be.
 */
export function reportCreditsRefreshFailed(
  err: unknown,
  accountId: string,
  opts: {
    trigger: CreditsRefreshTrigger;
    message: string;
    logger?: { error?: (obj: Record<string, unknown>, msg: string) => void } | null;
    sentry?: Pick<SentryClient, 'captureMessage'> | null;
  },
): void {
  opts.logger?.error?.(
    {
      component: 'credit-grants',
      event: 'ai_credits_refresh_failed',
      trigger: opts.trigger,
      accountId,
      err:
        err instanceof Error
          ? { name: err.name, message: err.message, cause: err.cause }
          : { value: err },
    },
    opts.message,
  );
  try {
    opts.sentry?.captureMessage({
      message:
        'Refreshing an account’s AI credits failed after a billing change. ' +
        'Find the account id in the server log; the coverage sweep retries it.',
      level: 'error',
      fingerprint: ['billing', 'ai_credits_refresh_failed', opts.trigger],
      tags: { kind: 'ai_credits_refresh_failed', trigger: opts.trigger },
      extra: { trigger: opts.trigger },
    });
  } catch {
    // Fire-and-forget, like every Sentry call.
  }
}

/**
 * Refresh an account's credits after something that may have changed its paid
 * coverage. Does nothing when `refresher` is null (AI credits are off).
 *
 * The caller's own work is already committed by the time this runs, and the
 * refresh is idempotent. So:
 *   · a TRANSIENT failure (the database blinked) is re-thrown when the caller
 *     says its sender retries (`rethrowTransient`: a Stripe event is redelivered,
 *     and the retry repeats nothing that was already done);
 *   · every other failure is logged, alerted and SWALLOWED. It must not turn a
 *     handled billing event into a failed one, or fail an admin action that has
 *     already happened; the coverage sweep retries the account within minutes.
 *
 * The alert carries the trigger and nothing else: no account, no invoice. The
 * account id is in the log line beside it.
 */
export async function refreshCreditsAfter(
  refresher: CreditsRefresher | null | undefined,
  accountId: string,
  opts: {
    trigger: CreditsRefreshTrigger;
    rethrowTransient: boolean;
    logger?: { error?: (obj: Record<string, unknown>, msg: string) => void } | null;
    sentry?: Pick<SentryClient, 'captureMessage'> | null;
  },
): Promise<void> {
  if (refresher === null || refresher === undefined) return;
  try {
    await refresher.refreshCredits(accountId);
  } catch (err) {
    if (opts.rethrowTransient && isTransientInfraError(err)) throw err;
    reportCreditsRefreshFailed(err, accountId, {
      trigger: opts.trigger,
      message:
        'refreshing AI credits failed — what triggered it stands; the coverage sweep retries',
      logger: opts.logger,
      sentry: opts.sentry,
    });
  }
}
