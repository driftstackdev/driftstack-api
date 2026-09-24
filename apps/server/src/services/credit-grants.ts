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
// ⛔ REVERSAL POLICY v2 (design-reversal-policy-v2.md, 2026-09-24, with its
// amendments R-A to R-F). A refund, a dispute or a crypto refund ONLY TAKES
// (rule 1): `reconcileUnit` brings a unit's position — what its LIVE lots
// still hold, what left them on the customer's work, less what its STANDING
// clawbacks charged beyond it — down to its target: free credit first, then
// credit a running task holds ON THAT UNIT'S OWN LOTS as a claim, and only
// what was spent beyond the worth as debt. A claim is paid only from what a
// task releases back into the unit's own lots (rule 4, credit-reservations.ts);
// left unpaid, a monthly payment's becomes debt and an annual payment's is
// dropped (rule 3), the drop still counting as charged.
//
// A WON DISPUTE DOES NOT REPLAY HISTORY (rule 6). Its clawbacks are reversed
// with their claims, its debt still owed is forgiven, and everything else it
// removed comes back (`returnWhatADisputeRemoved`): credit its takes and
// claims took from the unit's lots, and debt other credit repaid. Each part
// goes back INTO the lot it came from while that lot is valid and lasts at
// least as long as every lot the customer used or held while the dispute
// stood (R-A); otherwise it comes back as ONE NEW LOT, valid until the latest
// of the end of the current month, the expiry of the lots it came from and of
// every lot used or held meanwhile (a month from the win when none of those is
// in the future). Credit taken from a lot that has since ended comes back only
// when the customer used or held some OTHER lot while the dispute stood (R-G).
// What the dispute took from the won payment's lots belongs to the won payment
// (R-D); what repaid its debt belongs to the payment whose credit repaid it,
// and goodwill's to none (R-F). A later take never takes such a new lot first:
// what it would take there is debt, settled at once in the spend order (R-I).
// Then rule 1 is re-applied to the won payment in BOTH directions at its new
// still-paid share: claims released first, then debt forgiven or returned the
// same way. Every
// difference from the twin that never saw the dispute is a stated, one-sided
// bound in the customer's favour (§1, B1–B4).
//
// ⛔ THE INTERIM ANNUAL CAP IS FROZEN AT EACH REVERSAL, AND IS AN ANNUAL
// PAYMENT'S ONLY (R8, 0140; R-C). What the payment's credit had been spent —
// plus what running tasks held — when the refund or dispute was measured is
// recorded on its rows, and every later reconciliation (a win, a refresh)
// uses the newest standing reversal's figure: a later spend or a later win
// does not move what may be owed. A monthly payment has no cap: it follows
// rule 1 exactly, its worth following its plan changes.
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
  CreditLegacyDisputeError,
  parseUnitTargetKey,
  prorationGrantKey,
  unitGivebackPrefix,
  unitTargetKey,
  type AccountClawback,
  type ClawbackTargetLot,
  type LedgerDebtEvent,
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
 *
 * ⛔ A LOT A WON DISPUTE RETURNED IS NOT TAKEN FROM DIRECTLY (reversal policy
 * v2, R-I). Its term stands in for spending the dispute displaced onto
 * longer-lived credit (R-A), so taking it first would take long-lived credit
 * before short-lived. Such a lot (`returned`) counts toward what the lots ever
 * held — the take is not smaller for it — but gives nothing to the walk: what
 * would have come out of it is charged as DEBT, which the caller's settlement
 * repays at once from the account's free credit in the spend order,
 * soonest-expiring first (R-I: "equivalent to charging it as debt and
 * settling at once"). Running tasks' claims come first, as for any debt.
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
    if (lot.returned === true) continue;
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
  /**
   * S17 R8 — what the payment's credit had been spent (and held) across ALL
   * its windows when the standing reversal was measured: the cap is frozen
   * there, so a later spend or a later win does not move it. Absent, it is
   * what the units have spent now.
   */
  capSpentMicro?: number,
): (number | null)[] {
  if (paidForKeepMicro === null) return units.map(() => null);
  let spent = 0;
  for (const u of units) spent = spent + u.consumedMicro;
  if (capSpentMicro !== undefined) spent = capSpentMicro;
  let left = Math.max(0, spent - paidForKeepMicro);
  return units.map((u) => {
    const shortfall = Math.max(0, u.consumedMicro - u.keepMicro);
    const allowed = Math.min(shortfall, left);
    left = left - allowed;
    return allowed;
  });
}

/** What became of the debt one clawback wrote (`debtFates`). */
export interface ClawbackDebtFate {
  /** Every debt row it wrote: its own shortfall, and claims that became debt at a settle. */
  readonly incurredMicro: number;
  /** What the account still owes of it. */
  readonly outstandingMicro: number;
  /** What later credit repaid of it, lot by lot, in the order it was repaid, with the row. */
  readonly repaid: readonly {
    readonly lotId: string;
    readonly micro: number;
    readonly rowId: number;
    readonly at: PgInstant;
  }[];
  /** What a reconciliation of its own unit (or the undoing of it) forgave. */
  readonly forgivenSelfMicro: number;
  /** What anything else forgave — an admin's `forgive_debt`, say. */
  readonly forgivenOtherMicro: number;
}

/** `reinstate:window:<window>:<coverage>:undo:<clawback>:…` — a won dispute undoing one clawback. */
const UNDO_KEY =
  /^reinstate:window:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[^:]+:undo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;
/** `reinstate:window:<window>:<coverage>:…` — a reconciliation of one unit. */
const UNIT_GIVEBACK_KEY =
  /^reinstate:(window:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[^:]+):/;

/** One chunk of debt, as `followDebt` walks the account's debt oldest first. */
interface DebtChunk {
  readonly owner: string | null;
  readonly unit: string | null;
  readonly incurred: number;
  outstanding: number;
  readonly repaid: { lotId: string; micro: number; rowId: number; at: PgInstant }[];
  forgivenSelf: number;
  forgivenOther: number;
}

