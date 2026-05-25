import { describe, expect, it } from 'vitest';
import {
  generateScrollVelocityProfile,
  MockBehaviouralSimulator,
  SCROLL_VELOCITY_DEFAULTS,
  type ElementClass,
} from '../src/index.js';

// V-530.B — scroll velocity profile invariants.
//
// Property-style: enumerate seeds, assert invariants for every output.

const ALL_CLASSES: readonly ElementClass[] = [
  'button',
  'link',
  'input',
  'image',
  'video',
  'scroll-container',
  'generic',
];

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

function seeds(count: number, label: string): readonly string[] {
  return Array.from({ length: count }, (_, i) => `${label}:${i}`);
}

describe('V-530.B scroll velocity defaults — invariants', () => {
  it('every element class has a registered scroll-velocity default', () => {
    for (const klass of ALL_CLASSES) {
      expect(SCROLL_VELOCITY_DEFAULTS[klass]).toBeDefined();
    }
  });

  it('every default declares strictly positive parameters', () => {
    for (const klass of ALL_CLASSES) {
      const d = SCROLL_VELOCITY_DEFAULTS[klass];
      expect(d.meanInitialVelocityPxPerSec).toBeGreaterThan(0);
      expect(d.initialVelocityJitter).toBeGreaterThanOrEqual(0);
      expect(d.meanDecayRate).toBeGreaterThan(0);
      expect(d.decayRateJitter).toBeGreaterThanOrEqual(0);
    }
  });

  it('scroll-container default has higher initial velocity than generic', () => {
    // Sanity: the class explicitly designed for scrolling produces stronger
    // flicks than a generic container.
    expect(
      SCROLL_VELOCITY_DEFAULTS['scroll-container'].meanInitialVelocityPxPerSec,
    ).toBeGreaterThan(SCROLL_VELOCITY_DEFAULTS.generic.meanInitialVelocityPxPerSec);
  });

  it('scroll-container default has lower decay rate than generic', () => {
    expect(SCROLL_VELOCITY_DEFAULTS['scroll-container'].meanDecayRate).toBeLessThan(
      SCROLL_VELOCITY_DEFAULTS.generic.meanDecayRate,
    );
  });
});

