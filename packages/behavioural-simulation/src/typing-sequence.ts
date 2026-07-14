// V-530.H — typo-aware typing sequence. The single clearest human-vs-bot
// typing tell is that real users make occasional typos and immediately
// fix them; a bot types a string with zero corrections, every time.
//
// `generateKeyboardCadence` gives realistic per-keystroke TIMING for a
// clean string; this layers the behavioural-library spec's typo model on
// top (driftstack planning file 05 §"Typing behavior"): "Random typos:
// substitute adjacent keys with low probability per character (1-3% per
// persona). Detected immediately: most corrections within 1-2 keystrokes."
//
// The output is a keystroke-event stream (type a char / press backspace)
// rather than a per-char delay array, because a correction injects EXTRA
// keystrokes (the wrong key, a backspace, the right key). Replaying the
// events reproduces the intended text exactly.
//
// Typos substitute a PHYSICALLY adjacent QWERTY key (fat-finger), not a
// random char — that's what a real mis-tap looks like on the iOS
// keyboard. Correction is immediate (notice → backspace → retype) for
// v1; delayed-notice (the typo caught 1-2 keystrokes later) is a future
// refinement. Deterministic given a seed, matching the package.

import { generateKeyboardCadence, MAX_TEXT_LENGTH } from './keyboard.js';
import type { GenerateKeyboardCadenceOpts } from './interfaces.js';
import { splitGraphemes } from './graphemes.js';
import { requireFinite, requireUnitInterval } from './validation.js';

export interface GenerateTypingSequenceOpts extends GenerateKeyboardCadenceOpts {
  /** Per-character typo probability (0..1). Default 0.025 (file 05: 1-3%). */
  typoProbability?: number;
}

/** One physical keystroke in a typing sequence. */
export type KeystrokeEvent =
  { kind: 'char'; char: string; delayMs: number } | { kind: 'backspace'; delayMs: number };

export interface TypingSequence {
  /** The intended final text (what the events reproduce when replayed). */
  text: string;
  /** Ordered keystrokes, including any typo + correction keystrokes. */
  events: readonly KeystrokeEvent[];
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** How many typos were injected (observability / test assertions). */
  typoCount: number;
  /** RNG seed used. */
  seed: string;
}

/** File 05: 1-3% per persona — middle of the range as the default. */
export const DEFAULT_TYPO_PROBABILITY = 0.025;

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

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** iOS / QWERTY physical key adjacency (lowercase letters → fat-finger
 *  neighbours). A typo substitutes one of these for the intended key. */
const QWERTY_NEIGHBOURS: Readonly<Record<string, readonly string[]>> = {
  q: ['w', 'a', 's'],
  w: ['q', 'e', 'a', 's', 'd'],
  e: ['w', 'r', 's', 'd', 'f'],
  r: ['e', 't', 'd', 'f', 'g'],
  t: ['r', 'y', 'f', 'g', 'h'],
  y: ['t', 'u', 'g', 'h', 'j'],
  u: ['y', 'i', 'h', 'j', 'k'],
  i: ['u', 'o', 'j', 'k', 'l'],
  o: ['i', 'p', 'k', 'l'],
  p: ['o', 'l'],
  a: ['q', 'w', 's', 'z'],
  s: ['q', 'w', 'e', 'a', 'd', 'z', 'x'],
  d: ['w', 'e', 'r', 's', 'f', 'x', 'c'],
  f: ['e', 'r', 't', 'd', 'g', 'c', 'v'],
  g: ['r', 't', 'y', 'f', 'h', 'v', 'b'],
  h: ['t', 'y', 'u', 'g', 'j', 'b', 'n'],
  j: ['y', 'u', 'i', 'h', 'k', 'n', 'm'],
  k: ['u', 'i', 'o', 'j', 'l', 'm'],
  l: ['i', 'o', 'p', 'k'],
  z: ['a', 's', 'x'],
  x: ['z', 's', 'd', 'c'],
  c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'],
  n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k'],
};

/**
 * Produce a keystroke-event stream for `text` typed under `profile`,
 * with occasional adjacent-key typos that are immediately corrected.
 *
 * Replaying the events (apply `char`, undo on `backspace`) yields `text`.
 */
export function generateTypingSequence(opts: GenerateTypingSequenceOpts): TypingSequence {
  const { text, profile } = opts;
  // Checked directly here (not just relying on the delegated
  // generateKeyboardCadence call below) so this function's own validation
  // convention + error message hold even if the internal delegation ever
  // changes. Shares MAX_TEXT_LENGTH with generateKeyboardCadence so the two
  // stay in lockstep.
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(
      `generateTypingSequence: text must be <= ${MAX_TEXT_LENGTH} characters (got ${text.length})`,
    );
  }
  // ⚠️ DETERMINISTIC FALLBACK SEED — reference/testing only. Derived purely from
  // (profile.id, text), so the same args produce byte-identical sequences.
  // Intentional for reproducible tests; production callers MUST pass a
  // per-session `seed` to avoid correlated, replayable typing streams.
  const seed = opts.seed ?? `typing:${profile.id}:${text}`;
  const typoProbability = opts.typoProbability ?? DEFAULT_TYPO_PROBABILITY;
  requireUnitInterval('generateTypingSequence: typoProbability', typoProbability);

  // Reuse the realistic per-keystroke timing model for the clean text.
  const cadence = generateKeyboardCadence({ text, profile, seed });
  const graphemes = splitGraphemes(text);
  const rng = mulberry32(hashSeed(`${seed}:typo`));
  const minDelayMs = 30;
  const mean = profile.meanKeyDelayMs;

  const events: KeystrokeEvent[] = [];
  let typoCount = 0;

  for (let i = 0; i < graphemes.length; i += 1) {
    const char = graphemes[i] as string;
    const baseDelay = cadence.delaysMs[i] as number;
    const neighbours = QWERTY_NEIGHBOURS[char.toLowerCase()];

    if (neighbours && neighbours.length > 0 && rng() < typoProbability) {
      typoCount += 1;
      // The wrong adjacent key (preserve the intended key's case).
      const pick = neighbours[Math.floor(rng() * neighbours.length)] as string;
      const wrong = char >= 'A' && char <= 'Z' ? pick.toUpperCase() : pick;
      events.push({ kind: 'char', char: wrong, delayMs: baseDelay });
      // Notice + delete — quick (the typo is caught immediately).
      const backspaceDelayMs = Math.max(minDelayMs, Math.round(mean * (0.5 + rng() * 0.3)));
      requireFinite('generateTypingSequence: derived backspace delayMs', backspaceDelayMs);
      events.push({
        kind: 'backspace',
        delayMs: backspaceDelayMs,
      });
      // Retype the correct key — slightly quicker than a fresh keystroke
      // (the finger now knows where to go).
      const correctedDelayMs = Math.max(minDelayMs, Math.round(mean * (0.6 + rng() * 0.3)));
      requireFinite('generateTypingSequence: derived corrected delayMs', correctedDelayMs);
      events.push({
        kind: 'char',
        char,
        delayMs: correctedDelayMs,
      });
    } else {
      events.push({ kind: 'char', char, delayMs: baseDelay });
    }
  }

  const durationMs = events.reduce((acc, e) => acc + e.delayMs, 0);
  requireFinite('generateTypingSequence: durationMs', durationMs);
  return { text, events, durationMs, typoCount, seed };
}

/** Replay a typing sequence to the final text it produces (apply chars,
 *  undo on backspace). Useful for verification / tests. */
export function replayTypingSequence(events: readonly KeystrokeEvent[]): string {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === 'char') out.push(e.char);
    else out.pop();
  }
  return out.join('');
}