/** The walk behind `debtFates`: every chunk of debt, and what became of it. */
function followDebt(
  events: readonly LedgerDebtEvent[],
  clawbacks: readonly AccountClawback[],
  unitOf: ReadonlyMap<string, string>,
): DebtChunk[] {
  const byKey = new Map<string, AccountClawback>();
  const byId = new Map<string, AccountClawback>();
  for (const c of clawbacks) {
    byKey.set(`clawback:${c.source}:${c.sourceRef}:${c.targetKey}:debt`, c);
    byKey.set(`clawback:${c.source}:${c.sourceRef}:debt`, c);
    byId.set(c.id, c);
  }
  const chunks: DebtChunk[] = [];
  const reduce = (
    pool: readonly DebtChunk[],
    amount: number,
    apply: (c: DebtChunk, micro: number) => void,
  ): number => {
    let left = amount;
    for (const c of pool) {
      if (left <= 0) break;
      const take = Math.min(left, c.outstanding);
      if (take <= 0) continue;
      c.outstanding = c.outstanding - take;
      apply(c, take);
      left = left - take;
    }
    return left;
  };
  for (const e of events) {
    if (e.debtDeltaMicro > 0) {
      const claim = /^claim_debt:([^:]+):/.exec(e.key);
      const owner =
        claim !== null ? (byId.get(claim[1] ?? '') ?? null) : (byKey.get(e.key) ?? null);
      const unit =
        owner === null
          ? null
          : (unitOf.get(owner.id) ??
            (owner.targetKey.split(':').length === 3 ? owner.targetKey : null));
      chunks.push({
        owner: owner?.id ?? null,
        unit,
        incurred: e.debtDeltaMicro,
        outstanding: e.debtDeltaMicro,
        repaid: [],
        forgivenSelf: 0,
        forgivenOther: 0,
      });
      continue;
    }
    const amount = -e.debtDeltaMicro;
    if (e.lotId !== null) {
      const lotId = e.lotId;
      reduce(chunks, amount, (c, micro) => {
        c.repaid.push({ lotId, micro, rowId: e.id, at: e.at });
      });
      continue;
    }
    const undo = UNDO_KEY.exec(e.key);
    const unit = UNIT_GIVEBACK_KEY.exec(e.key);
    let left = amount;
    if (undo !== null) {
      left = reduce(
        chunks.filter((c) => c.owner === undo[1]),
        left,
        (c, micro) => {
          c.forgivenSelf = c.forgivenSelf + micro;
        },
      );
    } else if (unit !== null) {
      left = reduce(
        chunks.filter((c) => c.unit === unit[1]),
        left,
        (c, micro) => {
          c.forgivenSelf = c.forgivenSelf + micro;
        },
      );
    }
    reduce(chunks, left, (c, micro) => {
      c.forgivenOther = c.forgivenOther + micro;
    });
  }
  return chunks;
}

/**
 * S17 audit 4 (R9, R1') — follow the account's debt, oldest first, to say what
 * became of each clawback's: still owed, repaid out of which lots, or forgiven
 * — by the clawback's own unit (a give-back) or by anything else. Pure.
 *
 * Debt is one figure on the account, so a repayment names no debt. It is
 * taken to pay the OLDEST debt still owed, which is the order every repayment
 * is made in (`settleDebtFromFree` runs after each movement that adds credit or
 * debt). A forgiveness keyed to a unit, or to one clawback's undoing, lowers
 * that unit's (that clawback's) debt, oldest first; any other forgiveness is
 * taken oldest first, like a repayment. A debt row names its clawback by its
 * key (`clawback:<source>:<ref>[:<target>]:debt`, `claim_debt:<clawback>:…`);
 * one that names none is still counted, so the order stays whole.
 */
