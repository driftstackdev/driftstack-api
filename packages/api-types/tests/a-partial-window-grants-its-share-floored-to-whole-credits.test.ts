// A partial window grants its share of the month, floored to whole credits; a
// plan change adds or takes back the share of the days left, its magnitude
// floored the same way.
//
// share = level × window length ÷ natural-month length, floored to whole
// credits. Never rounded up: a partial month cannot grant more than its share,
// and a downgrade cannot take back more than its share. The product can pass
// 2^53 (a contract-sized allowance × a duration in microseconds), so it is
// taken in BigInt — the last arm is a case where float arithmetic gives the
// wrong whole credit.

import { describe, expect, it } from 'vitest';
import {
  MICROCREDITS_PER_CREDIT,
  creditsToMicro,
  proratedWholeCreditsMicro,
  windowShareMicro,
} from '../src/ai-credits.js';
import { seededRandom } from './_helpers/seeded-random.js';

const at = (s: string): Date => new Date(s);
const DAY_MS = 86_400_000;

describe('a partial window grants its share floored to whole credits', () => {
  it('a window that is the whole natural month grants the whole level', () => {
    const month = { start: at('2027-01-15T00:00:00Z'), end: at('2027-02-15T00:00:00Z') };
    expect(windowShareMicro(creditsToMicro(5_000), month, month)).toBe(creditsToMicro(5_000));
  });

  it('a 14-day stub of a 31-day Team month is 2,258 credits (5,000 × 14 / 31 = 2,258.06…)', () => {
    const natural = { start: at('2027-01-15T00:00:00Z'), end: at('2027-02-15T00:00:00Z') };
    const stub = { start: at('2027-02-01T00:00:00Z'), end: at('2027-02-15T00:00:00Z') };
    expect(windowShareMicro(creditsToMicro(5_000), stub, natural)).toBe(creditsToMicro(2_258));
  });

  it('the rest of a 30-day month from the 15th is half, and a single day of Scale is 1,000 credits', () => {
    const natural = { start: at('2027-04-01T00:00:00Z'), end: at('2027-05-01T00:00:00Z') };
    const second = { start: at('2027-04-16T00:00:00Z'), end: at('2027-05-01T00:00:00Z') };
    expect(windowShareMicro(creditsToMicro(3_000), second, natural)).toBe(creditsToMicro(1_500));
    const lastDay = { start: at('2027-04-30T00:00:00Z'), end: at('2027-05-01T00:00:00Z') };
    expect(windowShareMicro(creditsToMicro(30_000), lastDay, natural)).toBe(creditsToMicro(1_000));
  });

  it('a share below one credit grants nothing rather than a fraction', () => {
    const natural = { start: at('2027-04-01T00:00:00Z'), end: at('2027-05-01T00:00:00Z') };
    const oneMinute = { start: at('2027-04-30T23:59:00Z'), end: at('2027-05-01T00:00:00Z') };
    expect(windowShareMicro(creditsToMicro(1_500), oneMinute, natural)).toBe(0);
  });

  it('a window outside its natural month, or empty, is refused', () => {
    const natural = { start: at('2027-04-01T00:00:00Z'), end: at('2027-05-01T00:00:00Z') };
    expect(() =>
      windowShareMicro(
        1,
        { start: at('2027-03-31T00:00:00Z'), end: at('2027-04-02T00:00:00Z') },
        natural,
      ),
    ).toThrow(RangeError);
    expect(() =>
      windowShareMicro(
        1,
        { start: at('2027-04-02T00:00:00Z'), end: at('2027-04-02T00:00:00Z') },
        natural,
      ),
    ).toThrow(RangeError);
    expect(() => proratedWholeCreditsMicro(1, 2, 1)).toThrow(RangeError);
    expect(() => proratedWholeCreditsMicro(1, 0, 0)).toThrow(RangeError);
  });

  it('a plan change back down takes back the same share it would have added, magnitude floored (never −1 more)', () => {
    const up = proratedWholeCreditsMicro(creditsToMicro(5_000 - 3_000), 17 * DAY_MS, 31 * DAY_MS);
    const down = proratedWholeCreditsMicro(creditsToMicro(3_000 - 5_000), 17 * DAY_MS, 31 * DAY_MS);
    // 2,000 × 17 / 31 = 1,096.77…
    expect(up).toBe(creditsToMicro(1_096));
    expect(down).toBe(-creditsToMicro(1_096));
  });

  it('for generated shares: whole credits, never above the exact share, less than one credit below it, and monotonic in the portion', () => {
    const rnd = seededRandom(0x9a47_0001);
    for (let i = 0; i < 10_000; i += 1) {
      const level = creditsToMicro(rnd.int(0, 30_000));
      const whole = rnd.int(28, 31) * DAY_MS;
      const portion = rnd.int(0, whole);
      const share = proratedWholeCreditsMicro(level, portion, whole);
      expect(share % MICROCREDITS_PER_CREDIT).toBe(0);
      // share × whole ≤ level × portion < (share + 1 credit) × whole, in BigInt.
      const lhs = BigInt(share) * BigInt(whole);
      const exact = BigInt(level) * BigInt(portion);
      expect(lhs <= exact, `${String(level)} ${String(portion)}/${String(whole)}`).toBe(true);
      expect(exact < lhs + BigInt(MICROCREDITS_PER_CREDIT) * BigInt(whole)).toBe(true);
      const more = Math.min(whole, portion + rnd.int(0, DAY_MS));
      expect(proratedWholeCreditsMicro(level, more, whole)).toBeGreaterThanOrEqual(share);
    }
  });

  it('is exact where float arithmetic is not: a contract-sized allowance over a microsecond portion, where doubles over-grant by a credit', () => {
    // Found by searching generated cases against BigInt; the product is ~6.5e24,
    // far past 2^53, and the double lands on the wrong side of a whole credit.
    const level = creditsToMicro(4_618_972);
    const whole = 28 * DAY_MS * 1_000; // microseconds
    const portion = 1_414_384_243_074;
    const exact = (BigInt(level) * BigInt(portion)) / (BigInt(whole) * 1_000_000n);
    expect(exact).toBe(2_700_479n);
    expect(proratedWholeCreditsMicro(level, portion, whole)).toBe(creditsToMicro(2_700_479));
    // The same sum in doubles grants one credit more than the share.
    expect(Math.floor((level * portion) / whole / 1e6)).toBe(2_700_480);
  });
});
