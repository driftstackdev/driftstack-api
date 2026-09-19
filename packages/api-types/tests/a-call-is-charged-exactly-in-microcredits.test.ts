// A call is charged exactly in microcredits from its token counts, and amounts
// are rounded only where the plan says: grants down to whole credits, charges
// shown UP and balances shown DOWN to 0.001 credit.
//
// One credit is one US cent, stored as 1,000,000 microcredits. Every rate is a
// whole number of microcredits per token, so tokens × rate is an integer and a
// charge never rounds. The only floating point anywhere is the final division
// that turns a whole number of 0.001-credit steps into a JSON number.

import { describe, expect, it } from 'vitest';
import {
  AI_CREDIT_DISPLAY_DECIMALS,
  CREDIT_RATE_CARD_V1,
  CREDIT_VALUE_USD_CENTS,
  CreditAmountSchema,
  MICROCREDITS_PER_CREDIT,
  balanceCreditsForDisplay,
  callChargeMicro,
  ceilMicroToWholeCredits,
  chargeCreditsForDisplay,
  creditsPer1kTokens,
  creditsToMicro,
  floorMicroToWholeCredits,
  microToCreditsCeil,
  microToCreditsFloor,
} from '../src/ai-credits.js';
import { seededRandom } from './_helpers/seeded-random.js';

const SONNET_5 = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];

/** Decimals in the shortest string JSON would print for a number. */
function decimalsOf(n: number): number {
  const s = JSON.stringify(n);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

describe('the unit', () => {
  it('one credit is one US cent, stored as one million microcredits', () => {
    expect(CREDIT_VALUE_USD_CENTS).toBe(1);
    expect(MICROCREDITS_PER_CREDIT).toBe(1_000_000);
    expect(AI_CREDIT_DISPLAY_DECIMALS).toBe(3);
  });

  it('whole credits convert to microcredits exactly, and fractional credits are refused rather than rounded', () => {
    expect(creditsToMicro(0)).toBe(0);
    expect(creditsToMicro(1)).toBe(1_000_000);
    expect(creditsToMicro(30_000)).toBe(30_000_000_000);
    expect(creditsToMicro(10_000_000)).toBe(10_000_000_000_000);
    expect(() => creditsToMicro(1.5)).toThrow(RangeError);
    expect(() => creditsToMicro(Number.NaN)).toThrow(RangeError);
    // 2^53 / 10^6 ≈ 9.007e9 credits is the last amount that stays exact.
    expect(() => creditsToMicro(10_000_000_000)).toThrow(RangeError);
  });

  it('grants floor to whole credits; whole-credit charges round up', () => {
    expect(microToCreditsFloor(2_999_999)).toBe(2);
    expect(microToCreditsCeil(2_000_001)).toBe(3);
    expect(microToCreditsCeil(2_000_000)).toBe(2);
    expect(microToCreditsFloor(0)).toBe(0);
    expect(microToCreditsCeil(1)).toBe(1);
    expect(floorMicroToWholeCredits(2_258_064_516)).toBe(2_258_000_000);
    expect(ceilMicroToWholeCredits(1)).toBe(1_000_000);
    expect(ceilMicroToWholeCredits(5_000_000)).toBe(5_000_000);
    for (const bad of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => microToCreditsFloor(bad), String(bad)).toThrow(RangeError);
    }
  });

  it('whole-credit rounding holds for every amount, compared against BigInt arithmetic', () => {
    const rnd = seededRandom(0x5eed_0001);
    for (let i = 0; i < 20_000; i += 1) {
      const micro = rnd.int(0, Number.MAX_SAFE_INTEGER);
      const big = BigInt(micro);
      const floor = Number(big / 1_000_000n);
      const ceil = Number((big + 999_999n) / 1_000_000n);
      expect(microToCreditsFloor(micro), `seed case ${String(i)}: ${String(micro)}`).toBe(floor);
      expect(microToCreditsCeil(micro), `seed case ${String(i)}: ${String(micro)}`).toBe(ceil);
    }
  });
});

