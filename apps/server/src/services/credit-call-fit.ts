// Whether ONE model call may start, and what it is allowed to cost if it does
// (§4.5, M4).
//
// Everything here is PURE: no clock, no database, no environment. It takes byte
// counts, a rate card's prices and the room the task has left, and it answers
// one of four things — the four rungs of the fit ladder:
//
//   1. `ceiling`       the call fits at the model's full output ceiling; admit it;
//   2. `lower_output`  it fits once `max_tokens` comes down, but no lower than
//                      the floor a useful reply needs;
//   3. `trim_history`  (plan calls only) it cannot fit at any allowed output
//                      ceiling, but it would if the conversation carried fewer
//                      BYTES of history — so the caller is told how many bytes
//                      of history it may keep, and asks again;
//   4. `refuse`        nothing that can be cut makes it fit; the call never
//                      starts and it costs nothing.
//
// ⛔ THE BOUND IS AN UPPER BOUND, NEVER AN ESTIMATE. It comes from
// `callUpperBound` (S1), which prices each region of the serialized body at the
// dearest rate a token in it can be billed at and counts one token per BYTE.
// `count_tokens` is NOT a rung here (M4): the provider documents that call's
// result as an estimate, and the owner's rule is an exact count or an upper
// bound, never an estimate. Rung 3 exists precisely because dropping that rung
// would otherwise refuse long non-English sessions outright — 96,000 characters
// of CJK is about 288 KB, which no reservation could ever cover.
//
// ⛔ RUNG 3 PRICES THE BYTES IT ASKS THE CALLER TO DROP AT THE CHEAPEST RATE ANY
// BYTE CAN CARRY. This module is not told WHICH region the history sits in — it
// may be cached with the system block or not cached at all — so it assumes the
// cheapest, the plain input rate. Assuming the dearest would ask for too few
// bytes and the rebuilt call would still not fit, which is the loop that never
// ends; assuming the cheapest asks for at least enough, always.
//
// ⛔ WHAT THE CALLER MUST PUT IN R1, AND WHY THE PLAN'S OWN WORDING IS NOT AN
// UPPER BOUND. §4.5 describes R3 as "the rest, including the JSON envelope and
// `output_config`". That is wrong in one direction: the decomposer spreads its
// reply controls (`thinking`, and `output_config` carrying the effort setting
// and the JSON-schema format) into every plan call AHEAD of `system`, and the
// provider renders those ahead of tools and system on some models — inside the
// prefix written to the 1-hour cache. Priced at the plain input rate they would
// be UNDER-counted, and the "bound" would not bound.
//
//   R1 = every byte rendered up to and including the last 1-hour block — the
//        reply controls and the tool definitions included.
//   R2 = what follows, up to and including the last 5-minute marker.
//   R3 = only what is rendered after the last marker.
//
// Whether `output_config.format` is rendered there too is not verified, so it is
// treated the same way: in the dearest region, which is the direction that keeps
// the bound a bound.
//
// ⛔ WHAT THE FRAMING ALLOWANCE IS STILL FOR, once R1 is counted that widely. It
// is NOT the envelope — the envelope is bytes, and bytes are counted. It is the
// tokens the provider bills that the body does not spell out at all: role
// markers, block boundaries and the tool-use scaffolding the API adds around
// what was sent. Those are rendered inside the cached prefix, so
// `callUpperBound` prices all 2,048 of them at the 1-hour rate — the dearest any
// of them could be billed at.

import {
  callUpperBound,
  maxOutputTokensWithin,
  type CallUpperBound,
  type CreditRates,
  type RequestRegionBytes,
} from '@driftstack/api-types';
import type { CreditCallBound, CreditModelCallPurpose } from '../db/credit-reservations-repo.js';

/**
 * The output ceiling each kind of call asks for when nothing is in its way.
 * These are the `max_tokens` the adapter sends today (`agent-decomposer-claude.ts`
 * `MAX_OUTPUT_TOKENS` and `ANSWER_MAX_OUTPUT_TOKENS`), and a call admitted at the
 * ceiling is priced exactly as it will be sent.
 */
export const CALL_OUTPUT_CEILING: Readonly<Record<CreditModelCallPurpose, number>> = Object.freeze({
  plan: 8_192,
  answer: 4_096,
});

/**
 * The lowest output ceiling a call is allowed to run under. Below this the reply
 * is cut off mid-sentence and the customer has paid for a turn that answered
 * nothing, so the honest outcome is to refuse the call at no charge instead.
 */
export const CALL_OUTPUT_FLOOR: Readonly<Record<CreditModelCallPurpose, number>> = Object.freeze({
  plan: 1_024,
  answer: 512,
});

export interface CallFitInput {
  readonly purpose: CreditModelCallPurpose;
  /** `reserved − committed`: what this task has left to commit. */
  readonly roomMicro: number;
  /** The serialized body, split at its cache markers. */
  readonly regions: RequestRegionBytes;
  /** The rate card pinned to the reservation, never today's card. */
  readonly rates: CreditRates;
  /**
   * How many of the body's bytes are conversation history the caller could drop
   * and still make the same call. Zero when there is nothing droppable, which is
   * always true of an answer call (it carries no history window).
   */
  readonly historyBytes: number;
}

