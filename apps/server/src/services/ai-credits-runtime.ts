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
import type { CurrentCreditWindow, DrizzleCreditWindowsRepo } from '../db/credit-windows-repo.js';
import type {
  CreditRateCardReader,
  DrizzleCreditRateCardRepo,
} from '../db/credit-rate-card-repo.js';
import type { DrizzleCreditPlanOverridesRepo } from '../db/credit-plan-overrides-repo.js';
import type { CreditsRefresher } from './credit-grants.js';
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
 *
 * S13 widened this with the other `DrizzleCreditLedgerRepo` reads and the one
 * write the old `bundled-llm-settings`/`-status` routes need for a MOVED
 * account: `setAiSource` (also shaped for S14's `PATCH /v1/account/me/ai-settings`),
 * and the no-lock reads `spendableMicro`, `otherLiveGrantedMicro` and
 * `chargedInWindowMicro` that back the old status shape's `remaining_cents`,
 * `cap_cents` and `used_this_month_cents` (§8.6). Every deployment already
 * passes the ledger repo itself here (`accounts: creditLedgerRepo` in
 * bootstrap.ts), so widening this Pick needed no change there.
 */
export type AiCreditsAccounts = Pick<
  DrizzleCreditLedgerRepo,
  | 'ensureAccount'
  | 'setAiSource'
  | 'spendableMicro'
  | 'otherLiveGrantedMicro'
  | 'chargedInWindowMicro'
>;
export type { CreditAccountRecord };

/**
 * S13 — the current-window read the old status route needs alongside
 * {@link AiCreditsAccounts}: `credit_windows`, not `credit_accounts`/
 * `credit_lots`, so it is a different repo and a member of its own rather
 * than folded into `accounts`. No lock, same as `accounts` (§4.4).
 */
export type AiCreditsWindows = Pick<DrizzleCreditWindowsRepo, 'currentWindow'>;
export type { CurrentCreditWindow };

/**
 * S14 — the reads `GET /v1/account/me/ai`, its ledger page and
 * `GET /v1/ai/models` need beyond every member above: the current window's
 * own monthly lot and every other live lot (`DrizzleCreditLedgerRepo`), a
 * ledger page with each entry's running balance (same repo), what earlier
 * clawbacks still stand against held credit (`DrizzleCreditWindowsRepo`), how
 * many enforced tasks are open right now with no lock
 * (`DrizzleCreditReservationsRepo`), and the rate card in force plus the next
 * announced one (`CreditRateCardReader`).
 *
 * A hand-rolled interface rather than four more `Pick<...>` aliases folded
 * into `accounts`/`windows`, on purpose: those two are already `Pick`s over
 * SPECIFIC classes, and every existing fixture across the test suite that
 * builds a fake `AiCreditsRuntime` types its `accounts`/`windows` object
 * literals against them — widening either Pick would make every one of those
 * object literals miss a now-required key and fail to typecheck for a slice
 * they have nothing to do with. Bundling S14's five new reads into one NEW,
 * OPTIONAL member sidesteps that: an object literal that omits `stateReads`
 * entirely is still a valid `AiCreditsRuntime`.
 */
export interface AiCreditsStateReads {
  heldMicro: DrizzleCreditLedgerRepo['heldMicro'];
  latestDebtReason: DrizzleCreditLedgerRepo['latestDebtReason'];
  monthlyLotForWindow: DrizzleCreditLedgerRepo['monthlyLotForWindow'];
  liveExtraLots: DrizzleCreditLedgerRepo['liveExtraLots'];
  ledgerPageWithBalance: DrizzleCreditLedgerRepo['ledgerPageWithBalance'];
  /** For a message/session response's `credits_spent`, behind
   *  `DRIFTSTACK_AI_CREDITS_RESPONSE_FIELDS` — see `routes/agent-sessions.ts`. */
  chargedForSessionMicro: DrizzleCreditLedgerRepo['chargedForSessionMicro'];
  pendingClaimTotalMicro: DrizzleCreditWindowsRepo['pendingClaimTotalMicroNoLock'];
  /**
   * `DrizzleCreditReservationsRepo` is stateless (its methods take an
   * executor explicitly; there is no `this.database` to default it from), so
   * unlike every other read here this is not that class's method bound —
   * bootstrap closes over the pool itself to fill the executor in, and only
   * `accountId` is left for a caller to supply.
   */
  openEnforceCountNoLock: (accountId: string) => Promise<number>;
  cardInForce: CreditRateCardReader['cardInForce'];
  nextAnnouncedCard: CreditRateCardReader['nextAnnouncedCard'];
  /** One model's prices on one card version — `GET /v1/ai/models` reads this
   *  once per on-credits model, for the card in force and, when there is
   *  one, the next announced card. */
  modelRow: CreditRateCardReader['modelRow'];
}

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
  /**
   * S13 — the account's current credit window, for the old
   * `bundled-llm-settings`/`-status` routes' moved-account shape. See
   * {@link AiCreditsWindows}.
   */
  readonly windows: AiCreditsWindows;
  /**
   * S14 — see {@link AiCreditsStateReads}. OPTIONAL ON THE TYPE ONLY: every
   * deployment that constructs `aiCredits` at all (bootstrap.ts) populates
   * this alongside every other member, in the same `creditGrants === null`
   * guard as the rest — so in a real process this is undefined exactly when
   * `aiCredits` itself is undefined, never independently. The optionality
   * exists solely so pre-S14 test fixtures that build a narrower fake runtime
   * (for routes that never read `stateReads`) keep typechecking unmodified. A
   * route that reads it and finds it undefined has been handed a fixture that
   * does not support the surface it is calling and should throw, not guess.
   */
  readonly stateReads?: AiCreditsStateReads;
  /**
   * S15 — the admin mutation surface `routes/admin-ai-credits.ts` needs
   * beyond every read above: ledger writes (a goodwill lot, a debt
   * forgiveness adjustment), the plan-overrides repo, the rate-card writer
   * (publish/withdraw/list), and the ONE entry point that re-derives an
   * account's current window after either (`refreshCredits`, §6.6
   * `reconcileLevel`). OPTIONAL ON THE TYPE ONLY, same reason as
   * {@link AiCreditsStateReads}: a NEW bundle rather than widening
   * {@link AiCreditsAccounts}, so every fixture built before S15 (a narrower
   * `accounts` object literal satisfying that Pick) keeps typechecking
   * unmodified. A real deployment populates this alongside `stateReads` in
   * the same `creditGrants === null` guard bootstrap.ts already uses.
   */
  readonly admin?: AiCreditsAdminSurface;
}

