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
// `reconcileUnit` brings a unit's position — what its LIVE lots still hold,
// what left them on the customer's work, less what its STANDING clawbacks
// charged beyond it — to its target: it takes the difference (free credit
// first, held credit as a claim while the month runs, the rest as debt), or
// gives it back (a claim released, then what the charge beyond the lots became:
// debt still owed forgiven, debt later credit repaid returned INTO the lot that
// repaid it while that lot is live — nothing when it has expired or an admin
// forgave it (R1', R9) — then credit moved to the lots the customer's spending
// fell on while the unit's credit stood taken (R10), and the rest into the
// month while it runs). A won dispute first undoes its own clawbacks the same
// way (`undoReversedClawbacks`) and they then charge nothing. Because the target
// is a function of the facts and every event moves every affected unit to it,
// the order of events does not change where the account ends: a won dispute
// leaves exactly what the account would hold had the dispute never been filed —
// the same credit, lasting as long.
//
// ⛔ THE INTERIM ANNUAL CAP IS FROZEN AT EACH REVERSAL (R8, 0140). What the
// payment's credit had been spent — plus what running tasks held — when the
// refund or dispute was measured is recorded on its rows, and every later
// reconciliation (a win, a refresh, a task's settle) uses the newest standing
// reversal's figure: a later spend or a later win does not move what may be
// owed. A task that settles a claim into debt the frozen cap forbids owes only
// what the clawback's recorded threshold says (credit-reservations.ts).
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
  unitLotsForSettle,
  prorationGrantKey,
  unitGivebackPrefix,
  unitTargetKey,
  type AccountClawback,
  type ClawbackTargetLot,
  type LedgerDebtEvent,
  type ReservationHold,
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

/**
 * The walk behind `debtFates`: every chunk of debt, and for each row that
 * lowered debt, whose chunks it lowered and by how much.
 */
function followDebt(
  events: readonly LedgerDebtEvent[],
  clawbacks: readonly AccountClawback[],
  unitOf: ReadonlyMap<string, string>,
): {
  chunks: DebtChunk[];
  rowOwners: Map<number, { owner: string | null; micro: number }[]>;
} {
  const byKey = new Map<string, AccountClawback>();
  const byId = new Map<string, AccountClawback>();
  for (const c of clawbacks) {
    byKey.set(`clawback:${c.source}:${c.sourceRef}:${c.targetKey}:debt`, c);
    byKey.set(`clawback:${c.source}:${c.sourceRef}:debt`, c);
    byId.set(c.id, c);
  }
  const chunks: DebtChunk[] = [];
  const rowOwners = new Map<number, { owner: string | null; micro: number }[]>();
  const reduce = (
    rowId: number,
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
      rowOwners.set(rowId, [...(rowOwners.get(rowId) ?? []), { owner: c.owner, micro: take }]);
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
      rowOwners.set(e.id, [{ owner: owner?.id ?? null, micro: e.debtDeltaMicro }]);
      continue;
    }
    const amount = -e.debtDeltaMicro;
    if (e.lotId !== null) {
      const lotId = e.lotId;
      reduce(e.id, chunks, amount, (c, micro) => {
        c.repaid.push({ lotId, micro, rowId: e.id, at: e.at });
      });
      continue;
    }
    const undo = UNDO_KEY.exec(e.key);
    const unit = UNIT_GIVEBACK_KEY.exec(e.key);
    let left = amount;
    if (undo !== null) {
      left = reduce(
        e.id,
        chunks.filter((c) => c.owner === undo[1]),
        left,
        (c, micro) => {
          c.forgivenSelf = c.forgivenSelf + micro;
        },
      );
    } else if (unit !== null) {
      left = reduce(
        e.id,
        chunks.filter((c) => c.unit === unit[1]),
        left,
        (c, micro) => {
          c.forgivenSelf = c.forgivenSelf + micro;
        },
      );
    }
    reduce(e.id, chunks, left, (c, micro) => {
      c.forgivenOther = c.forgivenOther + micro;
    });
  }
  return { chunks, rowOwners };
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
  const { chunks } = followDebt(events, clawbacks, unitOf);
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

/** A point in the ledger: a row (its id and its transaction's clock), or a clock reading (id 0). */
export interface LedgerPoint {
  readonly at: PgInstant;
  readonly id: number;
}

const UNKNOWN_OWNER = 'unknown';

function isAfter(a: LedgerPoint, b: LedgerPoint): boolean {
  return a.at > b.at || (a.at === b.at && a.id > b.id);
}

/**
 * Credit a won dispute gives back into a LIVE lot, and since when a twin
 * without the dispute had it there (S17 audit 4, R10 with R1'): debt the
 * dispute wrote that the lot repaid, a claim it collected there, spending
 * that fell on the lot while the dispute stood, or the month it took.
 */
export interface TwinCredit {
  readonly lotId: string;
  readonly micro: number;
  readonly since: LedgerPoint;
  /** The unit whose give-back placed it: that unit's own later takes are already in its target. */
  readonly originUnit: string;
  /**
   * `returned`: debt the unit's charge wrote, or a claim it collected, given
   * back — that charge was the dispute's doing, and the twin never had it.
   */
  readonly kind: 'returned' | 'moved' | 'restored';
}

/** A claim a twin without a won dispute paid out of credit the dispute's claim collected. */
interface TwinClaimPay {
  readonly claimId: string;
  readonly source: CreditClawbackSource;
  /** The task whose settlement collected the credit. */
  readonly task: string;
  readonly micro: number;
}

/** A lot, for the order the twin's settlements would have used it in. */
export interface TwinLot {
  readonly lotId: string;
  readonly spendRank: number;
  readonly expiresAt: PgInstant;
  readonly createdAt: PgInstant;
}

/** What the twin's later settlements did differently, as corrections to write. */
export interface TwinCorrections {
  /** A later take of another unit would have taken this credit instead of writing debt. */
  readonly lateTakes: { readonly owner: string; readonly lotId: string; readonly micro: number }[];
  /** A later settlement would have repaid debt out of this credit (keyed by the credit's origin). */
  readonly paid: { readonly origin: string; readonly lotId: string; readonly micro: number }[];
  /** A later settlement repaid this much LESS out of this lot: it goes back into it. */
  readonly unrepaid: {
    readonly owner: string | null;
    readonly lotId: string;
    readonly micro: number;
  }[];
  /** Debt still owed that the twin had already repaid out of the credit. */
  readonly forgive: { readonly owner: string | null; readonly micro: number }[];
}

/**
 * S17 audit 4 — replay the account's debt settlements since each given-back
 * credit's origin as a twin without the won dispute would have made them. Pure.
 *
 * The twin never owed the dispute's debt (`excluded`), and held each credit in
 * its lot from its `since` on. So from then, every take of another unit whose
 * lots held such credit took it instead of writing that much debt; and every
 * settlement — a transaction's debt repayments, in the spend order — found it
 * at its lot's place in the order and repaid from it, leaving less owed and
 * reaching less far into later lots. A lot that expires loses the credit, in
 * the twin too. What the twin did differently comes out as corrections: the
 * credit consumed (a late take, or repaid), credit the account repaid that
 * the twin did not (back into those lots), and debt the twin no longer owed.
 * Repayments pay the oldest debt first in both (the `followDebt` order).
 */
