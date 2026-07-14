// W596.B — drift guard for packages/behavioural-simulation/src/scroll.ts.
// V-530.B scroll velocity profiles with exponential decay.

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

describe('W596.B packages/behavioural-simulation/src/scroll.ts content parity', () => {
  const body = read(LIB);

  it('V-530.B framing + finger-flick + exponential-decay model + distinct-from-mock-generateScrollPattern + V-530.C/.D deferrals pinned', () => {
    expect(body).toMatch(/\/\/ V-530\.B — scroll velocity profiles with exponential decay\./);
    expect(body).toMatch(/\/\/ Second module of the Phase 3 real implementation, after V-530\.A/);
    expect(body).toMatch(/\/\/ \(touch event distributions\)\./);
    expect(body).toMatch(
      /\/\/ flick produces on a scroll container: initial velocity from the flick,/,
    );
    expect(body).toMatch(/\/\/ then exponential decay as friction slows the scroll\./);
    expect(body).toMatch(/\/\/ Distinct from the existing `generateScrollPattern` mock surface/);
    expect(body).toMatch(
      /\/\/ \(constant per-tick deltas\) — this module produces realistic decaying/,
    );
    expect(body).toMatch(/\/\/ per-tick deltas\./);
  });

  it('ScrollVelocityTick + ScrollVelocityProfile + ScrollVelocityClassDefaults types pinned + seven-class defaults + bounded cadence/velocity/decay constants', () => {
    expect(body).toMatch(/\/\*\* A single per-tick sample of a decaying scroll\. \*\//);
    expect(body).toMatch(/^export interface ScrollVelocityTick \{$/m);
    expect(body).toMatch(/velocityPxPerSec: number;/);
    expect(body).toMatch(
      /\/\*\* Pixels scrolled during this tick \(signed: \+ = forward, - = reverse\)\. \*\//,
    );
    expect(body).toMatch(/cumulativePx: number;/);
    expect(body).toMatch(/^export interface ScrollVelocityProfile \{$/m);
    expect(body).toMatch(
      /\/\*\* Exponential decay rate \(1 \/ seconds\)\. Higher = faster decay\. \*\//,
    );
    expect(body).toMatch(/decayRate: number;/);
    expect(body).toMatch(/^export interface ScrollVelocityClassDefaults \{$/m);
    expect(body).toMatch(/meanInitialVelocityPxPerSec: number;/);
    expect(body).toMatch(/initialVelocityJitter: number;/);
    expect(body).toMatch(/meanDecayRate: number;/);
    expect(body).toMatch(/decayRateJitter: number;/);
    expect(body).toMatch(
      /export const SCROLL_VELOCITY_DEFAULTS: Readonly<Record<ElementClass, ScrollVelocityClassDefaults>> =\s*\n\s*Object\.freeze\(\{/,
    );
    expect(body).toMatch(/'scroll-container': \{\s*\n\s*meanInitialVelocityPxPerSec: 2400,/);
    expect(body).toMatch(/generic: \{\s*\n\s*meanInitialVelocityPxPerSec: 1500,/);
    expect(body).toMatch(/image: \{\s*\n\s*meanInitialVelocityPxPerSec: 1800,/);
    expect(body).toMatch(/video: \{\s*\n\s*meanInitialVelocityPxPerSec: 1200,/);
    expect(body).toMatch(/button: \{/);
    expect(body).toMatch(/\/\/ Scrolling from a button surface is unusual but possible/);
    expect(body).toMatch(/link: \{\s*\n\s*meanInitialVelocityPxPerSec: 900,/);
    expect(body).toMatch(/input: \{/);
    expect(body).toMatch(/\/\/ Scrolling within an input rarely happens; default small\./);
    expect(body).toMatch(/^const DEFAULT_TICK_INTERVAL_MS = 16;$/m);
    expect(body).toMatch(
      /\/\*\* Default tick interval \(ms\)\. 16ms ≈ 60 Hz, matching touch device rates\. \*\//,
    );
    expect(body).toMatch(/^const REST_VELOCITY_THRESHOLD_PX_PER_SEC = 5;$/m);
    expect(body).toMatch(/^const MAX_DURATION_MS = 5000;$/m);
    expect(body).toMatch(/^const MAX_TICK_INTERVAL_MS = 100;$/m);
    expect(body).toMatch(/^const MAX_INITIAL_VELOCITY_PX_PER_SEC = 12_000;$/m);
    expect(body).toMatch(/^const MIN_DECAY_RATE = 0\.1;$/m);
    expect(body).toMatch(/^const MAX_DECAY_RATE = 20;$/m);
  });

  it('generateScrollVelocityProfile: finite physical envelope + cadence-aligned settle guard + analytic delta + rest-threshold break', () => {
    expect(body).toMatch(/\* Generate a scroll velocity profile with exponential decay\./);
    expect(body).toMatch(/\* Pure \+ deterministic given \(direction, elementClass, seed\)\./);
    expect(body).toMatch(/\*\s+v\(t\) = v0 \* exp\(-decayRate \* t\)/);
    expect(body).toMatch(/\* sampled at `tickIntervalMs` intervals until velocity drops below the/);
    expect(body).toMatch(
      /\* rest threshold \(5 px\/s\)\. Explicit overrides that cannot settle inside/,
    );
    expect(body).toMatch(
      /\* `MAX_DURATION_MS` are rejected instead of compressing unseen motion into a/,
    );
    expect(body).toMatch(/\* synthetic final tick\./);
    expect(body).toMatch(/\* Direction sign convention:/);
    expect(body).toMatch(/\*\s+- 'down' \/ 'right' → positive `deltaPx`/);
    expect(body).toMatch(/\*\s+- 'up' \/ 'left'\s+→ negative `deltaPx`/);
    expect(body).toMatch(
      /\* `totalDistancePx` is always positive \(absolute distance scrolled\)\./,
    );
    expect(body).toMatch(
      /export function generateScrollVelocityProfile\(\s*\n\s*opts: GenerateScrollVelocityProfileOpts,\s*\n\): ScrollVelocityProfile \{/,
    );
    expect(body).toMatch(
      /requireFinite\('generateScrollVelocityProfile: tickIntervalMs', tickIntervalMs\);/,
    );
    expect(body).toMatch(
      /requireFinite\(\s*'generateScrollVelocityProfile: initialVelocityPxPerSec'/,
    );
    expect(body).toMatch(
      /requireFinite\('generateScrollVelocityProfile: decayRate', opts\.decayRate\);/,
    );
    expect(body).toMatch(/if \(tickIntervalMs <= 0\) \{\s*\n\s*throw new Error\(/);
    expect(body).toMatch(/`generateScrollVelocityProfile: tickIntervalMs must be > 0/);
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
    expect(body).toMatch(
      /const sign = opts\.direction === 'up' \|\| opts\.direction === 'left' \? -1 : 1;/,
    );
    expect(body).toMatch(/\/\/ Pixels scrolled this tick: ∫ v\(τ\)dτ from t to t\+tickSec/);
    expect(body).toMatch(
      /\/\/\s+= \(v0 \/ decayRate\) \* \(exp\(-decay \* t\) - exp\(-decay \* \(t\+tickSec\)\)\)/,
    );
    expect(body).toMatch(
      /if \(velocityPxPerSec < REST_VELOCITY_THRESHOLD_PX_PER_SEC && tMs > 0\) \{\s*\n\s*break;\s*\n\s*\}/,
    );
    expect(body).toMatch(/totalDistancePx: Math\.abs\(cumulativePx\),/);
    expect(body).not.toMatch(/remainingDistanceAbs|settlingDeltaPx|velocityPxPerSec: 0/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
