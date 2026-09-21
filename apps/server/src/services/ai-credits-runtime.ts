// ONE HOME FOR THE AI-CREDITS RUNTIME (S11).
//
// Three things have to agree with each other on every metered turn, and until
// this file existed all three were bootstrap LOCALS that nothing outside
// bootstrap could name:
//
//   · the BOOT ID — the lease owner. A task reserved under one boot id and
//     heartbeat by another renews NOTHING: `renewLeases` filters on
//     `lease_owner = $owner`, so the lease lapses under a process that believes
//     it is keeping it alive, and the keeper settles a task that is still
//     running. Passing the id and the keeper separately is exactly how that
//     happens, so they travel together or not at all.
//   · the RESERVATIONS SERVICE — what opens and settles a task.
//   · the LEASE KEEPER — what keeps a live task's lease alive and finishes the
//     tasks nobody came back for (§4.7, §5.3).
//
// So they are one optional member of `AppDeps`, present only while
// `DRIFTSTACK_AI_CREDITS_MODE` is shadow or enforce, and absent — not null-y
// fields on a present object — while it is off. A route that has the member has
// a complete, consistent runtime; a route that does not has today's code.
//
// ⛔ THE MODE LIVES HERE TOO, AND IT IS NARROWER THAN THE CONFIG'S. `off` is
// unrepresentable: the member is absent instead. A consumer therefore cannot
// write `if (credits.mode !== 'off')` and be wrong about which of the three
// things it is holding.

import type { CreditBoundExceeded, CreditReservationsService } from './credit-reservations.js';
import type { AiCreditLeaseKeeper } from './ai-credit-lease-keeper.js';
import type { AiCreditsReportReader } from '../db/ai-credits-report-repo.js';
import type { CreditAccountRecord, DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import { METRIC_NAMES } from './metrics-registry.js';

/**
 * What a turn asks of the reservations service: open its task, settle it, and
 * the four per-attempt statements the meter drives.
 *
 * ⛔ STRUCTURAL, for the same reason `AgentCreditReservations` is (see
 * agent-credit-meter.ts): a test drives a turn with six functions and no
 * database, and the faults this slice has to survive — a `reserve` that never
 * answers, a `settle` that throws — are trivial to write as functions and
 * awkward to provoke out of a real service. Narrower than the class on purpose:
 * nothing on the turn's path may reach past these six.
 */
export type AiCreditsReservations = Pick<
  CreditReservationsService,
  'reserve' | 'settle' | 'planCall' | 'admitCall' | 'markSent' | 'settleCall'
>;

/**
 * What a turn asks of the lease keeper: say this process is running a task, and
 * say it has stopped. `liveCount` is the reading that makes the second one
 * checkable — M1 is about a set that must always shrink again.
 */
export type AiCreditsLeaseKeeper = Pick<AiCreditLeaseKeeper, 'add' | 'remove' | 'liveCount'>;

/**
 * S12 — what a turn needs to know about ONE account before it decides which
 * leg funds it: `billing_mode` (is this account moved?) and, for a moved
 * account, its chosen `ai_source` (§4.3). `ensureAccount` is the read
 * `reserve()` itself takes under lock; here it runs with no lock, exactly as
 * §4.4 says the tier/source read may ("the tier read takes no lock — it gates
 * the product, not the money"). A route that decided from a stale read would
 * still be safe: `reserve()` re-reads `credit_accounts` under lock and is the
 * only place that ever moves credit.
 */
export type AiCreditsAccounts = Pick<DrizzleCreditLedgerRepo, 'ensureAccount'>;
export type { CreditAccountRecord };

/** The one member of `AppDeps` the credits runtime occupies. Absent while the mode is off. */
export interface AiCreditsRuntime {
  /** Never `off`: with the mode off this whole object is absent. */
  readonly mode: 'shadow' | 'enforce';
  /**
   * This process's boot id, and the lease owner of every task it reserves. The
   * SAME value the keeper was built with — see the header.
   */
  readonly bootId: string;
  readonly reservations: AiCreditsReservations;
  readonly leaseKeeper: AiCreditsLeaseKeeper;
  /**
   * The staff-only shadow report and cutover census (§8). It rides here rather
   * than on its own `AppDeps` member for the same reason the other three do:
   * the routes it feeds exist exactly when the mode is on, and a fourth
   * top-level member would be a fourth thing that could be wired without the
   * rest.
   */
  readonly report: AiCreditsReportReader;
  /**
   * S12 — whether ONE account is moved, and onto which source. See
   * {@link AiCreditsAccounts}. Absent from nothing: every deployment that has
   * an `aiCredits` member at all can answer this, whatever its mode — a
   * shadow-mode route reads `mode` first and never asks.
   */
  readonly accounts: AiCreditsAccounts;
}

/**
 * A shadow database call the turn is WAITING for, bounded by the wall clock.
 *
 * ⛔ IT STOPS THE WAITING AND IT CANNOT STOP THE STATEMENT, which keeps running
 * on the database after the turn has moved on. What it makes true is M3's
 * promise about the TURN — shadow adds no latency beyond a short bounded wait —
 * and nothing about the database's own load.
 *
 * ⛔ AND IT IS THE ONLY BOUND THESE CALLS HAVE. The 2 s `statement_timeout` in
 * credit-reservations.ts is set in ONE place, `reserveShadow`; `planCall`,
 * `admitCall`, `markSent` and `settleCall` set none, and `DB_STATEMENT_TIMEOUT_MS`
 * is optional and unset by default, so there is no per-connection backstop
 * either. Even where a statement timeout does apply it cannot bound a pool that
 * hands out no connection, a socket that never answers, or a promise that never
 * settles — which is exactly the "database unreachable" case shadow mode has to
 * survive without the customer noticing.
 *
 * ⛔ ONE DEFINITION, TWO CALLERS. The route waits for `reserve` and `settle`
 * here; the meter's per-attempt leg waits for `planCall`, `admitCall`,
 * `markSent` and `settleCall` through this same function. A second copy would
 * be a second place for the bound to drift, and M3 is a property of the whole
 * leg, not of one half of it.
 */
export async function withinShadowDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const running = work();
    // We stop WAITING for it; we cannot stop it. A promise nobody is left
    // awaiting must not take the process down with an unhandled rejection.
    void running.catch(() => undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('the AI credit measurement took too long')),
        deadlineMs,
      );
      // A pending measurement must never hold the process open at shutdown.
      timer.unref?.();
    });
    return await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Where a shadow measurement was lost. Closed, and the metric's only label values. */
