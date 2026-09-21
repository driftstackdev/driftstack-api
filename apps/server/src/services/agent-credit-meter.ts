// What the AI runtime asks before every billable model call, and tells
// afterwards (§4.5, §4.6, S10).
//
// ⛔ WHY THE PLANNER ADAPTER DOES NOT TALK TO THE RESERVATION DIRECTLY. The
// adapter knows four things nothing else knows — what the request body WILL be,
// how its bytes split across the cache regions, how many of them are droppable
// conversation history, and what `max_tokens` it is about to ask for — and it
// knows nothing about reservations, lots, holds or SQL. This interface is that
// boundary, and it is the whole of it: the adapter hands over four facts per
// attempt and is answered with one of four words.
//
//   admit as it stands        the bound fits; send exactly what you built
//   admit at a lower ceiling  it fits once `max_tokens` comes down; rebuild
//   rebuild with less history plan calls only; drop the oldest entries to fit
//                             inside this many BYTES and ask again
//   refuse                    nothing that can be cut makes it fit
//
// plus a fifth answer that is not a decision at all — `nothing_to_meter`, for a
// turn this meter has nothing to say about (see below).
//
// ⛔ THE BOUND AND THE CHARGE ARE NOT RE-DERIVED HERE. The fit ladder is
// `fitCall` (credit-call-fit.ts), the bound is `callUpperBound` (api-types) and
// the charge is `callSettlement` (credit-call-charge.ts), each already proved
// against the DDL. This module decides nothing about money; it sequences four
// database calls around one HTTP attempt and translates between the adapter's
// vocabulary and the reservation's.
//
// ⛔ TWO FLAVOURS, AND THE DIFFERENCE IS NOT A FLAG ON ONE CODE PATH.
//
//  · ENFORCE — refusals are real and end the turn. A DATABASE FAULT DURING
//    ADMISSION IS NOT A REFUSAL: it throws {@link AgentCreditMeterUnavailableError},
//    which classifies transient, and it is never worded as "credits used". The
//    customer whose database blinked has not spent anything, and telling them
//    they have is a lie they cannot check (H5).
//
//  · SHADOW — it measures and it must be INVISIBLE (M3). It never refuses,
//    never lowers `max_tokens`, never asks for a rebuild, never throws, and
//    never adds more than a short bounded wait. The WHOLE per-attempt leg —
//    plan, admit, mark sent, settle — is ONE unit: the first fault marks the
//    attempt lost, counts `ai_credits_shadow_lost` EXACTLY ONCE for that
//    attempt, and turns every later step of that attempt into a no-op. Counting
//    per call instead would report four losses for one blink and make the lost
//    rate — which M3 names as a shadow exit criterion — unreadable.
//
// ⛔ `planCall` ANSWERING `{ outcome: 'unavailable', reason: 'model' }` MEANS
// "NOTHING TO MEASURE ON THIS TURN", NOT "SOMETHING WENT WRONG". A shadow task
// whose model the pinned card does not price reserves zero and records the
// would-refuse reason at reserve; enforcement would have refused it on its model
// long before any call. So the shadow meter makes no call and counts NOTHING
// lost — a loss there would put a permanent floor under the lost rate for every
// own-key-only model in the picker.

import { randomUUID } from 'node:crypto';
import {
  callUpperBound,
  type CreditRates,
  type ModelCallTokens,
  type RequestRegionBytes,
} from '@driftstack/api-types';
import type {
  CreditAdmissionRefusal,
  CreditCallSettleBasis,
  CreditModelCallPurpose,
} from '../db/credit-reservations-repo.js';
import { admittedBound, type CallFitDecision } from './credit-call-fit.js';
import { withinShadowDeadline } from './ai-credits-runtime.js';
import {
  CREDIT_SHADOW_STATEMENT_TIMEOUT_MS,
  type CreditReservationsService,
} from './credit-reservations.js';

