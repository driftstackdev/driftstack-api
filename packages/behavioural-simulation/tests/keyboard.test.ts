import { describe, expect, it } from 'vitest';
import {
  generateKeyboardCadence,
  KEYBOARD_CADENCE_DEFAULTS,
  MAX_TEXT_LENGTH,
  type BehaviouralProfile,
} from '../src/index.js';

const PROFILE: BehaviouralProfile = {
  id: 'casual_browser_us',
  meanKeyDelayMs: 120,
  meanMouseSpeedPxPerMs: 1,
  meanScrollPxPerTick: 40,
  pauseProbability: 0.1,
  meanPauseMs: 800,
};

describe('generateKeyboardCadence', () => {
  it('emits one delay per character + durationMs = sum', () => {
    const text = 'hello world';
    const c = generateKeyboardCadence({ text, profile: PROFILE, seed: 's1' });
    expect(c.text).toBe(text);
    expect(c.delaysMs).toHaveLength(text.length);
    expect(c.durationMs).toBe(c.delaysMs.reduce((a, b) => a + b, 0));
    expect(c.seed).toBe('s1');
  });

  it('is deterministic for the same (text, profile, seed)', () => {
    const a = generateKeyboardCadence({ text: 'abc123', profile: PROFILE, seed: 'fixed' });
    const b = generateKeyboardCadence({ text: 'abc123', profile: PROFILE, seed: 'fixed' });
    expect(a.delaysMs).toEqual(b.delaysMs);
  });

  it('different seeds produce different cadences', () => {
    const a = generateKeyboardCadence({ text: 'the quick brown fox', profile: PROFILE, seed: 'a' });
    const b = generateKeyboardCadence({ text: 'the quick brown fox', profile: PROFILE, seed: 'b' });
    expect(a.delaysMs).not.toEqual(b.delaysMs);
  });

  it('defaults the seed deterministically from profile id + text', () => {
    const a = generateKeyboardCadence({ text: 'login', profile: PROFILE });
    const b = generateKeyboardCadence({ text: 'login', profile: PROFILE });
    expect(a.seed).toBe('keyboard:casual_browser_us:login');
    expect(a.delaysMs).toEqual(b.delaysMs);
  });

  it('first keystroke carries the orientation latency (longer than a typical key)', () => {
    // Average over seeds to wash out per-key jitter, then compare the
    // first-key delay to the mean of the rest.
    let firstSum = 0;
    let restSum = 0;
    let restCount = 0;
    for (let i = 0; i < 40; i += 1) {
      const c = generateKeyboardCadence({ text: 'aaaaaaaa', profile: PROFILE, seed: `seed${i}` });
      firstSum += c.delaysMs[0] as number;
      for (let k = 1; k < c.delaysMs.length; k += 1) {
        restSum += c.delaysMs[k] as number;
        restCount += 1;
      }
    }
    expect(firstSum / 40).toBeGreaterThan(restSum / restCount);
  });

  it('uppercase + symbol keys are slower than lowercase on average (iOS layer-switch cost)', () => {
    function avgNonFirst(text: string): number {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 60; i += 1) {
        const c = generateKeyboardCadence({ text, profile: PROFILE, seed: `c${i}` });
        for (let k = 1; k < c.delaysMs.length; k += 1) {
          sum += c.delaysMs[k] as number;
          n += 1;
        }
      }
      return sum / n;
    }
    // Distinct chars to avoid the repeat-char speed-up confounding it.
    const lower = avgNonFirst('abcdefgh');
    const upper = avgNonFirst('ABCDEFGH');
    const symbol = avgNonFirst('1!2@3#4$');
    expect(upper).toBeGreaterThan(lower);
    expect(symbol).toBeGreaterThan(lower);
  });

  it('non-ASCII letters type at the letter cadence, NOT the symbol penalty', () => {
    // Regression: an ASCII-only classifier mis-classified accented Latin /
    // Cyrillic / CJK letters as "symbols" and applied the 1.6x number/symbol
    // layer-switch penalty — a typing-cadence tell for every non-English
    // persona. A non-English string of LETTERS must type at roughly the
    // same average cadence as an English string of letters (same length,
    // same case profile), and clearly FASTER than the same length of actual
    // symbols.
    function avgNonFirst(text: string): number {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 80; i += 1) {
        const c = generateKeyboardCadence({ text, profile: PROFILE, seed: `u${i}` });
        for (let k = 1; k < c.delaysMs.length; k += 1) {
          sum += c.delaysMs[k] as number;
          n += 1;
        }
      }
      return sum / n;
    }
    // All-lowercase, distinct chars, no spaces — isolate the letter-vs-symbol
    // classification from shift / space / repeat-char effects.
    const ascii = avgNonFirst('abcdefgh');
    const accented = avgNonFirst('éàçñüößž'); // accented Latin letters
    const cyrillic = avgNonFirst('приветдляц'); // Cyrillic letters
    const cjk = avgNonFirst('你好世界用户名'); // CJK (caseless) letters
    const symbols = avgNonFirst('1!2@3#4$');

    // Letters in any script should never trip the symbol penalty: each
    // non-English letter cadence must be far below the actual-symbol cadence.
    expect(accented).toBeLessThan(symbols);
    expect(cyrillic).toBeLessThan(symbols);
    expect(cjk).toBeLessThan(symbols);
    // And it should sit within a tight band of the ASCII-letter cadence
    // (same letter cadence, just a different script) — well under the 1.6x
    // symbol multiplier that the bug applied. Generous 20% tolerance for
    // gaussian jitter / hesitation draws.
    expect(accented).toBeGreaterThan(ascii * 0.8);
    expect(accented).toBeLessThan(ascii * 1.2);
    expect(cyrillic).toBeGreaterThan(ascii * 0.8);
    expect(cyrillic).toBeLessThan(ascii * 1.2);
    expect(cjk).toBeGreaterThan(ascii * 0.8);
    expect(cjk).toBeLessThan(ascii * 1.2);
  });

  it('an uppercase non-ASCII letter still costs a Shift tap (not the symbol penalty)', () => {
    function avgNonFirst(text: string): number {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 80; i += 1) {
        const c = generateKeyboardCadence({ text, profile: PROFILE, seed: `us${i}` });
        for (let k = 1; k < c.delaysMs.length; k += 1) {
          sum += c.delaysMs[k] as number;
          n += 1;
        }
      }
      return sum / n;
    }
    const lowerCyrillic = avgNonFirst('абвгдежз');
    const upperCyrillic = avgNonFirst('АБВГДЕЖЗ');
    // Uppercase Cyrillic costs a Shift tap → slower than lowercase Cyrillic.
    expect(upperCyrillic).toBeGreaterThan(lowerCyrillic);
  });

  it('emits one cadence slot per Unicode grapheme, never per surrogate or joiner', () => {
    const text = 'A👩‍💻é🇺🇸';
    expect(text.length).toBe(12); // UTF-16 units — the old broken slot count.
    const cadence = generateKeyboardCadence({ text, profile: PROFILE, seed: 'graphemes' });
    expect(cadence.delaysMs).toHaveLength(4); // A, ZWJ emoji, combining é, flag.
    expect(cadence.durationMs).toBe(cadence.delaysMs.reduce((a, b) => a + b, 0));
  });

  it('scales with the profile mean delay', () => {
    const slow = generateKeyboardCadence({
      text: 'hello world this is a test',
      profile: { ...PROFILE, meanKeyDelayMs: 240 },
      seed: 'x',
    });
    const fast = generateKeyboardCadence({
      text: 'hello world this is a test',
      profile: { ...PROFILE, meanKeyDelayMs: 60 },
      seed: 'x',
    });
    expect(slow.durationMs).toBeGreaterThan(fast.durationMs);
  });

  it('respects the minimum-delay floor', () => {
    const c = generateKeyboardCadence({
      text: 'abcdefghij',
      profile: { ...PROFILE, meanKeyDelayMs: 1 },
      seed: 'floor',
    });
    for (const delay of c.delaysMs) {
      expect(delay).toBeGreaterThanOrEqual(KEYBOARD_CADENCE_DEFAULTS.minDelayMs);
    }
  });

  it('handles empty text (no delays, zero duration)', () => {
    const c = generateKeyboardCadence({ text: '', profile: PROFILE, seed: 'e' });
    expect(c.delaysMs).toEqual([]);
    expect(c.durationMs).toBe(0);
  });

  it('rejects non-positive and non-finite profile mean delays', () => {
    for (const meanKeyDelayMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        generateKeyboardCadence({
          text: 'hello',
          profile: { ...PROFILE, meanKeyDelayMs },
          seed: 'invalid-mean',
        }),
      ).toThrow(/meanKeyDelayMs/);
    }
  });

  it('rejects finite per-key delays whose accumulated duration overflows', () => {
    const text = 'aaaa';
    const seed = 'keyboard-total-overflow';
    const calibrationMean = 1_000_000;
    const calibration = generateKeyboardCadence({
      text,
      profile: { ...PROFILE, meanKeyDelayMs: calibrationMean },
      seed,
    });
    const totalRatio = calibration.durationMs / calibrationMean;
    const maxRatio = Math.max(...calibration.delaysMs) / calibrationMean;
    const overflowingMean = Number.MAX_VALUE / ((totalRatio + maxRatio) / 2);

    expect(Number.isFinite(overflowingMean)).toBe(true);
    expect(() =>
      generateKeyboardCadence({
        text,
        profile: { ...PROFILE, meanKeyDelayMs: overflowingMean },
        seed,
      }),
    ).toThrow(/^generateKeyboardCadence: durationMs must be finite/);
  });

  it('BSIM-4: rejects text over MAX_TEXT_LENGTH', () => {
    const overLong = 'x'.repeat(MAX_TEXT_LENGTH + 1);
    expect(() =>
      generateKeyboardCadence({ text: overLong, profile: PROFILE, seed: 'long' }),
    ).toThrow(/text must be <= 20000 characters/);
  });

  it('BSIM-4: accepts text exactly at MAX_TEXT_LENGTH', () => {
    const atLimit = 'x'.repeat(MAX_TEXT_LENGTH);
    expect(() =>
      generateKeyboardCadence({ text: atLimit, profile: PROFILE, seed: 'at-limit' }),
    ).not.toThrow();
  });

  it('BSIM-4: a normal-length paragraph of text still works exactly as before', () => {
    const paragraph =
      'The quick brown fox jumps over the lazy dog. '.repeat(20) + 'End of paragraph.';
    expect(paragraph.length).toBeLessThan(MAX_TEXT_LENGTH);
    const c = generateKeyboardCadence({ text: paragraph, profile: PROFILE, seed: 'paragraph' });
    expect(c.delaysMs).toHaveLength(paragraph.length);
    expect(c.durationMs).toBe(c.delaysMs.reduce((a, b) => a + b, 0));
  });

  it('is NOT a flat constant (real jitter, unlike the mock)', () => {
    const c = generateKeyboardCadence({ text: 'abcdefghijklmnop', profile: PROFILE, seed: 'jit' });
    const unique = new Set(c.delaysMs);
    expect(unique.size).toBeGreaterThan(3);
  });
});
