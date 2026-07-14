// V-530.F — keyboard cadence generator. Produces human-realistic
// per-keystroke inter-key delays for typing a string into a session,
// so an automated form-fill is behaviourally indistinguishable from a
// real person typing on the iOS software keyboard.
//
// Typing rhythm is a load-bearing bot-detection signal: a constant
// inter-key delay (or instant value-set) is the single clearest "this
// is a script" tell. This generator models the dynamics a detector
// looks for:
//
//   - a longer first-key latency (orienting to / focusing the field);
//   - gaussian jitter around the profile's mean inter-key delay (the
//     same sum-of-3-uniforms approximation the dwell/scroll generators
//     use, so the seeding + distribution shape stay consistent across
//     the package);
//   - iOS-keyboard layer-switch costs — uppercase letters cost a Shift
//     tap, and digits / punctuation cost a switch to the number/symbol
//     layer, so both are slower than a lowercase letter;
//   - a brief word-boundary pause on space;
//   - a small per-key chance of a longer "thinking" hesitation;
//   - a mild speed-up when the same key repeats (the finger is already
//     there).
//
// Deterministic given a seed (mulberry32 + FNV-1a), matching the rest
// of the package — same (text, profile, seed) always yields the same
// cadence, which keeps tests reproducible and lets a replay reproduce a
// run exactly.

import type { GenerateKeyboardCadenceOpts } from './interfaces.js';
import type { KeyboardCadence } from './types.js';
import { splitGraphemes } from './graphemes.js';
import { requireFinite } from './validation.js';

export interface KeyboardCadenceDefaults {
  /** σ as a fraction of the mean delay (gaussian jitter width). */
  jitterFraction: number;
  /** First-keystroke latency multiplier — the pause to start typing. */
  firstKeyLatencyMult: number;
  /** Word-boundary micro-pause multiplier (typing a space). */
  spaceMult: number;
  /** Uppercase letter multiplier — costs a Shift tap on iOS. */
  shiftMult: number;
  /** Digit / punctuation / symbol multiplier — number/symbol layer switch. */
  symbolMult: number;
  /** Repeated-character multiplier — the finger is already on the key. */
  repeatCharMult: number;
  /** Per-key probability of a longer "thinking" hesitation (after key 0). */
  hesitationProbability: number;
  /** Hesitation magnitude, as a [min, max] multiple of the mean delay. */
  hesitationMultRange: readonly [number, number];
  /** Hard floor on any single inter-key delay (ms). */
  minDelayMs: number;
}

/**
 * Maximum allowed `text` length (UTF-16 code units), shared with
 * `generateTypingSequence` (typing-sequence.ts imports this constant rather
 * than redefining its own value, keeping the two in lockstep). Unlike
 * BSIM-1/2's unbounded-loop shapes, iterating `text.length` here scales only
 * LINEARLY — but customer-controlled form-fill `text` is exactly the kind of
 * value this package will eventually receive from the recipe/session runner
 * with zero length validation today. A real "type into a form field" step
 * never plausibly needs more than a few thousand characters — even a full
 * pasted page of prose sits comfortably under five figures — so 20,000 is a
 * generous-but-bounded cap.
 */
export const MAX_TEXT_LENGTH = 20_000;

export const KEYBOARD_CADENCE_DEFAULTS: KeyboardCadenceDefaults = {
  jitterFraction: 0.22,
  firstKeyLatencyMult: 2.0,
  spaceMult: 1.15,
  shiftMult: 1.4,
  symbolMult: 1.6,
  repeatCharMult: 0.8,
  hesitationProbability: 0.04,
  hesitationMultRange: [4, 9],
  minDelayMs: 30,
};

/** Seeded PRNG (mulberry32) — float in [0, 1). Per-file copy, matching
 *  the seeding convention across the package (see idle.ts). */
