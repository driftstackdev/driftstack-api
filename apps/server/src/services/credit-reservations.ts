// A task sets credits aside before it runs, and pays for what it used when it
// ends.
//
// `reserve()` is ONE TRANSACTION, under the account's credit lock, and it does
// the same seven things in the same order every time (§4.4):
//
//   1. ensure the account's credit row and LOCK it, so two tasks of one account
//      decide one after the other and not against the same balance;
//   2. refresh the account's credits UNDER A SAVEPOINT — expire, grant, prorate,
//      settle debt — so a month that has just begun is spendable by this very
//      task, and a refresh that FAILS costs the customer a fresher balance and
//      nothing more (H5);
//   3. pick the rate card in force and the model's row on it;
//   4. refuse a model the deployment's key may not run, or one the card does not
//      price;
//   5. refuse a fourth task, an account in debt, and a balance under the model's
//      minimum;
//   6. write the reservation, taking the lowest free slot and reserving the
//      lesser of the model's maximum and what the account has;
//   7. hold that amount across the account's lots in spend order.
//
// ⛔ THE REFUSALS ARE IN THAT ORDER AND THE ORDER IS PART OF THE ANSWER. A
// customer on a plan that cannot run the model is told that, not that they are
// out of credits; an account with three tasks running is told to wait, not to
// buy more. Shadow mode records the SAME first failing check in
// `would_refuse_reason` without refusing anything, which is how the census
// measures what enforcement would have done before it is switched on.
//
// ⛔ A REFUSAL IS NOT AN ERROR. Every ordinary outcome — refused, or a shadow
// task that was measured — comes back as a value. What throws is a fault.
//
// ⛔ SHADOW NEVER THROWS AND NEVER REFUSES (M3). A legacy turn must be
// byte-identical whether or not the meter is running, so the shadow path runs
// under a two-second statement timeout and swallows every error, counting it.
// A shadow reservation holds nothing, so it cannot take credit from anybody.
//
// BETWEEN THE TWO, EVERY BILLABLE HTTP ATTEMPT ASKS FIRST (§4.5, §4.6).
// `planCall()` says which rung of the fit ladder the next call lands on against
// the room the task has left and the card it pinned; `admitCall()` commits that
// call's UPPER BOUND in one statement, and refuses when the task is over, is on
// another model, or has not got the room; `markSent()` records — in its own
// statement, committed before the fetch — that the request went out; and
// `settleCall()` charges the call for what the one recorded fact about it says
// it cost and gives the rest back. A call is settled EXACTLY ONCE: whichever of
// the adapter and the lease keeper reaches it first wins, and the other reads
// back what was already written.
//
// `settle()` is the other half (§5.1): it charges the task for what its calls
// actually cost, releases every hold, and gives the rest back — to a clawback
// that is still owed credit a running task was holding, to debt on a revoked
// lot, to expiry on a lot whose month has ended, and otherwise to the lot it
// came from. A task that made no call is charged nothing. Settling twice charges
// once: the second settlement finds the task already settled and does nothing.
//
// DARK. Nothing constructs this service yet and no route reserves; S8 admits
// calls against a reservation, S9 runs the lease keeper, and S12 switches
// enforcement on for moved accounts.

