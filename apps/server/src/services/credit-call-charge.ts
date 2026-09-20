// What ONE model call is charged, from the one thing that is known about it
// when it ends (§4.6).
//
// Pure: no clock, no database. The table below is the plan's, and it is the
// whole of it:
//
//   | basis              | when                                        | charge |
//   | provider_usage     | the usage block arrived                     | the exact tokens at the pinned rates, capped at the bound |
//   | provider_rejected  | a non-2xx status before any stream          | nothing |
//   | never_sent         | the request never left this process         | nothing |
//   | partial_usage      | a Stop, a torn stream or an error frame     | the exact input and cache observed, plus output at `max_tokens` |
//   | no_record          | it was sent and nothing came back           | the whole bound |
//
// ⛔ THE CAP IS NOT A ROUNDING. A call that reports more tokens than its bound
// allowed for is a defect in the bound — the body grew between the measurement
// and the send, or a region was mis-split — and the customer is charged the
// ceiling they were admitted under, never more. `overBound` says it happened so
// the caller can raise `ai_credits_bound_exceeded`; the difference is absorbed.
//
// ⛔ `partial_usage` PAYS FOR OUTPUT AT `max_tokens`, NOT AT WHAT WAS SEEN. A
// torn stream stops the bytes reaching us, not the model producing them, and the
// provider bills for what it produced. The input and cache halves ARE exact,
// because `message_start` reports them before any of this can go wrong.
//
// ⛔ `no_record` IS THE FULL BOUND AND THAT IS THE OWNER'S RULE (L5). A request
// that went out and left nothing behind — a transport failure, a crash, a lease
// that lapsed, or a Stop that landed after the send and before the first usage
// block — may well have been served and billed. The database says the same thing
// in `credit_model_calls_no_record_pays_bound`.

import { callChargeMicro, type CreditRates, type ModelCallTokens } from '@driftstack/api-types';
import type { CreditCallSettleBasis } from '../db/credit-reservations-repo.js';

export interface CallSettlementInput {
  readonly basis: CreditCallSettleBasis;
  /** The ceiling the call was admitted under; the charge never passes it. */
  readonly boundMicro: number;
  /** The `max_tokens` the call was admitted with, which `partial_usage` pays for. */
  readonly maxOutputTokens: number;
  /** The rate card pinned to the reservation, never today's card. */
  readonly rates: CreditRates;
  /** What the provider reported. Required by `provider_usage` and `partial_usage`. */
  readonly usage?: ModelCallTokens | null;
}

export interface CallSettlement {
  /** What the customer pays for this call, in microcredits. */
  readonly chargedMicro: number;
  /**
   * What it cost before the cap. Null ONLY for `no_record`, where nothing was
   * measured and a zero would read as "we looked and it was free". The other two
   * bases that charge nothing DO record a zero, and mean it: a request that never
   * left, and one the provider refused before any stream, each genuinely cost
   * nothing.
   */
  readonly actualMicro: number | null;
  /** True when the measured cost passed the bound and was capped at it. */
  readonly overBound: boolean;
  /** The token counts to record, or null when there are none. */
  readonly tokens: ModelCallTokens | null;
}

/**
 * What this call costs. See the table in the file header.
 *
 * Throws when a basis that needs the provider's numbers is given none: that is a
 * caller bug, and the two fallbacks available here — charging zero or charging
 * the bound — are each wrong in one direction and silent in both.
 */
export function callSettlement(input: CallSettlementInput): CallSettlement {
  const { basis, boundMicro, maxOutputTokens, rates } = input;
  requireNonNegativeSafeInteger('boundMicro', boundMicro);
  requireNonNegativeSafeInteger('maxOutputTokens', maxOutputTokens);

  switch (basis) {
    case 'provider_rejected':
    case 'never_sent':
      return { chargedMicro: 0, actualMicro: 0, overBound: false, tokens: null };

    case 'no_record':
      return { chargedMicro: boundMicro, actualMicro: null, overBound: false, tokens: null };

    case 'provider_usage': {
      const tokens = requireUsage(basis, input.usage);
      return cap(callChargeMicro(tokens, rates), boundMicro, tokens);
    }

    case 'partial_usage': {
      const observed = requireUsage(basis, input.usage);
      // The input and cache halves as reported; the output half at the ceiling
      // this call was admitted under, whatever the torn stream managed to show.
      const tokens: ModelCallTokens = { ...observed, output: maxOutputTokens };
      return cap(callChargeMicro(tokens, rates), boundMicro, tokens);
    }
  }
}

function cap(actualMicro: number, boundMicro: number, tokens: ModelCallTokens): CallSettlement {
  return {
    chargedMicro: Math.min(actualMicro, boundMicro),
    actualMicro,
    overBound: actualMicro > boundMicro,
    tokens,
  };
}

function requireUsage(
  basis: CreditCallSettleBasis,
  usage: ModelCallTokens | null | undefined,
): ModelCallTokens {
  if (usage === null || usage === undefined) {
    throw new RangeError(`a ${basis} settlement needs the token counts the provider reported`);
  }
  return usage;
}

function requireNonNegativeSafeInteger(what: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer`);
  }
}
