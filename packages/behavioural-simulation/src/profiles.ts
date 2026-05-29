// V-530.G — canonical behavioural persona catalogue.
//
// Every generator in this package (keyboard cadence, touch, scroll,
// idle) takes a `BehaviouralProfile` — but until now the only profiles
// that existed were two ad-hoc fixtures inside the MockBehaviouralSimulator
// (test scaffolding). This is the real, exported persona catalogue the
// session-driving layer feeds the generators.
//
// Grounded in the behavioural-library spec (driftstack planning file 05
// §"Persona model"): the v1 persona set is `casual` / `regular` /
// `power_user`, parameterised primarily by typing speed (base WPM) with
// scroll + pause behaviour scaling alongside it. "Real users have
// personas — a 22-year-old power user types faster and scrolls more
// aggressively than a 65-year-old casual user." A session locks to one
// persona for its lifetime (spec §"Persona consistency").
//
// Typing speed → mean inter-key delay: WPM is words/min; the standard
// word = 5 chars, so chars/min = WPM × 5 and the mean inter-key delay
// is 60000 / (WPM × 5) = 12000 / WPM ms. File 05 pins `casual` at
// base_wpm 38 (→ ~316 ms/char); `regular` + `power_user` follow a
// plausible mobile-typing progression (≈52 / ≈72 WPM). These are
// behavioural PERSONA archetypes (humans legitimately vary) — NOT
// fingerprint constants that must match a single captured iPhone value.

import type { BehaviouralProfile } from './types.js';

/** WPM → mean inter-keystroke delay (ms). 5 chars/word ⇒ 12000 / WPM. */
function wpmToMeanKeyDelayMs(wpm: number): number {
  return Math.round(12000 / wpm);
}

/** The v1 persona ids (file 05 §"Persona model"). */
export type PersonaId = 'casual' | 'regular' | 'power_user';

/**
 * Canonical persona catalogue. Ordered slowest → fastest typist so the
 * progression (key delay ↓, scroll ↑, pause probability ↓) is readable.
 */
export const PROFILE_CATALOGUE: readonly BehaviouralProfile[] = [
  {
    // base_wpm 38 (file 05). Deliberate, hunt-and-peck-ish mobile typist;
    // scrolls cautiously and pauses often to read.
    id: 'casual',
    meanKeyDelayMs: wpmToMeanKeyDelayMs(38),
    meanMouseSpeedPxPerMs: 0.7,
    meanScrollPxPerTick: 28,
    pauseProbability: 0.16,
    meanPauseMs: 950,
  },
  {
    // ~52 WPM. Comfortable thumb-typist; moderate scroll + pause cadence.
    id: 'regular',
    meanKeyDelayMs: wpmToMeanKeyDelayMs(52),
    meanMouseSpeedPxPerMs: 1.0,
    meanScrollPxPerTick: 42,
    pauseProbability: 0.1,
    meanPauseMs: 720,
  },
  {
    // ~72 WPM. Fast, fluent power user; aggressive scroll, rarely pauses.
    id: 'power_user',
    meanKeyDelayMs: wpmToMeanKeyDelayMs(72),
    meanMouseSpeedPxPerMs: 1.3,
    meanScrollPxPerTick: 58,
    pauseProbability: 0.06,
    meanPauseMs: 520,
  },
];

/** Look up a persona by id; `undefined` if unknown (caller decides the
 *  fallback — typically `DEFAULT_PERSONA_ID`). */
export function getProfile(id: string): BehaviouralProfile | undefined {
  return PROFILE_CATALOGUE.find((p) => p.id === id);
}

/** The full catalogue (stable order). */
export function listProfiles(): readonly BehaviouralProfile[] {
  return PROFILE_CATALOGUE;
}

/** Default persona when a session doesn't specify one (file 05 maps the
 *  `balanced` session profile to the middle persona). */
export const DEFAULT_PERSONA_ID: PersonaId = 'regular';
