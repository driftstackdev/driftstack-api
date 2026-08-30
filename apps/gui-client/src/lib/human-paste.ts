// V-2168 — "type like a human" paste for the manual simulator session.
//
// Owner 2026-08-30: "Add some more user friendly tools, such as type like human
// (copy paste) … Ctrl+Shift+V usually are commands that do this."
//
// ⛔ WHY NOT A REAL PASTE. The obvious implementation — ship the clipboard
// string to the device and have it set the field's value — is the single
// clearest automation tell there is: a text field going from empty to 200
// characters in one event, with no keydown/keyup pair and no inter-key timing,
// is what every behavioural detector looks for first. This product exists to
// not read as automation, so the paste is TYPED: the same keyDown/keyUp events
// the host keyboard and the on-screen iOS keyboard already emit, spaced by the
// package's fingerprint-grade cadence model.
//
// The cadence comes from @driftstack/behavioural-simulation rather than a
// hand-rolled `setTimeout(50)` loop, because that package already models what a
// detector measures: a longer first-key latency, gaussian jitter around the
// persona's mean, iOS layer-switch costs (uppercase pays a Shift tap, digits and
// punctuation pay a layer switch), word-boundary pauses on space, occasional
// thinking hesitations, and a speed-up on a repeated key. A uniform delay would
// be a different, equally obvious tell.
//
// The driver here is pure timing + dispatch: it owns no clipboard access and no
// Room. Both are injected, so the whole thing is unit-testable with fake timers
// and no LiveKit.

import {
  generateKeyboardCadence,
  getProfile,
  DEFAULT_PERSONA_ID,
} from '@driftstack/behavioural-simulation';

/**
 * Longest clipboard string that may be typed in one paste.
 *
 * ⛔ Not a style choice. Every character is a keyDown + keyUp on the RELIABLE
 * data channel, and the input-receipt tracker evicts at 128 pending — so a
 * multi-thousand-character burst would both flood the channel it shares with
 * taps and navigation, and trip the "device did not confirm the last input"
 * alarm on its own traffic. At the cadence model's ~200ms mean this is already
 * a ~6-minute type; anything longer is a file transfer, not typing.
 */
export const HUMAN_PASTE_MAX_CHARS = 2_000;

/** What the driver needs from its caller. All injected — no globals. */
export interface HumanPasteDeps {
  /** Reads the clipboard. Rejects when unavailable/denied. */
  readClipboard: () => Promise<string>;
  /** Sends ONE keystroke (the caller pairs keyDown/keyUp exactly as the host
   *  keyboard path does). Returning false stops the paste — the caller uses
   *  that for authority loss and reliable-channel congestion. */
  sendKey: (key: string) => boolean;
  /** Resolves after `ms`. Injected so tests drive it with fake timers. */
  sleep: (ms: number) => Promise<void>;
  /** Per-session seed. ⛔ Required: the cadence generator's default seed is
   *  derived from (persona, text) alone, so two sessions pasting the same
   *  string would emit byte-identical keystroke timing — a cross-session
   *  correlation tell, which is exactly what this feature exists to avoid. */
  seed: string;
  /** Persona id; falls back to the package default when unknown. */
  personaId?: string;
}

export type HumanPasteResult =
  | { status: 'typed'; chars: number; durationMs: number }
  | { status: 'empty' }
  | { status: 'too-long'; chars: number; max: number }
  | { status: 'interrupted'; chars: number }
  | { status: 'unavailable'; reason: string };

/**
 * Type the clipboard's contents into the device at human cadence.
 *
 * Never throws: a denied clipboard, an empty clipboard and an over-long one are
 * all reported as results, because this runs from a keyboard shortcut where an
 * exception would surface as an unhandled rejection over the borderless
 * simulator window.
 */
export async function pasteAsHumanTyping(deps: HumanPasteDeps): Promise<HumanPasteResult> {
  let text: string;
  try {
    text = await deps.readClipboard();
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : 'clipboard unavailable',
    };
  }
  if (text === '') return { status: 'empty' };
  if (text.length > HUMAN_PASTE_MAX_CHARS) {
    return { status: 'too-long', chars: text.length, max: HUMAN_PASTE_MAX_CHARS };
  }

  const profile =
    getProfile(deps.personaId ?? DEFAULT_PERSONA_ID) ?? getProfile(DEFAULT_PERSONA_ID);
  if (profile === undefined) {
    // The persona registry is a build-time constant, so this is unreachable in
    // practice — but typing at NO cadence would be the exact tell this module
    // exists to prevent, so refuse rather than fall back to a uniform delay.
    return { status: 'unavailable', reason: 'no behavioural profile available' };
  }

  const cadence = generateKeyboardCadence({ text, profile, seed: deps.seed });
  // The cadence is per GRAPHEME; iterate the string the same way so an emoji or
  // a combining pair consumes exactly one delay and is typed as one key.
  const graphemes = [...text];
  let typed = 0;
  for (let i = 0; i < graphemes.length; i += 1) {
    const delay = cadence.delaysMs[i];
    if (delay !== undefined && delay > 0) await deps.sleep(delay);
    const ch = graphemes[i];
    if (ch === undefined) break;
    // A newline is Enter on a real keyboard — a literal '\n' key does nothing.
    if (!deps.sendKey(ch === '\n' ? 'Enter' : ch)) {
      return { status: 'interrupted', chars: typed };
    }
    typed += 1;
  }
  return { status: 'typed', chars: typed, durationMs: cadence.durationMs };
}

/** True for the human-paste chord: Ctrl+Shift+V, or Cmd+Shift+V on a Mac. */
export function isHumanPasteChord(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  // `key` is 'V' while Shift is held on every layout that reports a cased key.
  if (e.key.toLowerCase() !== 'v') return false;
  if (!e.shiftKey || e.altKey) return false;
  return e.ctrlKey || e.metaKey;
}
