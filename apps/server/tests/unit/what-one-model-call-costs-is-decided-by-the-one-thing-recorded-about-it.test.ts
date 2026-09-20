// What one model call is charged (§4.6): the five bases, and nothing else.
//
// A call ends in one of five states, and each state is a different amount of
// knowledge about what the provider did. The charge follows the knowledge:
//
//   · the usage block arrived        → the exact tokens at the pinned rates;
//   · the provider refused outright  → nothing;
//   · the request never went out     → nothing;
//   · the stream tore after it began → exact input, output at the ceiling;
//   · it went out and vanished       → the whole bound.
//
// ⛔ THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THAT IS DELIBERATE. Where the
// facts are known, the customer pays exactly them. Where they are not, the rule
// errs toward the provider's bill rather than the customer's balance — because
// the provider bills for what it served whether or not this process saw the
// answer, and a system that charged zero for every lost response would be a
// system anyone could run for free by hanging up.
//
// ⛔ THE CAP IS WHERE IT ERRS THE OTHER WAY. A call that reports MORE than its
// bound is a defect in the bound, not in the customer, and the difference is
// absorbed. `overBound` is what makes that visible rather than silent.

import { describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1, type CreditRates, type ModelCallTokens } from '@driftstack/api-types';
import { callSettlement } from '../../src/services/credit-call-charge.js';

const RATES: CreditRates = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];

/** What the provider reported for a call that finished: 3,880,000 µcr at the card above. */
const REPORTED: ModelCallTokens = {
  uncachedInput: 1_000,
  output: 500,
  cacheRead: 2_000,
  cacheWrite5m: 0,
  cacheWrite1h: 3_000,
};
const REPORTED_MICRO = 1_000 * 400 + 500 * 2_000 + 2_000 * 40 + 3_000 * 800;

const BOUND = 19_022_400;
const MAX_OUTPUT = 8_192;

function settle(basis: Parameters<typeof callSettlement>[0]['basis'], over = {}) {
  return callSettlement({
    basis,
    boundMicro: BOUND,
    maxOutputTokens: MAX_OUTPUT,
    rates: RATES,
    ...over,
  });
}