export type CallFitDecision =
  | {
      readonly rung: 'ceiling';
      readonly maxOutputTokens: number;
      readonly bound: CallUpperBound;
    }
  | {
      readonly rung: 'lower_output';
      readonly maxOutputTokens: number;
      readonly bound: CallUpperBound;
    }
  | {
      /** Rebuild the body keeping at most this many bytes of history, then ask again. */
      readonly rung: 'trim_history';
      readonly historyByteBudget: number;
      readonly dropBytes: number;
    }
  | {
      readonly rung: 'refuse';
      /** The smallest bound this body could ever be admitted under. */
      readonly neededMicro: number;
      /** How much more room that would take than the task has. Always positive. */
      readonly shortfallMicro: number;
    };

/**
 * Which rung this call lands on. See the file header for the ladder.
 *
 * ⛔ A DECISION OF `ceiling` OR `lower_output` CARRIES A BOUND THAT FITS. Both
 * satisfy `bound.boundMicro <= roomMicro`, which is the same predicate the
 * admission statement re-checks against the reservation's own row — so a race
 * that shrinks the room between this answer and that statement ends in a
 * refusal, never in an over-commitment.
 *
 * ⛔ RUNG 3 ALWAYS SHRINKS. `dropBytes` is at least one, so the budget it
 * returns is strictly smaller than the history it was given; a caller that
 * rebuilds and asks again therefore reaches `ceiling`, `lower_output` or
 * `refuse` in a finite number of rounds.
 */
export function fitCall(input: CallFitInput): CallFitDecision {
  const { purpose, roomMicro, regions, rates, historyBytes } = input;
  requireSafeInteger('roomMicro', roomMicro);
  requireNonNegativeSafeInteger('historyBytes', historyBytes);

  if (rates.outputMicroPerToken <= 0) {
    // `credit_model_calls_bound` requires `bound_micro > input_bound_micro`, so
    // a free output rate produces a bound the database will not accept: the
    // admission would die on a constraint instead of answering. No published
    // card has one; this says so here rather than three statements later.
    throw new RangeError('a rate card with a free output rate cannot bound a call');
  }
  const ceilingTokens = CALL_OUTPUT_CEILING[purpose];
  const floorTokens = CALL_OUTPUT_FLOOR[purpose];
  // `callUpperBound` refuses rates that break read <= input <= 5m <= 1h, which
  // is what makes "the dearest rate this region can be billed at" true at all.
  const atCeiling = callUpperBound(regions, ceilingTokens, rates);
  if (atCeiling.boundMicro <= roomMicro) {
    return { rung: 'ceiling', maxOutputTokens: ceilingTokens, bound: atCeiling };
  }

  // Rung 2: the largest ceiling whose bound still fits, never above the one we
  // just failed at and never below the floor.
  const allowed = Math.min(
    maxOutputTokensWithin(roomMicro, atCeiling.inputBoundMicro, rates),
    ceilingTokens,
  );
  if (allowed >= floorTokens) {
    const bound = callUpperBound(regions, allowed, rates);
    return { rung: 'lower_output', maxOutputTokens: allowed, bound };
  }

  // The smallest bound this body could ever be admitted under: its input, which
  // only rung 3 can change, plus the floor's worth of output.
  const floorOutputMicro = floorTokens * rates.outputMicroPerToken;
  const neededMicro = atCeiling.inputBoundMicro + floorOutputMicro;
  const refuse = {
    rung: 'refuse',
    neededMicro,
    shortfallMicro: neededMicro - roomMicro,
  } as const;

  // Rung 3, plan calls only. An answer call carries no history window, so there
  // is nothing it could drop and asking it to would be asking for the question.
  if (purpose !== 'plan' || historyBytes === 0) return refuse;
  const allowedInputMicro = roomMicro - floorOutputMicro;
  // Not one byte of body would fit beside the floor's output. No amount of
  // trimming reaches that, because the framing allowance alone outlasts it.
  if (allowedInputMicro <= 0) return refuse;
  if (rates.inputMicroPerToken <= 0) {
    // With a free input rate, dropping bytes from the cheapest region saves
    // nothing, and this module cannot tell which region the history is in. That
    // is a rate card nobody has published; it fails loudly rather than looping.
    throw new RangeError('a rate card with a free input rate cannot price a history trim');
  }
  const excessMicro = atCeiling.inputBoundMicro - allowedInputMicro;
  const dropBytes = ceilDiv(excessMicro, rates.inputMicroPerToken);
  if (dropBytes > historyBytes) return refuse;
  return { rung: 'trim_history', historyByteBudget: historyBytes - dropBytes, dropBytes };
}

/**
 * The bound to admit this call under, or null when the ladder did not reach a
 * rung that admits anything. `'region_bytes'` is the only basis this system
 * writes: `count_tokens` is not a rung (M4), and the column's other value exists
 * only so that a later card could record one if the owner ever rules that count
 * exact.
 */
export function admittedBound(decision: CallFitDecision): CreditCallBound | null {
  if (decision.rung !== 'ceiling' && decision.rung !== 'lower_output') return null;
  return {
    inputBoundTokens: decision.bound.inputBoundTokens,
    inputBoundMicro: decision.bound.inputBoundMicro,
    maxOutputTokens: decision.maxOutputTokens,
    boundMicro: decision.bound.boundMicro,
    basis: 'region_bytes',
  };
}

/** `ceil(a / b)` for positive safe integers, without a floating-point divide. */
function ceilDiv(a: number, b: number): number {
  const raised = a + b - 1;
  return (raised - (raised % b)) / b;
}

function requireSafeInteger(what: string, value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer`);
}

function requireNonNegativeSafeInteger(what: string, value: number): void {
  requireSafeInteger(what, value);
  if (value < 0) throw new RangeError(`${what} must not be negative`);
}
