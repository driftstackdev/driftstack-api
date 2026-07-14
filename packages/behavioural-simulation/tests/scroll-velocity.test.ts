import { describe, expect, it } from 'vitest';
import {
  generateScrollVelocityProfile,
  MIN_TICK_INTERVAL_MS,
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

  it('rejects non-finite physical overrides', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        generateScrollVelocityProfile({
          direction: 'down',
          elementClass: 'scroll-container',
          tickIntervalMs: value,
        }),
      ).toThrow(/tickIntervalMs must be finite/);
      expect(() =>
        generateScrollVelocityProfile({
          direction: 'down',
          elementClass: 'scroll-container',
          initialVelocityPxPerSec: value,
        }),
      ).toThrow(/initialVelocityPxPerSec must be finite/);
      expect(() =>
        generateScrollVelocityProfile({
          direction: 'down',
          elementClass: 'scroll-container',
          decayRate: value,
        }),
      ).toThrow(/decayRate must be finite/);
    }
  });

  it('BSIM-1: rejects a tickIntervalMs below MIN_TICK_INTERVAL_MS (unbounded-loop OOM guard)', () => {
    // Exact repro values from the finding: 0.001 synchronously builds a
    // 3.1M-element array in 166ms; 0.00001 OOM-crashes the process. Both
    // must now be rejected with a clear validation error instead of running.
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        tickIntervalMs: 0.001,
      }),
    ).toThrow(/tickIntervalMs must be >= 1/);
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        tickIntervalMs: 0.00001,
      }),
    ).toThrow(/tickIntervalMs must be >= 1/);
  });

  it('BSIM-1: a value just below MIN_TICK_INTERVAL_MS is rejected, the floor itself is accepted', () => {
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        tickIntervalMs: MIN_TICK_INTERVAL_MS - 0.5,
      }),
    ).toThrow(/tickIntervalMs/);
    // The floor value itself is a valid, working tickIntervalMs (boundary
    // inclusive — the check is `< MIN_TICK_INTERVAL_MS`, not `<=`).
    expect(() =>
      generateScrollVelocityProfile({
        direction: 'down',
        elementClass: 'scroll-container',
        tickIntervalMs: MIN_TICK_INTERVAL_MS,
      }),
    ).not.toThrow();
  });

  it('BSIM-1: a reasonable tickIntervalMs (10ms, realistic scroll tick rate) still works exactly as before', () => {
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      tickIntervalMs: 10,
      initialVelocityPxPerSec: 1000,
      decayRate: 2,
      seed: 'bsim1-regression',
    });
    expect(profile.ticks.length).toBeGreaterThan(0);
    expect(profile.ticks[1]?.tMs).toBe(10);
  });

  it('BSIM-1: MIN_TICK_INTERVAL_MS stays small enough that MAX_DURATION_MS / floor is bounded to a sane tick count', () => {
    // Documents + pins the relationship the module-level self-check in
    // scroll.ts enforces, so a future change to either constant can't
    // silently reopen the unbounded-loop gap: the worst-case iteration
    // count must stay in the "a few thousand ticks" range, not millions.
    const MAX_DURATION_MS = 5000; // mirrors scroll.ts's private constant
    expect(MIN_TICK_INTERVAL_MS).toBeGreaterThanOrEqual(1);
    expect(MAX_DURATION_MS / MIN_TICK_INTERVAL_MS).toBeLessThanOrEqual(10_000);
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

  it('floors a decayRate 0 override to 0.1 (a real finger flick always decays)', () => {
    // decayRate 0 would be a non-decaying constant-velocity scroll — physically
    // impossible. The override is floored to 0.1 rather than throwing so existing
    // decayRate:0 callers keep working with a realistic decaying profile.
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      initialVelocityPxPerSec: 1000,
      decayRate: 0,
    });
    expect(profile.decayRate).toBe(0.1);
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

  it('settles to rest even when the MAX_DURATION cap truncates the decay (high v0, low decayRate)', () => {
    // A high v0 with a low/floored decayRate decays slowly enough that the
    // 5s MAX_DURATION cap would otherwise cut the profile while velocity is
    // still high (e.g. v0=8000, decayRate=0.1 is ~4800 px/s at 5s) — an
    // unnatural abrupt stop a detector can read. The settling phase MUST
    // bring the final tick to rest regardless of v0/decayRate.
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      initialVelocityPxPerSec: 8000,
      decayRate: 0.1,
    });
    const last = profile.ticks[profile.ticks.length - 1];
    // The final tick is at rest (velocity below the 5 px/s rest threshold).
    expect(last.velocityPxPerSec).toBeLessThan(5);
    // Monotonic non-increasing velocity is preserved through the settling tick.
    for (let i = 1; i < profile.ticks.length; i += 1) {
      expect(profile.ticks[i].velocityPxPerSec).toBeLessThanOrEqual(
        profile.ticks[i - 1].velocityPxPerSec,
      );
    }
    // cumulativePx still equals the running sum of deltaPx (tail integral
    // folded into the settling tick keeps distance physically consistent).
    let runningSum = 0;
    for (const tick of profile.ticks) {
      runningSum += tick.deltaPx;
      expect(tick.cumulativePx).toBeCloseTo(runningSum, 9);
    }
    expect(profile.totalDistancePx).toBeCloseTo(Math.abs(last.cumulativePx), 9);
  });

  it('settling tail is the EXACT analytic integral — no off-by-one tick overlap', () => {
    // A flick whose decay is slow enough that the 5s MAX_DURATION cap truncates
    // the loop BEFORE the rest threshold, so the settling tail runs. Explicit
    // v0/decayRate + tickIntervalMs make the total analytically computable.
    //
    // The emitted total distance must equal the exact analytic integral of the
    // whole decaying flick from t=0 to infinity:
    //   ∫ v0·exp(-decay·τ) dτ, 0→∞ = v0 / decayRate
    // The in-loop ticks integrate [0, t_cut + tickSec] and the settling tail
    // must integrate [t_cut + tickSec, ∞) — with NO overlap. The prior bug
    // started the tail at t_cut, double-counting the last in-loop tick's
    // interval [t_cut, t_cut + tickSec] and inflating the total by exactly that
    // tick's distance. Asserting EQUALITY with v0/decayRate (not just "< old
    // value") proves the overlap is gone and the integral is exact.
    const v0 = 8000;
    const decayRate = 0.1;
    const profile = generateScrollVelocityProfile({
      direction: 'down',
      elementClass: 'scroll-container',
      initialVelocityPxPerSec: v0,
      decayRate,
      tickIntervalMs: 16,
      seed: 'analytic-tail',
    });
    // Confirm the tail actually ran (loop truncated by MAX_DURATION, not rest):
    // v(5s) = 8000·exp(-0.1·5) ≈ 4852 px/s, well above the 5 px/s rest threshold.
    const last = profile.ticks[profile.ticks.length - 1];
    expect(last.velocityPxPerSec).toBe(0); // appended settling tick is at rest
    const secondToLast = profile.ticks[profile.ticks.length - 2];
    expect(secondToLast.velocityPxPerSec).toBeGreaterThan(/* rest threshold */ 5);

    // EXACT total: v0 / decayRate = 8000 / 0.1 = 80000 px. Telescoping the
    // per-tick integrals + the corrected tail collapses to this closed form.
    const expectedTotalPx = v0 / decayRate;
    expect(profile.totalDistancePx).toBeCloseTo(expectedTotalPx, 6);
    expect(profile.totalDistancePx).toBeCloseTo(Math.abs(last.cumulativePx), 9);

    // Guard against the specific regression: the OLD (buggy) tail started at
    // t_cut, so the total was inflated by exactly the last in-loop tick's
    // distance (v0/decay · (exp(-decay·t_cut) − exp(-decay·(t_cut+tickSec)))).
    // Recompute that overlap and assert the emitted total is NOT the old,
    // inflated value — i.e. the correct total is strictly less by that amount.
    const tickSec = 16 / 1000;
    const tCutSec = secondToLast.tMs / 1000;
    const lastInLoopTickDistance =
      (v0 / decayRate) *
      (Math.exp(-decayRate * tCutSec) - Math.exp(-decayRate * (tCutSec + tickSec)));
    const oldBuggyTotal = expectedTotalPx + lastInLoopTickDistance;
    expect(oldBuggyTotal - profile.totalDistancePx).toBeCloseTo(lastInLoopTickDistance, 6);
    expect(profile.totalDistancePx).toBeLessThan(oldBuggyTotal);
  });

  it('a high-v0 profile across element classes always ends at rest', () => {
    for (const klass of ALL_CLASSES) {
      const profile = generateScrollVelocityProfile({
        direction: 'up',
        elementClass: klass,
        initialVelocityPxPerSec: 12000,
        decayRate: 0.1,
        seed: `settle-${klass}`,
      });
      const last = profile.ticks[profile.ticks.length - 1];
      expect(last.velocityPxPerSec).toBeLessThan(5);
    }
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