/**
 * S15 — see {@link AiCreditsRuntime.admin}. `transaction`/`lockAccount` are the
 * two primitives the goodwill-grant and debt-forgiveness writes need to read
 * the account's current debt and write its ledger row atomically, under the
 * account's own lock; `insertLot`/`append` are the two writes themselves.
 *
 * `settleDebtFromFree` is ADDED (beyond the read/write pair above) because a
 * goodwill grant is free credit, and the database refuses to COMMIT an
 * account that holds debt beside spendable credit
 * (`credit_check_debt_vs_free`, migration 0128) — every OTHER writer that
 * adds free credit to an account ends its transaction with this same call
 * (`credit-grants.ts`'s `refreshCreditsIn`), and an admin goodwill grant to an
 * account that is IN DEBT is exactly the case that would otherwise fail at
 * commit with a raw trigger error instead of quietly paying the debt down.
 */
export interface AiCreditsAdminSurface {
  transaction: DrizzleCreditLedgerRepo['transaction'];
  lockAccount: DrizzleCreditLedgerRepo['lockAccount'];
  insertLot: DrizzleCreditLedgerRepo['insertLot'];
  /** Re-reads a lot's state AFTER it was funded — see the method's own doc
   *  comment; `insertLot`'s own return value is a pre-funding snapshot. */
  getLot: DrizzleCreditLedgerRepo['getLot'];
  append: DrizzleCreditLedgerRepo['append'];
  settleDebtFromFree: DrizzleCreditLedgerRepo['settleDebtFromFree'];
  planOverrides: Pick<DrizzleCreditPlanOverridesRepo, 'get' | 'upsert' | 'end'>;
  rateCards: Pick<DrizzleCreditRateCardRepo, 'publish' | 'withdraw' | 'listAll' | 'modelCounts'>;
  /** §6.6 — re-derive the account's current window after a plan-override
   *  change. Does nothing when credits are off; always present here because
   *  this whole member is absent then. */
  refreshCredits: CreditsRefresher['refreshCredits'];
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
