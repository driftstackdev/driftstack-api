import { describe, expect, it } from 'vitest';
import {
  generateKeyboardCadence,
  KEYBOARD_CADENCE_DEFAULTS,
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

  it('is NOT a flat constant (real jitter, unlike the mock)', () => {
    const c = generateKeyboardCadence({ text: 'abcdefghijklmnop', profile: PROFILE, seed: 'jit' });
    const unique = new Set(c.delaysMs);
    expect(unique.size).toBeGreaterThan(3);
  });
});
