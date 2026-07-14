// W453.A — drift guard for packages/behavioural-simulation/src/scroll.ts.
// V-530.B finger-flick scroll velocity profiles with exponential decay.
// Drift here either drops the ∫ v(τ)dτ integral that closes the gap
// between v(t) and v(t+tick) (per-tick deltaPx becomes sample-grade
// rather than integrated, accumulated distance drifts off the
// analytical answer) or loses the rest-velocity termination guard
// (profile runs to MAX_DURATION_MS even at trivial velocity, padding
// ticks with near-zero deltas).
//
//   • V-530.B header framing pinned + 'distinct from constant per-tick'
//     mock surface rationale.
//   • ScrollVelocityTick: 4-field (tMs + velocityPxPerSec +
//     deltaPx signed + cumulativePx running total).
//   • ScrollVelocityProfile: 7-field (direction + initialVelocityPxPerSec
//     + decayRate + ticks readonly + totalDistancePx absolute +
//     durationMs + seed).
//   • ScrollVelocityClassDefaults: 4-field; scroll-container has
//     stronger flicks + lower friction than generic; SCROLL_VELOCITY_
//     DEFAULTS 7-entry table (per-ElementClass) Object.freeze.
//   • Constants: DEFAULT_TICK_INTERVAL_MS=16 ('60Hz, matching touch
//     device rates'), REST_VELOCITY_THRESHOLD_PX_PER_SEC=5,
//     MAX_DURATION_MS=5000, MAX_TICK_INTERVAL_MS=100,
//     MAX_INITIAL_VELOCITY_PX_PER_SEC=12000, MIN_DECAY_RATE=0.1,
//     MAX_DECAY_RATE=20.
//   • generateScrollVelocityProfile framing pinned:
//     'v(t) = v0 * exp(-decayRate * t) sampled at tickIntervalMs
//     intervals until velocity drops below the rest threshold (5
//     px/s); overrides unable to settle within MAX_DURATION_MS fail.'
//   • Direction sign: 'down'/'right' → positive; 'up'/'left' →
//     negative; totalDistancePx always positive (abs).
//   • Per-tick integration: ∫ v(τ)dτ = (v0/decayRate) ×
//     (exp(-decay*t) - exp(-decay*(t+tickSec))); non-positive decay
//     fails at the boundary.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/scroll.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W453.A packages/behavioural-simulation/src/scroll.ts content parity', () => {
  const body = read(LIB);

  it("V-530.B framing pinned: 'V-530.B — scroll velocity profiles with exponential decay.' + 'Second module of the Phase 3 real implementation, after V-530.A (touch event distributions). Models the velocity curve a human finger flick produces on a scroll container: initial velocity from the flick, then exponential decay as friction slows the scroll.'", () => {
    expect(body).toMatch(/\/\/ V-530\.B — scroll velocity profiles with exponential decay\./);
    expect(body).toMatch(
      /\/\/ Second module of the Phase 3 real implementation, after V-530\.A\s*\n?\s*\/\/ \(touch event distributions\)\. Models the velocity curve a human finger\s*\n?\s*\/\/ flick produces on a scroll container: initial velocity from the flick,\s*\n?\s*\/\/ then exponential decay as friction slows the scroll\./,
    );
  });

  it("distinct-from-mock-surface framing pinned: 'Distinct from the existing generateScrollPattern mock surface (constant per-tick deltas) — this module produces realistic decaying per-tick deltas. The existing mock surface stays unchanged for backward compatibility; new callers reach for the velocity profile.'", () => {
    expect(body).toMatch(
      /\/\/ Distinct from the existing `generateScrollPattern` mock surface\s*\n?\s*\/\/ \(constant per-tick deltas\) — this module produces realistic decaying\s*\n?\s*\/\/ per-tick deltas\. The existing mock surface stays unchanged for\s*\n?\s*\/\/ backward compatibility; new callers reach for the velocity profile\./,
    );
  });

  it("ScrollVelocityTick: 4-field (tMs + velocityPxPerSec + deltaPx signed + cumulativePx); 'signed: + = forward, - = reverse' framing on deltaPx", () => {
    expect(body).toMatch(
      /export interface ScrollVelocityTick \{[\s\S]*?tMs: number;[\s\S]*?velocityPxPerSec: number;[\s\S]*?\/\*\* Pixels scrolled during this tick \(signed: \+ = forward, - = reverse\)\. \*\/\s*\n?\s*deltaPx: number;[\s\S]*?cumulativePx: number;/,
    );
  });

  it("ScrollVelocityProfile: 7-field (direction 4-union + initialVelocityPxPerSec + decayRate '1 / seconds. Higher = faster decay' + ticks readonly + totalDistancePx absolute + durationMs + seed)", () => {
    expect(body).toMatch(
      /export interface ScrollVelocityProfile \{[\s\S]*?direction: 'up' \| 'down' \| 'left' \| 'right';[\s\S]*?initialVelocityPxPerSec: number;[\s\S]*?\/\*\* Exponential decay rate \(1 \/ seconds\)\. Higher = faster decay\. \*\/\s*\n?\s*decayRate: number;[\s\S]*?ticks: readonly ScrollVelocityTick\[\];[\s\S]*?\/\*\* Total distance scrolled \(absolute, in pixels\)\. \*\/\s*\n?\s*totalDistancePx: number;[\s\S]*?durationMs: number;[\s\S]*?seed: string;/,
    );
  });

  it("ScrollVelocityClassDefaults framing pinned: 'scroll-container has stronger flicks + lower friction (the touched surface is designed to be scrolled); generic containers have weaker flicks + higher friction (incidental scroll, e.g. background body)'", () => {
    expect(body).toMatch(
      /\* Per-element-class defaults for scroll velocity\. The `container` class\s*\n?\s*\*\s*the touch initiates on shapes the initial flick velocity \+ friction\.\s*\n?\s*\*\s*scroll-container has stronger flicks \+ lower friction \(the touched\s*\n?\s*\*\s*surface is designed to be scrolled\); generic containers have weaker\s*\n?\s*\*\s*flicks \+ higher friction \(incidental scroll, e\.g\. background body\)\./,
    );
  });

  it("SCROLL_VELOCITY_DEFAULTS: 7-entry table; Object.freeze + Readonly<Record<ElementClass, ScrollVelocityClassDefaults>>; scroll-container 2400 px/s mean + decay 2.0; input lowest 700 px/s + decay 6.0; button/link sharing 'Scrolling from a button surface is unusual but possible' framing", () => {
    expect(body).toMatch(
      /export const SCROLL_VELOCITY_DEFAULTS: Readonly<Record<ElementClass, ScrollVelocityClassDefaults>> =\s*\n?\s*Object\.freeze\(\{/,
    );
    expect(body).toMatch(
      /'scroll-container': \{\s*\n?\s*meanInitialVelocityPxPerSec: 2400,\s*\n?\s*initialVelocityJitter: 600,\s*\n?\s*meanDecayRate: 2\.0,\s*\n?\s*decayRateJitter: 0\.4,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /\/\/ Scrolling from a button surface is unusual but possible \(touchpad\s*\n?\s*\/\/ \/ inertial scroll origin happens to be over a button\)\. Conservative\s*\n?\s*\/\/ defaults — short, weak scroll\./,
    );
    expect(body).toMatch(
      /input: \{[\s\S]*?meanInitialVelocityPxPerSec: 700,[\s\S]*?meanDecayRate: 6\.0,/,
    );
  });

  it("Module constants: DEFAULT_TICK_INTERVAL_MS=16 ('60Hz, matching touch device rates' framing), REST_VELOCITY_THRESHOLD_PX_PER_SEC=5, MAX_DURATION_MS=5000 plus bounded cadence/velocity/decay envelope", () => {
    expect(body).toMatch(
      /\/\*\* Default tick interval \(ms\)\. 16ms ≈ 60 Hz, matching touch device rates\. \*\/\s*\n?\s*const DEFAULT_TICK_INTERVAL_MS = 16;/,
    );
    expect(body).toMatch(
      /\/\*\* Velocity below this threshold \(px\/s\) terminates the scroll\. \*\/\s*\n?\s*const REST_VELOCITY_THRESHOLD_PX_PER_SEC = 5;/,
    );
    expect(body).toMatch(
      /\/\*\* Hard cap on duration to bound test runtime\. ~5 seconds is generous\. \*\/\s*\n?\s*const MAX_DURATION_MS = 5000;/,
    );
    expect(body).toMatch(/^const MAX_TICK_INTERVAL_MS = 100;$/m);
    expect(body).toMatch(/^const MAX_INITIAL_VELOCITY_PX_PER_SEC = 12_000;$/m);
    expect(body).toMatch(/^const MIN_DECAY_RATE = 0\.1;$/m);
    expect(body).toMatch(/^const MAX_DECAY_RATE = 20;$/m);
  });

  it('generateScrollVelocityProfile framing pinned: decay sampled until rest; overrides unable to settle in MAX_DURATION_MS reject without a synthetic final tick; direction and total-distance conventions pinned', () => {
    expect(body).toMatch(
      /\*\s*v\(t\) = v0 \* exp\(-decayRate \* t\)\s*\n?\s*\*\s*sampled at `tickIntervalMs` intervals until velocity drops below the\s*\n?\s*\*\s*rest threshold \(5 px\/s\)\. Explicit overrides that cannot settle inside\s*\n?\s*\*\s*`MAX_DURATION_MS` are rejected instead of compressing unseen motion into a\s*\n?\s*\*\s*synthetic final tick\./,
    );
    expect(body).toMatch(
      /\* Direction sign convention:\s*\n?\s*\*\s*- 'down' \/ 'right' → positive `deltaPx`\s*\n?\s*\*\s*- 'up' \/ 'left'\s*→ negative `deltaPx`\s*\n?\s*\*\s*\n?\s*\* `totalDistancePx` is always positive \(absolute distance scrolled\)\./,
    );
    expect(body).toMatch(
      /const sign = opts\.direction === 'up' \|\| opts\.direction === 'left' \? -1 : 1;/,
    );
  });

  it("Per-tick deltaPx integration framing pinned: '∫ v(τ)dτ from t to t+tickSec = (v0 / decayRate) * (exp(-decay * t) - exp(-decay * (t+tickSec)))' with positive decay guaranteed at the boundary", () => {
    expect(body).toMatch(
      /\/\/ Pixels scrolled this tick: ∫ v\(τ\)dτ from t to t\+tickSec\s*\n?\s*\/\/\s*= \(v0 \/ decayRate\) \* \(exp\(-decay \* t\) - exp\(-decay \* \(t\+tickSec\)\)\)/,
    );
    expect(body).toMatch(
      /const deltaPxAbs =\s*\n?\s*\(v0 \/ decayRate\) \*\s*\n?\s*\(Math\.exp\(-decayRate \* tSec\) - Math\.exp\(-decayRate \* \(tSec \+ tickSec\)\)\);/,
    );
    expect(body).toMatch(
      /if \(opts\.decayRate < MIN_DECAY_RATE \|\| opts\.decayRate > MAX_DECAY_RATE\) \{/,
    );
  });

  it("Rest-velocity termination guard: 'if velocityPxPerSec < REST_VELOCITY_THRESHOLD_PX_PER_SEC && tMs > 0 break' — bounds profile length when velocity dies below 5 px/s; tickIntervalMs > 0 guard with throw on <= 0", () => {
    expect(body).toMatch(
      /if \(tickIntervalMs <= 0\) \{\s*\n?\s*throw new Error\(\s*\n?\s*`generateScrollVelocityProfile: tickIntervalMs must be > 0 \(got \$\{tickIntervalMs\}\)`,\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /if \(velocityPxPerSec < REST_VELOCITY_THRESHOLD_PX_PER_SEC && tMs > 0\) \{\s*\n?\s*break;\s*\n?\s*\}/,
    );
  });

  it('physical envelope fails closed before generation: max cadence/velocity/decay plus cadence-aligned settle check; no synthetic tail append', () => {
    expect(body).toMatch(/if \(tickIntervalMs > MAX_TICK_INTERVAL_MS\) \{/);
    expect(body).toMatch(
      /if \(opts\.initialVelocityPxPerSec > MAX_INITIAL_VELOCITY_PX_PER_SEC\) \{/,
    );
    expect(body).toMatch(
      /if \(opts\.decayRate < MIN_DECAY_RATE \|\| opts\.decayRate > MAX_DECAY_RATE\) \{/,
    );
    expect(body).toMatch(
      /const lastSampleMs = Math\.floor\(MAX_DURATION_MS \/ tickIntervalMs\) \* tickIntervalMs;/,
    );
    expect(body).toMatch(/if \(velocityAtLastSample >= REST_VELOCITY_THRESHOLD_PX_PER_SEC\) \{/);
    expect(body).not.toMatch(/remainingDistanceAbs|settlingDeltaPx|velocityPxPerSec: 0/);
  });

  it('v0/decayRate jitter with bounded minimums: v0 = max(1, mean + uniformSigned*jitter); decayRate = max(0.1, mean + uniformSigned*jitter); defaultSeed = `scroll-v:${direction}:${elementClass}`', () => {
    expect(body).toMatch(
      /Math\.max\(\s*\n?\s*1,\s*\n?\s*defaults\.meanInitialVelocityPxPerSec \+ uniformSigned\(\) \* defaults\.initialVelocityJitter,\s*\n?\s*\)/,
    );
    expect(body).toMatch(
      /Math\.max\(0\.1, defaults\.meanDecayRate \+ uniformSigned\(\) \* defaults\.decayRateJitter\)/,
    );
    expect(body).toMatch(
      /function defaultSeed\(opts: GenerateScrollVelocityProfileOpts\): string \{\s*\n?\s*return `scroll-v:\$\{opts\.direction\}:\$\{opts\.elementClass\}`;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