/**
 * The part of the reservations service one attempt needs. Structural on purpose:
 * a test drives the meter with four functions and no database, and nothing here
 * can reach past these four.
 */
export type AgentCreditReservations = Pick<
  CreditReservationsService,
  'planCall' | 'admitCall' | 'markSent' | 'settleCall'
>;

/** What one attempt tells the meter about the request it has built. */
export interface AgentCreditAttempt {
  readonly purpose: CreditModelCallPurpose;
  /** The model the request will ACTUALLY be sent to, not the task's (M10). */
  readonly model: string;
  /** The serialized body's bytes, split at its cache markers (§4.5 R1/R2/R3). */
  readonly regions: RequestRegionBytes;
  /** The `max_tokens` the request carries as it stands. */
  readonly maxOutputTokens: number;
  /**
   * How many of the body's bytes are conversation history the caller could drop
   * and still make the same call. Zero when there is nothing droppable — always
   * true of an answer call, which carries no history window.
   */
  readonly historyBytes: number;
}

/** Why a metered attempt may not be made. */
export type AgentCreditRefusalReason =
  | CreditAdmissionRefusal
  /** The adapter cannot measure its own requests, so it cannot be metered. */
  | 'unmetered_provider';

/**
 * What one call tells the meter when it is over. The union mirrors §4.6's table
 * and carries the usage exactly where that table needs it, so a caller cannot
 * name `provider_usage` and forget the counts it is priced from.
 */
export type AgentCreditSettlement =
  | { readonly basis: 'provider_usage'; readonly usage: ModelCallTokens }
  /** Stop, a torn stream or an error frame after `message_start`: the input and
   *  cache as observed, the output at the ceiling it was admitted under. */
  | { readonly basis: 'partial_usage'; readonly usage: ModelCallTokens }
  | { readonly basis: 'provider_rejected' }
  | { readonly basis: 'never_sent' }
  | { readonly basis: 'no_record' };

/** One admitted call, from the statement that admitted it to the one that pays for it. */
export interface AgentCreditCall {
  /**
   * The `max_tokens` this call was admitted under. When it is below what the
   * attempt asked for, the caller MUST rebuild the body with this number before
   * sending: the bound was priced at this ceiling, and sending a higher one
   * would let the call cost more than the task committed for it.
   */
  readonly maxOutputTokens: number;
  /**
   * Record that the request is going out, in its own statement, immediately
   * before it does (§4.5).
   *
   * False means the call is no longer started — the lease keeper settled the
   * task around it — and an ENFORCE caller must not send the request. A SHADOW
   * caller is always answered true: what the measurement found is not a decision
   * about the customer's turn.
   */
  markSent(): Promise<boolean>;
  /**
   * Pay for the call, in the attempt's `finally` (§4.6).
   *
   * ⛔ IT NEVER THROWS. A settlement that escaped would replace the turn's own
   * outcome with a database error, which is wrong in enforce (the lease keeper
   * finishes an unsettled call within 90 s — §5.3) and forbidden in shadow (M3).
   */
  settle(settlement: AgentCreditSettlement): Promise<void>;
}

export type AgentCreditDecision =
  | { readonly outcome: 'admitted'; readonly call: AgentCreditCall }
  /** Plan calls only: rebuild keeping at most this many BYTES of history, then ask again. */
  | { readonly outcome: 'rebuild'; readonly historyByteBudget: number }
  | { readonly outcome: 'refused'; readonly reason: AgentCreditRefusalReason }
  /** Nothing to measure and nothing to decide: send exactly what you built. */
  | { readonly outcome: 'nothing_to_meter' };

