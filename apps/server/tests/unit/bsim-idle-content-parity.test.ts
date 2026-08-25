// W453.B — drift guard for packages/behavioural-simulation/src/idle.ts.
// V-530.D idle-period jitter generator. Drift here either drops the
// 50ms minimum-duration clamp (caller asks for a zero-length idle
// and gets a degenerate zero-duration period that breaks downstream
// timeline math) or loses the second-half refocus bias (refocus
// lands uniformly, no longer modeling the persona 'coming back' from
// wandering attention — detection vendors flag uniform refocus
// timing as bot-shaped).
//
//   • V-530.D framing pinned + 'detection vendors fingerprint
//     sessions on the absence of these pauses as much as on the
//     presence of taps + scrolls; a session that transitions cap-
//     to-cap with zero idle time is the most-obvious bot pattern.'
//   • Multi-touch deferral framing pinned.
//   • mulberry32 + FNV-1a seeding-shape-consistency rationale.
//   • IdlePeriod: 4-field (durationMs + microMovements + refocusAt
//     nullable + seed); microMovements ReadonlyArray<{tMs+dxPx+dyPx}>.
//   • IdleClassDefaults: 5-field; IDLE_DEFAULTS 4-class table
//     (reading 8500ms + thinking 3200ms + distracted 2100ms +
//     transition 450ms) with class-typical framing comments pinned.
//   • IdleClass union: reading|thinking|distracted|transition.
//   • generateIdlePeriod: 50ms minimum clamp; explicit durationMs
//     override branch; microCount Poisson-ish round(mean + small
//     jitter); refocus < refocusProbability → halfMark = duration *
//     0.55 + tail; refocus bias second-half rationale pinned.
//   • IdleSequenceEntry: idle + idleClass + cumulative offsetMs.
//   • IdleSequence: entries + totalDurationMs + seed.
//   • generateIdleSequence: per-entry-seed = `${seed}#${i}` deterministic
//     chain with offset accumulation; defaultSequenceSeed format.

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

