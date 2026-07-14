// W597.B — drift guard for packages/behavioural-simulation/src/idle.ts.
// V-530.D idle-period jitter generator.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/idle.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W597.B packages/behavioural-simulation/src/idle.ts content parity', () => {
  const body = read(LIB);

  it('V-530.D framing + detection-vendors-fingerprint-on-absence-of-pauses + 2 generators (generateIdlePeriod + generateIdleSequence) + multi-touch deferral rationale pinned', () => {
    expect(body).toMatch(/\/\/ V-530\.D — idle-period jitter generator\./);
    expect(body).toMatch(/\/\/ Final sub-slice of the V-530 series\./);
    expect(body).toMatch(/\/\/ a synthetic persona pauses without interaction — reading a page,/);
    expect(body).toMatch(
      /\/\/ Detection vendors fingerprint sessions on the absence of these pauses/,
    );
    expect(body).toMatch(/\/\/ as much as on the presence of taps \+ scrolls; a session that/);
    expect(body).toMatch(/\/\/ transitions cap-to-cap with zero idle time is the most-obvious bot/);
    expect(body).toMatch(/\/\/ pattern\./);
    expect(body).toMatch(/\/\/\s+- generateIdlePeriod — a single bounded idle interval/);
    expect(body).toMatch(/\/\/\s+- generateIdleSequence — N idle periods interleaved/);
    expect(body).toMatch(/\/\/ Multi-touch gesture sequencing \(the other half of V-530\.D's/);
    expect(body).toMatch(/\/\/ original scope\) is deferred/);
    expect(body).toMatch(/This module covers the idle half\./);
  });

  it('IdlePeriod + IdleClassDefaults + IDLE_DEFAULTS 4 classes (reading + thinking + distracted + transition) with mean/jitter durations + refocus probability + micro-movement magnitude pinned', () => {
    expect(body).toMatch(/^export interface IdlePeriod \{$/m);
    expect(body).toMatch(/microMovements: ReadonlyArray<\{/);
    expect(body).toMatch(/refocusAt: number \| null;/);
    expect(body).toMatch(/^export interface IdleClassDefaults \{$/m);
    expect(body).toMatch(/meanDurationMs: number;/);
    expect(body).toMatch(/durationJitterMs: number;/);
    expect(body).toMatch(/meanMicroMovementCount: number;/);
    expect(body).toMatch(/refocusProbability: number;/);
    expect(body).toMatch(/microMovementMagnitudePx: number;/);
    expect(body).toMatch(/^export const IDLE_DEFAULTS = Object\.freeze\(\{$/m);
    expect(body).toMatch(/\/\/ Customer is reading; long idle, occasional cursor jitter, moderate/);
    expect(body).toMatch(/\/\/ chance of a re-focus pass\./);
    expect(body).toMatch(
      /reading: \{\s*\n\s*meanDurationMs: 8_500,\s*\n\s*durationJitterMs: 3_500,/,
    );
    expect(body).toMatch(/refocusProbability: 0\.5,/);
    expect(body).toMatch(/thinking: \{\s*\n\s*meanDurationMs: 3_200,/);
    expect(body).toMatch(/distracted: \{\s*\n\s*meanDurationMs: 2_100,/);
    expect(body).toMatch(/refocusProbability: 0\.85,/);
    expect(body).toMatch(
      /transition: \{\s*\n\s*meanDurationMs: 450,\s*\n\s*durationJitterMs: 250,/,
    );
    expect(body).toMatch(/\} satisfies Record<IdleClass, IdleClassDefaults>\);/);
    expect(body).toMatch(
      /^export type IdleClass = 'reading' \| 'thinking' \| 'distracted' \| 'transition';$/m,
    );
  });

  it('generateIdlePeriod: explicit-durationMs-override OR class-jittered triangular (min 50ms clamp) + Poisson-ish microCount + evenly-distributed micro tMs with timeJitter + refocus second-half-biased (halfMark=0.55) pinned', () => {
    expect(body).toMatch(
      /export function generateIdlePeriod\(opts: GenerateIdlePeriodOpts\): IdlePeriod \{/,
    );
    expect(body).toMatch(/const defaults = IDLE_DEFAULTS\[opts\.idleClass\];/);
    expect(body).toMatch(/if \(opts\.durationMs !== undefined\) \{/);
    expect(body).toMatch(/requireFinite\('generateIdlePeriod: durationMs', opts\.durationMs\);/);
    expect(body).toMatch(/durationMs = opts\.durationMs;/);
    // Override-validation guard: non-positive explicit duration bypasses
    // the 50ms-min clamp, so it throws (mirrors the scroll-override guard).
    expect(body).toMatch(/if \(opts\.durationMs <= 0\) \{/);
    expect(body).toMatch(/durationMs must be > 0 when set \(got \$\{opts\.durationMs\}\)/);
    expect(body).toMatch(/\/\/ Triangular-style jitter around the class mean: rng\(\) in \[0,1\)/);
    expect(body).toMatch(/\/\/ mapped to ±durationJitterMs\. Clamp at 50ms minimum so callers/);
    expect(body).toMatch(/\/\/ never get a degenerate zero-length idle when they ask for one\./);
    expect(body).toMatch(
      /durationMs = Math\.max\(50, Math\.round\(defaults\.meanDurationMs \+ jitter\)\);/,
    );
    expect(body).toMatch(
      /\/\/ Micro-movement count is Poisson-ish: round\(mean \+ small jitter\)\./,
    );
    expect(body).toMatch(/\/\/ Distribute micro-movements roughly evenly across the idle, with/);
    expect(body).toMatch(/\/\/ per-event time jitter so they don't fall on perfect intervals\./);
    expect(body).toMatch(/\/\/ Re-focus tends to land in the second half of the idle — the/);
    expect(body).toMatch(/\/\/ persona "comes back" after the wandering attention\./);
    expect(body).toMatch(/const halfMark = durationMs \* 0\.55;/);
    expect(body).toMatch(/refocusAt = Math\.round\(halfMark \+ rng\(\) \* tail\);/);
  });

  it('generateIdleSequence: chains N idle periods with per-entry seed `${seed}#${i}` + cumulative offsetMs cursor + returns totalDurationMs envelope pinned', () => {
    expect(body).toMatch(/\* Generate an ordered chain of idle periods\. Each entry's `offsetMs`/);
    expect(body).toMatch(/\* is the cumulative start offset from the sequence root, so callers/);
    expect(body).toMatch(/\* can replay the chain back-to-back into a session timeline without/);
    expect(body).toMatch(/\* recomputing offsets\./);
    expect(body).toMatch(
      /export function generateIdleSequence\(opts: GenerateIdleSequenceOpts\): IdleSequence \{/,
    );
    expect(body).toMatch(/\/\/ Per-entry seed combines the sequence seed with the index — keeps/);
    expect(body).toMatch(/\/\/ the chain deterministic but each idle gets its own RNG stream\./);
    expect(body).toMatch(/const entrySeed = `\$\{seed\}#\$\{i\.toString\(\)\}`;/);
    expect(body).toMatch(/cursor \+= idle\.durationMs;/);
    expect(body).toMatch(/return \{ entries, totalDurationMs: cursor, seed \};/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