describe('a call is charged exactly in microcredits from its token counts', () => {
  it('each kind of token is charged at its own rate', () => {
    const charge = callChargeMicro(
      {
        uncachedInput: 1_000,
        output: 100,
        cacheRead: 10_000,
        cacheWrite5m: 2_000,
        cacheWrite1h: 3_000,
      },
      SONNET_5,
    );
    // 1000×400 + 100×2000 + 10000×40 + 2000×500 + 3000×800
    expect(charge).toBe(400_000 + 200_000 + 400_000 + 1_000_000 + 2_400_000);
  });

  it('a typical plan call costs what the rate card says, to the microcredit', () => {
    // 3,000 uncached input and 110 output tokens on Sonnet 5.
    const charge = callChargeMicro(
      { uncachedInput: 3_000, output: 110, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      SONNET_5,
    );
    expect(charge).toBe(1_420_000);
    expect(chargeCreditsForDisplay(charge)).toBe(1.42);
  });

  it('an empty call costs nothing, and the charge is linear in every count', () => {
    const zero = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(callChargeMicro(zero, SONNET_5)).toBe(0);
    const rnd = seededRandom(0x5eed_0002);
    for (let i = 0; i < 2_000; i += 1) {
      const a = {
        uncachedInput: rnd.int(0, 500_000),
        output: rnd.int(0, 64_000),
        cacheRead: rnd.int(0, 500_000),
        cacheWrite5m: rnd.int(0, 500_000),
        cacheWrite1h: rnd.int(0, 500_000),
      };
      const expected =
        a.uncachedInput * SONNET_5.inputMicroPerToken +
        a.output * SONNET_5.outputMicroPerToken +
        a.cacheRead * SONNET_5.cacheReadMicroPerToken +
        a.cacheWrite5m * SONNET_5.cacheWrite5mMicroPerToken +
        a.cacheWrite1h * SONNET_5.cacheWrite1hMicroPerToken;
      const got = callChargeMicro(a, SONNET_5);
      expect(Number.isSafeInteger(got)).toBe(true);
      expect(got, JSON.stringify(a)).toBe(expected);
    }
  });

  it('a count that is not a whole non-negative number is refused, never charged as zero', () => {
    const base = { uncachedInput: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => callChargeMicro({ ...base, output: bad }, SONNET_5), String(bad)).toThrow(
        RangeError,
      );
    }
  });
});

describe('amounts shown to a customer: at most 3 decimals, charges up and balances down', () => {
  it('pinned cases', () => {
    expect(chargeCreditsForDisplay(1)).toBe(0.001);
    expect(balanceCreditsForDisplay(1)).toBe(0);
    expect(chargeCreditsForDisplay(1_000)).toBe(0.001);
    expect(balanceCreditsForDisplay(1_000)).toBe(0.001);
    expect(chargeCreditsForDisplay(1_234_567)).toBe(1.235);
    expect(balanceCreditsForDisplay(1_234_567)).toBe(1.234);
    expect(chargeCreditsForDisplay(60_000_000)).toBe(60);
    expect(balanceCreditsForDisplay(0)).toBe(0);
    expect(() => chargeCreditsForDisplay(-1)).toThrow(RangeError);
  });

  it('for any amount: a charge is never shown below its cost, a balance never above what is there, each off by less than 0.001, with at most 3 decimals', () => {
    const rnd = seededRandom(0x5eed_0003);
    for (let i = 0; i < 20_000; i += 1) {
      // Mostly realistic amounts, some at the top of the exact range.
      const micro =
        i % 10 === 0 ? rnd.int(0, Number.MAX_SAFE_INTEGER) : rnd.int(0, 100_000_000_000);
      const up = chargeCreditsForDisplay(micro);
      const down = balanceCreditsForDisplay(micro);
      for (const shown of [up, down]) {
        expect(decimalsOf(shown), `${String(micro)} → ${String(shown)}`).toBeLessThanOrEqual(3);
        expect(CreditAmountSchema.safeParse(shown).success, String(shown)).toBe(true);
      }
      // Compared in exact integer thousandths, never as floats.
      const upSteps = BigInt(Math.round(up * 1000));
      const downSteps = BigInt(Math.round(down * 1000));
      const exact = BigInt(micro);
      expect(upSteps * 1000n >= exact, `charge ${String(micro)}`).toBe(true);
      expect(upSteps * 1000n - exact < 1000n, `charge ${String(micro)}`).toBe(true);
      expect(downSteps * 1000n <= exact, `balance ${String(micro)}`).toBe(true);
      expect(exact - downSteps * 1000n < 1000n, `balance ${String(micro)}`).toBe(true);
    }
  });

  it('a per-1k price is shown exactly: Sonnet 5 is 0.4 credits in and 2 out per 1,000 tokens', () => {
    expect(creditsPer1kTokens(SONNET_5.inputMicroPerToken)).toBe(0.4);
    expect(creditsPer1kTokens(SONNET_5.outputMicroPerToken)).toBe(2);
    expect(creditsPer1kTokens(SONNET_5.cacheReadMicroPerToken)).toBe(0.04);
    expect(creditsPer1kTokens(1)).toBe(0.001);
  });
});