export interface AgentCreditMeter {
  /**
   * ENFORCE refuses for real; SHADOW only measures. An adapter that cannot
   * measure its own requests reads this to decide between failing closed and
   * sending exactly as it always has.
   */
  readonly kind: 'enforce' | 'shadow';
  /**
   * The task's reservation (§4.4) — the one identity every call of this turn is
   * admitted against.
   *
   * ⛔ IT IS HERE SO THE USAGE ROW CAN NAME IT, and for nothing else. The report
   * has to put what a turn really COST (the provider's list price, from the
   * turn's `usage_records` rows) beside what it was MEASURED at (the charge on
   * this reservation's `credit_model_calls`), and the only thing that says those
   * two are the same turn is this id written on both sides. Without it the ratio
   * is a comparison of two populations that merely happen to be near each other:
   * a turn on the customer's own key contributes usage rows and no calls, and
   * the "must be 2.0" check would quietly become "2.0 on average, over whatever
   * was in the window".
   */
  readonly reservationId: string;
  admit(attempt: AgentCreditAttempt): Promise<AgentCreditDecision>;
}

/**
 * Admission could not be decided — the database was unreachable, timed out, or
 * refused the statement. TRANSIENT, and deliberately not worded as anything
 * about credits: nothing was spent and nothing ran out.
 */
export class AgentCreditMeterUnavailableError extends Error {
  constructor(readonly step: 'plan' | 'admit' | 'sent') {
    super('the AI credit check could not be completed just now');
    this.name = 'AgentCreditMeterUnavailableError';
  }
}

export interface AgentCreditMeterDeps {
  readonly reservations: AgentCreditReservations;
  /** The task's reservation, opened by the route before the turn began (§4.4). */
  readonly reservationId: string;
  /** Minted by the caller so a crash between minting and committing is findable. */
  readonly newCallId?: () => string;
  /** Reported once per attempt whose shadow leg was lost (`ai_credits_shadow_lost`). */
  readonly onShadowLost?: (err: unknown) => void;
  /** Reported when an ENFORCE settlement failed and was left to the lease keeper. */
  readonly onSettleFailed?: (err: unknown) => void;
  /** The ceiling on EACH shadow database call. A hung database must not hang a turn. */
  readonly shadowDeadlineMs?: number;
}

/**
 * ENFORCE: the task really is funded from its reservation, and a call that does
 * not fit does not happen.
 */
export function enforceCreditMeter(deps: AgentCreditMeterDeps): AgentCreditMeter {
  const newCallId = deps.newCallId ?? randomUUID;
  return {
    kind: 'enforce',
    reservationId: deps.reservationId,
    async admit(attempt: AgentCreditAttempt): Promise<AgentCreditDecision> {
      const plan = await enforceStep('plan', () =>
        deps.reservations.planCall({
          reservationId: deps.reservationId,
          purpose: attempt.purpose,
          regions: attempt.regions,
          historyBytes: attempt.historyBytes,
        }),
      );
      if (plan.outcome === 'unavailable') return { outcome: 'refused', reason: plan.reason };
      // M10 — a call on a model the task did not reserve is refused here as well
      // as by the admission statement, so the answer names the model rather than
      // arriving as an unexplained zero-row update.
      if (plan.model !== attempt.model) return { outcome: 'refused', reason: 'model' };
      if (plan.decision.rung === 'refuse') return { outcome: 'refused', reason: 'did_not_fit' };
      if (plan.decision.rung === 'trim_history') {
        return { outcome: 'rebuild', historyByteBudget: plan.decision.historyByteBudget };
      }
      const bound = admittedBound(atMostTheCeilingAsked(plan.decision, attempt, plan.rates));
      /* c8 ignore next -- `admittedBound` is null only for the two rungs returned above */
      if (bound === null) return { outcome: 'refused', reason: 'did_not_fit' };
      const callId = newCallId();
      const admitted = await enforceStep('admit', () =>
        deps.reservations.admitCall({
          reservationId: deps.reservationId,
          purpose: attempt.purpose,
          model: plan.model,
          bound,
          callId,
        }),
      );
      if (admitted.outcome === 'refused') {
        return { outcome: 'refused', reason: admitted.reason };
      }
      return {
        outcome: 'admitted',
        call: {
          maxOutputTokens: bound.maxOutputTokens,
          markSent: () => enforceStep('sent', () => deps.reservations.markSent(admitted.callId)),
          settle: async (settlement) => {
            try {
              await deps.reservations.settleCall(settleCallInput(admitted.callId, settlement));
            } catch (err) {
              // §5.3 — the lease lapses and the keeper settles within 90 s. What
              // must not happen is this replacing the turn's own outcome.
              deps.onSettleFailed?.(err);
            }
          },
        },
      };
    },
  };
}