function mulberry32(seedNum: number): () => number {
  let state = seedNum >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → 32-bit seed. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Approx standard-normal via sum of 3 uniforms (mean 0, σ≈1) — the
 *  same shape the dwell/scroll generators use. */
function gaussian(rng: () => number): number {
  return (rng() + rng() + rng() - 1.5) / 0.5;
}

// Unicode-aware character classification. An ASCII-only classifier
// (`/[A-Z]/`, `/[a-z]/`) mis-classifies every non-English letter —
// accented Latin (café, niño), Cyrillic (привет), CJK, etc. — as a
// "symbol", applying the number/symbol-layer switch penalty (symbolMult)
// to ordinary letters. That is a typing-cadence fingerprint tell for
// every non-English persona (a real keyboard types those letters at the
// letter cadence, not the slower symbol cadence). Classify with Unicode
// property escapes so a letter is a letter in any script:
//   - LETTER  (\p{L})    → letter cadence; if it is also uppercase
//                          (\p{Lu}) it costs a Shift tap (shiftMult).
//   - SYMBOLIC ([0-9] | \p{P} punctuation | \p{S} symbol) → symbolMult
//     (the number/symbol iOS keyboard layer). Reserved for ACTUAL
//     digits / punctuation / symbols, not for non-ASCII letters.
const LETTER = /\p{L}/u;
const UPPERCASE = /\p{Lu}/u;
const SYMBOLIC = /[0-9\p{P}\p{S}]/u;

/**
 * Produce per-keystroke timings for `text` typed under `profile`.
 *
 * `delaysMs[i]` is the delay BEFORE Unicode grapheme keystroke `i` (so
 * `delaysMs[0]` is the latency to the first keypress). `durationMs` is their
 * sum. Emoji, combining sequences, and flags each occupy one cadence slot.
 */
export function generateKeyboardCadence(opts: GenerateKeyboardCadenceOpts): KeyboardCadence {
  const { text, profile } = opts;
  requireFinite('generateKeyboardCadence: profile.meanKeyDelayMs', profile.meanKeyDelayMs);
  if (profile.meanKeyDelayMs <= 0) {
    throw new Error(
      `generateKeyboardCadence: profile.meanKeyDelayMs must be > 0 ` +
        `(got ${profile.meanKeyDelayMs})`,
    );
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(
      `generateKeyboardCadence: text must be <= ${MAX_TEXT_LENGTH} characters ` +
        `(got ${text.length})`,
    );
  }
  // ⚠️ DETERMINISTIC FALLBACK SEED — reference/testing only. The default below
  // is derived purely from (profile.id, text), so two default-seed calls with
  // the same args produce byte-identical cadences. Intentional for reproducible
  // tests; production callers MUST pass a per-session `seed` to avoid correlated,
  // replayable keystroke streams (a cross-session correlation tell).
  const seed = opts.seed ?? `keyboard:${profile.id}:${text}`;
  const rng = mulberry32(hashSeed(seed));
  const d = KEYBOARD_CADENCE_DEFAULTS;
  const mean = profile.meanKeyDelayMs;
  const graphemes = splitGraphemes(text);

  const delaysMs: number[] = [];
  let prevChar = '';

  for (let i = 0; i < graphemes.length; i += 1) {
    const char = graphemes[i] as string;

    // Base delay with gaussian jitter; clamp the factor so a single
    // unlucky draw can't collapse the delay to near-zero.
    const factor = Math.max(0.35, 1 + d.jitterFraction * gaussian(rng));
    let delay = mean * factor;

    if (i === 0) {
      delay *= d.firstKeyLatencyMult;
    }

    // iOS software-keyboard layer-switch costs + word-boundary pause.
    if (char === ' ') {
      delay *= d.spaceMult;
    } else if (UPPERCASE.test(char)) {
      // Uppercase letter (any script) — costs a Shift tap.
      delay *= d.shiftMult;
    } else if (LETTER.test(char)) {
      // Lowercase or caseless letter (any script — accented Latin,
      // Cyrillic, CJK, …) — ordinary letter cadence, no layer-switch cost.
    } else if (SYMBOLIC.test(char)) {
      // Actual digit / punctuation / symbol — lives on a switched iOS
      // keyboard layer (number/symbol), so slower than a letter.
      delay *= d.symbolMult;
    }

    // Repeated character — the finger is already on the key.
    if (char === prevChar) {
      delay *= d.repeatCharMult;
    }

    // Occasional longer hesitation (not on the first key — that's the
    // first-key latency above).
    if (i > 0 && rng() < d.hesitationProbability) {
      const [lo, hi] = d.hesitationMultRange;
      delay += mean * (lo + rng() * (hi - lo));
    }

    const roundedDelayMs = Math.max(d.minDelayMs, Math.round(delay));
    requireFinite('generateKeyboardCadence: derived delayMs', roundedDelayMs);
    delaysMs.push(roundedDelayMs);
    prevChar = char;
  }

  const durationMs = delaysMs.reduce((acc, v) => acc + v, 0);
  requireFinite('generateKeyboardCadence: durationMs', durationMs);
  return { text, delaysMs, durationMs, seed };
}
