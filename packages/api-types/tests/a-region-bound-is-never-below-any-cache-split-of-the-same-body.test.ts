// A region bound is never below any cache split of the same body.
//
// Before a model call is sent, its cost is bounded from the serialized body's
// BYTE counts, split at the cache markers:
//
//   R1  up to and including the block with the 1-hour marker  → 1-hour write rate
//   R2  after that, up to the last 5-minute marker            → 5-minute write rate
//   R3  the rest                                              → plain input rate
//   + REQUEST_FRAMING_TOKENS at the 1-hour rate, + max_tokens × output rate
//
// After the call, the provider reports how the prompt was ACTUALLY billed — some
// tokens read from cache, some written at 5 minutes or 1 hour, the rest plain
// input. That split is the provider's, not ours, and it varies call to call
// (a cache hit, a miss, a prefix below the model's minimum cacheable length).
//
// ASSUMPTION (the provider's tokenizer, stated because the bound rests on it):
// every input token stands for at least one byte of the UTF-8 text sent, so a
// region holds no more tokens than bytes; the request framing the provider adds
// is at most REQUEST_FRAMING_TOKENS; a token in R1 is billed at no more than the
// 1-hour write rate, a token in R2 at no more than the 5-minute write rate (no
// marker after R1 asks for the 1-hour lifetime), and a token in R3 is either
// plain input or a cache read. Rates satisfy read ≤ input ≤ 5m ≤ 1h (the rate
// card's database CHECK).
//
// Under that assumption the claim is: for EVERY split the provider may choose,
// the charge is at most the bound. Checked over generated bodies and splits on
// every model the rate card prices, plus the one split that meets the bound
// exactly (so a bound that is merely "large" is not mistaken for a correct one).

import { describe, expect, it } from 'vitest';
import {
  CREDIT_RATE_CARD_V1,
  REQUEST_FRAMING_TOKENS,
  callChargeMicro,
  callUpperBound,
  maxOutputTokensWithin,
  type CreditRates,
  type RequestRegionBytes,
} from '../src/ai-credits.js';
import type { ModelCallTokens } from '../src/agent-models.js';
import { seededRandom, type SeededRandom } from './_helpers/seeded-random.js';

type Bucket = keyof ModelCallTokens;

/** Scatter `count` tokens across the allowed billing buckets. */
function scatter(
  rnd: SeededRandom,
  count: number,
  buckets: readonly Bucket[],
  into: ModelCallTokens,
) {
  let left = count;
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i] as Bucket;
    const take = i === buckets.length - 1 ? left : rnd.int(0, left);
    into[bucket] += take;
    left -= take;
  }
}