/** Every database step of an enforce admission fails the same way: transiently. */
async function enforceStep<T>(step: 'plan' | 'admit' | 'sent', work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw new AgentCreditMeterUnavailableError(step);
  }
}

/**
 * SHADOW: the same four statements, and not one of them may change the turn (M3).
 */
export function shadowCreditMeter(deps: AgentCreditMeterDeps): AgentCreditMeter {
  const newCallId = deps.newCallId ?? randomUUID;
  const deadlineMs = deps.shadowDeadlineMs ?? CREDIT_SHADOW_STATEMENT_TIMEOUT_MS;
  return {
    kind: 'shadow',
    reservationId: deps.reservationId,
    async admit(attempt: AgentCreditAttempt): Promise<AgentCreditDecision> {
      // ⛔ ONE LEG PER ATTEMPT. Every step below shares this object, so the first
      // fault counts once and silences the rest of the attempt.
      const leg = new ShadowLeg(deps.onShadowLost, deadlineMs);
      const plan = await leg.step(() =>
        deps.reservations.planCall({
          reservationId: deps.reservationId,
          purpose: attempt.purpose,
          regions: attempt.regions,
          historyBytes: attempt.historyBytes,
        }),
      );
      // Lost, or nothing this task can be measured against — a model the pinned
      // card never priced, a task that is gone, settled or past its ceiling. None
      // of those is a fault, and none counts as lost.
      if (plan === LOST || plan.outcome === 'unavailable') return NOTHING_TO_METER;
      // A shadow task is always planned at the ceiling (`planCall`), so the two
      // rungs that ask the caller to change its request are unreachable here.
      // Answered as "nothing to measure" rather than acted on, because acting on
      // either one would alter the turn.
      if (plan.decision.rung !== 'ceiling' && plan.decision.rung !== 'lower_output') {
        return NOTHING_TO_METER;
      }
      const bound = admittedBound(atMostTheCeilingAsked(plan.decision, attempt, plan.rates));
      if (bound === null) return NOTHING_TO_METER;
      const admitted = await leg.step(() =>
        deps.reservations.admitCall({
          reservationId: deps.reservationId,
          purpose: attempt.purpose,
          // The model the request really goes to. A shadow task measures what
          // this turn costs, and the task's own model is what the admission
          // statement checks it against; a mismatch answers `refused` below and
          // is simply not measured.
          model: attempt.model,
          bound,
          callId: newCallId(),
        }),
      );
      if (admitted === LOST || admitted.outcome === 'refused') return NOTHING_TO_METER;
      const callId = admitted.callId;
      return {
        outcome: 'admitted',
        call: {
          // ⛔ WHAT THE ATTEMPT ASKED FOR, ALWAYS. A shadow measurement that
          // lowered a live turn's output ceiling would be measuring the limit
          // rather than the load, and it would change the reply the customer
          // reads.
          maxOutputTokens: attempt.maxOutputTokens,
          markSent: async () => {
            const sent = await leg.step(() => deps.reservations.markSent(callId));
            // A shadow task settled around us ends the measurement, not the turn.
            if (sent === LOST || !sent) leg.finish();
            return true;
          },
          settle: async (settlement) => {
            await leg.step(() => deps.reservations.settleCall(settleCallInput(callId, settlement)));
          },
        },
      };
    },
  };
}

const NOTHING_TO_METER: AgentCreditDecision = Object.freeze({ outcome: 'nothing_to_meter' });