export function debtFates(
  events: readonly LedgerDebtEvent[],
  clawbacks: readonly AccountClawback[],
  /** The unit a clawback's debt belongs to when its target does not say (a plan change's). */
  unitOf: ReadonlyMap<string, string> = new Map(),
): Map<string, ClawbackDebtFate> {
  const chunks = followDebt(events, clawbacks, unitOf);
  const fates = new Map<string, ClawbackDebtFate>();
  for (const c of chunks) {
    if (c.owner === null) continue;
    const had = fates.get(c.owner);
    fates.set(c.owner, {
      incurredMicro: (had?.incurredMicro ?? 0) + c.incurred,
      outstandingMicro: (had?.outstandingMicro ?? 0) + c.outstanding,
      repaid: [...(had?.repaid ?? []), ...c.repaid],
      forgivenSelfMicro: (had?.forgivenSelfMicro ?? 0) + c.forgivenSelf,
      forgivenOtherMicro: (had?.forgivenOtherMicro ?? 0) + c.forgivenOther,
    });
  }
  return fates;
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
 * What the payment bought, in microcredits, for the interim cap — which binds
 * ANNUAL payments only (reversal policy v2, R-C): a yearly PERIOD line's plan
 * allowance × 12; an ANNUAL UPGRADE line's step up `(upper − from)` × the
 * calendar months its line spans (re-audit #8). Null — no cap: the payment
 * follows rule 1 exactly, debt being what was spent beyond each month's worth,
 * its worth following its plan changes — for a MONTHLY line of either kind,
 * a line on a plan with no plan-wide allowance, or one whose interval or
 * period is unknown. (A monthly period line was capped at its allowance until
 * R-C, which measured a downgraded month against the plan it no longer had.)
 */
export function paidForMicro(payment: InvoicePaymentFacts): number | null {
  if (payment.lineTier === null) return null;
  const tier = AccountTierSchema.safeParse(payment.lineTier);
  if (!tier.success || !Object.hasOwn(AI_PLAN_ENTITLEMENTS, tier.data)) return null;
  const monthly = planMonthlyCreditsMicro(tier.data);
  if (monthly === null || monthly <= 0) return null;
  if (payment.lineKind === 'period') {
    return payment.lineInterval === 'year' ? monthly * 12 : null;
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
 * The key of a lot a give-back makes for credit that cannot go back into the
 * lot it came from (`reinstate:<unit>:<event>:returned`): a lot of its own,
 * with a term of its own (reversal policy v2, rule 6). The suffix keeps it
 * apart from the event's other give-back lot.
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

/** What a reconciliation records on every clawback it writes (0140). */
interface ClawbackExtras {
  /**
   * The interim cap's consumption it was measured on (R8); null when the
   * payment has no cap — every payment but an annual one (R-C). A claim whose
   * clawback carries one is an annual payment's, and is dropped rather than
   * charged when a task spends what it claimed (rule 3).
   */
  readonly capSpentMicro: number | null;
  /** The account's newest ledger row id when it was measured. */
  readonly ledgerMark: number;
}

/** What a reconciliation of one payment's units did. */
export interface UnitReconcileSummary {
  /** How many windows the payment has credit in. */
  readonly windows: number;
  /** The clawbacks the event wrote (takes), one per unit that gave anything up. */
  readonly clawbacks: readonly CreditClawbackRecord[];
  /** Credit given back as lots or into lots (the month's give-back and returned debt). */
  readonly regrantedMicro: number;
  /** Debt forgiven. */
  readonly forgivenMicro: number;
  /**
   * S17 R8 — the interim cap's consumption this reconciliation measured on
   * (frozen for a reversal, the standing reversal's otherwise); null when the
   * payment has no cap.
   */
  readonly capSpentMicro: number | null;
}

/**
 * Reversal policy v2, rule 6 — what a won dispute's give-backs measure a
 * returned lot's term by, read once per win (`wonDisputeReturn`).
 */
export interface WonDisputeReturn {
  /** The win's reference (`<dispute>:won`): what the lots it makes are keyed by. */
  readonly ref: string;
  /**
   * The latest expiry of any lot the customer used or held while the dispute
   * stood; null when none. Credit goes back into the lot it came from only when
   * that lot lasts at least this long (R-A), and a new lot lasts at least this
   * long.
   */
  readonly usedExpiry: PgInstant | null;
  /**
   * The lots the customer used or held while the dispute stood (R-G): credit
   * the dispute took from a lot that has since ended comes back only when
   * one of them is ANOTHER lot — spending was displaced.
   */
  readonly usedLots: readonly string[];
  /** The end of the window containing now(); null when none does. */
  readonly windowEnd: PgInstant | null;
  /** The database's clock. */
  readonly now: PgInstant;
  /** A month from now: a new lot's term when nothing else is in the future. */
  readonly monthOn: PgInstant;
}

/** One part of credit a give-back returns, and the key its row is written under. */
interface ReturnPart {
  /** The lot it came from. */
  readonly lotId: string;
  readonly micro: number;
  /** Its row's key before the marker and lot: `reinstate:<unit>:<event>`, or `…:undo:<clawback>`. */
  readonly key: string;
  /**
   * `''`: credit a take (or a claim) removed from the unit's own lots — its
   * return restores what was taken. `returned:`: debt the lot repaid.
   * `unclaimed:`: a claim the lot paid. Each of the last two undoes spending of
   * the lot it came from.
   */
  readonly marker: '' | 'returned:' | 'unclaimed:';
}

const NOTHING: UnitReconcileSummary = {
  windows: 0,
  clawbacks: [],
  regrantedMicro: 0,
  forgivenMicro: 0,
  capSpentMicro: null,
};

/** One lot's part of a charge, in the order it arose. */
interface LotPart {
  readonly lotId: string;
  micro: number;
}

/**
 * One clawback charged against a unit, with what became of what it charged
 * BEYOND the unit's lots (S17 audit 4, R9): the debt it wrote — still owed,
 * repaid out of other credit and not yet returned, or forgiven by something
 * other than a reconciliation — the claims it collected from lots that are
 * not the unit's and has not given back, and (reversal policy v2, rule 3) the
 * part of its claim an annual payment dropped when a task spent what it held.
 */
interface UnitCharge {
  readonly clawback: UnitClawback;
  /** Applied, not reversed by a win: only a standing clawback still charges the unit. */
  readonly standing: boolean;
  readonly outstandingMicro: number;
  readonly repaidLeft: readonly LotPart[];
  readonly forgivenOtherMicro: number;
  readonly collectedLeft: readonly LotPart[];
  /** Dropped of its claim (`drop:<clawback>:<task>` records): not charged, and counted as if it were. */
  readonly droppedMicro: number;
}

/**
 * What a charge still stands charged for beyond the unit's lots, its claim
 * aside. A give-back walks it: debt still owed is forgiven, what other credit
 * repaid or a claim collected elsewhere goes back, and what an admin forgave or
 * an annual claim dropped gives nothing back — it is part of what is given
 * back all the same, so nothing is given twice for it.
 */
function chargedBeyond(c: UnitCharge): number {
  let micro = c.outstandingMicro + c.forgivenOtherMicro + c.droppedMicro;
  for (const p of c.repaidLeft) micro = micro + p.micro;
  for (const p of c.collectedLeft) micro = micro + p.micro;
  return micro;
}

/** One unit, read for a reconciliation. */
interface UnitState {
  readonly windowId: string;
  readonly windowEnd: PgInstant;
  /** Whether the window still runs: only then does credit go back into it, or a claim fall. */
  readonly live: boolean;
  readonly coverageRef: string;
  readonly targetKey: string;
  readonly lots: readonly UnitLot[];
  /** Every clawback of the unit, oldest first. */
  readonly charges: readonly UnitCharge[];
  /** The grants and takes the unit's target is made of. */
  readonly terms: readonly UnitKeepTerm[];
}

/**
 * L + S − B: what the unit holds and spent, less what its standing clawbacks
 * charged beyond it. A lot whose term has ended counts what is left in it
 * until the expiry is written (a take may still take it, and what it takes
 * does not expire); what a running task holds there counts until the task
 * settles — charged, it is spent; released, it pays the claims on it and the
 * rest expires.
 */
function positionOf(u: UnitState): number {
  let held = 0;
  for (const lot of u.lots) held = held + lot.remainingMicro;
  return held + consumedOf(u) - chargedOf(u);
}

/** What the unit's standing clawbacks charged beyond its lots and still stand charged for. */
function chargedOf(u: UnitState): number {
  let charged = 0;
  for (const c of u.charges) {
    if (!c.standing) continue;
    charged = charged + chargedBeyond(c) + c.clawback.pendingMicro;
  }
  return charged;
}

function consumedOf(u: UnitState): number {
  let spent = 0;
  for (const lot of u.lots) spent = spent + lot.consumedMicro;
  return spent;
}

/** What running tasks hold of the unit's lots: credit the customer may yet spend. */
function heldOf(u: UnitState): number {
  let held = 0;
  for (const lot of u.lots) held = held + lot.heldMicro;
  return held;
}

/**
 * Rule 1 (as policy v2 words it): what a take may claim of credit a running
 * task holds ON THE UNIT'S OWN LOTS — what they hold less what the unit's
 * standing clawbacks already claim of it. Rule 4 pays the claim only from those
 * lots, so credit held elsewhere is never claimed for it.
 */
function claimableOf(u: UnitState): number {
  let claimed = 0;
  for (const c of u.charges) if (c.standing) claimed = claimed + c.clawback.pendingMicro;
  // R-I: credit held on a lot a win returned is not claimed; what a take would
  // claim of it is debt, settled at once in the spend order.
  let held = 0;
  for (const lot of u.lots) if (!lot.returned) held = held + lot.heldMicro;
  return Math.max(0, held - claimed);
}

/** Free credit on the unit's lots a take may take (`planClawbackOfAmount`'s measure). */
function freeOf(u: UnitState): number {
  let free = 0;
  for (const lot of u.lots) {
    if (lot.returned) continue;
    free =
      free +
      Math.min(
        Math.max(0, lot.remainingMicro - lot.heldMicro),
        Math.max(0, lot.grantedMicro - lot.expiredMicro),
      );
  }
  return free;
}

/** What the unit's standing clawbacks charged beyond its lots (`chargedBeyond`, summed). */
function chargedBeyondOf(u: UnitState): number {
  let micro = 0;
  for (const c of u.charges) if (c.standing) micro = micro + chargedBeyond(c);
  return micro;
}

/**
 * What of that a give-back can undo: debt still owed, and what other credit
 * repaid or a claim collected elsewhere (what an admin forgave, or an annual
 * claim dropped, cannot be undone).
 */
function cancellableBeyondOf(u: UnitState): number {
  let micro = 0;
  for (const c of u.charges) {
    if (!c.standing) continue;
    micro = micro + c.outstandingMicro;
    for (const p of c.repaidLeft) micro = micro + p.micro;
    for (const p of c.collectedLeft) micro = micro + p.micro;
  }
  return micro;
}

/**
 * Rule 7 — the share of a month that has ENDED which a stand-alone payment
 * (a resubscription, a crypto term) was handed: fixed when the month ended.
 * It is where the unit stood then — what it holds and spent, less what it is
 * charged — with what has since expired unspent put back, and so are the
 * takes of its own payment's reversals measured after the month ended (a
 * later reversal is measured against the share, not against what an earlier
 * one left).
 */
function handedShareOf(u: UnitState): number {
  let share = positionOf(u);
  for (const lot of u.lots) share = share + lot.expiredMicro;
  for (const c of u.charges) {
    if (!c.standing || c.clawback.createdAt < u.windowEnd) continue;
    share = share + c.clawback.clawedMicro + c.clawback.pendingMicro + chargedBeyond(c);
  }
  return Math.max(0, share);
}

/**
 * What the unit's customer spent that no plan change has already made them
 * owe: the spend the interim cap weighs. A downgrade's debt is not debt a
 * REVERSAL created (the cap governs only that), so it is taken off before the
 * cap measures what a reversal may still charge — otherwise a won dispute,
 * moving the unit to the capped target, would forgive a downgrade's debt that
 * no reversal ever charged.
 */
function spentForCapOf(u: UnitState): number {
  let planChange = 0;
  for (const c of u.charges) {
    if (!c.standing || c.clawback.source !== 'plan_change') continue;
    planChange = planChange + chargedBeyond(c) + c.clawback.pendingMicro;
  }
  const owedByPlanChange = Math.min(planChange, Math.max(0, chargedOf(u)));
  return Math.max(0, consumedOf(u) - owedByPlanChange);
}

/** Take up to `micro` off the parts on one lot, oldest first; what could not be taken. */
function takeFromParts(parts: LotPart[], lotId: string, micro: number): number {
  let left = micro;
  for (const p of parts) {
    if (left <= 0) break;
    if (p.lotId !== lotId || p.micro <= 0) continue;
    const take = Math.min(left, p.micro);
    p.micro = p.micro - take;
    left = left - take;
  }
  return left;
}

/**
 * `drop:<clawback>:<task>` — the record of the part of an annual reversal's
 * claim a settlement dropped (`DrizzleCreditReservationsRepo.dropClaim`).
 */
const DROP_REF = /^drop:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

/**
 * A give-back row that returned debt a lot repaid (`:returned:`) or a claim a
 * lot paid (`:unclaimed:`), and the lot the credit CAME FROM: the row's own lot
 * when it went back into it, the lot named before `:new` when it went into a
 * new lot instead (rule 6).
 */
const RETURNED_ROW =
  /:(returned|unclaimed):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::new)?$/;

function wholeNonNegative(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} is a whole non-negative number`);
  }
  return value;
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
    await this.reconcileWindowUnits(tx, accountId, {
      event: null,
      exclude: [],
      changed: window.outcome === 'created' || level !== null,
    });
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
    // ⛔ A window written before 0139 records no undisputed level, and when a
    // dispute stands on its payment the level it shows is the lowered one: read
    // as undisputed it would be granted back as an "upgrade" (audit 4 #11, R14).
    if (wc.undisputedRecorded === false && wc.covers.some((c) => c.disputed === true)) {
      throw new CreditLegacyDisputeError();
    }
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
        // The line's lots only: a stand-alone cover's share of the month is
        // another payment's, held at its own target (`clawbackTargets`).
        const lineRefs = [...new Set([wc.sourceRef, ...t.line.map((c) => c.sourceRef)])];
        clawback = await this.clawBack(tx, accountId, {
          source: 'plan_change',
          sourceRef: `${wc.windowId}:${String(seq)}`,
          targetKey: `window:${wc.windowId}`,
          windowId: wc.windowId,
          amountMicro: -deltaMicro,
          ledgerKind: 'proration_clawback',
          debtReason: 'plan_change',
          targets: await windows.clawbackTargets(tx, accountId, wc.windowId, lineRefs),
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
   * or holds a level change of, or was handed a share of, newest first) to its
   * target at what the payment still pays now (see the header). `take` only
   * takes — a refund, a dispute or a crypto refund never adds credit (rule 1) —
   * and `both` also gives back: a win re-applying rule 1 in both directions
   * (`win` says how long what it returns lasts), or a refresh re-measuring a
   * payment a dispute stands against. `onlyWindowIds` limits what is read and
   * moved (a refresh moves only the current window, the newest).
   *
   * ⛔ A STAND-ALONE PAYMENT'S HAND-OVER IS ITS OWN, IN EVERY WINDOW (audit 4
   * #1, R11). A resubscription, a crypto term or an override holds the share of
   * a month drawn from ANOTHER payment that it was handed; when it is refunded
   * or disputed that share is reconciled here too — in the current window to
   * what it earns there now (its level above what stands beneath it, the same
   * figure `reconcileWindowUnits` holds it at), in a window that has ended to
   * what its grants there keep at what it still pays. (Once its month has
   * ended, a won dispute of the window's own payment leaves that share where it
   * is: rule 7, bound B3.)
   *
   * ⛔ THE INTERIM CAP IS FROZEN AT THE REVERSAL, AND BINDS ANNUAL PAYMENTS ONLY
   * (R8; R-C). `cap: 'measure'` is a reversal: what the payment's credit has
   * been spent — and what running tasks hold of it — across all its windows is
   * measured now and recorded with every row this writes. Anything else (a win,
   * a refresh) uses the newest standing reversal's figure, so a later spend or
   * a later win does not move what the payment may owe. A payment with no cap
   * (`paidForMicro` null: every monthly one) is held to rule 1 exactly.
   *
   * ⛔ EACH UNIT IS RE-READ RIGHT BEFORE IT MOVES, AND DEBT IS SETTLED ONCE,
   * AFTER THE LOOP, BY THE CALLER (audit 4 #2, R12). A take no longer repays
   * debt out of another window's lots in the middle of the walk, so no window
   * asks for credit an earlier step already moved.
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
       * ANOTHER payment is the share of it it was handed.
       */
      readonly standsAlone: boolean;
      readonly cap: 'measure' | 'standing';
      /** A win: how long the credit its give-backs return lasts (rule 6). */
      readonly win?: WonDisputeReturn;
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
    const moving = earned.filter(
      (w) => opts.onlyWindowIds === undefined || opts.onlyWindowIds.includes(w.id),
    );
    if (moving.length === 0) return { ...NOTHING, windows: earned.length };
    // A reversal measures the cap over every window; anything else reads only
    // the windows it moves (the cap is frozen, R13).
    const read = opts.cap === 'measure' ? earned : moving;
    const states: UnitState[] = [];
    for (const w of read) states.push(await this.unitState(tx, accountId, w, coverage));

    const handed = (w: SourcedCreditWindow): boolean =>
      opts.standsAlone && w.sourceRef !== coverage.sourceRef;
    const handedCurrent = (w: SourcedCreditWindow): boolean => handed(w) && w.current;
    const envelope = read.some(handedCurrent) ? await this.currentEnvelope(tx, accountId) : null;
    const keeps = read.map((w, i) => {
      if (handedCurrent(w)) {
        return envelope !== null &&
          envelope.cover.source === coverage.source &&
          envelope.cover.sourceRef === coverage.sourceRef
          ? envelope.keepMicro
          : 0;
      }
      if (handed(w)) {
        // Rule 7: once its month has ended, the share the payment was handed is
        // fixed — and it is what the payment bought there, so reversing the
        // payment brings it down to that share at what is still paid (rule 1),
        // as its level above the month did while the month ran.
        const share = handedShareOf(states[i] as UnitState);
        return terms.stillPaidMinor >= terms.amountPaidMinor
          ? share
          : unitKeepMicro({
              amountPaidMinor: terms.amountPaidMinor,
              stillPaidMinor: terms.stillPaidMinor,
              terms: [{ micro: share, stillPaidAtMinor: null }],
            });
      }
      return unitKeepMicro({
        amountPaidMinor: terms.amountPaidMinor,
        stillPaidMinor: terms.stillPaidMinor,
        terms: (states[i] as UnitState).terms,
      });
    });

    const paidForKeep =
      terms.paidForMicro === null
        ? null
        : floorMicroToWholeCredits(
            stillPaidShareMicro(terms.paidForMicro, terms.amountPaidMinor, terms.stillPaidMinor),
          );
    let capSpent: number | null = null;
    if (paidForKeep !== null) {
      let measured = 0;
      for (const s of states) measured = measured + spentForCapOf(s) + heldOf(s);
      capSpent =
        opts.cap === 'measure'
          ? measured
          : ((await windows.standingCapSpent(tx, accountId, coverage.sourceRef)) ?? measured);
    }
    const allowed = allowedDebtByUnit(
      states.map((s, i) => ({ keepMicro: keeps[i] ?? 0, consumedMicro: spentForCapOf(s) })),
      paidForKeep,
      capSpent ?? undefined,
    );

    const mark = await windows.ledgerMark(tx, accountId);
    const clawbacks: CreditClawbackRecord[] = [];
    let regranted = 0;
    let forgiven = 0;
    let first = true;
    for (const [i, w] of read.entries()) {
      if (!moving.includes(w)) continue;
      const snapshot = states[i] as UnitState;
      const keep = keeps[i] ?? 0;
      const target = handedCurrent(w)
        ? keep
        : unitTargetMicro(keep, spentForCapOf(snapshot), allowed[i] ?? null);
      const state = first ? snapshot : await this.unitState(tx, accountId, w, coverage);
      first = false;
      const done = await this.reconcileUnit(tx, accountId, w, coverage, state, target, {
        mode: opts.mode,
        event: opts.event,
        extras: { capSpentMicro: capSpent, ledgerMark: mark },
        win: opts.win,
      });
      if (done.clawback !== null) clawbacks.push(done.clawback);
      regranted = regranted + done.regrantedMicro;
      forgiven = forgiven + done.forgivenMicro;
    }
    return {
      windows: earned.length,
      clawbacks,
      regrantedMicro: regranted,
      forgivenMicro: forgiven,
      capSpentMicro: capSpent,
    };
  }

  /** The stand-alone cover of the window containing now, and what it earns there; null for none. */
  private async currentEnvelope(
    tx: CreditLedgerTx,
    accountId: string,
  ): Promise<WindowTargets['envelope']> {
    const wc = await this.deps.windows.windowCovers(tx, accountId);
    return wc === null ? null : windowTargets(wc).envelope;
  }

  /**
   * S17 — the units of the CURRENT window whose target the facts may have
   * moved without their own payment moving: the stand-alone cover above the
   * window's own payment (its share rises when that payment is refunded or
   * disputed, and falls back when a dispute is won), and — on a refresh — each
   * payment of the window that a dispute stands against, once a new month or a
   * plan change has changed what it bought. `event` null is a refresh; an
   * event's own payment is `exclude`d (the event reconciled it already).
   *
   * ⛔ A REFRESH THAT MOVED NOTHING RECONCILES NO DISPUTED PAYMENT (audit 4
   * #10, R13). A spend, an expiry or a lease does not change what a payment
   * with a dispute standing bought in this window; only a new month or a level
   * change (`changed`) does, and every event reconciles what it moved itself.
   * So the refresh inside every task reserve does not read the disputed
   * payment's units while a dispute stands. The stand-alone cover's share is
   * still checked on every refresh: a resubscription that arrives beside an
   * upgrade line already showing more moves no level, and it earns its share
   * all the same.
   */
  async reconcileWindowUnits(
    tx: CreditLedgerTx,
    accountId: string,
    input: {
      readonly event: CreditUnitEvent | null;
      readonly exclude: readonly string[];
      /** A refresh: whether it drew a window or moved a level. */
      readonly changed?: boolean;
      /** A win: how long the credit its give-backs return lasts (rule 6). */
      readonly win?: WonDisputeReturn;
    },
  ): Promise<void> {
    const { windows } = this.deps;
    const wc = await windows.windowCovers(tx, accountId);
    if (wc === null) return;
    const t = windowTargets(wc);
    if (input.event === null && input.changed !== true && t.envelope === null) return;
    const window = currentWindowOf(wc);
    const tag =
      input.event === null ? `rf${String(await windows.ledgerMark(tx, accountId))}` : null;

    if (input.event === null && input.changed === true) {
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
            cap: 'standing',
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
      win: input.win,
      extras: {
        capSpentMicro: null,
        ledgerMark: await windows.ledgerMark(tx, accountId),
      },
    });
  }

  /**
   * Reversal policy v2, rule 6 — what a won dispute's give-backs measure a
   * returned lot's term by, read once at the win (after the month the win
   * makes the payment cover again has been drawn): since when the dispute
   * stood, the latest expiry of any lot the customer used or held since then
   * (`latestExpiryUsedSince`), the end of the month running now, and a month
   * from now.
   */
  async wonDisputeReturn(
    tx: CreditLedgerTx,
    accountId: string,
    disputeId: string,
  ): Promise<WonDisputeReturn> {
    const { windows } = this.deps;
    const since = await windows.disputeStoodSince(tx, accountId, disputeId);
    const current = await windows.currentWindow(accountId, tx);
    const used = since === null ? null : await windows.latestExpiryUsedSince(tx, accountId, since);
    return {
      ref: `${disputeId}:won`,
      usedExpiry: used?.latestExpiry ?? null,
      usedLots: used?.lotIds ?? [],
      windowEnd: current?.windowEnd ?? null,
      now: await windows.databaseNow(tx),
      monthOn: await windows.aMonthFromNow(tx),
    };
  }

  /**
   * Reversal policy v2, rule 6 — a won dispute's clawbacks, just reversed (and
   * their claims cancelled with them), give back everything they removed:
   *
   *   · debt still owed is forgiven (`…:undo:<clawback>:forgive`);
   *   · credit a take removed from the unit's lots, and credit its claims
   *     collected there, comes back to the unit — the won payment's (R-D);
   *   · debt that later credit repaid, and a claim collected from a lot that
   *     is not the unit's, comes back to the lot that paid — to whichever
   *     payment's that lot is, goodwill's to none (R-F). Debt something else
   *     forgave (an admin) gives nothing back (`debtFates`, R9).
   *
   * Each part goes back into the lot it came from while that lot is valid and
   * lasts at least as long as every lot used or held while the dispute stood,
   * or else into one new lot per owner (`returnCredit`). Keyed to each
   * clawback (`reinstate:<unit>:undo:<clawback>:…`), so nothing is written
   * twice. Called under the account's credit lock, before rule 1 is
   * re-applied to the won payment.
   */
  async returnWhatADisputeRemoved(
    tx: CreditLedgerTx,
    accountId: string,
    reversed: readonly CreditClawbackRecord[],
    win: WonDisputeReturn,
  ): Promise<{ readonly regrantedMicro: number; readonly forgivenMicro: number }> {
    const { ledger, windows } = this.deps;
    const byUnit = new Map<string, CreditClawbackRecord[]>();
    for (const c of reversed) {
      if (parseUnitTargetKey(c.targetKey) === null) continue;
      byUnit.set(c.targetKey, [...(byUnit.get(c.targetKey) ?? []), c]);
    }
    if (byUnit.size === 0) return { regrantedMicro: 0, forgivenMicro: 0 };
    const unitWindows = new Map(
      (
        await windows.windowsByIds(
          tx,
          accountId,
          [...byUnit.keys()].map((k) => parseUnitTargetKey(k)?.windowId ?? ''),
        )
      ).map((w) => [w.id, w]),
    );
    let forgiven = 0;
    const parts: ReturnPart[] = [];
    for (const [targetKey, group] of byUnit) {
      const unit = parseUnitTargetKey(targetKey);
      const window = unit === null ? undefined : unitWindows.get(unit.windowId);
      if (unit === null || window === undefined) continue;
      const state = await this.unitState(tx, accountId, window, {
        source: 'stripe_invoice',
        sourceRef: unit.coverageRef,
      });
      const ownLots = state.lots.map((l) => l.lotId);
      const prefix = unitGivebackPrefix(targetKey);
      for (const c of group) {
        const charge = state.charges.find((x) => x.clawback.id === c.id);
        if (charge === undefined) continue;
        const key = `${prefix}undo:${c.id}`;
        const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
        const forgive = Math.min(charge.outstandingMicro, owed);
        if (forgive > 0) {
          await ledger.append(
            {
              accountId,
              kind: 'adjustment',
              forgiveDebtMicro: forgive,
              idempotencyKey: `${key}:forgive`,
              reason: 'dispute_reinstated',
            },
            tx,
          );
          forgiven = forgiven + forgive;
        }
        const taken = await windows.clawbackTakes(tx, accountId, {
          keyPrefix: `clawback:${c.source}:${c.sourceRef}:${c.targetKey}`,
          lotIds: ownLots,
        });
        for (const t of taken) parts.push({ lotId: t.lotId, micro: t.micro, key, marker: '' });
        for (const q of await windows.collectedClaims(tx, accountId, [c.id])) {
          if (ownLots.includes(q.lotId)) {
            parts.push({ lotId: q.lotId, micro: q.micro, key, marker: '' });
          }
        }
        for (const p of charge.collectedLeft) {
          parts.push({ lotId: p.lotId, micro: p.micro, key, marker: 'unclaimed:' });
        }
        for (const p of charge.repaidLeft) {
          parts.push({ lotId: p.lotId, micro: p.micro, key, marker: 'returned:' });
        }
      }
    }
    const regranted = await this.returnCredit(tx, accountId, parts, Number.MAX_SAFE_INTEGER, {
      context: win,
      tag: `${win.ref}:undo`,
    });
    return { regrantedMicro: regranted, forgivenMicro: forgiven };
  }

  /**
   * Give credit back to where it came from (reversal policy v2, rule 6), up to
   * `budgetMicro`, the parts in the order given. Each goes back INTO the lot it
   * came from while that lot is valid — at a win, only when the lot also lasts
   * at least as long as every lot the customer used or held while the dispute
   * stood (R-A) — up to the room below the lot's grant. Credit a take or a
   * claim removed from a lot that has since ENDED comes back only when the
   * customer used or held some OTHER lot while the dispute stood (R-G: the
   * spending was displaced; otherwise the twin's credit expired unused too).
   * At a win, what cannot go back there comes back as ONE NEW LOT per owner:
   * the credit unit the lot it came from belongs to (R-D and R-F — the won
   * payment's for what the dispute took from it, the payer's for debt another
   * payment's credit repaid; goodwill's and a top-up's belongs to none), valid
   * until the latest of the end of the current month, the expiry of the lots
   * it came from and `usedExpiry` — a month from now when none of those is in
   * the future. A later take does not take such a lot first (R-I,
   * `planClawbackOfAmount`).
   * Outside a win, credit whose lot has ended is not returned: it would have
   * expired with the lot. A revoked lot gets nothing. Each row is keyed
   * `<key>:<marker><lot it came from>` (`:new` on a new lot's), which is how a
   * later reading of the unit knows what was already given back. Returns what
   * was given back.
   */
  private async returnCredit(
    tx: CreditLedgerTx,
    accountId: string,
    parts: readonly ReturnPart[],
    budgetMicro: number,
    win: { readonly context: WonDisputeReturn; readonly tag: string } | undefined,
  ): Promise<number> {
    const { ledger, windows } = this.deps;
    const wanted = parts.filter((p) => p.micro > 0);
    if (wanted.length === 0 || budgetMicro <= 0) return 0;
    const lots = new Map(
      (await windows.lotsForReturn(tx, accountId, [...new Set(wanted.map((p) => p.lotId))])).map(
        (l) => [l.lotId, l],
      ),
    );
    const into = new Map<string, { lotId: string; micro: number }>();
    const usedRoom = new Map<string, number>();
    /** What comes back as a new lot, by the unit it belongs to ('' for none). */
    const fresh = new Map<
      string,
      { owner: string | null; rows: Map<string, number>; ends: PgInstant[] }
    >();
    let lost = 0;
    let left = budgetMicro;
    for (const p of wanted) {
      if (left <= 0) break;
      const lot = lots.get(p.lotId);
      if (lot === undefined || (!lot.live && !lot.expired)) continue;
      if (
        win !== undefined &&
        p.marker === '' &&
        !lot.live &&
        !win.context.usedLots.some((id) => id !== p.lotId)
      ) {
        continue;
      }
      const micro = Math.min(left, p.micro);
      left = left - micro;
      const used = win?.context.usedExpiry ?? null;
      let back = 0;
      if (lot.live && (used === null || lot.expiresAt >= used)) {
        back = Math.min(micro, lot.roomMicro - (usedRoom.get(p.lotId) ?? 0));
        if (back > 0) {
          usedRoom.set(p.lotId, (usedRoom.get(p.lotId) ?? 0) + back);
          const k = `${p.key}:${p.marker}${p.lotId}`;
          into.set(k, { lotId: p.lotId, micro: (into.get(k)?.micro ?? 0) + back });
        }
      }
      const rest = micro - back;
      if (rest <= 0) continue;
      if (win === undefined) {
        lost = lost + rest;
        continue;
      }
      const owner = lot.unit ?? '';
      const group = fresh.get(owner) ?? {
        owner: lot.unit,
        rows: new Map<string, number>(),
        ends: [] as PgInstant[],
      };
      const k = `${p.key}:${p.marker}${p.lotId}:new`;
      group.rows.set(k, (group.rows.get(k) ?? 0) + rest);
      group.ends.push(lot.expiresAt);
      fresh.set(owner, group);
    }
    let given = 0;
    for (const [k, row] of into) {
      const written = await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          lotId: row.lotId,
          lotDeltaMicro: row.micro,
          idempotencyKey: k,
          reason: 'dispute_reinstated',
        },
        tx,
      );
      if (written.applied) given = given + row.micro;
    }
    if (win !== undefined) {
      for (const group of fresh.values()) {
        const c = win.context;
        let latest: PgInstant | null = null;
        for (const e of [c.windowEnd, c.usedExpiry, ...group.ends]) {
          if (e !== null && (latest === null || e > latest)) latest = e;
        }
        const expiresAt = latest !== null && latest > c.now ? latest : c.monthOn;
        let micro = 0;
        for (const m of group.rows.values()) micro = micro + m;
        const inserted = await ledger.insertLot(
          {
            accountId,
            kind: 'adjustment',
            grantKey:
              group.owner === null
                ? `returned:${accountId}:${win.tag}`
                : returnedGrantKey(`${group.owner}:${win.tag}`),
            grantedMicro: ceilMicroToWholeCredits(micro),
            startsAt: floorToPriorMinute(this.now()),
            expiresAt: new Date(expiresAt),
          },
          tx,
        );
        for (const [k, m] of group.rows) {
          const written = await ledger.append(
            {
              accountId,
              kind: 'adjustment',
              lotId: inserted.lot.id,
              lotDeltaMicro: m,
              idempotencyKey: k,
              reason: 'dispute_reinstated',
            },
            tx,
          );
          if (written.applied) given = given + m;
        }
      }
    }
    if (lost > 0) {
      this.deps.logger?.warn(
        { component: 'credit-grants', event: 'returned_credit_already_expired', accountId },
        'credit given back came from a lot that has since ended; it was not returned (it would have expired anyway)',
      );
    }
    return given;
  }

  /**
   * Bring one unit to `target` (see the header): take the difference when it
   * stands above, give it back — `both` only — when it stands below. A take
   * is recorded once per event and unit (the clawback's key); a give-back is
   * keyed to the event and the unit too, and rounded UP to whole credits where
   * it becomes a lot of its own, the rounding then taken straight back so the
   * unit stands exactly at its target. Debt a take writes is settled by the
   * caller, once, after every unit has moved (R12).
   */
  private async reconcileUnit(
    tx: CreditLedgerTx,
    accountId: string,
    window: SourcedCreditWindow,
    coverage: { readonly source: CreditWindowSource; readonly sourceRef: string },
    unit: UnitState,
    target: number,
    opts: {
      readonly mode: 'take' | 'both';
      readonly event: CreditUnitEvent;
      readonly extras: ClawbackExtras;
      readonly win?: WonDisputeReturn | undefined;
    },
  ): Promise<{
    clawback: CreditClawbackRecord | null;
    regrantedMicro: number;
    forgivenMicro: number;
  }> {
    let state = unit;
    let delta = positionOf(state) - target;
    let given = { regrantedMicro: 0, forgivenMicro: 0 };
    if (delta > 0 && opts.win !== undefined) {
      // Rule 1 re-applied at a win: debt only for credit spent beyond the
      // worth. A reversal measured while the dispute's claims stood found the
      // held credit claimed and wrote DEBT where, with those claims now
      // cancelled, it takes free or held credit — so that debt is given back
      // first (forgiven, or returned the way the win returns credit) and taken
      // again in rule 1's order.
      const excess = Math.min(
        cancellableBeyondOf(state),
        chargedBeyondOf(state) - Math.max(0, consumedOf(state) - target),
        freeOf(state) + claimableOf(state) - delta,
      );
      if (excess > 0) {
        given = await this.giveBackBeyond(tx, accountId, state, excess, opts.event, opts.win);
        if (given.regrantedMicro + given.forgivenMicro > 0) {
          state = await this.unitState(tx, accountId, window, coverage);
          delta = positionOf(state) - target;
        }
      }
    }
    if (delta > 0) {
      const clawback = await this.takeFromUnit(
        tx,
        accountId,
        state,
        delta,
        opts.event,
        '',
        opts.extras,
      );
      return { clawback, ...given };
    }
    if (delta === 0 || opts.mode === 'take') return { clawback: null, ...given };
    given = await this.giveBack(tx, accountId, state, -delta, opts.event, opts.win);
    // The whole-credit rounding of what was given back, taken straight back.
    const after = await this.unitState(tx, accountId, window, coverage);
    const over = positionOf(after) - target;
    const trim =
      over > 0
        ? await this.takeFromUnit(tx, accountId, after, over, opts.event, ':trim', opts.extras)
        : null;
    return {
      clawback: trim,
      regrantedMicro: given.regrantedMicro,
      forgivenMicro: given.forgivenMicro,
    };
  }

  /**
   * One take from one unit: its free credit first, then — rule 1 — as a claim
   * what running tasks hold on the unit's OWN lots and no standing clawback of
   * the unit already claims (`claimableOf`), and the rest as debt.
   */
  private async takeFromUnit(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    amountMicro: number,
    event: CreditUnitEvent,
    suffix: string,
    extras: ClawbackExtras,
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
      claimableMicro: claimableOf(state),
      disputedMinor: suffix === '' ? (event.disputedMinor ?? null) : null,
      settle: false,
      ...extras,
    });
  }

  /**
   * Give `amountMicro` back to one unit (rule 1 re-applied in both directions,
   * or a refresh re-measuring a disputed payment):
   *
   *   1. its standing claims on held credit are released — also once the
   *      month has ended (rule 6: claims are released first). The held credit
   *      a claim stands on in an ended month expires when the task releases
   *      it, so releasing the claim lets the task spend it free of the debt
   *      the claim stood for — which is where a twin whose reversal claimed
   *      less stands (P-R10);
   *   2. what its standing clawbacks charged beyond its lots, by what became
   *      of it (`debtFates`, R9): debt still owed is forgiven; debt later
   *      credit repaid, and claims collected from other lots, go back the way
   *      a win returns what it removed (`returnCredit` — at a win, rule 6's
   *      terms; otherwise into the lot while it is live); and what an admin
   *      forgave, or an annual claim dropped, gives nothing back — it is part
   *      of what is given back all the same;
   *   3. the rest back into the unit's own lots that gave it up, while the
   *      month runs (`restoreTaken`). A month that has ENDED gets nothing of
   *      it back here: what a win returns of an ended month it returns as
   *      credit the dispute removed (`returnWhatADisputeRemoved`).
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
    win?: WonDisputeReturn,
  ): Promise<{ regrantedMicro: number; forgivenMicro: number }> {
    const { windows } = this.deps;
    const ref = `${state.targetKey}:${event.ref}`;
    let left = amountMicro;
    const standing = state.charges.filter((c) => c.standing);

    for (const c of standing) {
      if (left <= 0) break;
      if (c.clawback.pendingMicro <= 0) continue;
      const release = Math.min(left, c.clawback.pendingMicro);
      await windows.releasePendingClaim(tx, c.clawback.id, release);
      left = left - release;
    }

    let beyond = 0;
    for (const c of standing) beyond = beyond + chargedBeyond(c);
    const part = Math.min(left, beyond);
    const back =
      part > 0
        ? await this.giveBackBeyond(tx, accountId, state, part, event, win)
        : { regrantedMicro: 0, forgivenMicro: 0 };
    let regrantedMicro = back.regrantedMicro;
    const forgivenMicro = back.forgivenMicro;
    left = left - part;

    if (left > 0 && state.live) {
      regrantedMicro =
        regrantedMicro + (await this.restoreTaken(tx, accountId, state, left, ref, event));
    }
    return { regrantedMicro, forgivenMicro };
  }

  /**
   * Step 2 of a give-back: up to `amountMicro` of what the unit's standing
   * clawbacks charged beyond its lots, by what became of it (`debtFates`, R9):
   * debt still owed is forgiven; debt later credit repaid, and claims
   * collected from other lots, go back the way a win returns credit
   * (`returnCredit`), newest charge first and within it what was repaid or
   * collected last. What an admin forgave, or an annual claim dropped, gives
   * nothing back.
   */
  private async giveBackBeyond(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    amountMicro: number,
    event: CreditUnitEvent,
    win: WonDisputeReturn | undefined,
  ): Promise<{ regrantedMicro: number; forgivenMicro: number }> {
    const { ledger } = this.deps;
    const key = reinstateGrantKey(`${state.targetKey}:${event.ref}`);
    const standing = state.charges.filter((c) => c.standing);
    let left = amountMicro;
    let outstanding = 0;
    for (const c of standing) outstanding = outstanding + c.outstandingMicro;
    const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
    const forgive = Math.min(left, outstanding, owed);
    if (forgive > 0) {
      await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          forgiveDebtMicro: forgive,
          idempotencyKey: `${key}:forgive`,
          reason: event.label,
        },
        tx,
      );
      left = left - forgive;
    }
    const parts: ReturnPart[] = [];
    for (const c of [...standing].reverse()) {
      for (const p of [...c.collectedLeft].reverse()) {
        parts.push({ lotId: p.lotId, micro: p.micro, key, marker: 'unclaimed:' });
      }
      for (const p of [...c.repaidLeft].reverse()) {
        parts.push({ lotId: p.lotId, micro: p.micro, key, marker: 'returned:' });
      }
    }
    const regranted = await this.returnCredit(
      tx,
      accountId,
      parts,
      left,
      win === undefined
        ? undefined
        : { context: win, tag: `${event.ref}:from:${state.windowId}:${state.coverageRef}` },
    );
    return { regrantedMicro: regranted, forgivenMicro: Math.max(0, forgive) };
  }

  /**
   * Step 3 of a give-back: `micro` of credit back into the unit's own live
   * lots that gave it up, the lot taken from last first, each no more than was
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
      if (!lot.live) continue;
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
   * target, the clawbacks charged against it and what became of what each
   * charged beyond its lots (`debtFates`), what a reconciliation or a win
   * already gave back for it, and what an annual payment dropped of its claims.
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
    // Rule 3: a claim an annual reversal dropped leaves a record against the
    // unit (`drop:<clawback>:<task>`), which is no clawback of its own: it
    // counts as charged while the clawback it names stands.
    const dropped = new Map<string, number>();
    const clawbacks = (
      await windows.unitClawbacks(tx, accountId, {
        windowId: window.id,
        targetKey,
        planChangeRefs,
      })
    ).filter((c) => {
      const drop = DROP_REF.exec(c.sourceRef);
      if (drop === null) return true;
      const of = drop[1] ?? '';
      dropped.set(of, (dropped.get(of) ?? 0) + (c.amountMicro ?? 0));
      return false;
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

    const collectedBy = new Map<string, LotPart[]>();
    for (const claim of await windows.collectedClaims(tx, accountId, ownIds)) {
      if (lotIds.has(claim.lotId)) continue;
      const list = collectedBy.get(claim.clawbackId) ?? [];
      list.push({ lotId: claim.lotId, micro: claim.micro });
      collectedBy.set(claim.clawbackId, list);
    }
    let fates = new Map<string, ClawbackDebtFate>();
    if (clawbacks.some((c) => c.debtMicro > 0)) {
      const unitOf = new Map<string, string>();
      for (const c of clawbacks) if (c.source === 'plan_change') unitOf.set(c.id, targetKey);
      fates = debtFates(
        await windows.debtEvents(tx, accountId),
        await windows.accountClawbacks(tx, accountId),
        unitOf,
      );
    }
    const charges = clawbacks.map((c) => {
      const fate = fates.get(c.id);
      return {
        clawback: c,
        standing: c.state === 'applied',
        // A debt no ledger row accounts for is treated as gone: nothing is
        // forgiven or returned for it, and it still stands charged.
        outstandingMicro: fate?.outstandingMicro ?? 0,
        repaidLeft: (fate?.repaid ?? []).map((p) => ({ lotId: p.lotId, micro: p.micro })),
        forgivenOtherMicro:
          fate === undefined
            ? c.debtMicro
            : fate.forgivenOtherMicro + Math.max(0, c.debtMicro - fate.incurredMicro),
        collectedLeft: collectedBy.get(c.id) ?? [],
        droppedMicro: dropped.get(c.id) ?? 0,
      };
    });

    // What a give-back or a win already returned for a charge (`:returned:`,
    // `:unclaimed:`, keyed to the lot the credit came from) is no longer
    // charged beyond the unit's lots.
    for (const row of await windows.unitGivebackRows(tx, accountId, window.id, givebackPrefix)) {
      if (row.lotId === null || row.lotDeltaMicro <= 0) continue;
      const back = RETURNED_ROW.exec(row.key);
      if (back === null) continue;
      const undo = UNDO_KEY.exec(row.key);
      const owners = undo === null ? charges : charges.filter((c) => c.clawback.id === undo[1]);
      const from = back[2] ?? '';
      let left = row.lotDeltaMicro;
      for (const c of owners) {
        left = takeFromParts(back[1] === 'returned' ? c.repaidLeft : c.collectedLeft, from, left);
      }
    }

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
      charges,
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
   * then — unless the caller settles once for a whole walk (`settle: false`,
   * R12) — the account's debt is paid down from whatever free credit it has
   * left, because the database refuses to COMMIT debt beside spendable credit.
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
      /** R12 — false: the caller settles the account's debt once, after every unit moved. */
      readonly settle?: boolean;
      /**
       * Reversal policy v2, rule 1 — what a reversal may claim: held credit on
       * the unit's own lots its standing clawbacks do not already claim
       * (`claimableOf`). Absent — a plan change — it is what the account's
       * tasks hold less every standing claim.
       */
      readonly claimableMicro?: number;
    } & Partial<ClawbackExtras>,
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
    const onAccount = Math.max(0, heldTotal - standingClaims);
    // Never more than the account holds unclaimed, whatever the unit says: two
    // claims must not stand over one credit.
    const claimable =
      input.claimableMicro === undefined
        ? onAccount
        : Math.min(onAccount, Math.max(0, input.claimableMicro));
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
      capSpentMicro: input.capSpentMicro ?? null,
      ledgerMark: input.ledgerMark ?? null,
    });
    if (input.settle !== false) await ledger.settleDebtFromFree(tx, accountId);
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