describe('V-530.B generateScrollVelocityProfile — properties', () => {
  it('is deterministic: identical inputs → identical profile', () => {
    for (const klass of ALL_CLASSES) {
      for (const direction of DIRECTIONS) {
        const a = generateScrollVelocityProfile({
          direction,
          elementClass: klass,
          seed: 'detX',
        });
        const b = generateScrollVelocityProfile({
          direction,
          elementClass: klass,
          seed: 'detX',
        });
        expect(a).toEqual(b);
      }
    }
  });

  it('different seeds produce different profiles', () => {
    for (const klass of ALL_CLASSES) {
      const a = generateScrollVelocityProfile({
        direction: 'down',
        elementClass: klass,
        seed: 'sA',
      });
      const b = generateScrollVelocityProfile({
        direction: 'down',
        elementClass: klass,
        seed: 'sB',
      });
      const allSame =
        a.initialVelocityPxPerSec === b.initialVelocityPxPerSec && a.decayRate === b.decayRate;
      expect(allSame).toBe(false);
    }
  });

  it('velocity is monotonically non-increasing across ticks (exponential decay)', () => {
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(32, `mono-${klass}`)) {
        const profile = generateScrollVelocityProfile({
          direction: 'down',
          elementClass: klass,
          seed,
        });
        for (let i = 1; i < profile.ticks.length; i += 1) {
          expect(profile.ticks[i].velocityPxPerSec).toBeLessThanOrEqual(
            profile.ticks[i - 1].velocityPxPerSec,
          );
        }
      }
    }
  });

  it('tick timestamps are strictly monotonically increasing', () => {
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(32, `time-${klass}`)) {
        const profile = generateScrollVelocityProfile({
          direction: 'down',
          elementClass: klass,
          seed,
        });
        for (let i = 1; i < profile.ticks.length; i += 1) {
          expect(profile.ticks[i].tMs).toBeGreaterThan(profile.ticks[i - 1].tMs);
        }
      }
    }
  });

  it('delta signs match direction across all classes + seeds', () => {
    for (const klass of ALL_CLASSES) {
      for (const direction of DIRECTIONS) {
        for (const seed of seeds(8, `sign-${klass}-${direction}`)) {
          const profile = generateScrollVelocityProfile({
            direction,
            elementClass: klass,
            seed,
          });
          const expectedSign = direction === 'up' || direction === 'left' ? -1 : 1;
          for (const tick of profile.ticks) {
            // Allow tick.deltaPx === 0 at terminal tick (velocity below threshold)
            if (tick.deltaPx !== 0) {
              expect(Math.sign(tick.deltaPx)).toBe(expectedSign);
            }
          }
        }
      }
    }
  });

  it('cumulativePx matches running sum of deltaPx exactly', () => {
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(16, `cumsum-${klass}`)) {
        const profile = generateScrollVelocityProfile({
          direction: 'down',
          elementClass: klass,
          seed,
        });
        let runningSum = 0;
        for (const tick of profile.ticks) {
          runningSum += tick.deltaPx;
          expect(tick.cumulativePx).toBeCloseTo(runningSum, 9);
        }
      }
    }
  });

  it('totalDistancePx equals |cumulativePx at last tick|', () => {
    for (const klass of ALL_CLASSES) {
      for (const direction of DIRECTIONS) {
        const profile = generateScrollVelocityProfile({
          direction,
          elementClass: klass,
          seed: 'total-distance',
        });
        const lastCum = profile.ticks[profile.ticks.length - 1].cumulativePx;
        expect(profile.totalDistancePx).toBeCloseTo(Math.abs(lastCum), 9);
      }
    }
  });

  it('durationMs equals the last tick tMs', () => {
    for (const klass of ALL_CLASSES) {
      const profile = generateScrollVelocityProfile({
        direction: 'down',
        elementClass: klass,
        seed: 'duration',
      });
      expect(profile.durationMs).toBe(profile.ticks[profile.ticks.length - 1].tMs);
    }
  });

  it('initial velocity stays within mean ± jitter of class default (no opts override)', () => {
    for (const klass of ALL_CLASSES) {
      const d = SCROLL_VELOCITY_DEFAULTS[klass];
      const lo = Math.max(1, d.meanInitialVelocityPxPerSec - d.initialVelocityJitter);
      const hi = d.meanInitialVelocityPxPerSec + d.initialVelocityJitter;
      for (const seed of seeds(32, `iv-${klass}`)) {
        const profile = generateScrollVelocityProfile({
          direction: 'down',
          elementClass: klass,
          seed,
        });
        expect(profile.initialVelocityPxPerSec).toBeGreaterThanOrEqual(lo);
        expect(profile.initialVelocityPxPerSec).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('explicit initialVelocity + decayRate override class defaults', () => {
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      initialVelocityPxPerSec: 1000,
      decayRate: 2.5,
      seed: 'override',
    });
    expect(profile.initialVelocityPxPerSec).toBe(1000);
    expect(profile.decayRate).toBe(2.5);
  });

  it('scroll-container average duration exceeds button average duration (class differentiation)', () => {
    const N = 100;
    let scrollDurSum = 0;
    let buttonDurSum = 0;
    for (let i = 0; i < N; i += 1) {
      const seed = `dur-${i}`;
      scrollDurSum += generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        seed,
      }).durationMs;
      buttonDurSum += generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'button',
        seed,
      }).durationMs;
    }
    expect(scrollDurSum / N).toBeGreaterThan(buttonDurSum / N);
  });

  it('rejects tickIntervalMs <= 0', () => {
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        tickIntervalMs: 0,
      }),
    ).toThrow(/tickIntervalMs/);
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        tickIntervalMs: -10,
      }),
    ).toThrow(/tickIntervalMs/);
  });

  it('rejects a non-positive initialVelocityPxPerSec override', () => {
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        initialVelocityPxPerSec: 0,
      }),
    ).toThrow(/initialVelocityPxPerSec must be > 0/);
  });

  it('rejects a negative decayRate override (would accelerate, not decay)', () => {
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        decayRate: -1,
      }),
    ).toThrow(/decayRate must be >= 0/);
  });

  it('allows decayRate 0 (constant-velocity scroll, no decay)', () => {
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      initialVelocityPxPerSec: 1000,
      decayRate: 0,
    });
    expect(profile.decayRate).toBe(0);
    expect(profile.ticks.length).toBeGreaterThan(0);
  });

  it('regression pin — deterministic shape for fixed inputs', () => {
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      initialVelocityPxPerSec: 2000,
      decayRate: 2.0,
      seed: 'regression-v530b',
    });
    expect(profile.direction).toBe('down');
    expect(profile.initialVelocityPxPerSec).toBe(2000);
    expect(profile.decayRate).toBe(2.0);
    expect(profile.ticks.length).toBeGreaterThan(0);
    expect(profile.ticks[0].tMs).toBe(0);
    // Tick 0 velocity should equal initial velocity exactly.
    expect(profile.ticks[0].velocityPxPerSec).toBe(2000);
    // Cumulative at last tick should be close to the analytic asymptote
    // v0 / decay for an indefinite decay (= 1000 px) — but truncated at
    // the rest threshold.
    expect(profile.totalDistancePx).toBeGreaterThan(900);
    expect(profile.totalDistancePx).toBeLessThan(1000);
  });
});

describe('MockBehaviouralSimulator — scroll velocity surface', () => {
  it('exposes generateScrollVelocityProfile across all element classes', () => {
    const sim = new MockBehaviouralSimulator();
    for (const klass of ALL_CLASSES) {
      const profile = sim.generateScrollVelocityProfile({
        direction: 'down',
        elementClass: klass,
        seed: 'mock-surface',
      });
      expect(profile.ticks.length).toBeGreaterThan(0);
    }
  });

  it('mock parity: simulator surface output equals standalone generator output', () => {
    const sim = new MockBehaviouralSimulator();
    const opts = {
      direction: 'down' as const,
      elementClass: 'scroll-container' as const,
      seed: 'parity',
    };
    expect(sim.generateScrollVelocityProfile(opts)).toEqual(generateScrollVelocityProfile(opts));
  });
});
