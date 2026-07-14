import { describe, expect, it } from 'vitest';
import {
  generateIdlePeriod,
  generateIdleSequence,
  IDLE_DEFAULTS,
  type IdleClass,
} from '../src/idle.js';

describe('V-530.D generateIdlePeriod — class defaults', () => {
  const classes: readonly IdleClass[] = ['reading', 'thinking', 'distracted', 'transition'];

  for (const cls of classes) {
    it(`${cls}: returns a duration within ±2× the class jitter`, () => {
      const idle = generateIdlePeriod({ idleClass: cls, seed: 'fixed-seed' });
      const defaults = IDLE_DEFAULTS[cls];
      expect(idle.durationMs).toBeGreaterThanOrEqual(50);
      expect(idle.durationMs).toBeLessThanOrEqual(
        defaults.meanDurationMs + defaults.durationJitterMs * 2,
      );
    });

    it(`${cls}: microMovement timestamps are within [0, durationMs]`, () => {
      const idle = generateIdlePeriod({ idleClass: cls, seed: 'fixed-seed' });
      for (const mm of idle.microMovements) {
        expect(mm.tMs).toBeGreaterThanOrEqual(0);
        expect(mm.tMs).toBeLessThanOrEqual(idle.durationMs);
      }
    });

    it(`${cls}: microMovement magnitudes respect the class default`, () => {
      const idle = generateIdlePeriod({ idleClass: cls, seed: 'fixed-seed' });
      const max = IDLE_DEFAULTS[cls].microMovementMagnitudePx;
      for (const mm of idle.microMovements) {
        expect(Math.abs(mm.dxPx)).toBeLessThanOrEqual(max);
        expect(Math.abs(mm.dyPx)).toBeLessThanOrEqual(max);
      }
    });

    it(`${cls}: refocusAt (when non-null) lies within (0, durationMs]`, () => {
      const idle = generateIdlePeriod({ idleClass: cls, seed: 'fixed-seed' });
      if (idle.refocusAt !== null) {
        expect(idle.refocusAt).toBeGreaterThan(0);
        expect(idle.refocusAt).toBeLessThanOrEqual(idle.durationMs);
      }
    });
  }
});

describe('V-530.D generateIdlePeriod — seeded determinism', () => {
  it('same (idleClass, seed) → identical output', () => {
    const a = generateIdlePeriod({ idleClass: 'reading', seed: 's1' });
    const b = generateIdlePeriod({ idleClass: 'reading', seed: 's1' });
    expect(a).toEqual(b);
  });

  it('different seeds → different outputs (very likely)', () => {
    const a = generateIdlePeriod({ idleClass: 'reading', seed: 's1' });
    const b = generateIdlePeriod({ idleClass: 'reading', seed: 's2' });
    expect(a).not.toEqual(b);
  });

  it('explicit durationMs overrides the class default', () => {
    const idle = generateIdlePeriod({ idleClass: 'reading', durationMs: 1234, seed: 's' });
    expect(idle.durationMs).toBe(1234);
  });

  it('rejects a non-positive durationMs override (bypasses the default 50ms-min clamp)', () => {
    expect(() => generateIdlePeriod({ idleClass: 'reading', durationMs: 0, seed: 's' })).toThrow(
      /durationMs must be > 0/,
    );
    expect(() => generateIdlePeriod({ idleClass: 'reading', durationMs: -100, seed: 's' })).toThrow(
      /durationMs must be > 0/,
    );
  });

  it('rejects non-finite durationMs overrides', () => {
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        generateIdlePeriod({ idleClass: 'reading', durationMs, seed: 'non-finite' }),
      ).toThrow(/durationMs must be finite/);
    }
  });
});

describe('V-530.D generateIdleSequence', () => {
  it('returns one entry per class', () => {
    const seq = generateIdleSequence({
      classes: ['reading', 'thinking', 'transition'],
      seed: 'seq-1',
    });
    expect(seq.entries).toHaveLength(3);
    expect(seq.entries.map((e) => e.idleClass)).toEqual(['reading', 'thinking', 'transition']);
  });

  it('offset is cumulative across entries', () => {
    const seq = generateIdleSequence({
      classes: ['transition', 'transition', 'transition'],
      seed: 'cumulative',
    });
    expect(seq.entries[0]?.offsetMs).toBe(0);
    expect(seq.entries[1]?.offsetMs).toBe(seq.entries[0]?.idle.durationMs ?? 0);
    expect(seq.entries[2]?.offsetMs).toBe(
      (seq.entries[0]?.idle.durationMs ?? 0) + (seq.entries[1]?.idle.durationMs ?? 0),
    );
  });

  it('totalDurationMs matches sum of entry durations', () => {
    const seq = generateIdleSequence({
      classes: ['reading', 'thinking'],
      seed: 's',
    });
    const sum = seq.entries.reduce((acc, e) => acc + e.idle.durationMs, 0);
    expect(seq.totalDurationMs).toBe(sum);
  });

  it('empty classes array → empty sequence with totalDurationMs 0', () => {
    const seq = generateIdleSequence({ classes: [], seed: 's' });
    expect(seq.entries).toHaveLength(0);
    expect(seq.totalDurationMs).toBe(0);
  });

  it('seeded determinism: same input → identical output', () => {
    const a = generateIdleSequence({ classes: ['reading', 'thinking'], seed: 'fixed' });
    const b = generateIdleSequence({ classes: ['reading', 'thinking'], seed: 'fixed' });
    expect(a).toEqual(b);
  });

  it('each per-entry idle is itself reproducible', () => {
    const seq1 = generateIdleSequence({ classes: ['reading', 'reading'], seed: 'seqseed' });
    const seq2 = generateIdleSequence({ classes: ['reading', 'reading'], seed: 'seqseed' });
    expect(seq1.entries[0]?.idle).toEqual(seq2.entries[0]?.idle);
    expect(seq1.entries[1]?.idle).toEqual(seq2.entries[1]?.idle);
  });
});