describe('W453.B packages/behavioural-simulation/src/idle.ts content parity', () => {
  const body = read(LIB);

  it("V-530.D framing pinned: 'V-530.D — idle-period jitter generator.' + 'detection vendors fingerprint sessions on the absence of these pauses as much as on the presence of taps + scrolls; a session that transitions cap-to-cap with zero idle time is the most-obvious bot pattern.'", () => {
    expect(body).toMatch(/\/\/ V-530\.D — idle-period jitter generator\./);
    expect(body).toMatch(
      /\/\/ Final sub-slice of the V-530 series\. Models the "between" time when\s*\/\/ a synthetic persona pauses without interaction — reading a page,\s*\/\/ thinking about a form field, scrolling slowly to take in content\./,
    );
    expect(body).toMatch(
      /\/\/ Detection vendors fingerprint sessions on the absence of these pauses\s*\/\/ as much as on the presence of taps \+ scrolls; a session that\s*\/\/ transitions cap-to-cap with zero idle time is the most-obvious bot\s*\/\/ pattern\./,
    );
  });

  it("Two-generators framing pinned: 'generateIdlePeriod — a single bounded idle interval with an internal jitter pattern' + 'generateIdleSequence — N idle periods interleaved with synthetic active markers, suitable for stitching between meaningful interactions in a recipe runner.'", () => {
    expect(body).toMatch(
      /\/\/\s*- generateIdlePeriod — a single bounded idle interval with an\s*\/\/\s*internal jitter pattern \(micro-movements, occasional re-focus\)\.\s*\/\/\s*- generateIdleSequence — N idle periods interleaved with synthetic\s*\/\/\s*"active" markers, suitable for stitching between meaningful\s*\/\/\s*interactions in a recipe runner\./,
    );
  });

  it("multi-touch deferral framing pinned: 'Multi-touch gesture sequencing (the other half of V-530.D's original scope) is deferred: it's a substantially different model (per-finger track interleaving with collision avoidance) and belongs in a separate slice. This module covers the idle half.'", () => {
    expect(body).toMatch(
      /\/\/ Multi-touch gesture sequencing \(the other half of V-530\.D's\s*\/\/ original scope\) is deferred: it's a substantially different model\s*\/\/ \(per-finger track interleaving with collision avoidance\) and\s*\/\/ belongs in a separate slice\. This module covers the idle half\./,
    );
  });

  it("Seeding-shape-consistency framing pinned: 'The PRNG / hash helpers match touch.ts / scroll.ts / dwell.ts (mulberry32 + FNV-1a) — keeping seeding shape consistent across the package means the same string seed produces the same shape regardless of which generator's caller wires it through.'", () => {
    expect(body).toMatch(
      /\/\/ Like the rest of the package, outputs are deterministic given a\s*\/\/ seed\. The PRNG \/ hash helpers match touch\.ts \/ scroll\.ts \/ dwell\.ts\s*\/\/ \(mulberry32 \+ FNV-1a\) — keeping seeding shape consistent across\s*\/\/ the package means the same string seed produces the same shape\s*\/\/ regardless of which generator's caller wires it through\./,
    );
  });

  it("IdlePeriod: 4-field; microMovements ReadonlyArray<{tMs+dxPx+dyPx}>; refocusAt nullable with 'Null when the idle stays uninterrupted' framing pinned", () => {
    expect(body).toMatch(
      /export interface IdlePeriod \{[\s\S]*?durationMs: number;[\s\S]*?microMovements: ReadonlyArray<\{\s*tMs: number;\s*dxPx: number;\s*dyPx: number;\s*\}>;[\s\S]*?\/\*\*\s*\*\s*Timestamp of a re-focus event during the idle \(ms since idle-start\)\.\s*\*\s*Null when the idle stays uninterrupted\.\s*\*\/\s*refocusAt: number \| null;[\s\S]*?seed: string;/,
    );
  });

  it("IDLE_DEFAULTS: 4-class table (reading 8500ms + 0.5 refocus, thinking 3200ms + 0.2 refocus, distracted 2100ms + 0.85 refocus, transition 450ms + 0.05 refocus); satisfies Record<IdleClass, IdleClassDefaults>; framing pinned on each class' persona model", () => {
    expect(body).toMatch(
      /reading: \{\s*meanDurationMs: 8_500,\s*durationJitterMs: 3_500,\s*meanMicroMovementCount: 4,\s*refocusProbability: 0\.5,\s*microMovementMagnitudePx: 6,\s*\},/,
    );
    expect(body).toMatch(
      /thinking: \{\s*meanDurationMs: 3_200,\s*durationJitterMs: 1_500,\s*meanMicroMovementCount: 1,\s*refocusProbability: 0\.2,\s*microMovementMagnitudePx: 4,\s*\},/,
    );
    expect(body).toMatch(
      /distracted: \{\s*meanDurationMs: 2_100,[\s\S]*?refocusProbability: 0\.85,[\s\S]*?microMovementMagnitudePx: 3,/,
    );
    expect(body).toMatch(
      /transition: \{\s*meanDurationMs: 450,[\s\S]*?refocusProbability: 0\.05,[\s\S]*?microMovementMagnitudePx: 2,/,
    );
    expect(body).toMatch(/\} satisfies Record<IdleClass, IdleClassDefaults>\);/);
    expect(body).toMatch(
      /export type IdleClass = 'reading' \| 'thinking' \| 'distracted' \| 'transition';/,
    );
  });

  it("generateIdlePeriod: 50ms minimum-duration clamp framing pinned 'Clamp at 50ms minimum so callers never get a degenerate zero-length idle when they ask for one.' + explicit durationMs override branch + triangular-style jitter rationale", () => {
    expect(body).toMatch(
      /\/\/ Triangular-style jitter around the class mean: rng\(\) in \[0,1\)\s*\/\/ mapped to ±durationJitterMs\. Clamp at 50ms minimum so callers\s*\/\/ never get a degenerate zero-length idle when they ask for one\./,
    );
    expect(body).toMatch(
      /durationMs = Math\.max\(50, Math\.round\(defaults\.meanDurationMs \+ jitter\)\);/,
    );
    expect(body).toMatch(/if \(opts\.durationMs !== undefined\) \{/);
    expect(body).toMatch(/durationMs = opts\.durationMs;/);
    // Override-validation guard (mirrors the scroll-override guard):
    // a non-positive explicit duration bypasses the 50ms-min clamp.
    expect(body).toMatch(/if \(opts\.durationMs <= 0\) \{/);
    expect(body).toMatch(/durationMs must be > 0 when set \(got \$\{opts\.durationMs\}\)/);
  });

  it('Micro-movement generation: Poisson-ish round(mean + small jitter); per-event time jitter prevents perfect-interval placement; even spread via (i+0.5)/microCount', () => {
    expect(body).toMatch(
      /\/\/ Micro-movement count is Poisson-ish: round\(mean \+ small jitter\)\./,
    );
    expect(body).toMatch(
      /const microCount = Math\.max\(0, Math\.round\(defaults\.meanMicroMovementCount \+ microJitter\)\);/,
    );
    expect(body).toMatch(
      /\/\/ Distribute micro-movements roughly evenly across the idle, with\s*\/\/ per-event time jitter so they don't fall on perfect intervals\./,
    );
    expect(body).toMatch(/const fraction = \(i \+ 0\.5\) \/ microCount;/);
  });

  it('Refocus generation framing pinned: \'Re-focus tends to land in the second half of the idle — the persona "comes back" after the wandering attention.\' + halfMark = duration * 0.55 + tail-uniform sampling', () => {
    expect(body).toMatch(
      /\/\/ Re-focus tends to land in the second half of the idle — the\s*\/\/ persona "comes back" after the wandering attention\.\s*const halfMark = durationMs \* 0\.55;\s*const tail = durationMs - halfMark;\s*refocusAt = Math\.round\(halfMark \+ rng\(\) \* tail\);/,
    );
  });

  it("IdleSequenceEntry: 3-field (idle + idleClass + offsetMs cumulative); IdleSequence: entries + totalDurationMs + seed; defaultSequenceSeed = `idle-seq:${classes.join(',')}`; generateIdleSequence per-entry-seed `${seed}#${i}` framing pinned 'keeps the chain deterministic but each idle gets its own RNG stream'", () => {
    expect(body).toMatch(
      /export interface IdleSequenceEntry \{[\s\S]*?idle: IdlePeriod;[\s\S]*?idleClass: IdleClass;[\s\S]*?\/\*\* Cumulative offset from sequence-start when this idle begins \(ms\)\. \*\/\s*offsetMs: number;/,
    );
    expect(body).toMatch(
      /export interface IdleSequence \{\s*entries: readonly IdleSequenceEntry\[\];[\s\S]*?totalDurationMs: number;[\s\S]*?seed: string;/,
    );
    expect(body).toMatch(
      /function defaultSequenceSeed\(opts: GenerateIdleSequenceOpts\): string \{\s*return `idle-seq:\$\{opts\.classes\.join\(','\)\}`;\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Per-entry seed combines the sequence seed with the index — keeps\s*\/\/ the chain deterministic but each idle gets its own RNG stream\.\s*const entrySeed = `\$\{seed\}#\$\{i\.toString\(\)\}`;/,
    );
  });

  it("generateIdleSequence: cursor accumulation; undefined-class skip via continue; defaultSeed='idle:${idleClass}:${durationMs??'auto'}'", () => {
    expect(body).toMatch(
      /if \(cls === undefined\) continue;[\s\S]*?const idle = generateIdlePeriod\(\{ idleClass: cls, seed: entrySeed \}\);\s*entries\.push\(\{ idle, idleClass: cls, offsetMs: cursor \}\);\s*cursor \+= idle\.durationMs;/,
    );
    expect(body).toMatch(
      /function defaultSeed\(opts: GenerateIdlePeriodOpts\): string \{\s*return `idle:\$\{opts\.idleClass\}:\$\{opts\.durationMs \?\? 'auto'\}`;\s*\}/,
    );
  });

  it('idle-sequence allocation is capped before default-seed construction', () => {
    expect(body).toContain('export const MAX_IDLE_SEQUENCE_ENTRIES = 1000;');
    expect(body).toContain('if (opts.classes.length > MAX_IDLE_SEQUENCE_ENTRIES) {');
    expect(body.indexOf('if (opts.classes.length > MAX_IDLE_SEQUENCE_ENTRIES) {')).toBeLessThan(
      body.indexOf('const seed = opts.seed ?? defaultSequenceSeed(opts);'),
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
