// Monthly AI credits, granted from PAID coverage.
//
// `refreshCredits(accountId)` is the ONE entry point. Whoever calls it — a
// billing event, a background job, an admin action — gets the same four steps,
// in one transaction, under the account's credit lock:
//
//   1. expire    what is left of every lot whose term has ended (never the part
//                a running task still holds), one ledger row per lot;
//   2. grant     the month window the account's paid coverage earns RIGHT NOW,
//                if it has none: the window, its monthly lot, and the grant row
//                that funds the lot;
//   3. reconcile the current window's level with a plan that changed mid-month:
//                an upgrade's prorated share arrives in a lot of its own, a
//                downgrade takes its share back out of the window's lots;
//   4. settle    any debt from whatever credit is now free. The database refuses
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

import { proratedWholeCreditsMicro, type AiDebtReason } from '@driftstack/api-types';
import type { DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import type {
  CreditDebtRepayment,
  CreditLedgerTx,
  ExpiredCreditLot,
} from '../db/credit-ledger-repo.js';
import {
  CREDIT_WINDOW_SOURCES,
  type ClawbackTargetLot,
  type CreditClawbackKey,
  type CreditClawbackRecord,
  type CreditWindowCandidate,
  type DrizzleCreditWindowsRepo,
  type PgInstant,
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
}

/**
 * The candidate to grant: the highest monthly level; between equals the one
 * that starts earliest; then by source and reference, so the choice never
 * depends on the order the database returned them in. Null for none.
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
  if (a.levelMicro !== b.levelMicro) return a.levelMicro > b.levelMicro ? -1 : 1;
  // Fixed-width UTC text: string order is time order.
  if (a.windowStart !== b.windowStart) return a.windowStart < b.windowStart ? -1 : 1;
  const bySource =
    CREDIT_WINDOW_SOURCES.indexOf(a.source) - CREDIT_WINDOW_SOURCES.indexOf(b.source);
  if (bySource !== 0) return bySource;
  return a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0;
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
   * ⛔ IDEMPOTENT BY THE LEVEL ITSELF, not by remembering. The window carries
   * the level it is at; once it has been moved to the target there is no
   * difference left to prorate, so a second refresh — a redelivered webhook, a
   * sweep, a task's lazy refresh — computes nothing and writes nothing. Behind
   * that, the proration lot's grant key, the level change's `(window, seq)` and
   * the clawback's `(source, source_ref, target)` each refuse a second copy.
   *
   * ⛔ A LAPSE NEVER LOWERS THE LEVEL. An account whose coverage has ended has
   * no target at all, and keeps the month it paid for. What stops it spending
   * is its tier, which is not decided here.
   */
  async reconcileLevel(
    tx: CreditLedgerTx,
    accountId: string,
  ): Promise<CreditLevelReconciled | null> {
    const { ledger, windows } = this.deps;
    const due = await windows.levelReconciliation(tx, accountId);
    if (due === null) return null;

    const seq = due.levelSeq + 1;
    const deltaMicro = proratedWholeCreditsMicro(
      due.targetMicro - due.levelMicro,
      due.remainingMicroseconds,
      due.naturalMicroseconds,
    );
    // The level moves FIRST, and it moves whether or not the prorated share
    // rounds to a whole credit: the level is what the next reconciliation
    // measures against, so a change left unrecorded would be recomputed for
    // ever, and a plan change in the last minutes of a month is worth no
    // credits and is still a plan change.
    await windows.setWindowLevel(tx, {
      accountId,
      windowId: due.windowId,
      seq,
      reason: 'plan_change',
      fromLevelMicro: due.levelMicro,
      toLevelMicro: due.targetMicro,
      effectiveAt: due.effectiveAt,
      deltaMicro,
    });

    let prorationLotId: string | null = null;
    let clawback: CreditClawbackRecord | null = null;
    if (deltaMicro > 0) {
      const lot = await windows.ensureProrationLot(tx, accountId, due.windowId, seq, deltaMicro);
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
        sourceRef: `${due.windowId}:${String(seq)}`,
        targetKey: `window:${due.windowId}`,
        windowId: due.windowId,
        amountMicro: -deltaMicro,
        ledgerKind: 'proration_clawback',
        debtReason: 'plan_change',
      });
    }
    return {
      windowId: due.windowId,
      fromLevelMicro: due.levelMicro,
      toLevelMicro: due.targetMicro,
      seq,
      deltaMicro,
      prorationLotId,
      clawback,
    };
  }

  /**
   * Take credits back from the lots of one window, and record what happened.
   * Shared: a mid-month downgrade calls it, and so will a refund or a dispute
   * (S17), which differ only in what they claw and why the debt is owed.
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
       * (one window per source reference) keys everything by. A refund of an
       * annual invoice claws SEVERAL windows under one source reference, and
       * each window's `debt` row needs a key of its own, so a refund passes a
       * prefix that names the window.
       */
      readonly ledgerKeyPrefix?: string;
    },
  ): Promise<CreditClawbackRecord> {
    const { ledger, windows } = this.deps;
    const already = await windows.findClawback(tx, input);
    if (already !== null) return already;
    const keyOf = (suffix: string): string =>
      input.ledgerKeyPrefix !== undefined
        ? `${input.ledgerKeyPrefix}:${suffix}`
        : clawbackLedgerKey(input, suffix);

    const lots = await windows.clawbackTargets(tx, accountId, input.windowId);
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
    });
    await ledger.settleDebtFromFree(tx, accountId);
    return record;
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