export function twinSettlements(input: {
  readonly events: readonly LedgerDebtEvent[];
  readonly rowOwners: ReadonlyMap<number, readonly { owner: string | null; micro: number }[]>;
  readonly ownerUnit: ReadonlyMap<string, string | null>;
  readonly excluded: ReadonlySet<string>;
  readonly credits: readonly TwinCredit[];
  readonly lots: ReadonlyMap<string, TwinLot>;
  readonly unitLots: ReadonlyMap<string, ReadonlySet<string>>;
  readonly now: PgInstant;
}): TwinCorrections {
  const out: {
    lateTakes: { owner: string; lotId: string; micro: number }[];
    paid: { origin: string; lotId: string; micro: number }[];
    unrepaid: { owner: string | null; lotId: string; micro: number }[];
    forgive: { owner: string | null; micro: number }[];
  } = { lateTakes: [], paid: [], unrepaid: [], forgive: [] };
  const pending = [...input.credits].sort((a, b) =>
    isAfter(a.since, b.since) ? 1 : isAfter(b.since, a.since) ? -1 : 0,
  );
  const extras = new Map<string, { origin: string; micro: number }[]>();
  const wOut = new Map<string, number>();
  const diff = new Map<string, number>();
  const order: string[] = [];
  // Debt no clawback wrote is one bucket: its rows cannot be told apart.
  const ownerKey = (owner: string | null, _rowId: number): string => owner ?? UNKNOWN_OWNER;
  const spendCmp = (a: string, b: string): number => {
    const x = input.lots.get(a);
    const y = input.lots.get(b);
    if (x === undefined || y === undefined) return a < b ? -1 : a > b ? 1 : 0;
    return (
      x.spendRank - y.spendRank ||
      (x.expiresAt < y.expiresAt ? -1 : x.expiresAt > y.expiresAt ? 1 : 0) ||
      (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0) ||
      (a < b ? -1 : a > b ? 1 : 0)
    );
  };
  const extraOn = (lotId: string): number => {
    let micro = 0;
    for (const x of extras.get(lotId) ?? []) micro = micro + x.micro;
    return micro;
  };
  const addExtra = (lotId: string, origin: string, micro: number): void => {
    if (micro <= 0) return;
    extras.set(lotId, [...(extras.get(lotId) ?? []), { origin, micro }]);
  };
  const consume = (
    lotId: string,
    micro: number,
    allow: (origin: string) => boolean,
    onPart: (origin: string, part: number) => void,
  ): number => {
    let left = micro;
    for (const x of extras.get(lotId) ?? []) {
      if (left <= 0) break;
      if (!allow(x.origin) || x.micro <= 0) continue;
      const part = Math.min(left, x.micro);
      x.micro = x.micro - part;
      left = left - part;
      onPart(x.origin, part);
    }
    return micro - left;
  };
  const advanceTo = (point: LedgerPoint): void => {
    while (pending.length > 0 && isAfter(point, (pending[0] as TwinCredit).since)) {
      const c = pending.shift() as TwinCredit;
      addExtra(c.lotId, c.originUnit, c.micro);
    }
    for (const lotId of extras.keys()) {
      const lot = input.lots.get(lotId);
      if (lot !== undefined && lot.expiresAt <= point.at) extras.delete(lotId);
    }
  };
  const debtOf = (k: string): number => wOut.get(k) ?? 0;
  const diffOf = (k: string): number => diff.get(k) ?? 0;

  const events = input.events;
  let i = 0;
  while (i < events.length) {
    const e = events[i] as LedgerDebtEvent;
    advanceTo(e);
    if (e.debtDeltaMicro > 0) {
      i = i + 1;
      const owner = input.rowOwners.get(e.id)?.[0]?.owner ?? null;
      if (owner !== null && input.excluded.has(owner)) continue;
      const k = ownerKey(owner, e.id);
      if (!order.includes(k)) order.push(k);
      wOut.set(k, debtOf(k) + e.debtDeltaMicro);
      const unit = owner === null ? null : (input.ownerUnit.get(owner) ?? null);
      const own = unit === null ? undefined : input.unitLots.get(unit);
      if (owner === null || unit === null || own === undefined) continue;
      let left = e.debtDeltaMicro;
      const newestFirst = [...own].sort(
        (a, b) =>
          -((input.lots.get(a)?.createdAt ?? '') < (input.lots.get(b)?.createdAt ?? '') ? -1 : 1),
      );
      for (const lotId of newestFirst) {
        if (left <= 0) break;
        const took = consume(
          lotId,
          left,
          (origin) => origin !== unit,
          () => undefined,
        );
        if (took <= 0) continue;
        out.lateTakes.push({ owner, lotId, micro: took });
        diff.set(k, diffOf(k) + took);
        left = left - took;
      }
      continue;
    }
    if (e.lotId === null) {
      i = i + 1;
      for (const part of input.rowOwners.get(e.id) ?? []) {
        if (part.owner !== null && input.excluded.has(part.owner)) continue;
        const k = ownerKey(part.owner, e.id);
        const tOut = Math.max(0, debtOf(k) - diffOf(k));
        wOut.set(k, debtOf(k) - part.micro);
        diff.set(k, Math.max(0, debtOf(k) - Math.max(0, tOut - part.micro)));
      }
      continue;
    }
    // One settlement: the repayment rows one transaction wrote.
    const batch: LedgerDebtEvent[] = [];
    while (i < events.length) {
      const r = events[i] as LedgerDebtEvent;
      if (r.lotId === null || r.debtDeltaMicro >= 0 || r.at !== e.at) break;
      batch.push(r);
      i = i + 1;
    }
    const wLot = new Map<string, number>();
    const wPaid = new Map<string, number>();
    for (const r of batch) {
      for (const part of input.rowOwners.get(r.id) ?? []) {
        if (part.owner !== null && input.excluded.has(part.owner)) continue;
        const k = ownerKey(part.owner, r.id);
        wPaid.set(k, (wPaid.get(k) ?? 0) + part.micro);
        wLot.set(r.lotId as string, (wLot.get(r.lotId as string) ?? 0) + part.micro);
      }
    }
    let pool = 0;
    for (const k of order) pool = pool + Math.max(0, debtOf(k) - diffOf(k));
    const candidates = new Set<string>(wLot.keys());
    for (const lotId of extras.keys()) {
      const lot = input.lots.get(lotId);
      if (lot !== undefined && lot.createdAt <= e.at && extraOn(lotId) > 0) candidates.add(lotId);
    }
    const tLot = new Map<string, number>();
    let left = pool;
    for (const lotId of [...candidates].sort(spendCmp)) {
      const take = Math.min(left, (wLot.get(lotId) ?? 0) + extraOn(lotId));
      tLot.set(lotId, take);
      left = left - take;
    }
    // Who the twin paid: the oldest debt first, as the account did.
    const tPaid = new Map<string, number>();
    let tTotal = pool - left;
    for (const k of order) {
      if (tTotal <= 0) break;
      const pay = Math.min(tTotal, Math.max(0, debtOf(k) - diffOf(k)));
      tPaid.set(k, pay);
      tTotal = tTotal - pay;
    }
    const surplus = order
      .filter((k) => (wPaid.get(k) ?? 0) > (tPaid.get(k) ?? 0))
      .map((k) => ({ k, micro: (wPaid.get(k) ?? 0) - (tPaid.get(k) ?? 0) }))
      .reverse();
    for (const lotId of [...candidates].sort(spendCmp)) {
      const d = (tLot.get(lotId) ?? 0) - (wLot.get(lotId) ?? 0);
      if (d > 0) {
        consume(
          lotId,
          d,
          () => true,
          (origin, part) => {
            out.paid.push({ origin, lotId, micro: part });
          },
        );
      } else if (d < 0) {
        let back = -d;
        for (const s of surplus) {
          if (back <= 0) break;
          const part = Math.min(back, s.micro);
          if (part <= 0) continue;
          s.micro = s.micro - part;
          back = back - part;
          const owner = s.k === UNKNOWN_OWNER ? null : s.k;
          out.unrepaid.push({ owner, lotId, micro: part });
          addExtra(lotId, owner === null ? '' : (input.ownerUnit.get(owner) ?? ''), part);
        }
      }
    }
    for (const k of order) {
      const wAfter = debtOf(k) - (wPaid.get(k) ?? 0);
      const tAfter = Math.max(0, debtOf(k) - diffOf(k) - (tPaid.get(k) ?? 0));
      wOut.set(k, wAfter);
      diff.set(k, Math.max(0, wAfter - tAfter));
    }
  }
  advanceTo({ at: input.now, id: Number.MAX_SAFE_INTEGER });
  for (const k of order) {
    const micro = Math.min(diffOf(k), debtOf(k));
    if (micro > 0) out.forgive.push({ owner: k === UNKNOWN_OWNER ? null : k, micro });
  }
  return out;
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

/**
 * S17 R10 — the lot a running task's redirected share waits in beside the lot
 * it holds (`hold:<task>:<lot>:<unit>`): keyed by the task first, so its
 * settlement finds it (`holdOverflowLotsOf`), and not under any unit's
 * give-back prefix, so it is no unit's own lot.
 */
export function holdOverflowGrantKey(
  reservationId: string,
  besideLotId: string,
  targetKey: string,
): string {
  return `hold:${reservationId}:${besideLotId}:${targetKey}`;
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

/** What a reconciliation records on every clawback it writes (0140). */
interface ClawbackExtras {
  /** The interim cap's consumption it was measured on (R8); null when the payment has no cap. */
  readonly capSpentMicro: number | null;
  /** The account's newest ledger row id when it was measured. */
  readonly ledgerMark: number;
  /** How much more may be spent before an unpaid claim of it is no longer owed; null: always owed. */
  readonly claimForgiveAfterMicro: number | null;
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
  /** When the account's credit left the lot this way: from then, a twin kept it there. */
  readonly since?: LedgerPoint;
  /** A collected claim: the task whose settlement paid it. */
  readonly reservationId?: string;
}

/**
 * One clawback charged against a unit, with what became of what it charged
 * BEYOND the unit's lots (S17 audit 4, R9): the debt it wrote — still owed,
 * repaid out of other credit and not yet returned, or forgiven by something
 * other than a reconciliation — and the claims it collected from lots that are
 * not the unit's and has not given back.
 */
interface UnitCharge {
  readonly clawback: UnitClawback;
  /** Applied, not reversed by a win: only a standing clawback still charges the unit. */
  readonly standing: boolean;
  readonly outstandingMicro: number;
  readonly repaidLeft: readonly LotPart[];
  readonly forgivenOtherMicro: number;
  readonly collectedLeft: readonly LotPart[];
}

/** What a charge still stands charged for beyond the unit's lots, its claim aside. */
function chargedBeyond(c: UnitCharge): number {
  let micro = c.outstandingMicro + c.forgivenOtherMicro;
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
  /**
   * Credit a give-back MOVED to lots outside the unit because the customer's
   * spending fell on them while the unit's credit was taken (R10): spending
   * that was the unit's, so it counts as the unit's.
   */
  readonly movedMicro: number;
  readonly movedByLot: ReadonlyMap<string, number>;
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
  let spent = u.movedMicro;
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

/** Two task holds in the spend order of their lots. */
function holdSpendOrder(a: ReservationHold, b: ReservationHold): number {
  return (
    a.spendRank - b.spendRank ||
    (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0) ||
    (a.lotCreatedAt < b.lotCreatedAt ? -1 : a.lotCreatedAt > b.lotCreatedAt ? 1 : 0) ||
    (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0)
  );
}

/** The unit's lot that comes first in the spend order; null when it has none. */
function firstInSpendOrder(lots: readonly UnitLot[]): UnitLot | null {
  let first: UnitLot | null = null;
  for (const lot of lots) {
    if (
      first === null ||
      lot.spendRank < first.spendRank ||
      (lot.spendRank === first.spendRank &&
        (lot.expiresAt < first.expiresAt ||
          (lot.expiresAt === first.expiresAt &&
            (lot.createdAt < first.createdAt ||
              (lot.createdAt === first.createdAt && lot.lotId < first.lotId)))))
    ) {
      first = lot;
    }
  }
  return first;
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
   * or holds a level change of, or was handed a share of, newest first) to its
   * target at what the payment still pays now (see the header). `take` only
   * takes — a refund, a dispute or a crypto refund never adds credit — and
   * `both` also gives back (a win). `onlyWindowIds` limits what is read and
   * moved (a refresh moves only the current window, the newest).
   *
   * ⛔ A STAND-ALONE PAYMENT'S HAND-OVER IS ITS OWN, IN EVERY WINDOW (audit 4
   * #1, R11). A resubscription, a crypto term or an override holds the share of
   * a month drawn from ANOTHER payment that it was handed; when it is refunded
   * or disputed that share is reconciled here too — in the current window to
   * what it earns there now (its level above what stands beneath it, the same
   * figure `reconcileWindowUnits` holds it at), in a window that has ended to
   * what its grants there keep at what it still pays.
   *
   * ⛔ THE INTERIM CAP IS FROZEN AT THE REVERSAL (R8). `cap: 'measure'` is a
   * reversal: what the payment's credit has been spent — and what running
   * tasks hold of it — across all its windows is measured now and recorded
   * with every row this writes. Anything else (a win, a refresh, a task's
   * settle) uses the newest standing reversal's figure, so a later spend or a
   * later win does not move what the payment may owe.
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
      /** A win: where each credit it gives back into a live lot is recorded (`resettleAsTwin`). */
      readonly collect?: TwinCredit[];
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

    const handedCurrent = (w: SourcedCreditWindow): boolean =>
      opts.standsAlone && w.sourceRef !== coverage.sourceRef && w.current;
    const envelope = read.some(handedCurrent) ? await this.currentEnvelope(tx, accountId) : null;
    const keeps = read.map((w, i) => {
      if (handedCurrent(w)) {
        return envelope !== null &&
          envelope.cover.source === coverage.source &&
          envelope.cover.sourceRef === coverage.sourceRef
          ? envelope.keepMicro
          : 0;
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
    // What of the cap is still unshared when each window's turn comes (newest
    // first): the most debt more spending there could yet be charged — where a
    // claim left unpaid at a task's settle stops being owed (R8, audit 4 #3).
    const unshared: number[] = [];
    let open = paidForKeep === null || capSpent === null ? 0 : Math.max(0, capSpent - paidForKeep);
    for (const a of allowed) {
      unshared.push(open);
      open = Math.max(0, open - (a ?? 0));
    }

    const mark = await windows.ledgerMark(tx, accountId);
    const clawbacks: CreditClawbackRecord[] = [];
    let regranted = 0;
    let forgiven = 0;
    let first = true;
    for (const [i, w] of read.entries()) {
      if (!moving.includes(w)) continue;
      const snapshot = states[i] as UnitState;
      const handed = handedCurrent(w);
      const keep = keeps[i] ?? 0;
      const target = handed
        ? keep
        : unitTargetMicro(keep, spentForCapOf(snapshot), allowed[i] ?? null);
      const state = first ? snapshot : await this.unitState(tx, accountId, w, coverage);
      first = false;
      const forgiveAfter =
        handed || paidForKeep === null
          ? null
          : Math.max(0, target + (unshared[i] ?? 0) - spentForCapOf(snapshot));
      const done = await this.reconcileUnit(tx, accountId, w, coverage, state, target, {
        mode: opts.mode,
        event: opts.event,
        extras: { capSpentMicro: capSpent, ledgerMark: mark, claimForgiveAfterMicro: forgiveAfter },
        collect: opts.collect,
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

  /**
   * S17 R11 (audit 4 #7) — after a won dispute has moved its own payment's
   * units, the share of each of that payment's ENDED windows a stand-alone
   * payment (a resubscription) was handed while the dispute stood is
   * reconciled too: the month is its own payment's again, so what the
   * customer spent out of the hand-over has moved home (R10), and what the
   * hand-over's payment was charged for spending it — a refund of it while
   * the dispute stood — follows (the window running now is `reconcileWindowUnits`'s).
   */
  async reconcileHandedShares(
    tx: CreditLedgerTx,
    accountId: string,
    wonRef: string,
    event: CreditUnitEvent,
    collect?: TwinCredit[],
  ): Promise<{ readonly regrantedMicro: number; readonly forgivenMicro: number }> {
    const { windows } = this.deps;
    const ended = (await windows.windowsOfCoverage(tx, accountId, 'stripe_invoice', wonRef)).filter(
      (w) => !w.current && w.sourceRef === wonRef,
    );
    const handed = await windows.handedStripePayments(
      tx,
      accountId,
      ended.map((w) => w.id),
    );
    const byRef = new Map<string, string[]>();
    for (const h of handed)
      byRef.set(h.stripeInvoiceId, [...(byRef.get(h.stripeInvoiceId) ?? []), h.windowId]);
    let regranted = 0;
    let forgiven = 0;
    for (const [ref, windowIds] of byRef) {
      const facts = await windows.invoicePayment(tx, accountId, ref);
      if (facts === null) continue;
      const done = await this.reconcilePaymentUnits(
        tx,
        accountId,
        { source: 'stripe_invoice', sourceRef: ref },
        invoiceTerms(facts),
        {
          mode: 'both',
          event: { ...event, disputedMinor: undefined },
          onlyWindowIds: windowIds,
          standsAlone: true,
          cap: 'standing',
          collect,
        },
      );
      regranted = regranted + done.regrantedMicro;
      forgiven = forgiven + done.forgivenMicro;
    }
    return { regrantedMicro: regranted, forgivenMicro: forgiven };
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
      /** A win: where each credit it gives back into a live lot is recorded. */
      readonly collect?: TwinCredit[];
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
      collect: input.collect,
      extras: {
        capSpentMicro: null,
        ledgerMark: await windows.ledgerMark(tx, accountId),
        claimForgiveAfterMicro: null,
      },
    });
  }

  /**
   * S17 audit 4 (R9, R1') — a won dispute's clawbacks, just reversed, give back
   * what they charged BEYOND their units' lots, each by what became of it:
   * debt still owed is forgiven; debt later credit repaid, and claims collected
   * from lots that are not the unit's, go back into those very lots while they
   * are live, lasting as long as they do; debt repaid out of a lot that has
   * since expired, and debt something else forgave (an admin), give nothing
   * back — the credit is gone either way, exactly where a twin without the
   * dispute stands. Keyed to the clawback (`…:undo:<clawback>:…`), so a replay
   * writes nothing twice. Called under the account's credit lock.
   */
  async undoReversedClawbacks(
    tx: CreditLedgerTx,
    accountId: string,
    reversed: readonly CreditClawbackRecord[],
    collect?: TwinCredit[],
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
    let regranted = 0;
    let forgiven = 0;
    for (const [targetKey, group] of byUnit) {
      const unit = parseUnitTargetKey(targetKey);
      const window = unit === null ? undefined : unitWindows.get(unit.windowId);
      if (unit === null || window === undefined) continue;
      const state = await this.unitState(tx, accountId, window, {
        source: 'stripe_invoice',
        sourceRef: unit.coverageRef,
      });
      const prefix = unitGivebackPrefix(targetKey);
      for (const c of group) {
        const charge = state.charges.find((x) => x.clawback.id === c.id);
        if (charge === undefined) continue;
        const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
        const forgive = Math.min(charge.outstandingMicro, owed);
        if (forgive > 0) {
          await ledger.append(
            {
              accountId,
              kind: 'adjustment',
              forgiveDebtMicro: forgive,
              idempotencyKey: `${prefix}undo:${c.id}:forgive`,
              reason: 'dispute_reinstated',
            },
            tx,
          );
          forgiven = forgiven + forgive;
        }
        const collected = await this.twinClaimsOf(tx, accountId, charge.collectedLeft);
        regranted =
          regranted +
          (await this.returnParts(
            tx,
            accountId,
            [
              ...charge.repaidLeft.map((p) => ({ ...p, key: `${prefix}undo:${c.id}:returned` })),
              ...collected.map((p) => ({
                ...p,
                key: `${prefix}undo:${c.id}:unclaimed`,
                twinKey: `undo:${c.id}`,
              })),
            ],
            Number.MAX_SAFE_INTEGER,
            collect === undefined ? undefined : { into: collect, originUnit: targetKey },
          ));
      }
    }
    return { regrantedMicro: regranted, forgivenMicro: forgiven };
  }

  /**
   * S17 audit 4 — a won dispute's claim collected credit a settling task
   * released. A twin without the dispute had no such claim, so that same
   * settlement paid its OTHER claims with the credit instead — each one that
   * already stood then and still stands now, oldest first, as a settlement
   * pays them. So each part the dispute's claim collected carries the claims
   * the twin paid out of it (`twin`): `returnParts` puts the part back into
   * its lot and collects those claims from it again, with a row of the shape a
   * settlement writes (`claim:<claim>:<task>:<lot>:undo:<clawback>`), so the
   * claim's unit reads it as collected exactly as the twin's. Plans only; the
   * rows are written by `returnParts`.
   */
  private async twinClaimsOf(
    tx: CreditLedgerTx,
    accountId: string,
    parts: readonly LotPart[],
  ): Promise<(LotPart & { readonly twin?: TwinClaimPay[] })[]> {
    const planned: (LotPart & { twin?: TwinClaimPay[] })[] = parts
      .filter((p) => p.micro > 0)
      .map((p) => ({ ...p }));
    if (planned.every((p) => p.reservationId === undefined || p.since === undefined)) {
      return planned;
    }
    const claims = (await this.deps.windows.standingClaims(tx, accountId)).map((q) => ({
      ...q,
      owed: q.pendingMicro,
    }));
    for (const p of planned) {
      const since = p.since;
      const task = p.reservationId;
      if (since === undefined || task === undefined) continue;
      let free = p.micro;
      for (const q of claims) {
        if (free <= 0) break;
        if (q.owed <= 0) continue;
        const stoodThen = q.ledgerMark !== null ? q.ledgerMark < since.id : q.createdAt < since.at;
        if (!stoodThen) continue;
        const pay = Math.min(free, q.owed);
        p.twin = [...(p.twin ?? []), { claimId: q.id, source: q.source, task, micro: pay }];
        q.owed = q.owed - pay;
        free = free - pay;
      }
    }
    return planned;
  }

  /**
   * S17 audit 4 — a won dispute's claims on held credit are zeroed with it.
   * A reversal measured while they stood found that held credit already
   * claimed, so what it could not take free it wrote as DEBT where a twin
   * without the dispute made a CLAIM (paid when the task releases the credit,
   * which would otherwise expire). So, on each unit whose claims the win
   * freed, as much of its standing charges' debt as the freed held credit now
   * covers becomes a claim again: that debt is given back (forgiven while
   * owed, returned into the lots that repaid it), and the same amount is taken
   * as a pending claim (`<event>:reclaim`). Where the unit stands is unchanged;
   * what it is charged in is the twin's.
   */
  async reclaimDebtAsClaims(
    tx: CreditLedgerTx,
    accountId: string,
    targetKeys: readonly string[],
    event: CreditUnitEvent,
    collect?: TwinCredit[],
  ): Promise<void> {
    const { ledger, windows } = this.deps;
    const units = [...new Set(targetKeys)]
      .map((k) => ({ key: k, unit: parseUnitTargetKey(k) }))
      .filter((u) => u.unit !== null);
    if (units.length === 0) return;
    const found = new Map(
      (
        await windows.windowsByIds(
          tx,
          accountId,
          units.map((u) => u.unit?.windowId ?? ''),
        )
      ).map((w) => [w.id, w]),
    );
    for (const { key, unit } of units) {
      const window = unit === null ? undefined : found.get(unit.windowId);
      if (unit === null || window === undefined) continue;
      const coverage = { source: 'stripe_invoice' as const, sourceRef: unit.coverageRef };
      const state = await this.unitState(tx, accountId, window, coverage);
      let debt = 0;
      for (const c of state.charges) {
        if (!c.standing || c.clawback.sourceRef.startsWith('hold:')) continue;
        debt = debt + c.outstandingMicro;
        for (const p of c.repaidLeft) debt = debt + p.micro;
      }
      if (debt <= 0) continue;
      const claimable = Math.max(
        0,
        (await ledger.heldMicro(accountId, tx)) -
          (await windows.pendingClaimTotalMicro(tx, accountId)),
      );
      const convert = Math.min(debt, claimable);
      if (convert <= 0) continue;
      const reclaim: CreditUnitEvent = {
        ...event,
        ref: `${event.ref}:reclaim`,
        disputedMinor: undefined,
      };
      const ref = `${state.targetKey}:${reclaim.ref}`;
      let left = convert;
      let outstanding = 0;
      for (const c of state.charges) if (c.standing) outstanding = outstanding + c.outstandingMicro;
      const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
      const forgive = Math.min(left, outstanding, owed);
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
        left = left - forgive;
      }
      const parts: { lotId: string; micro: number; key: string; since?: LedgerPoint }[] = [];
      for (const c of [...state.charges].reverse()) {
        if (!c.standing) continue;
        for (const p of [...c.repaidLeft].reverse()) {
          parts.push({
            lotId: p.lotId,
            micro: p.micro,
            key: `${reinstateGrantKey(ref)}:returned`,
            since: p.since,
          });
        }
      }
      const returned = await this.returnParts(
        tx,
        accountId,
        parts,
        left,
        collect === undefined ? undefined : { into: collect, originUnit: key },
      );
      const given = forgive + returned;
      if (given <= 0) continue;
      const mark = await windows.ledgerMark(tx, accountId);
      await this.clawBack(tx, accountId, {
        source: reclaim.source,
        sourceRef: reclaim.ref,
        targetKey: state.targetKey,
        windowId: state.windowId,
        amountMicro: given,
        ledgerKind: reclaim.ledgerKind,
        debtReason: reclaim.debtReason,
        ledgerKeyPrefix: `clawback:${reclaim.source}:${reclaim.ref}:${state.targetKey}`,
        // Nothing free is taken: the debt becomes a claim on held credit.
        targets: state.lots.map((l) => ({ ...l, remainingMicro: l.heldMicro })),
        settle: false,
        capSpentMicro: null,
        ledgerMark: mark,
        claimForgiveAfterMicro: null,
      });
    }
  }

  /**
   * S17 audit 4 — the last step of a win, before its debt is settled. Each
   * credit the win gave back into a live lot is credit a twin without the
   * dispute had held there since the dispute took it (`TwinCredit`). Meanwhile
   * the account went on: another payment's take found that lot short and wrote
   * debt, a settlement found it short and repaid out of later lots or left
   * debt owed. So the account's debt settlements since are replayed as the
   * twin made them (`twinSettlements`), and what the twin did differently is
   * written: the credit a take or a settlement would have used is taken out of
   * the lot again (a late take on that clawback, or a repayment keyed
   * `…:rs:paid:<lot>`), what the account repaid out of later lots that the twin
   * did not goes back into them (`…:rs:returned:<lot>`), and debt the twin no
   * longer owed is forgiven (`…:rs:forgive`). Keyed to the win, so a replay
   * writes nothing twice.
   */
  async resettleAsTwin(
    tx: CreditLedgerTx,
    accountId: string,
    credits: readonly TwinCredit[],
    reversedIds: readonly string[],
    eventRef: string,
  ): Promise<void> {
    if (credits.length === 0) return;
    const { ledger, windows } = this.deps;
    const events = await windows.debtEvents(tx, accountId);
    const clawbacks = await windows.accountClawbacks(tx, accountId);
    const { rowOwners } = followDebt(events, clawbacks, new Map());
    const byId = new Map(clawbacks.map((c) => [c.id, c]));
    const ownerUnit = new Map<string, string | null>(
      clawbacks.map((c) => [c.id, parseUnitTargetKey(c.targetKey) === null ? null : c.targetKey]),
    );
    let earliest = (credits[0] as TwinCredit).since;
    for (const c of credits) if (isAfter(earliest, c.since)) earliest = c.since;
    const unitLots = new Map<string, Set<string>>();
    const lotIds = new Set(credits.map((c) => c.lotId));
    for (const e of events) {
      if (!isAfter(e, earliest)) continue;
      if (e.lotId !== null) lotIds.add(e.lotId);
      if (e.debtDeltaMicro <= 0) continue;
      const owner = rowOwners.get(e.id)?.[0]?.owner ?? null;
      const unit = owner === null ? null : (ownerUnit.get(owner) ?? null);
      if (unit === null || unitLots.has(unit)) continue;
      const own = new Set((await unitLotsForSettle(tx, accountId, unit)).map((l) => l.lotId));
      unitLots.set(unit, own);
      for (const id of own) lotIds.add(id);
    }
    const lotRows = await windows.lotsForReturn(tx, accountId, [...lotIds]);
    const lots = new Map(
      lotRows.map((l) => [
        l.lotId,
        { lotId: l.lotId, spendRank: l.spendRank, expiresAt: l.expiresAt, createdAt: l.createdAt },
      ]),
    );
    // Debt the win itself gave back — forgave, or returned into the lots that
    // repaid it — was the dispute's doing (a charge measured while it stood, a
    // hand-over it caused): the twin never owed it, whoever wrote it.
    const undoneUnits = new Set(
      credits.filter((c) => c.kind === 'returned').map((c) => c.originUnit),
    );
    for (const e of events) {
      if (e.debtDeltaMicro >= 0 || e.lotId !== null) continue;
      if (!e.key.includes(`:${eventRef}:`) && !UNDO_KEY.test(e.key)) continue;
      const unit = UNIT_GIVEBACK_KEY.exec(e.key)?.[1];
      if (unit !== undefined) undoneUnits.add(unit);
    }
    const excluded = new Set(reversedIds);
    for (const c of clawbacks) if (undoneUnits.has(c.targetKey)) excluded.add(c.id);
    const found = twinSettlements({
      events,
      rowOwners,
      ownerUnit,
      excluded,
      credits,
      lots,
      unitLots,
      now: await windows.databaseNow(tx),
    });

    const fallback = (credits[0] as TwinCredit).originUnit;
    const unitFor = (owner: string | null): string =>
      (owner === null ? null : (ownerUnit.get(owner) ?? null)) ?? fallback;
    const live = new Map(lotRows.map((l) => [l.lotId, l]));
    const sum = <K extends string>(rows: readonly { key: K; micro: number }[]): Map<K, number> => {
      const m = new Map<K, number>();
      for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + r.micro);
      return m;
    };
    const rs = `${eventRef}:rs`;
    for (const [k, micro] of sum(
      found.unrepaid.map((u) => ({ key: `${unitFor(u.owner)}|${u.lotId}`, micro: u.micro })),
    )) {
      const [unit, lotId] = k.split('|') as [string, string];
      const lot = live.get(lotId);
      if (lot === undefined || (!lot.live && !lot.expired)) continue;
      await this.giveInto(
        tx,
        accountId,
        lotId,
        micro,
        `${unitGivebackPrefix(unit)}${rs}:returned:${lotId}`,
        !lot.live,
      );
    }
    for (const [k, micro] of sum(
      found.lateTakes.map((t) => ({ key: `${t.owner}|${t.lotId}`, micro: t.micro })),
    )) {
      const [owner, lotId] = k.split('|') as [string, string];
      await ledger.append(
        {
          accountId,
          kind:
            byId.get(owner)?.source === 'plan_change' ? 'proration_clawback' : 'refund_clawback',
          lotId,
          amountMicro: micro,
          idempotencyKey: `resettle:${eventRef}:take:${owner}:${lotId}`,
          reason: byId.get(owner)?.source ?? 'stripe_dispute',
        },
        tx,
      );
    }
    for (const [k, micro] of sum(
      found.paid.map((p) => ({
        key: `${p.origin === '' ? fallback : p.origin}|${p.lotId}`,
        micro: p.micro,
      })),
    )) {
      const [unit, lotId] = k.split('|') as [string, string];
      await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          lotId,
          lotDeltaMicro: -micro,
          idempotencyKey: `${unitGivebackPrefix(unit)}${rs}:paid:${lotId}`,
          reason: 'dispute_reinstated',
        },
        tx,
      );
    }
    for (const [unit, micro] of sum(
      found.forgive.map((f) => ({ key: unitFor(f.owner), micro: f.micro })),
    )) {
      const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
      const forgive = Math.min(micro, owed);
      if (forgive <= 0) continue;
      await ledger.append(
        {
          accountId,
          kind: 'adjustment',
          forgiveDebtMicro: forgive,
          idempotencyKey: `${unitGivebackPrefix(unit)}${rs}:forgive`,
          reason: 'dispute_reinstated',
        },
        tx,
      );
    }
  }

  /**
   * Credit back into the lots it came out of — `<key>:<lot>` each — while the
   * lot has room. A live lot keeps it for its own term (R1'). A lot that has
   * EXPIRED gets it and gives it up again at once (`giveInto`): the customer
   * gains nothing — what it paid would have expired with it, exactly as in a
   * twin where it never paid — and the lot's spending reads as its twin's. A
   * revoked lot gets nothing. Returns what the customer can spend of it.
   */
  private async returnParts(
    tx: CreditLedgerTx,
    accountId: string,
    parts: readonly {
      readonly lotId: string;
      readonly micro: number;
      readonly key: string;
      readonly since?: LedgerPoint;
      /** Claims a twin paid out of this part (`twinClaimsOf`), collected again once it is back. */
      readonly twin?: readonly TwinClaimPay[];
      readonly twinKey?: string;
    }[],
    budgetMicro: number = Number.MAX_SAFE_INTEGER,
    collect?: { readonly into: TwinCredit[]; readonly originUnit: string },
  ): Promise<number> {
    const { ledger, windows } = this.deps;
    const wanted = parts.filter((p) => p.micro > 0);
    if (wanted.length === 0 || budgetMicro <= 0) return 0;
    const lots = new Map(
      (await windows.lotsForReturn(tx, accountId, [...new Set(wanted.map((p) => p.lotId))])).map(
        (l) => [l.lotId, l],
      ),
    );
    const into = new Map<
      string,
      {
        key: string;
        lotId: string;
        micro: number;
        live: boolean;
        recollect: { pay: TwinClaimPay; key: string }[];
      }
    >();
    const usedRoom = new Map<string, number>();
    let left = budgetMicro;
    for (const p of wanted) {
      if (left <= 0) break;
      const lot = lots.get(p.lotId);
      if (lot === undefined || (!lot.live && !lot.expired)) continue;
      const room = lot.roomMicro - (usedRoom.get(p.lotId) ?? 0);
      const give = Math.min(left, p.micro, room);
      if (give <= 0) continue;
      let recollect = 0;
      const again: { pay: TwinClaimPay; key: string }[] = [];
      for (const pay of p.twin ?? []) {
        const micro = Math.min(pay.micro, give - recollect);
        if (micro <= 0) break;
        again.push({
          pay: { ...pay, micro },
          key: `claim:${pay.claimId}:${pay.task}:${p.lotId}:${p.twinKey ?? 'undo'}`,
        });
        recollect = recollect + micro;
      }
      const k = `${p.key}:${p.lotId}`;
      const had = into.get(k);
      into.set(k, {
        key: k,
        lotId: p.lotId,
        micro: (had?.micro ?? 0) + give,
        live: lot.live,
        recollect: [...(had?.recollect ?? []), ...again],
      });
      usedRoom.set(p.lotId, (usedRoom.get(p.lotId) ?? 0) + give);
      left = left - give;
      if (collect !== undefined && lot.live && p.since !== undefined && give > recollect) {
        collect.into.push({
          lotId: p.lotId,
          micro: give - recollect,
          since: p.since,
          originUnit: collect.originUnit,
          kind: 'returned',
        });
      }
    }
    let given = 0;
    let expired = 0;
    for (const row of into.values()) {
      await this.giveInto(tx, accountId, row.lotId, row.micro, row.key, false);
      let recollected = 0;
      const byKey = new Map<string, { pay: TwinClaimPay; micro: number }>();
      for (const r of row.recollect) {
        const had = byKey.get(r.key);
        byKey.set(r.key, { pay: r.pay, micro: (had?.micro ?? 0) + r.pay.micro });
      }
      for (const [key, r] of byKey) {
        await ledger.append(
          {
            accountId,
            kind: r.pay.source === 'plan_change' ? 'proration_clawback' : 'refund_clawback',
            lotId: row.lotId,
            amountMicro: r.micro,
            idempotencyKey: key,
            reason: r.pay.source,
          },
          tx,
        );
        await windows.releasePendingClaim(tx, r.pay.claimId, r.micro);
        recollected = recollected + r.micro;
      }
      const keep = row.micro - recollected;
      if (!row.live && keep > 0) {
        await ledger.append(
          {
            accountId,
            kind: 'expiry',
            lotId: row.lotId,
            amountMicro: keep,
            idempotencyKey: `${row.key}:expired`,
          },
          tx,
        );
      }
      if (row.live) given = given + keep;
      else expired = expired + keep;
    }
    if (expired > 0) {
      this.deps.logger?.warn(
        { component: 'credit-grants', event: 'returned_credit_already_expired', accountId },
        'credit that repaid debt came from a lot that has since expired; it was not returned (R1: it would have expired anyway)',
      );
    }
    return given;
  }

  /**
   * One give-back row into one lot; into a lot whose term has ended, followed
   * by its expiry in the same transaction, so nothing is left for a refresh to
   * expire and the customer gains nothing they could spend.
   */
  private async giveInto(
    tx: CreditLedgerTx,
    accountId: string,
    lotId: string,
    micro: number,
    key: string,
    expired: boolean,
  ): Promise<void> {
    const { ledger } = this.deps;
    await ledger.append(
      {
        accountId,
        kind: 'adjustment',
        lotId,
        lotDeltaMicro: micro,
        idempotencyKey: key,
        reason: 'dispute_reinstated',
      },
      tx,
    );
    if (expired) {
      await ledger.append(
        { accountId, kind: 'expiry', lotId, amountMicro: micro, idempotencyKey: `${key}:expired` },
        tx,
      );
    }
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
    state: UnitState,
    target: number,
    opts: {
      readonly mode: 'take' | 'both';
      readonly event: CreditUnitEvent;
      readonly extras: ClawbackExtras;
      readonly collect?: TwinCredit[] | undefined;
    },
  ): Promise<{
    clawback: CreditClawbackRecord | null;
    regrantedMicro: number;
    forgivenMicro: number;
  }> {
    const delta = positionOf(state) - target;
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
      return { clawback, regrantedMicro: 0, forgivenMicro: 0 };
    }
    if (delta === 0 || opts.mode === 'take') {
      return { clawback: null, regrantedMicro: 0, forgivenMicro: 0 };
    }
    const given = await this.giveBack(tx, accountId, state, -delta, opts.event, opts.collect);
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
      disputedMinor: suffix === '' ? (event.disputedMinor ?? null) : null,
      settle: false,
      ...extras,
    });
  }

  /**
   * Give `amountMicro` back to one unit, in the order the charge was made
   * beyond its lots and then into them — each part to the very lot it came
   * out of, so the account a give-back leaves is the one it would have held
   * had the charge never been made (the lots, not only their sum, and so the
   * order credit is spent in):
   *
   *   1. while the month runs, its standing claims on held credit are
   *      released. Once the month has ended they are not (audit 4 #6): the
   *      held credit a claim stands on expires when the task releases it, so
   *      releasing the claim gives nothing back and only lets the task spend
   *      it free of the debt the claim stood for;
   *   2. what its standing clawbacks charged beyond its lots, by what became
   *      of it (`debtFates`, R9): debt still owed is forgiven; debt later
   *      credit repaid, and claims collected from other lots, go back into
   *      those lots while they are live (R1': lasting as long as they do); and
   *      what a lot that has expired repaid, or an admin forgave, gives nothing
   *      back — it is part of what is given back all the same;
   *   3. credit moved to the lots the customer's spending fell on while the
   *      unit's credit stood taken (R10): what they spent from lots after the
   *      unit's own in the spend order, since its first take and before its
   *      window ended, LAST in the spend order first — the lots a twin whose
   *      credit was never taken would not have reached;
   *   4. the rest back into the unit's own lots that gave it up, while the
   *      month runs. A month that has ENDED gets nothing of it back: it would
   *      have expired with the month (M6).
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
    collect?: TwinCredit[],
  ): Promise<{ regrantedMicro: number; forgivenMicro: number }> {
    const { ledger, windows } = this.deps;
    const ref = `${state.targetKey}:${event.ref}`;
    const key = reinstateGrantKey(ref);
    let left = amountMicro;
    const standing = state.charges.filter((c) => c.standing);

    if (state.live) {
      for (const c of standing) {
        if (left <= 0) break;
        if (c.clawback.pendingMicro <= 0) continue;
        const release = Math.min(left, c.clawback.pendingMicro);
        await windows.releasePendingClaim(tx, c.clawback.id, release);
        left = left - release;
      }
    }

    let forgivenMicro = 0;
    let regrantedMicro = 0;
    let beyond = 0;
    for (const c of standing) beyond = beyond + chargedBeyond(c);
    const part = Math.min(left, beyond);
    if (part > 0) {
      let partLeft = part;
      let outstanding = 0;
      for (const c of standing) outstanding = outstanding + c.outstandingMicro;
      const owed = (await ledger.lockAccount(tx, accountId)).debtMicro;
      const forgive = Math.min(partLeft, outstanding, owed);
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
        forgivenMicro = forgive;
        partLeft = partLeft - forgive;
      }
      // Newest charge first, and within it what was repaid or collected last.
      const parts: { lotId: string; micro: number; key: string; since?: LedgerPoint }[] = [];
      for (const c of [...standing].reverse()) {
        for (const p of [...c.collectedLeft].reverse()) {
          parts.push({ lotId: p.lotId, micro: p.micro, key: `${key}:unclaimed`, since: p.since });
        }
        for (const p of [...c.repaidLeft].reverse()) {
          parts.push({ lotId: p.lotId, micro: p.micro, key: `${key}:returned`, since: p.since });
        }
      }
      regrantedMicro =
        regrantedMicro +
        (await this.returnParts(
          tx,
          accountId,
          parts,
          partLeft,
          collect === undefined ? undefined : { into: collect, originUnit: state.targetKey },
        ));
      left = left - part;
    }

    if (left > 0) {
      const moved = await this.moveToWhereSpendingFell(
        tx,
        accountId,
        state,
        left,
        key,
        event,
        collect,
      );
      regrantedMicro = regrantedMicro + moved;
      left = left - moved;
    }
    if (left > 0 && state.live) {
      regrantedMicro =
        regrantedMicro + (await this.restoreTaken(tx, accountId, state, left, ref, event, collect));
    }
    return { regrantedMicro, forgivenMicro };
  }

  /**
   * Step 3 of a give-back (R10, audit 4 #5): while the unit's credit stood
   * taken, the customer's tasks fell through to other lots — a top-up,
   * goodwill, another payment's share. A twin whose credit was never taken
   * held and spent that much more of the unit's own lots instead.
   *
   * So the tasks started since the take (and before the window ended) are
   * walked in the order they started: the free credit the reversed takes
   * removed is what each could not find on the unit's lots, so each task's
   * holds on lots after the unit's in the spend order take up as much of it as
   * they hold, until it is used up. What a SETTLED task was charged of that
   * share goes back into the lots it was charged from (the share it released
   * went back to them already; it is the unit's to have back, and the caller
   * restores it while the month runs). A task STILL RUNNING has its share
   * given back into the lots it holds now, as if it will spend it all, and a
   * record (`hold:<task>:…`) tells its settlement to take back what it did not
   * spend (`applyHoldRedirects`, credit-reservations.ts). A lot that has
   * expired takes the credit and expires it again at once. What is given
   * counts as the unit's own spending. Returns what the give-back placed.
   */
  private async moveToWhereSpendingFell(
    tx: CreditLedgerTx,
    accountId: string,
    state: UnitState,
    micro: number,
    key: string,
    event: CreditUnitEvent,
    collect?: TwinCredit[],
  ): Promise<number> {
    const { windows } = this.deps;
    const takes = state.charges
      .filter(
        (c) =>
          !c.standing && !c.clawback.sourceRef.startsWith('hold:') && c.clawback.clawedMicro > 0,
      )
      .map((c) => ({ at: c.clawback.createdAt, micro: c.clawback.clawedMicro }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const first = firstInSpendOrder(state.lots);
    const earliest = takes[0];
    if (earliest === undefined || first === null) return 0;
    const unitLotIds = new Set(state.lots.map((l) => l.lotId));
    const recorded = new Map<string, number>();
    for (const c of state.charges) {
      if (!c.clawback.sourceRef.startsWith('hold:')) continue;
      const task = c.clawback.sourceRef.split(':')[1] ?? '';
      recorded.set(task, (recorded.get(task) ?? 0) + (c.clawback.amountMicro ?? 0));
    }
    const afterUnit = (h: ReservationHold): boolean =>
      h.spendRank > first.spendRank ||
      (h.spendRank === first.spendRank &&
        (h.expiresAt > first.expiresAt ||
          (h.expiresAt === first.expiresAt &&
            (h.lotCreatedAt > first.createdAt ||
              (h.lotCreatedAt === first.createdAt && h.lotId > first.lotId)))));
    const tasks = await windows.reservationsSince(tx, accountId, {
      since: earliest.at,
      before: state.live ? null : state.windowEnd,
    });

    let unfound = 0;
    let nextTake = 0;
    let budget = micro;
    const spentOutside = new Map<
      string,
      { hold: ReservationHold; micro: number; since: PgInstant }
    >();
    const plans: {
      reservationId: string;
      startedAt: PgInstant;
      share: number;
      open: boolean;
      parts: { lotId: string; micro: number }[];
    }[] = [];
    for (const task of tasks) {
      while (nextTake < takes.length && (takes[nextTake]?.at ?? '') <= task.startedAt) {
        unfound = unfound + (takes[nextTake]?.micro ?? 0);
        nextTake = nextTake + 1;
      }
      const already = recorded.get(task.reservationId);
      if (already !== undefined) {
        unfound = Math.max(0, unfound - already);
        continue;
      }
      const outside = task.holds.filter((h) => !unitLotIds.has(h.lotId) && afterUnit(h));
      let outsideHeld = 0;
      for (const h of outside) outsideHeld = outsideHeld + h.heldMicro;
      const share = Math.min(outsideHeld, unfound, budget);
      if (share <= 0) continue;
      unfound = unfound - share;
      let place = share;
      if (!task.open) {
        let charged = 0;
        let chargedOnUnit = 0;
        for (const h of task.holds) {
          charged = charged + h.chargedMicro;
          if (unitLotIds.has(h.lotId)) chargedOnUnit = chargedOnUnit + h.chargedMicro;
        }
        place = Math.min(share, Math.max(0, charged - chargedOnUnit));
      }
      // A twin whose credit was never taken drew on the unit's lots FIRST, so
      // the holds it would not have made are the task's LAST in the spend order.
      const parts: { lotId: string; micro: number }[] = [];
      let rest = place;
      for (const h of [...outside].reverse()) {
        if (rest <= 0) break;
        const part = Math.min(rest, task.open ? h.heldMicro : h.chargedMicro);
        if (part <= 0) continue;
        parts.push({ lotId: h.lotId, micro: part });
        rest = rest - part;
      }
      budget = budget - (place - rest);
      plans.push({
        reservationId: task.reservationId,
        startedAt: task.startedAt,
        share,
        open: task.open,
        parts,
      });
      if (!task.open) {
        for (const h of outside) {
          if (h.chargedMicro <= 0) continue;
          const had = spentOutside.get(h.lotId);
          spentOutside.set(h.lotId, {
            hold: h,
            micro: (had?.micro ?? 0) + h.chargedMicro,
            since: had?.since ?? task.startedAt,
          });
        }
      }
    }
    if (plans.length === 0) return 0;

    // What SETTLED tasks spent outside the unit is one pool: a twin whose
    // credit was never taken spent less there in all, and what it did spend
    // fell first in the spend order (one task's spending left free what a
    // later one then reached). So their shares, together, go back into the
    // lots LAST in the spend order first — each at most what was spent there.
    let pooled = 0;
    for (const plan of plans) {
      if (plan.open) continue;
      for (const part of plan.parts) pooled = pooled + part.micro;
    }
    const settledParts: {
      reservationId: string;
      startedAt: PgInstant;
      share: number;
      open: boolean;
      parts: { lotId: string; micro: number }[];
    }[] = [];
    const lastFirst = [...spentOutside.values()].sort((a, b) => -holdSpendOrder(a.hold, b.hold));
    for (const spent of lastFirst) {
      if (pooled <= 0) break;
      const part = Math.min(pooled, spent.micro);
      if (part <= 0) continue;
      settledParts.push({
        reservationId: '',
        startedAt: spent.since,
        share: 0,
        open: false,
        parts: [{ lotId: spent.hold.lotId, micro: part }],
      });
      pooled = pooled - part;
    }

    const lotIds = [
      ...new Set([...plans, ...settledParts].flatMap((p) => p.parts.map((x) => x.lotId))),
    ];
    const lots = new Map(
      (await windows.lotsForReturn(tx, accountId, lotIds)).map((l) => [l.lotId, l]),
    );
    const usedRoom = new Map<string, number>();
    const into = new Map<string, { micro: number; expired: boolean }>();
    let placed = 0;
    // Settled tasks first: what they were charged made room in the lots it came
    // out of; a task still running has no such room of its own.
    const ordered = [...settledParts, ...plans.filter((p) => p.open)];
    for (const plan of ordered) {
      for (const part of plan.parts) {
        const lot = lots.get(part.lotId);
        if (lot === undefined || (!lot.live && !lot.expired)) continue;
        const room = Math.max(0, lot.roomMicro - (usedRoom.get(part.lotId) ?? 0));
        const fits = Math.min(part.micro, room);
        if (fits > 0) {
          usedRoom.set(part.lotId, (usedRoom.get(part.lotId) ?? 0) + fits);
          const had = into.get(part.lotId);
          into.set(part.lotId, { micro: (had?.micro ?? 0) + fits, expired: !lot.live });
          placed = placed + fits;
          // A settled task's spending: the twin had this credit on the lot from
          // when the task began.
          if (collect !== undefined && lot.live && !plan.open) {
            collect.push({
              lotId: part.lotId,
              micro: fits,
              since: { at: plan.startedAt, id: 0 },
              originUnit: state.targetKey,
              kind: 'moved',
            });
          }
        }
        // A task still running holds that share on a lot with too little
        // room below its grant to take it (holding does not lower what a lot
        // has left): the rest waits beside it, in a lot of the same term, for
        // the task's settlement to empty (`applyHoldRedirects`).
        const over = part.micro - fits;
        if (over > 0 && plan.open && lot.live) {
          placed =
            placed +
            (await this.overflowLot(tx, accountId, {
              reservationId: plan.reservationId,
              besideLotId: part.lotId,
              expiresAt: lot.expiresAt,
              targetKey: state.targetKey,
              micro: over,
              key,
            }));
        }
      }
    }
    for (const [lotId, row] of into) {
      await this.giveInto(tx, accountId, lotId, row.micro, `${key}:moved:${lotId}`, row.expired);
    }
    const mark = await windows.ledgerMark(tx, accountId);
    for (const plan of plans) {
      await windows.recordHoldRedirect(tx, {
        accountId,
        source: event.source,
        reservationId: plan.reservationId,
        eventRef: event.ref,
        targetKey: state.targetKey,
        amountMicro: plan.share,
        open: plan.open,
        ledgerMark: mark,
      });
    }
    return placed;
  }

  /**
   * The lot a running task's redirected share waits in when the lot it holds
   * has no room for it (`hold:<task>:<lot>:<unit>`): an adjustment lot with
   * that lot's term, funded under the unit's give-back prefix as credit moved
   * for the unit (so it counts as the unit's spending), which the task's
   * settlement empties. Not a unit's lot: its key is not under a give-back
   * prefix. Returns what it holds.
   */
  private async overflowLot(
    tx: CreditLedgerTx,
    accountId: string,
    input: {
      readonly reservationId: string;
      readonly besideLotId: string;
      readonly expiresAt: PgInstant;
      readonly targetKey: string;
      readonly micro: number;
      readonly key: string;
    },
  ): Promise<number> {
    const { ledger } = this.deps;
    const inserted = await ledger.insertLot(
      {
        accountId,
        kind: 'adjustment',
        grantKey: holdOverflowGrantKey(input.reservationId, input.besideLotId, input.targetKey),
        grantedMicro: ceilMicroToWholeCredits(input.micro),
        startsAt: floorToPriorMinute(this.now()),
        expiresAt: new Date(input.expiresAt),
      },
      tx,
    );
    const funded = await ledger.append(
      {
        accountId,
        kind: 'adjustment',
        lotId: inserted.lot.id,
        lotDeltaMicro: input.micro,
        idempotencyKey: `${input.key}:moved:${inserted.lot.id}`,
        reason: 'dispute_reinstated',
      },
      tx,
    );
    return funded.applied ? input.micro : 0;
  }

  /**
   * Step 4 of a give-back: `micro` of credit back into the unit's own live
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
    collect?: TwinCredit[],
  ): Promise<number> {
    const { ledger } = this.deps;
    let left = micro;
    let given = 0;
    // The twin kept it from the first take being undone.
    let since: LedgerPoint | null = null;
    for (const c of state.charges) {
      if (c.standing || c.clawback.sourceRef.startsWith('hold:') || c.clawback.clawedMicro <= 0)
        continue;
      const point = { at: c.clawback.createdAt, id: c.clawback.ledgerMark ?? 0 };
      if (since === null || isAfter(since, point)) since = point;
    }
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
      if (collect !== undefined && since !== null) {
        collect.push({
          lotId: lot.lotId,
          micro: fits,
          since,
          originUnit: state.targetKey,
          kind: 'restored',
        });
      }
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
   * charged beyond its lots (`debtFates`), and what a reconciliation already
   * gave back for it or moved to other lots.
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

    const collectedBy = new Map<string, LotPart[]>();
    for (const claim of await windows.collectedClaims(tx, accountId, ownIds)) {
      if (lotIds.has(claim.lotId)) continue;
      const list = collectedBy.get(claim.clawbackId) ?? [];
      list.push({
        lotId: claim.lotId,
        micro: claim.micro,
        since: { at: claim.at, id: claim.id },
        reservationId: claim.reservationId,
      });
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
        repaidLeft: (fate?.repaid ?? []).map((p) => ({
          lotId: p.lotId,
          micro: p.micro,
          since: { at: p.at, id: p.rowId },
        })),
        forgivenOtherMicro:
          fate === undefined
            ? c.debtMicro
            : fate.forgivenOtherMicro + Math.max(0, c.debtMicro - fate.incurredMicro),
        collectedLeft: collectedBy.get(c.id) ?? [],
      };
    });

    let moved = 0;
    const movedByLot = new Map<string, number>();
    for (const row of await windows.unitGivebackRows(tx, accountId, window.id, givebackPrefix)) {
      if (row.lotId === null) continue;
      // A settlement took back what a running task did not spend of what a
      // give-back moved to its lots (`:back:`): no longer the unit's spending.
      if (row.key.includes(':back:')) {
        moved = moved + row.lotDeltaMicro;
        movedByLot.set(row.lotId, (movedByLot.get(row.lotId) ?? 0) + row.lotDeltaMicro);
        continue;
      }
      if (row.lotDeltaMicro <= 0) continue;
      const undo = UNDO_KEY.exec(row.key);
      const owners = undo === null ? charges : charges.filter((c) => c.clawback.id === undo[1]);
      if (row.key.includes(':returned:')) {
        let left = row.lotDeltaMicro;
        for (const c of owners) left = takeFromParts(c.repaidLeft, row.lotId, left);
      } else if (row.key.includes(':unclaimed:')) {
        let left = row.lotDeltaMicro;
        for (const c of owners) left = takeFromParts(c.collectedLeft, row.lotId, left);
      } else if (row.key.includes(':moved:')) {
        moved = moved + row.lotDeltaMicro;
        movedByLot.set(row.lotId, (movedByLot.get(row.lotId) ?? 0) + row.lotDeltaMicro);
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
      movedMicro: moved,
      movedByLot,
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
      capSpentMicro: input.capSpentMicro ?? null,
      ledgerMark: input.ledgerMark ?? null,
      claimForgiveAfterMicro: plan.pendingMicro > 0 ? (input.claimForgiveAfterMicro ?? null) : null,
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