/** What a shadow step answers when it failed, timed out, or the leg is over. */
const LOST = Symbol('shadow leg is over');
type Lost = typeof LOST;

/**
 * One attempt's shadow leg: plan, admit, mark sent, settle, as a single unit.
 *
 * ⛔ ONE COUNT PER ATTEMPT, NOT PER CALL. A database blink fails whichever step
 * it lands on, and once it has, the remaining steps would fail too; counting
 * each would report four losses for one event.
 *
 * ⛔ AND A DEADLINE PER STEP, WHICH IS THE ONLY BOUND THESE FOUR STATEMENTS
 * HAVE. The 2 s `statement_timeout` in credit-reservations.ts is set in ONE
 * place — `reserveShadow`, the §4.4 reserve — and `planCall`, `admitCall`,
 * `markSent` and `settleCall` set none, so nothing in the database bounds them
 * (`DB_STATEMENT_TIMEOUT_MS` is optional and unset by default, so there is no
 * per-connection backstop either).
 *
 * The bound itself is {@link withinShadowDeadline}, shared with the route's
 * `reserve` and `settle` waits so the whole shadow leg carries ONE rule: it
 * stops the WAITING and cannot stop the statement. Bounding the statement
 * itself belongs to the file that owns the SQL.
 */
class ShadowLeg {
  private over = false;

  constructor(
    private readonly onShadowLost: ((err: unknown) => void) | undefined,
    private readonly deadlineMs: number,
  ) {}

  finish(): void {
    this.over = true;
  }

  async step<T>(work: () => Promise<T>): Promise<T | Lost> {
    if (this.over) return LOST;
    try {
      // ⛔ THE SAME BOUND THE ROUTE PUTS ON `reserve` AND `settle`, from one
      // definition (ai-credits-runtime.ts). M3 is a promise about the whole
      // shadow leg, so the two halves of it may not carry two copies of the
      // rule that keeps it.
      return await withinShadowDeadline(work, this.deadlineMs);
    } catch (err) {
      this.over = true;
      try {
        this.onShadowLost?.(err);
      } catch {
        // Counting the loss must not become a second way to lose the turn.
      }
      return LOST;
    }
  }
}

/**
 * The decision, capped at the ceiling the attempt actually asked for.
 *
 * ⛔ A METER MAY LOWER A CALL'S CEILING AND MUST NEVER RAISE IT. The ladder
 * prices `CALL_OUTPUT_CEILING[purpose]`, which is the adapter's own ceiling
 * today (pinned by `the-fit-ladders-ceiling-is-the-one-the-adapter-sends`); an
 * adapter that asked for less would otherwise be admitted — and charged, when a
 * torn stream settles `partial_usage` — for output it never asked for.
 *
 * The bound is rebuilt at the lower ceiling through `callUpperBound`, the same
 * primitive `fitCall` used, so nothing about how a bound is assembled is written
 * twice; and a lower ceiling only ever lowers the bound, so a decision that fit
 * still fits.
 */
function atMostTheCeilingAsked(
  decision: Extract<CallFitDecision, { rung: 'ceiling' | 'lower_output' }>,
  attempt: AgentCreditAttempt,
  rates: CreditRates,
): CallFitDecision {
  if (attempt.maxOutputTokens >= decision.maxOutputTokens) return decision;
  return {
    rung: decision.rung,
    maxOutputTokens: attempt.maxOutputTokens,
    bound: callUpperBound(attempt.regions, attempt.maxOutputTokens, rates),
  };
}

/** §4.6's table, as the settlement statement takes it. */
function settleCallInput(
  callId: string,
  settlement: AgentCreditSettlement,
): { callId: string; basis: CreditCallSettleBasis; usage?: ModelCallTokens | null } {
  return settlement.basis === 'provider_usage' || settlement.basis === 'partial_usage'
    ? { callId, basis: settlement.basis, usage: settlement.usage }
    : { callId, basis: settlement.basis };
}