import {
  callUpperBound,
  deploymentKeyModelRefusal,
  type DeploymentKeyModelRefusal,
} from '@driftstack/api-types';
import type {
  AiDebtReason,
  CreditRates,
  ModelCallTokens,
  RequestRegionBytes,
} from '@driftstack/api-types';
import { sql } from 'drizzle-orm';
import type { CreditRateCardReader } from '../db/credit-rate-card-repo.js';
import type { CreditLedgerTx, DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import {
  type CreditAdmissionRefusal,
  type CreditCallBound,
  type CreditCallSettleBasis,
  type CreditModelCallPurpose,
  type CreditSettleReason,
  type CreditWouldRefuseReason,
  type DrizzleCreditReservationsRepo,
  type PendingCreditClaim,
} from '../db/credit-reservations-repo.js';
import type { CreditClawbackSource } from '../db/credit-windows-repo.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';
import { callSettlement } from './credit-call-charge.js';
import { CALL_OUTPUT_CEILING, fitCall, type CallFitDecision } from './credit-call-fit.js';
import { reportCreditsRefreshFailed } from './credit-grants.js';

/**
 * Why enforcement refused a task, in the order `reserveEnforce` asks them. The
 * account's `blocked_reason` (services/ai-account-state.ts) walks this same
 * array, so the state a customer reads never names a different refusal from the
 * one a task gets (S14 audit #4); a test pins it to the order of the checks.
 */
export const CREDIT_RESERVE_REFUSAL_ORDER = [
  'model',
  'tasks_in_flight',
  'debt',
  'balance',
] as const;
export type CreditReserveRefusal = (typeof CREDIT_RESERVE_REFUSAL_ORDER)[number];

/** How long a shadow reservation may spend in the database before it gives up (M3). */
export const CREDIT_SHADOW_STATEMENT_TIMEOUT_MS = 2_000;

export interface CreditReserveInput {
  readonly accountId: string;
  /** Minted by the caller, so a crash between minting and committing is findable. */
  readonly reservationId: string;
  readonly agentSessionId: string;
  /**
   * The customer's Idempotency-Key, or null. ⛔ NOT the request id (M2): that is
   * client-controlled, and a proxy reusing one would refuse every later task.
   */
  readonly idempotencyKey: string | null;
  readonly model: string;
  readonly mode: 'enforce' | 'shadow';
  /** The boot id of this process; it owns the lease until it lapses. */
  readonly bootId: string;
}

export interface CreditReserveRefused {
  readonly outcome: 'refused';
  readonly reason: CreditReserveRefusal;
  /** Why the deployment's key refuses the model; null when the card simply has no row. */
  readonly modelRefusal: DeploymentKeyModelRefusal | null;
  /** Why the account owes credits, for a `debt` refusal. */
  readonly debtReason: AiDebtReason | null;
  readonly debtMicro: number;
  readonly availableMicro: number;
  /** The model's minimum to start, or null when the model has no row at all. */
  readonly minStartMicro: number | null;
  readonly openTasks: number;
}

export type CreditReserveResult =
  | {
      readonly outcome: 'reserved';
      readonly reservationId: string;
      readonly slot: 1 | 2 | 3;
      readonly reservedMicro: number;
      readonly rateCardVersion: number;
      readonly holds: readonly { readonly lotId: string; readonly heldMicro: number }[];
    }
  | CreditReserveRefused
  | {
      /** Measured, not enforced: nothing was held and nothing was refused. */
      readonly outcome: 'shadowed';
      readonly reservationId: string;
      readonly reservedMicro: number;
      readonly wouldRefuseReason: CreditWouldRefuseReason | null;
    }
  | {
      /** Shadow only: something went wrong and was swallowed. The turn is untouched. */
      readonly outcome: 'shadow_lost';
    };

export interface CreditSettleResult {
  readonly outcome: 'settled' | 'already_settled' | 'unknown';
  readonly chargedMicro: number;
  /** What each lot gave up, in spend order. Empty for a shadow task. */
  readonly charges: readonly { readonly lotId: string; readonly micro: number }[];
  /** What was paid off standing claims out of the credit this task released. */
  readonly claimsPaidMicro: number;
  /** What was turned into debt because no task is left to release credit for it. */
  readonly claimsToDebtMicro: number;
}

// ───────────────────────────────────────────────────────────────────────────
// One model call: planning it, admitting it, sending it, settling it (§4.5, §4.6)
// ───────────────────────────────────────────────────────────────────────────

export interface CreditPlanCallInput {
  readonly reservationId: string;
  readonly purpose: CreditModelCallPurpose;
  /** The serialized body, split at its cache markers (`callUpperBound`'s regions). */
  readonly regions: RequestRegionBytes;
  /**
   * How many of those bytes are conversation history the caller could drop.
   * Zero when there is nothing droppable; then the trim rung cannot be reached.
   */
  readonly historyBytes: number;
}

export type CreditCallPlan =
  | {
      readonly outcome: 'planned';
      readonly decision: CallFitDecision;
      /** The task's model, which the call must be made on (M10). */
      readonly model: string;
      /** `reserved − committed` when the plan was made; the admission re-checks it. */
      readonly roomMicro: number;
      readonly reservedMicro: number;
      readonly rates: CreditRates;
    }
  | {
      /** The task cannot admit any call at all, whatever this one costs. */
      readonly outcome: 'unavailable';
      readonly reason: CreditAdmissionRefusal;
    };

export interface CreditAdmitCallInput {
  readonly reservationId: string;
  readonly purpose: CreditModelCallPurpose;
  /** The model the call is ACTUALLY about to be made on, not the task's. */
  readonly model: string;
  readonly bound: CreditCallBound;
  /** Minted by the caller, so a crash between minting and committing is findable. */
  readonly callId: string;
}

export type CreditAdmitCallResult =
  | {
      readonly outcome: 'admitted';
      readonly callId: string;
      readonly seq: number;
      readonly mode: 'enforce' | 'shadow';
      /** What the task has left to commit after this call took its share. */
      readonly leftMicro: number;
      /** Shadow only: this call took the measurement past what the task reserved. */
      readonly overReservation: boolean;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: CreditAdmissionRefusal;
      readonly leftMicro: number;
    };

export interface CreditSettleCallInput {
  readonly callId: string;
  readonly basis: CreditCallSettleBasis;
  /** Required by `provider_usage` and `partial_usage`; ignored by the rest. */
  readonly usage?: ModelCallTokens | null;
  /** The best-effort usage row this call was recorded against, when there is one. */
  readonly usageRecordId?: string | null;
}

export interface CreditCallSettlementResult {
  readonly outcome: 'settled' | 'already_settled' | 'unknown';
  readonly chargedMicro: number;
  readonly boundMicro: number;
  /** True when the provider reported more than the bound and the charge was capped. */
  readonly overBound: boolean;
}

/** What `ai_credits_bound_exceeded` is raised with. */
export interface CreditBoundExceeded {
  readonly callId: string;
  readonly reservationId: string;
  readonly accountId: string;
  readonly model: string;
  readonly basis: CreditCallSettleBasis;
  readonly boundMicro: number;
  readonly actualMicro: number;
}

/** The refresh, as a task needs it: inside a transaction the caller already holds. */
export interface CreditsInTransactionRefresher {
  refreshCreditsIn(tx: CreditLedgerTx, accountId: string): Promise<unknown>;
}

export interface CreditReservationsDeps {
  readonly ledger: DrizzleCreditLedgerRepo;
  readonly reservations: DrizzleCreditReservationsRepo;
  readonly rateCards: CreditRateCardReader;
  /** Null when AI credits are off; then a task never refreshes and runs on what is there. */
  readonly refresher: CreditsInTransactionRefresher | null;
  readonly logger?: Logger;
  readonly sentry?: Pick<SentryClient, 'captureMessage'> | null;
  /**
   * Called once for every shadow reservation that was lost to an error
   * (`ai_credits_shadow_lost`). S11 registers the counter; here it is a
   * dependency so that this slice adds no metric to the published catalogue
   * while it is dark.
   */
  readonly onShadowLost?: (err: unknown) => void;
  /**
   * Called once for every call whose measured cost passed the bound it was
   * admitted under (`ai_credits_bound_exceeded`, §4.6). A dependency for the
   * same reason `onShadowLost` is: S11 registers the counter, and this slice
   * must add nothing to the published metric catalogue while it is dark.
   */
  readonly onBoundExceeded?: (detail: CreditBoundExceeded) => void;
}

/**
 * Which ledger movement takes credit back for a clawback of this source. A plan
 * change's is a proration; every other source is a payment that was reversed.
 */
export function clawbackLedgerKind(
  source: CreditClawbackSource,
): 'proration_clawback' | 'refund_clawback' {
  return source === 'plan_change' ? 'proration_clawback' : 'refund_clawback';
}

/**
 * Why an account owes credits a clawback of this source could not take.
 *
 * The database accepts two reasons and there are five sources, so this is a
 * narrowing and the mapping is stated once. `admin` reads as `payment_reversed`
 * because an admin clawback exists to undo a payment that should not have been
 * honoured; it is the closer of the two, and the audit trail carries the real
 * source on the clawback row itself.
 */
export function clawbackDebtReason(source: CreditClawbackSource): AiDebtReason {
  return source === 'plan_change' ? 'plan_change' : 'payment_reversed';
}

export class CreditReservationsService {
  constructor(private readonly deps: CreditReservationsDeps) {}

  /**
   * Set credits aside for one task, in one transaction. See the file header for
   * the order and why it is the order.
   */
  async reserve(input: CreditReserveInput): Promise<CreditReserveResult> {
    if (input.mode === 'shadow') return this.reserveShadow(input);
    return this.deps.ledger.transaction((tx) => this.reserveEnforce(tx, input));
  }

  private async reserveEnforce(
    tx: CreditLedgerTx,
    input: CreditReserveInput,
  ): Promise<CreditReserveResult> {
    const { ledger, reservations } = this.deps;
    await ledger.lockAccount(tx, input.accountId);
    await this.refreshUnderSavepoint(tx, input.accountId);

    const priced = await this.priceModel(tx, input.model);
    if (priced === null) {
      return this.refused(tx, input.accountId, 'model', {
        modelRefusal: deploymentKeyModelRefusal(input.model),
        minStartMicro: null,
      });
    }

    const openTasks = await reservations.openEnforceCount(tx, input.accountId);
    if (openTasks >= MAX_ENFORCED_TASKS) {
      return this.refused(tx, input.accountId, 'tasks_in_flight', {
        modelRefusal: null,
        minStartMicro: priced.minStartMicro,
        openTasks,
      });
    }

    // Re-read after the refresh: settling debt from free credit may have cleared
    // it, and the locked row this reads is the one the refresh just wrote.
    const account = await ledger.ensureAccount(input.accountId, tx);
    if (account.debtMicro > 0) {
      return this.refused(tx, input.accountId, 'debt', {
        modelRefusal: null,
        minStartMicro: priced.minStartMicro,
        openTasks,
      });
    }

    const availableMicro = await ledger.spendableMicro(input.accountId, tx);
    if (availableMicro < priced.minStartMicro) {
      return this.refused(tx, input.accountId, 'balance', {
        modelRefusal: null,
        minStartMicro: priced.minStartMicro,
        openTasks,
        availableMicro,
      });
    }

    const written = await reservations.insertEnforceReservation(tx, {
      id: input.reservationId,
      accountId: input.accountId,
      agentSessionId: input.agentSessionId,
      requestKey: requestKeyFor(input.idempotencyKey),
      model: input.model,
      rateCardVersion: priced.rateCardVersion,
      maxReserveMicro: priced.maxReserveMicro,
      availableMicro,
      leaseOwner: input.bootId,
    });
    const holds = await reservations.placeHolds(tx, {
      reservationId: input.reservationId,
      accountId: input.accountId,
      neededMicro: written.reservedMicro,
    });
    return {
      outcome: 'reserved',
      reservationId: input.reservationId,
      slot: written.slot,
      reservedMicro: written.reservedMicro,
      rateCardVersion: priced.rateCardVersion,
      holds,
    };
  }

  /**
   * The shadow path: the same transaction and the same refresh, no refusal, no
   * slot and no holds — and NOTHING that can reach the caller as a failure. A
   * legacy turn runs identically whether or not this ran at all (M3).
   */
  private async reserveShadow(input: CreditReserveInput): Promise<CreditReserveResult> {
    try {
      return await this.deps.ledger.transaction(async (tx) => {
        // ⛔ `set_config(…, is_local => true)`, NOT `SET LOCAL`. They do the
        // same thing, and only this one takes the value as a PARAMETER: `SET`
        // is a utility statement whose value cannot be bound, so writing it
        // that way is a syntax error — and on the shadow path a syntax error is
        // swallowed, which would leave the cap silently absent. It also keeps
        // the file inside the repo's rule that no SQL is assembled from text.
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(CREDIT_SHADOW_STATEMENT_TIMEOUT_MS)}, true)`,
        );
        return this.measureShadow(tx, input);
      });
    } catch (err) {
      this.deps.onShadowLost?.(err);
      this.deps.logger?.warn?.(
        {
          component: 'credit-reservations',
          event: 'ai_credits_shadow_lost',
          accountId: input.accountId,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'a shadow reservation was lost — the turn it was measuring is unaffected',
      );
      return { outcome: 'shadow_lost' };
    }
  }

  private async measureShadow(
    tx: CreditLedgerTx,
    input: CreditReserveInput,
  ): Promise<CreditReserveResult> {
    const { ledger, reservations } = this.deps;
    await ledger.lockAccount(tx, input.accountId);
    await this.refreshUnderSavepoint(tx, input.accountId);

    const priced = await this.priceModel(tx, input.model);
    if (priced === null) return this.measureModelRefusal(tx, input);

    const openTasks = await reservations.openEnforceCount(tx, input.accountId);
    const account = await ledger.ensureAccount(input.accountId, tx);
    const availableMicro = await ledger.spendableMicro(input.accountId, tx);
    const wouldRefuseReason: CreditWouldRefuseReason | null =
      openTasks >= MAX_ENFORCED_TASKS
        ? 'tasks_in_flight'
        : account.debtMicro > 0
          ? 'debt'
          : availableMicro < priced.minStartMicro
            ? 'balance'
            : null;

    const written = await reservations.insertShadowReservation(tx, {
      id: input.reservationId,
      accountId: input.accountId,
      agentSessionId: input.agentSessionId,
      requestKey: requestKeyFor(input.idempotencyKey),
      model: input.model,
      rateCardVersion: priced.rateCardVersion,
      reservedMicro: priced.maxReserveMicro,
      leaseOwner: input.bootId,
      wouldRefuseReason,
    });
    return {
      outcome: 'shadowed',
      reservationId: input.reservationId,
      reservedMicro: written.reservedMicro,
      wouldRefuseReason,
    };
  }

  /**
   * The shadow measurement of a task whose MODEL enforcement would have refused:
   * an own-key-only model, or one the card in force carries no row for.
   *
   * ⛔ THIS IS THE FIRST CHECK IN THE ORDER AND IT USED TO BE THE ONE THE CENSUS
   * COULD NOT SEE. `would_refuse_reason = 'model'` was a value the CHECK
   * accepted and nothing wrote: this path returned `shadow_lost` instead, so
   * model refusals were invisible to S11's census AND M3's "a lost rate of 0"
   * shadow exit criterion was unreachable for any deployment whose customers
   * ever asked for an Opus-class model on a legacy turn. `shadow_lost` now means
   * what it says — a FAULT — and this means "enforcement would have said no".
   *
   * IT RESERVES NOTHING, and zero is the honest amount rather than a placeholder:
   * `reserved_micro` on a shadow row is the model's `max_reserve`, the measuring
   * stick, and a model with no rate-card row has none. 0132's
   * `credit_reservations_amounts` accepts zero for exactly this shape.
   *
   * ⛔ NO CARD IN FORCE AT ALL IS STILL A LOST MEASUREMENT, and that is not a
   * hedge. `rate_card_version` is NOT NULL and a foreign key, so with no card
   * there is no version to record the measurement under and no row that could be
   * written at all — and a deployment metering credits with no card in force is
   * a misconfiguration, which is what `shadow_lost` is for.
   *
   * The card is read a second time here rather than threaded out of
   * `priceModel`, deliberately: `priceModel` answers the M10 question — may the
   * deployment's key run this model — BEFORE it looks at any card, so that the
   * answer cannot depend on one, and the enforced path (which needs no version)
   * stays exactly as it was. This path is rare and the read is one indexed row.
   */
  private async measureModelRefusal(
    tx: CreditLedgerTx,
    input: CreditReserveInput,
  ): Promise<CreditReserveResult> {
    const card = await this.deps.rateCards.cardInForce(undefined, tx);
    if (card === null) {
      this.deps.onShadowLost?.(new Error('no credit rate card is in force'));
      return { outcome: 'shadow_lost' };
    }
    const written = await this.deps.reservations.insertShadowReservation(tx, {
      id: input.reservationId,
      accountId: input.accountId,
      agentSessionId: input.agentSessionId,
      requestKey: requestKeyFor(input.idempotencyKey),
      model: input.model,
      rateCardVersion: card.version,
      reservedMicro: 0,
      leaseOwner: input.bootId,
      wouldRefuseReason: 'model',
    });
    return {
      outcome: 'shadowed',
      reservationId: input.reservationId,
      reservedMicro: written.reservedMicro,
      wouldRefuseReason: 'model',
    };
  }

  /**
   * Refresh the account's credits inside the caller's transaction, under a
   * SAVEPOINT.
   *
   * ⛔ H5: ONE FAULT MUST NOT LOCK AN ACCOUNT OUT OF AI. The refresh touches
   * windows, prorations and debt, and a fault in any of those would otherwise
   * abort the reserve transaction — deterministically, on every turn, for as
   * long as the fault lasted. Under a savepoint the transaction survives it: the
   * partial work is rolled back, the failure is logged and alerted, and the task
   * goes on against the balance the account already had. The worst case is a
   * month that has just begun is not granted until the sweep grants it.
   */
  private async refreshUnderSavepoint(tx: CreditLedgerTx, accountId: string): Promise<void> {
    const refresher = this.deps.refresher;
    if (refresher === null) return;
    try {
      await tx.transaction(async (savepoint) => {
        await refresher.refreshCreditsIn(savepoint, accountId);
      });
    } catch (err) {
      reportCreditsRefreshFailed(err, accountId, {
        trigger: 'task_reserve',
        message:
          'refreshing AI credits inside a task reservation failed — the task continues on the balance already recorded',
        logger: this.deps.logger,
        sentry: this.deps.sentry,
      });
    }
  }

  /** The card in force and the model's row on it, both read inside the transaction. */
  private async priceModel(
    tx: CreditLedgerTx,
    model: string,
  ): Promise<{
    readonly rateCardVersion: number;
    readonly minStartMicro: number;
    readonly maxReserveMicro: number;
  } | null> {
    // Defence in depth (M10): the card is not allowed to price an Opus-class
    // model and a CHECK refuses one, but a card published from a registry that
    // did would otherwise put Opus on credits wherever the route check was
    // missed. Asked FIRST, so the answer does not depend on the card at all.
    if (deploymentKeyModelRefusal(model) !== null) return null;
    const card = await this.deps.rateCards.cardInForce(undefined, tx);
    if (card === null) return null;
    const row = await this.deps.rateCards.modelRow(card.version, model, tx);
    if (row === null) return null;
    return {
      rateCardVersion: card.version,
      minStartMicro: row.minStartMicro,
      maxReserveMicro: row.maxReserveMicro,
    };
  }

  private async refused(
    tx: CreditLedgerTx,
    accountId: string,
    reason: CreditReserveRefusal,
    detail: {
      readonly modelRefusal: DeploymentKeyModelRefusal | null;
      readonly minStartMicro: number | null;
      readonly openTasks?: number;
      readonly availableMicro?: number;
    },
  ): Promise<CreditReserveRefused> {
    const account = await this.deps.ledger.ensureAccount(accountId, tx);
    return {
      outcome: 'refused',
      reason,
      modelRefusal: detail.modelRefusal,
      debtReason:
        account.debtMicro > 0 ? await this.deps.ledger.latestDebtReason(accountId, tx) : null,
      debtMicro: account.debtMicro,
      availableMicro:
        detail.availableMicro ?? (await this.deps.ledger.spendableMicro(accountId, tx)),
      minStartMicro: detail.minStartMicro,
      openTasks: detail.openTasks ?? 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // One model call
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Which rung of the fit ladder the next call lands on, against the room this
   * task has left and the rate card it PINNED at reserve (§4.5).
   *
   * ⛔ THE PINNED CARD, NEVER TODAY'S. A card published mid-task must not change
   * what the task is charged, and a bound priced on one card and settled on
   * another is not a bound at all.
   *
   * ⛔ A SHADOW TASK IS ALWAYS PLANNED AT THE CEILING. It holds nothing and
   * refuses nothing, and a measurement that lowered its own `max_tokens` would
   * be measuring the limit rather than the load. Whether the call fitted is
   * recorded by the admission instead, on the call and on the task.
   *
   * The numbers here are read without a lock and the admission re-checks every
   * one of them, so a race can turn a call that would have fitted into a
   * refusal, never the other way round.
   */
  async planCall(input: CreditPlanCallInput): Promise<CreditCallPlan> {
    const { ledger, reservations } = this.deps;
    return ledger.transaction(async (tx) => {
      const terms = await reservations.reservationTerms(tx, input.reservationId);
      if (terms === null) return { outcome: 'unavailable', reason: 'gone' };
      if (terms.state === 'settled') return { outcome: 'unavailable', reason: 'settled' };
      if (terms.pastCeiling) return { outcome: 'unavailable', reason: 'max_age' };

      const rates = await this.deps.rateCards.modelRow(terms.rateCardVersion, terms.model, tx);
      if (rates === null) {
        // ⛔ A MEASUREMENT OF A MODEL THE CARD NEVER PRICED IS NOT CORRUPTION,
        // AND IT IS NOW A STATE THE SERVICE ITSELF WRITES. `measureModelRefusal`
        // records the would-refuse reason `model` on a SHADOW row reserving
        // ZERO, which is the whole point of that value existing: enforcement
        // would have refused this task on its model, and the census must see it.
        // Such a task then reaches here once per attempt, and there is no bound
        // to plan — but there is also nothing wrong. Answered as `unavailable`,
        // the same as a task that is gone, settled or past its ceiling.
        //
        // ⛔ AND THE DISCRIMINATOR IS THE DATABASE'S, NOT A GUESS.
        // `credit_reservations_amounts` (0132) accepts `reserved_micro = 0` for
        // exactly one row shape — shadow, `would_refuse_reason = 'model'` — so a
        // shadow task that reserved nothing IS a model refusal and nothing else
        // can be. A task that was PRICED at reserve reserved its model's
        // `max_reserve`, which is `> 0`, so it still takes the throw below: a
        // card is immutable and its rows are never deleted, so losing a row a
        // live task pinned is corruption, and a bound priced at a guessed rate
        // is not a bound.
        if (terms.mode === 'shadow' && terms.reservedMicro === 0)
          return { outcome: 'unavailable', reason: 'model' };
        throw new Error(
          `credit rate card ${terms.rateCardVersion} does not price ${terms.model}, which a running task pinned`,
        );
      }
      const roomMicro = terms.reservedMicro - terms.committedMicro;
      const decision: CallFitDecision =
        terms.mode === 'shadow'
          ? {
              rung: 'ceiling',
              maxOutputTokens: CALL_OUTPUT_CEILING[input.purpose],
              bound: callUpperBound(input.regions, CALL_OUTPUT_CEILING[input.purpose], rates),
            }
          : fitCall({
              purpose: input.purpose,
              roomMicro,
              regions: input.regions,
              rates,
              historyBytes: input.historyBytes,
            });
      return {
        outcome: 'planned',
        decision,
        model: terms.model,
        roomMicro,
        reservedMicro: terms.reservedMicro,
        rates,
      };
    });
  }

  /**
   * Admit one call against its task: commit its bound, then write the call
   * (§4.5). One transaction, and the two halves belong to it together — the
   * COMMIT-time check requires a task's `committed_micro` to equal what its
   * calls commit.
   *
   * ⛔ THE BOUND IS COMMITTED BEFORE THE REQUEST EXISTS, AND THAT IS THE POINT.
   * A task can only ever be charged what it reserved, so the decision has to be
   * taken against the ceiling of what this call might cost, not against what it
   * turns out to have cost. What the call does not use comes back at settlement.
   *
   * A refusal is a value, not an exception, and it says which predicate failed:
   * a task that is gone, settled or past its ceiling is a different thing to
   * tell the customer than a call that did not fit.
   */
  async admitCall(input: CreditAdmitCallInput): Promise<CreditAdmitCallResult> {
    const { ledger, reservations } = this.deps;
    return ledger.transaction(async (tx) => {
      const committed = await reservations.commitCallBound(tx, {
        reservationId: input.reservationId,
        model: input.model,
        boundMicro: input.bound.boundMicro,
      });
      if (committed === null) {
        const refused = await reservations.admissionRefusal(tx, {
          reservationId: input.reservationId,
          model: input.model,
        });
        return { outcome: 'refused', reason: refused.reason, leftMicro: refused.leftMicro };
      }
      const written = await reservations.insertModelCall(tx, {
        callId: input.callId,
        reservationId: input.reservationId,
        accountId: committed.accountId,
        purpose: input.purpose,
        model: input.model,
        bound: input.bound,
        shadowOverReservation: committed.overReservation,
      });
      return {
        outcome: 'admitted',
        callId: written.callId,
        seq: written.seq,
        mode: committed.mode,
        leftMicro: committed.leftMicro,
        overReservation: committed.overReservation,
      };
    });
  }

  /**
   * Record that this call's request is going out, immediately before it does
   * (§4.5). Its own statement, committed before the fetch.
   *
   * False means the call is no longer started — a keeper settled the task around
   * it — and the caller must not send the request: the task is over, and a
   * request sent now would be paid for by nobody.
   */
  async markSent(callId: string): Promise<boolean> {
    return this.deps.ledger.transaction((tx) => this.deps.reservations.markCallSent(tx, callId));
  }

  /**
   * Settle one call for what the one recorded fact about it says it cost (§4.6),
   * and give the task back the difference between that and its bound.
   *
   * ⛔ EXACTLY ONCE. The call is updated `WHERE state = 'started'`, so a keeper
   * that settled the task first wins and this returns `already_settled` without
   * touching a number. Both paths lead to the same charge for the same call,
   * and `credit_check_reservation` re-adds the calls at COMMIT either way.
   *
   * ⛔ THE RATES COME FROM THE CARD THE TASK PINNED, read here rather than
   * carried from admission, so that a settlement running in a process that never
   * saw the admission — the crash path, which §5.3 calls the main one — charges
   * the same as one that did.
   *
   * ⛔ AND SO DOES THE ONE FACT THAT DECIDES WHETHER THERE IS ANYTHING TO PAY
   * FOR. `sent` is read from the row under its own lock and it decides the
   * basis, in BOTH directions, rather than the caller's word (see
   * `basisTheRowAgreesWith`): a basis that charges, named on a request the row
   * says never left this process, is settled `never_sent` at zero, and
   * `never_sent` named on a request the row says DID go out is settled
   * `no_record` at the bound. Each is what `settleStartedCallsAfterACrash`
   * charges that same row, and what a call costs must not depend on which of the
   * two reached it first. The second direction is also the one the DATABASE
   * refuses outright — `credit_model_calls_never_sent_really` — so leaving it to
   * the caller raised a CHECK violation out of the adapter's per-attempt
   * `finally`, left the call `started`, and handed the keeper the same bound a
   * lease later.
   */
  async settleCall(input: CreditSettleCallInput): Promise<CreditCallSettlementResult> {
    const { ledger, reservations } = this.deps;
    let exceeded: CreditBoundExceeded | null = null;
    const result = await ledger.transaction(async (tx) => {
      const call = await reservations.lockCallForSettlement(tx, input.callId);
      if (call === null) return UNSETTLED_CALL;
      if (call.state === 'settled') {
        return {
          outcome: 'already_settled' as const,
          chargedMicro: call.chargedMicro ?? 0,
          boundMicro: call.boundMicro,
          overBound: false,
        };
      }

      const rates = await this.deps.rateCards.modelRow(call.rateCardVersion, call.model, tx);
      if (rates === null) {
        throw new Error(
          `credit rate card ${call.rateCardVersion} does not price ${call.model}, which a running call pinned`,
        );
      }
      const basis = basisTheRowAgreesWith(input.basis, call.sent, (corrected) => {
        this.deps.logger?.warn?.(
          {
            component: 'credit-reservations',
            event: 'ai_credits_basis_not_sent',
            callId: input.callId,
            reservationId: call.reservationId,
            accountId: call.accountId,
            basis: input.basis,
            settledAs: corrected,
            sent: call.sent,
          },
          'a call settlement named a basis the row disagrees with — the row decides what it cost',
        );
      });
      const settlement = callSettlement({
        basis,
        boundMicro: call.boundMicro,
        maxOutputTokens: call.maxOutputTokens,
        rates,
        usage: input.usage ?? null,
      });
      const written = await reservations.settleOneCall(tx, {
        callId: input.callId,
        basis,
        chargedMicro: settlement.chargedMicro,
        actualMicro: settlement.actualMicro,
        tokens: settlement.tokens,
        usageRecordId: input.usageRecordId ?? null,
      });
      // Nothing to update, having just read the row as started UNDER ITS OWN
      // ROW LOCK: nobody else can have settled it, so the row is gone — its
      // account was deleted — and the answer is the same one a call that never
      // existed gets. ⛔ NOT `already_settled` with a zero charge: that number
      // travels on to the customer's usage row as what the call cost, and a
      // settlement that lost a race to the lease keeper would report a call
      // charged its whole bound as having been free. That is what the
      // `state === 'settled'` branch above is for, and it reports the charge
      // that stands — which it can only do because the read is taken after the
      // lock rather than beside it (see `lockCallForSettlement`).
      if (written === null) return UNSETTLED_CALL;
      await reservations.releaseCommittedBound(tx, {
        reservationId: call.reservationId,
        boundMicro: written.boundMicro,
        chargedMicro: written.chargedMicro,
      });
      if (settlement.overBound && settlement.actualMicro !== null) {
        exceeded = {
          callId: input.callId,
          reservationId: call.reservationId,
          accountId: call.accountId,
          model: call.model,
          basis,
          boundMicro: written.boundMicro,
          actualMicro: settlement.actualMicro,
        };
      }
      return {
        outcome: 'settled' as const,
        chargedMicro: written.chargedMicro,
        boundMicro: written.boundMicro,
        overBound: settlement.overBound,
      };
    });
    // Raised only once the charge it describes is committed: a counter bumped
    // inside a transaction that then rolled back would alert on a call nobody made.
    if (exceeded !== null) this.deps.onBoundExceeded?.(exceeded);
    return result;
  }

  /** Settle one task in a transaction of its own. */
  async settle(reservationId: string, reason: CreditSettleReason): Promise<CreditSettleResult> {
    return this.deps.ledger.transaction((tx) => this.settleIn(tx, reservationId, reason));
  }

  /**
   * The settlement itself, inside a transaction the caller holds (§5.1).
   *
   * ⛔ THE ACCOUNT'S CREDIT ROW IS LOCKED BEFORE THE RESERVATION. That is the
   * lock order every credit writer uses, and taking the reservation first would
   * invert it against a refresh or another task's reserve.
   *
   * ⛔ THE WALK ALWAYS ENDS WITH NOTHING LEFT TO CHARGE. The holds sum to
   * exactly what the task reserved — a COMMIT-time check refuses a reservation
   * where they do not — and it can never be charged more than it reserved, so
   * charging in spend order across the holds always fits.
   *
   * ⛔ WHAT IS RELEASED AND NOT CHARGED IS NOT ALWAYS THE CUSTOMER'S TO KEEP.
   * In order: a clawback still owed credit that this task was holding is paid
   * first, oldest first, and each claim is paid once (M5); then, on a revoked
   * lot, what is left repays debt; then, on a lot whose term has ended or that
   * was revoked, the remainder expires. Only credit released onto a live lot
   * stays spendable.
   */
  async settleIn(
    tx: CreditLedgerTx,
    reservationId: string,
    reason: CreditSettleReason,
  ): Promise<CreditSettleResult> {
    const { ledger, reservations } = this.deps;
    const accountId = await reservations.accountOf(tx, reservationId);
    if (accountId === null) return EMPTY_SETTLEMENT;
    const account = await ledger.lockAccount(tx, accountId);
    const reservation = await reservations.lockReservation(tx, reservationId);
    if (reservation === null) return EMPTY_SETTLEMENT;
    if (reservation.state === 'settled') {
      // A late settle after the keeper's is a no-op, and it reports what the
      // task WAS charged rather than zero: the caller asked what this task cost.
      return {
        ...EMPTY_SETTLEMENT,
        outcome: 'already_settled',
        chargedMicro: reservation.chargedMicro ?? 0,
      };
    }

    await reservations.settleStartedCallsAfterACrash(tx, reservationId);
    const chargedMicro = await reservations.chargedByCalls(tx, reservationId);

    if (reservation.mode === 'shadow') {
      await reservations.markSettled(tx, { reservationId, chargedMicro, settleReason: reason });
      return { ...EMPTY_SETTLEMENT, outcome: 'settled', chargedMicro };
    }

    const claims = (await reservations.pendingClaims(tx, accountId)).map((claim) => ({
      ...claim,
      owed: claim.pendingMicro,
    }));
    const charges: { lotId: string; micro: number }[] = [];
    let left = chargedMicro;
    let owedDebt = account.debtMicro;
    let claimsPaidMicro = 0;

    for (const hold of await reservations.openHoldsInSpendOrder(tx, reservationId)) {
      const take = Math.min(left, hold.heldMicro);
      // The release comes FIRST. `held_micro` is part of what the lot has
      // committed, so charging before releasing would momentarily leave the lot
      // holding more than it has left and the database would refuse it.
      await reservations.releaseHold(tx, { reservationId, lotId: hold.lotId, chargedMicro: take });
      left = left - take;
      if (take > 0) {
        charges.push({ lotId: hold.lotId, micro: take });
        await ledger.append(
          {
            accountId,
            kind: 'task_charge',
            lotId: hold.lotId,
            amountMicro: take,
            idempotencyKey: `task_charge:${reservationId}:${hold.lotId}`,
            reservationId,
            rateCardVersion: reservation.rateCardVersion,
            model: reservation.model,
            agentSessionId: reservation.agentSessionId,
          },
          tx,
        );
      }

      let released = hold.heldMicro - take;
      released = await this.payClaims(tx, {
        accountId,
        reservationId,
        lotId: hold.lotId,
        released,
        claims,
        onPaid: (micro) => {
          claimsPaidMicro = claimsPaidMicro + micro;
        },
      });
      if (released > 0 && hold.lotRevoked && owedDebt > 0) {
        const repay = Math.min(released, owedDebt);
        await ledger.append(
          {
            accountId,
            kind: 'debt_repayment',
            lotId: hold.lotId,
            amountMicro: repay,
            idempotencyKey: `task_release_debt:${reservationId}:${hold.lotId}`,
          },
          tx,
        );
        released = released - repay;
        owedDebt = owedDebt - repay;
      }
      if (released > 0 && hold.lotDone) {
        await ledger.append(
          {
            accountId,
            kind: 'expiry',
            lotId: hold.lotId,
            amountMicro: released,
            idempotencyKey: `task_release_expiry:${reservationId}:${hold.lotId}`,
          },
          tx,
        );
      }
    }

    await reservations.markSettled(tx, { reservationId, chargedMicro, settleReason: reason });
    const claimsToDebtMicro = await this.claimsLeftBecomeDebt(tx, {
      accountId,
      reservationId,
      claims,
    });
    await ledger.settleDebtFromFree(tx, accountId);
    return {
      outcome: 'settled',
      chargedMicro,
      charges,
      claimsPaidMicro,
      claimsToDebtMicro,
    };
  }

  /**
   * Pay standing claims out of the credit one hold released, oldest first, and
   * return what is left. Each claim's own `owed` falls as it is paid, so two
   * lots never pay the same claim twice over.
   */
  private async payClaims(
    tx: CreditLedgerTx,
    input: {
      readonly accountId: string;
      readonly reservationId: string;
      readonly lotId: string;
      readonly released: number;
      readonly claims: { owed: number; readonly clawbackId: string; readonly source: string }[];
      readonly onPaid: (micro: number) => void;
    },
  ): Promise<number> {
    let released = input.released;
    for (const claim of input.claims) {
      if (released <= 0) break;
      if (claim.owed <= 0) continue;
      const paid = Math.min(released, claim.owed);
      await this.deps.ledger.append(
        {
          accountId: input.accountId,
          kind: clawbackLedgerKind(claim.source as CreditClawbackSource),
          lotId: input.lotId,
          amountMicro: paid,
          idempotencyKey: `claim:${claim.clawbackId}:${input.reservationId}:${input.lotId}`,
          reason: claim.source,
        },
        tx,
      );
      await this.deps.reservations.payPendingClaim(tx, {
        clawbackId: claim.clawbackId,
        micro: paid,
      });
      claim.owed = claim.owed - paid;
      released = released - paid;
      input.onPaid(paid);
    }
    return released;
  }

  /**
   * A claim nothing is left to pay it becomes debt — but only once the account
   * has no other enforced task running, because that task's own credit may yet
   * pay it. One `debt_incurred` row per clawback, carrying THAT clawback's
   * reason: the plan's "one row for their sum" is the same row whenever the
   * claims come from one clawback, which is the only case reachable today, and
   * two clawbacks of different sources must not be recorded under one reason.
   *
   * ⛔ THE CLAWBACK'S OWN RECORD MOVES WITH THE LEDGER'S, NOT AFTER IT. The
   * claim does not merely disappear: it BECOMES the clawback's `debt_micro`, in
   * the one statement 0132's guard permits. Until 0132 the guard listed
   * `debt_micro` among the immutable facts, so this wrote the ledger row and
   * left the clawback saying it had caused no debt at all — and M6's "forgive
   * the unrepaid debt it created", read off that row, would forgive too little.
   */
  private async claimsLeftBecomeDebt(
    tx: CreditLedgerTx,
    input: {
      readonly accountId: string;
      readonly reservationId: string;
      readonly claims: readonly (PendingCreditClaim & { readonly owed: number })[];
    },
  ): Promise<number> {
    const left = input.claims.filter((claim) => claim.owed > 0);
    if (left.length === 0) return 0;
    if (
      await this.deps.reservations.hasOtherOpenEnforce(tx, {
        accountId: input.accountId,
        exceptReservationId: input.reservationId,
      })
    ) {
      return 0;
    }
    let total = 0;
    for (const claim of left) {
      await this.deps.ledger.append(
        {
          accountId: input.accountId,
          kind: 'debt_incurred',
          amountMicro: claim.owed,
          reason: clawbackDebtReason(claim.source as CreditClawbackSource),
          idempotencyKey: `claim_debt:${claim.clawbackId}:${input.reservationId}`,
        },
        tx,
      );
      await this.deps.reservations.pendingClaimBecomesDebt(tx, {
        clawbackId: claim.clawbackId,
        micro: claim.owed,
      });
      total = total + claim.owed;
    }
    return total;
  }
}

/** At most three enforced tasks per account, in flight at once. */
const MAX_ENFORCED_TASKS = 3;

/** The two bases that cost nothing whether or not the request went out (§4.6). */
const FREE_SETTLE_BASES: readonly CreditCallSettleBasis[] = ['provider_rejected', 'never_sent'];

/**
 * The basis to settle one call under, decided by what the DATABASE says about
 * whether its request went out — IN BOTH DIRECTIONS, because `sent` is the only
 * fact either settlement can read and the two must reach the same number.
 *
 *   · the row says NOT sent, and the caller named a basis that charges →
 *     `never_sent`, nothing to pay for. Left alone otherwise: `provider_rejected`
 *     already charges nothing, so correcting it would rewrite the audit trail
 *     without moving a number.
 *   · the row says SENT, and the caller named `never_sent` → `no_record`, the
 *     full bound. §5.3 prices exactly that window — after `sent`, before any
 *     record — at the bound, and `settleStartedCallsAfterACrash` charges this
 *     same row the same way. ⛔ AND THE DATABASE REFUSES THE ALTERNATIVE:
 *     `credit_model_calls_never_sent_really` rejects that basis on a sent row,
 *     so writing what the caller asked would raise a CHECK violation out of the
 *     adapter's per-attempt `finally`, leave the call `started`, and hand the
 *     keeper the same full bound ninety seconds later — the worse half of both
 *     outcomes.
 *
 * `onCorrected` is told which basis replaced the caller's, because each
 * direction is a caller defect that must be findable rather than silent.
 */
function basisTheRowAgreesWith(
  asked: CreditCallSettleBasis,
  sent: boolean,
  onCorrected: (corrected: CreditCallSettleBasis) => void,
): CreditCallSettleBasis {
  if (sent) {
    if (asked !== 'never_sent') return asked;
    onCorrected('no_record');
    return 'no_record';
  }
  if (FREE_SETTLE_BASES.includes(asked)) return asked;
  onCorrected('never_sent');
  return 'never_sent';
}

/** No such call: an answer, not an exception, exactly as for a missing task. */
const UNSETTLED_CALL = {
  outcome: 'unknown' as const,
  chargedMicro: 0,
  boundMicro: 0,
  overBound: false,
};

const EMPTY_SETTLEMENT: CreditSettleResult = {
  outcome: 'unknown',
  chargedMicro: 0,
  charges: [],
  claimsPaidMicro: 0,
  claimsToDebtMicro: 0,
};

/**
 * The reservation's request key: `'idem:<key>'` on the idempotent lane and NULL
 * everywhere else (M2).
 *
 * ⛔ NEVER THE REQUEST ID. `genReqId` returns the inbound `x-request-id` when
 * one is present, which any client or proxy may repeat; keyed on that, the
 * unique index would refuse every task after the first. The idempotent lane
 * already prevents re-execution through its turn receipt, so the key here is a
 * second guard on a lane that asked for one.
 */
export function requestKeyFor(idempotencyKey: string | null): string | null {
  if (idempotencyKey === null) return null;
  const trimmed = idempotencyKey.trim();
  return trimmed === '' ? null : `idem:${trimmed}`;
}