/** A billing split the provider could report for a body with these regions. */
function providerSplit(
  rnd: SeededRandom,
  regions: RequestRegionBytes,
  maxOutputTokens: number,
): ModelCallTokens {
  const tokens: ModelCallTokens = {
    uncachedInput: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  const shuffle = <T>(xs: T[]): T[] => xs.sort(() => rnd.next() - 0.5);
  // Tokens never exceed bytes; often far fewer (English is ~4 bytes a token).
  //
  // A third of the time a part is at its EXTREME: as many tokens as it may
  // have, all billed in the dearest bucket it allows. Uniform draws alone land
  // near half the bound and never reach its edge — they let through a bound
  // that priced the framing allowance at the plain input rate, 2,048 × (1-hour
  // − input) below the real worst case, and only the tightness arm below caught
  // it. That arm restates the formula; this one is the invariant, and it has to
  // stand on its own when the formula is changed on purpose.
  const part = (most: number, dearest: Bucket, cheaper: readonly Bucket[]): void => {
    if (rnd.int(0, 2) === 0) tokens[dearest] += most;
    else scatter(rnd, rnd.int(0, most), shuffle([dearest, ...cheaper]), tokens);
  };
  part(regions.oneHourRegionBytes, 'cacheWrite1h', ['cacheWrite5m', 'uncachedInput', 'cacheRead']);
  part(REQUEST_FRAMING_TOKENS, 'cacheWrite1h', ['cacheWrite5m', 'uncachedInput', 'cacheRead']);
  part(regions.fiveMinuteRegionBytes, 'cacheWrite5m', ['uncachedInput', 'cacheRead']);
  part(regions.uncachedRegionBytes, 'uncachedInput', ['cacheRead']);
  tokens.output = rnd.int(0, 2) === 0 ? maxOutputTokens : rnd.int(0, maxOutputTokens);
  return tokens;
}

function randomRegions(rnd: SeededRandom): RequestRegionBytes {
  const size = (): number => (rnd.int(0, 4) === 0 ? 0 : rnd.int(1, 400_000));
  return {
    oneHourRegionBytes: size(),
    fiveMinuteRegionBytes: size(),
    uncachedRegionBytes: size(),
  };
}

const PRICED = Object.entries(CREDIT_RATE_CARD_V1.models) as Array<[string, CreditRates]>;

describe('a region bound is never below any cache split of the same body', () => {
  it('holds for every generated body and every generated billing split, on every priced model', () => {
    const rnd = seededRandom(0xb0_0d_0001);
    let checked = 0;
    let atTheBound = 0;
    for (const [model, rates] of PRICED) {
      for (let body = 0; body < 400; body += 1) {
        const regions = randomRegions(rnd);
        const maxOut = rnd.int(1, 8_192);
        const bound = callUpperBound(regions, maxOut, rates);
        for (let split = 0; split < 25; split += 1) {
          const tokens = providerSplit(rnd, regions, maxOut);
          const cost = callChargeMicro(tokens, rates);
          if (cost > bound.boundMicro) {
            throw new Error(
              `${model}: bound ${String(bound.boundMicro)} below cost ${String(cost)} for ` +
                `${JSON.stringify(regions)} max_tokens=${String(maxOut)} split=${JSON.stringify(tokens)}`,
            );
          }
          if (cost === bound.boundMicro) atTheBound += 1;
          checked += 1;
        }
      }
    }
    expect(checked).toBe(PRICED.length * 400 * 25);
    // Positive control on the generator: some splits reach the bound exactly, so
    // "never above it" was tested at its edge and not only in its interior.
    expect(atTheBound, 'generated splits that reach the bound').toBeGreaterThan(0);
  });

  it('is met exactly by the dearest split, so it is tight and not merely large', () => {
    const rnd = seededRandom(0xb0_0d_0002);
    for (const [model, rates] of PRICED) {
      for (let i = 0; i < 200; i += 1) {
        const regions = randomRegions(rnd);
        const maxOut = rnd.int(1, 8_192);
        const dearest: ModelCallTokens = {
          cacheWrite1h: regions.oneHourRegionBytes + REQUEST_FRAMING_TOKENS,
          cacheWrite5m: regions.fiveMinuteRegionBytes,
          uncachedInput: regions.uncachedRegionBytes,
          cacheRead: 0,
          output: maxOut,
        };
        const bound = callUpperBound(regions, maxOut, rates);
        expect(callChargeMicro(dearest, rates), model).toBe(bound.boundMicro);
        expect(bound.inputBoundTokens).toBe(
          regions.oneHourRegionBytes +
            regions.fiveMinuteRegionBytes +
            regions.uncachedRegionBytes +
            REQUEST_FRAMING_TOKENS,
        );
        expect(bound.boundMicro - bound.inputBoundMicro).toBe(maxOut * rates.outputMicroPerToken);
      }
    }
  });

  it('a bound that priced every byte at the plain input rate WOULD fall below a real split — the regions are load-bearing', () => {
    const rates = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    const regions = {
      oneHourRegionBytes: 30_000,
      fiveMinuteRegionBytes: 60_000,
      uncachedRegionBytes: 500,
    };
    const naive =
      (regions.oneHourRegionBytes +
        regions.fiveMinuteRegionBytes +
        regions.uncachedRegionBytes +
        REQUEST_FRAMING_TOKENS) *
        rates.inputMicroPerToken +
      8_192 * rates.outputMicroPerToken;
    const dearest = callChargeMicro(
      {
        cacheWrite1h: regions.oneHourRegionBytes + REQUEST_FRAMING_TOKENS,
        cacheWrite5m: regions.fiveMinuteRegionBytes,
        uncachedInput: regions.uncachedRegionBytes,
        cacheRead: 0,
        output: 8_192,
      },
      rates,
    );
    expect(dearest).toBeGreaterThan(naive);
    expect(callUpperBound(regions, 8_192, rates).boundMicro).toBe(dearest);
  });

  it('refuses rates out of order, since pricing a region at "its" rate would no longer be its dearest', () => {
    const rates = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    const regions = { oneHourRegionBytes: 1, fiveMinuteRegionBytes: 1, uncachedRegionBytes: 1 };
    expect(() =>
      callUpperBound(regions, 1, {
        ...rates,
        cacheWrite5mMicroPerToken: rates.cacheWrite1hMicroPerToken + 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      callUpperBound(regions, 1, {
        ...rates,
        cacheReadMicroPerToken: rates.inputMicroPerToken + 1,
      }),
    ).toThrow(RangeError);
    expect(() => callUpperBound(regions, 0, rates)).toThrow(RangeError);
    expect(() => callUpperBound({ ...regions, uncachedRegionBytes: -1 }, 1, rates)).toThrow(
      RangeError,
    );
  });

  it('the largest output ceiling that fits is the floor of what is left over the output rate', () => {
    const rates = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    const regions = {
      oneHourRegionBytes: 34_408,
      fiveMinuteRegionBytes: 12_000,
      uncachedRegionBytes: 900,
    };
    const input = callUpperBound(regions, 1, rates).inputBoundMicro;
    const room = 40_000_000;
    const allowed = maxOutputTokensWithin(room, input, rates);
    expect(callUpperBound(regions, allowed, rates).boundMicro).toBeLessThanOrEqual(room);
    expect(callUpperBound(regions, allowed + 1, rates).boundMicro).toBeGreaterThan(room);
    expect(maxOutputTokensWithin(input, input, rates)).toBe(0);
    expect(maxOutputTokensWithin(input - 1, input, rates)).toBe(0);
  });
});
