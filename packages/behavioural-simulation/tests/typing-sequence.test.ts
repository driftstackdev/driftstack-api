import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TYPO_PROBABILITY,
  generateTypingSequence,
  getProfile,
  MAX_TEXT_LENGTH,
  replayTypingSequence,
  type BehaviouralProfile,
} from '../src/index.js';

const PROFILE: BehaviouralProfile = getProfile('regular')!;

describe('generateTypingSequence', () => {
  it('exports the file-05 default typo probability (1-3% range)', () => {
    expect(DEFAULT_TYPO_PROBABILITY).toBeGreaterThanOrEqual(0.01);
    expect(DEFAULT_TYPO_PROBABILITY).toBeLessThanOrEqual(0.03);
  });

  it('replaying the events always reproduces the intended text', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const seq = generateTypingSequence({
        text: 'log in and reply to my messages',
        profile: PROFILE,
        seed,
        typoProbability: 0.5, // high rate to exercise the correction path
      });
      expect(replayTypingSequence(seq.events)).toBe('log in and reply to my messages');
    }
  });

  it('with typoProbability 0: no typos, one char event per character, no backspaces', () => {
    const text = 'hello world';
    const seq = generateTypingSequence({ text, profile: PROFILE, seed: 's', typoProbability: 0 });
    expect(seq.typoCount).toBe(0);
    expect(seq.events).toHaveLength(text.length);
    expect(seq.events.every((e) => e.kind === 'char')).toBe(true);
    expect(replayTypingSequence(seq.events)).toBe(text);
  });

  it('with typoProbability 1 on a single letter: wrong adjacent key → backspace → correct key', () => {
    const seq = generateTypingSequence({
      text: 'a',
      profile: PROFILE,
      seed: 'z',
      typoProbability: 1,
    });
    expect(seq.typoCount).toBe(1);
    expect(seq.events).toHaveLength(3);
    const [wrong, back, right] = seq.events;
    expect(wrong!.kind).toBe('char');
    // 'a' fat-finger neighbours on QWERTY.
    expect(['q', 'w', 's', 'z']).toContain((wrong as { char: string }).char);
    expect(back!.kind).toBe('backspace');
    expect(right!.kind).toBe('char');
    expect((right as { char: string }).char).toBe('a');
    expect(replayTypingSequence(seq.events)).toBe('a');
  });

  it('rejects typo probabilities outside the finite unit interval', () => {
    for (const typoProbability of [
      -0.01,
      1.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() =>
        generateTypingSequence({ text: 'hello', profile: PROFILE, typoProbability }),
      ).toThrow(/typoProbability/);
    }
  });

  it('preserves case — an uppercase letter typo substitutes an uppercase neighbour', () => {
    const seq = generateTypingSequence({
      text: 'A',
      profile: PROFILE,
      seed: 'z',
      typoProbability: 1,
    });
    const wrong = seq.events[0] as { char: string };
    expect(wrong.char).toMatch(/^[A-Z]$/);
    expect(wrong.char).not.toBe('A');
  });

  it('is deterministic for the same (text, profile, seed, typoProbability)', () => {
    const opts = {
      text: 'the quick brown fox',
      profile: PROFILE,
      seed: 'fixed',
      typoProbability: 0.4,
    };
    expect(generateTypingSequence(opts).events).toEqual(generateTypingSequence(opts).events);
  });

  it('durationMs = sum of event delays', () => {
    const seq = generateTypingSequence({
      text: 'check messages',
      profile: PROFILE,
      seed: 'd',
      typoProbability: 0.3,
    });
    expect(seq.durationMs).toBe(seq.events.reduce((a, e) => a + e.delayMs, 0));
  });

  it('non-letter characters (spaces, digits) are never typo-substituted', () => {
    // QWERTY_NEIGHBOURS only covers letters, so a digits/space string can
    // never inject a typo even at probability 1.
    const seq = generateTypingSequence({
      text: '12 34 56',
      profile: PROFILE,
      seed: 'n',
      typoProbability: 1,
    });
    expect(seq.typoCount).toBe(0);
    expect(replayTypingSequence(seq.events)).toBe('12 34 56');
  });

  it('emits emoji, combining sequences, and flags as intact grapheme keystrokes', () => {
    const text = 'A👩‍💻é🇺🇸';
    const seq = generateTypingSequence({
      text,
      profile: PROFILE,
      seed: 'graphemes',
      typoProbability: 0,
    });
    expect(seq.events).toEqual([
      expect.objectContaining({ kind: 'char', char: 'A' }),
      expect.objectContaining({ kind: 'char', char: '👩‍💻' }),
      expect.objectContaining({ kind: 'char', char: 'é' }),
      expect.objectContaining({ kind: 'char', char: '🇺🇸' }),
    ]);
    expect(replayTypingSequence(seq.events)).toBe(text);
  });

  it('BSIM-4: rejects text over MAX_TEXT_LENGTH with its OWN check (not just via the delegated generateKeyboardCadence call)', () => {
    // Regression-proofing: generateTypingSequence delegates to
    // generateKeyboardCadence internally, which has its own identical check —
    // so a naive test could pass even if generateTypingSequence's OWN check
    // were removed (the delegate's error would still surface). Assert the
    // message is specifically generateTypingSequence's to prove ITS check
    // fires, matching the finding's "fix both, don't assume fixing one
    // covers the other" requirement.
    const overLong = 'a'.repeat(MAX_TEXT_LENGTH + 1);
    expect(() =>
      generateTypingSequence({ text: overLong, profile: PROFILE, seed: 'long' }),
    ).toThrow(/^generateTypingSequence: text must be <= 20000 characters/);
  });

  it('BSIM-4: accepts text exactly at MAX_TEXT_LENGTH', () => {
    const atLimit = 'a'.repeat(MAX_TEXT_LENGTH);
    expect(() =>
      generateTypingSequence({
        text: atLimit,
        profile: PROFILE,
        seed: 'at-limit',
        typoProbability: 0,
      }),
    ).not.toThrow();
  });

  it('BSIM-4: a normal-length paragraph of text still works exactly as before', () => {
    const paragraph =
      'the quick brown fox jumps over the lazy dog. '.repeat(20) + 'end of paragraph.';
    expect(paragraph.length).toBeLessThan(MAX_TEXT_LENGTH);
    const seq = generateTypingSequence({
      text: paragraph,
      profile: PROFILE,
      seed: 'paragraph',
      typoProbability: 0,
    });
    expect(replayTypingSequence(seq.events)).toBe(paragraph);
  });

  it('handles empty text', () => {
    const seq = generateTypingSequence({ text: '', profile: PROFILE, seed: 'e' });
    expect(seq.events).toEqual([]);
    expect(seq.durationMs).toBe(0);
    expect(seq.typoCount).toBe(0);
  });
});