describe('what one model call costs is decided by the one thing recorded about it', () => {
  it('CRITICAL the arithmetic below is the seeded card, not a number retyped here', () => {
    expect([
      RATES.inputMicroPerToken,
      RATES.outputMicroPerToken,
      RATES.cacheReadMicroPerToken,
      RATES.cacheWrite1hMicroPerToken,
    ]).toEqual([400, 2_000, 40, 800]);
    expect(REPORTED_MICRO).toBe(3_880_000);
  });

  it('CRITICAL `provider_usage` charges the EXACT tokens at the pinned rates — every kind at its own rate, and no rounding anywhere', () => {
    expect(settle('provider_usage', { usage: REPORTED })).toEqual({
      chargedMicro: REPORTED_MICRO,
      actualMicro: REPORTED_MICRO,
      overBound: false,
      tokens: REPORTED,
    });
  });

  it('⛔ CRITICAL a call that reported MORE than its bound is charged its bound and says so: the customer pays the ceiling they were admitted under, and the excess is an alert about the bound rather than a bill', () => {
    const result = callSettlement({
      basis: 'provider_usage',
      boundMicro: 1_000_000,
      maxOutputTokens: MAX_OUTPUT,
      rates: RATES,
      usage: REPORTED,
    });
    expect(result.chargedMicro).toBe(1_000_000);
    expect(result.actualMicro, 'the measured cost is kept, so the alert can say by how much').toBe(
      REPORTED_MICRO,
    );
    expect(result.overBound).toBe(true);
  });

  it('CRITICAL a charge exactly equal to the bound is NOT over it. An exclusive comparison here would alert on every call that used precisely what it was allowed', () => {
    const result = callSettlement({
      basis: 'provider_usage',
      boundMicro: REPORTED_MICRO,
      maxOutputTokens: MAX_OUTPUT,
      rates: RATES,
      usage: REPORTED,
    });
    expect(result.chargedMicro).toBe(REPORTED_MICRO);
    expect(result.overBound).toBe(false);
  });

  it('CRITICAL a call the provider REFUSED with a status costs nothing: no stream began, so nothing was served and nothing is owed', () => {
    expect(settle('provider_rejected')).toEqual({
      chargedMicro: 0,
      actualMicro: 0,
      overBound: false,
      tokens: null,
    });
  });

  it('⛔ CRITICAL a call that was NEVER SENT costs nothing. The request never left this process, and the database says the same thing twice — `never_sent` is only accepted while `sent` is false, and the charge must then be zero', () => {
    expect(settle('never_sent')).toEqual({
      chargedMicro: 0,
      actualMicro: 0,
      overBound: false,
      tokens: null,
    });
  });

  it('⛔ CRITICAL a TORN stream pays its exact input and its output at `max_tokens`, not at what was seen: the bytes stopped reaching us, the model did not stop producing them, and the provider bills for what it produced', () => {
    const observed: ModelCallTokens = {
      uncachedInput: 1_000,
      output: 17,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    };
    const result = settle('partial_usage', { usage: observed });
    expect(result.chargedMicro).toBe(1_000 * 400 + MAX_OUTPUT * 2_000);
    expect(result.tokens?.output, 'the 17 tokens actually seen were billed').toBe(MAX_OUTPUT);
    expect(result.tokens?.uncachedInput, 'the input half is exact, not a ceiling').toBe(1_000);
  });

  it('CRITICAL a torn stream is still capped at the bound: paying output at `max_tokens` is exactly the case where the charge can reach the ceiling, and it must not pass it', () => {
    const result = callSettlement({
      basis: 'partial_usage',
      boundMicro: 1_000_000,
      maxOutputTokens: MAX_OUTPUT,
      rates: RATES,
      usage: { uncachedInput: 1_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
    expect(result.chargedMicro).toBe(1_000_000);
    expect(result.overBound).toBe(true);
  });

  it('⛔ CRITICAL a call that went out and left NO RECORD is charged its whole bound (L5) — a transport failure, a crash, a lapsed lease, or a Stop that landed after the send and before the first usage block are all the same fact: it may well have been served', () => {
    expect(settle('no_record')).toEqual({
      chargedMicro: BOUND,
      actualMicro: null,
      overBound: false,
      tokens: null,
    });
  });

  it('CRITICAL `no_record` records NO measured cost rather than a measured zero. `actual_micro = 0` would read as "we looked and it was free", which is the opposite of what happened', () => {
    expect(settle('no_record').actualMicro).toBeNull();
    expect(settle('provider_rejected').actualMicro).toBe(0);
  });

  it("CRITICAL a basis that needs the provider's numbers and is given none is a fault, not a guess. Both available fallbacks — charge nothing, charge the bound — are wrong in one direction and silent in both", () => {
    expect(() => settle('provider_usage')).toThrow(RangeError);
    expect(() => settle('partial_usage', { usage: null })).toThrow(RangeError);
    expect(() => settle('no_record'), 'no_record needs nothing and must not throw').not.toThrow();
  });

  it('CRITICAL every basis the database accepts is priced here. A basis this function could not answer would reach the settlement as a thrown error on the path §5.3 calls the main one', () => {
    const bases = [
      'provider_usage',
      'provider_rejected',
      'never_sent',
      'partial_usage',
      'no_record',
    ] as const;
    for (const basis of bases) {
      const result = settle(basis, { usage: REPORTED });
      expect(result.chargedMicro, `${basis} priced below zero`).toBeGreaterThanOrEqual(0);
      expect(result.chargedMicro, `${basis} priced above its bound`).toBeLessThanOrEqual(BOUND);
    }
  });
});