export type AiCreditsShadowLostLeg = 'reserve' | 'call' | 'turn';

/** The sliver of the metrics registry these counters need. */
export interface AiCreditsCounters {
  inc: (name: string, labels?: Readonly<Record<string, string>>, delta?: number) => void;
}

/**
 * The two counters §8's shadow exit criteria are read from, as the callbacks
 * `CreditReservationsService` and the shadow meter take.
 *
 * ⛔ EVERY INCREMENT IS SWALLOWED. Both callbacks are invoked from inside a
 * measurement that has already promised not to change the turn it is measuring
 * (M3) — one of them from the very handler that is recording a failure. A
 * throwing counter there would turn a lost measurement into a lost turn, which
 * is the single thing shadow mode may not do.
 *
 * ⛔ AND NEITHER CARRIES AN ID. `CreditBoundExceeded` knows the call, the task
 * and the account; none of that may become a label (one never-evicted map entry
 * per account, for the life of the process). The log line beside the emit site
 * carries what an operator needs to find the row.
 */
export function aiCreditsCounters(metrics: AiCreditsCounters | undefined): {
  onShadowLost: (leg: AiCreditsShadowLostLeg) => void;
  onBoundExceeded: (detail: CreditBoundExceeded) => void;
} {
  // ⛔ THE METRIC CONSTANT IS WRITTEN AT THE `.inc(` CALL, not passed in as a
  // name. `emitted-metrics-are-registered-invariant` finds emit sites by
  // scanning for `.inc(METRIC_NAMES.…`, so a helper taking the name as a
  // parameter would hide both of these from the guard that proves they are
  // registered at boot — and an unregistered counter here increments nothing,
  // silently, which is indistinguishable from "this never happens".
  const safely = (emit: () => void): void => {
    try {
      emit();
    } catch {
      // Counting must never become a second way to lose the turn.
    }
  };
  return {
    onShadowLost: (leg) => {
      safely(() => metrics?.inc(METRIC_NAMES.aiCreditsShadowLostTotal, { leg }));
    },
    onBoundExceeded: (detail) => {
      safely(() =>
        metrics?.inc(METRIC_NAMES.aiCreditsBoundExceededTotal, { settle_basis: detail.basis }),
      );
    },
  };
}
