import { describe, expect, it } from 'vitest';
import {
  MAX_MOUSE_TRAJECTORY_SAMPLES,
  MAX_SCROLL_PATTERN_TICKS,
  MAX_TEXT_LENGTH,
  MockBehaviouralSimulator,
  type BehaviouralProfile,
} from '../src/index.js';

const PROFILE: BehaviouralProfile = {
  id: 'test_profile',
  meanKeyDelayMs: 100,
  meanMouseSpeedPxPerMs: 0.5,
  meanScrollPxPerTick: 50,
  pauseProbability: 0.2,
  meanPauseMs: 500,
};

describe('MockBehaviouralSimulator — determinism', () => {
  it('generateMouseTrajectory is deterministic for identical inputs', () => {
    const sim = new MockBehaviouralSimulator();
    const a = sim.generateMouseTrajectory({ from: { x: 0, y: 0 }, to: { x: 100, y: 50 } });
    const b = sim.generateMouseTrajectory({ from: { x: 0, y: 0 }, to: { x: 100, y: 50 } });
    expect(a).toEqual(b);
  });

  it('mouse trajectory has the expected start + end points and sample count', () => {
    const sim = new MockBehaviouralSimulator();
    const traj = sim.generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 200, y: 100 },
      samples: 16,
    });
    expect(traj.points).toHaveLength(17); // 0..samples inclusive
    expect(traj.points[0]).toEqual({ x: 0, y: 0, tMs: 0 });
    expect(traj.points[16]).toEqual({ x: 200, y: 100, tMs: 250 });
    // Midpoint check (linear interpolation in mock).
    expect(traj.points[8]).toEqual({ x: 100, y: 50, tMs: 125 });
  });

  it('BSIM-3: rejects an absurd samples value on generateMouseTrajectory', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateMouseTrajectory({
        from: { x: 0, y: 0 },
        to: { x: 100, y: 50 },
        samples: 50_000_000,
      }),
    ).toThrow(/samples must be between/);
  });

  it('BSIM-3: rejects a zero/negative samples value on generateMouseTrajectory', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateMouseTrajectory({ from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, samples: 0 }),
    ).toThrow(/samples must be between/);
    expect(() =>
      sim.generateMouseTrajectory({ from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, samples: -5 }),
    ).toThrow(/samples must be between/);
  });

  it('BSIM-3: the ceiling value itself is accepted, one above it is rejected', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateMouseTrajectory({
        from: { x: 0, y: 0 },
        to: { x: 100, y: 50 },
        samples: MAX_MOUSE_TRAJECTORY_SAMPLES,
      }),
    ).not.toThrow();
    expect(() =>
      sim.generateMouseTrajectory({
        from: { x: 0, y: 0 },
        to: { x: 100, y: 50 },
        samples: MAX_MOUSE_TRAJECTORY_SAMPLES + 1,
      }),
    ).toThrow(/samples must be between/);
  });

  it('BSIM-3: the default (unspecified, 32) and a reasonable explicit value still work as before', () => {
    const sim = new MockBehaviouralSimulator();
    const defaultTraj = sim.generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 100, y: 50 },
    });
    expect(defaultTraj.points).toHaveLength(33); // 0..32 inclusive

    const explicitTraj = sim.generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 200, y: 100 },
      samples: 16,
    });
    expect(explicitTraj.points).toHaveLength(17);
  });

  it('rejects fractional and non-finite mouse sample counts', () => {
    const sim = new MockBehaviouralSimulator();
    for (const samples of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        sim.generateMouseTrajectory({
          from: { x: 0, y: 0 },
          to: { x: 100, y: 50 },
          samples,
        }),
      ).toThrow(/samples must/);
    }
  });

  it('rejects non-finite mouse coordinates instead of emitting NaN points', () => {
    const sim = new MockBehaviouralSimulator();
    for (const opts of [
      { from: { x: Number.NaN, y: 0 }, to: { x: 10, y: 10 } },
      { from: { x: 0, y: Number.POSITIVE_INFINITY }, to: { x: 10, y: 10 } },
      { from: { x: 0, y: 0 }, to: { x: Number.NEGATIVE_INFINITY, y: 10 } },
      { from: { x: 0, y: 0 }, to: { x: 10, y: Number.NaN } },
    ]) {
      expect(() => sim.generateMouseTrajectory(opts)).toThrow(/must be finite/);
    }
  });

  it('rejects finite mouse endpoints whose derived span overflows', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateMouseTrajectory({
        from: { x: Number.MAX_VALUE, y: 0 },
        to: { x: -Number.MAX_VALUE, y: 0 },
      }),
    ).toThrow(/derived x span must be finite/);
  });

  it('different inputs produce different seeds', () => {
    const sim = new MockBehaviouralSimulator();
    const a = sim.generateMouseTrajectory({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 } });
    const b = sim.generateMouseTrajectory({ from: { x: 0, y: 0 }, to: { x: 200, y: 0 } });
    expect(a.seed).not.toEqual(b.seed);
  });

  it('generateKeyboardCadence emits one delay per character at the profile mean', () => {
    const sim = new MockBehaviouralSimulator();
    const cad = sim.generateKeyboardCadence({ text: 'hello', profile: PROFILE });
    expect(cad.text).toBe('hello');
    expect(cad.delaysMs).toEqual([100, 100, 100, 100, 100]);
    expect(cad.durationMs).toBe(500);
  });

  it('generateKeyboardCadence mirrors real Unicode grapheme boundaries', () => {
    const sim = new MockBehaviouralSimulator();
    const cad = sim.generateKeyboardCadence({ text: 'A👩‍💻é🇺🇸', profile: PROFILE });
    expect(cad.delaysMs).toEqual([100, 100, 100, 100]);
    expect(cad.durationMs).toBe(400);
  });

  it('generateKeyboardCadence rejects non-positive and non-finite profile means', () => {
    const sim = new MockBehaviouralSimulator();
    for (const meanKeyDelayMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        sim.generateKeyboardCadence({
          text: 'hello',
          profile: { ...PROFILE, meanKeyDelayMs },
        }),
      ).toThrow(/meanKeyDelayMs/);
    }
  });

  it('generateKeyboardCadence applies the real generator text allocation cap', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateKeyboardCadence({
        text: 'x'.repeat(MAX_TEXT_LENGTH + 1),
        profile: PROFILE,
      }),
    ).toThrow(/^MockBehaviouralSimulator\.generateKeyboardCadence: text must be <= 20000/);
  });

  it('generateKeyboardCadence rejects a non-finite accumulated duration', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateKeyboardCadence({
        text: 'aa',
        profile: { ...PROFILE, meanKeyDelayMs: Number.MAX_VALUE },
      }),
    ).toThrow(/^MockBehaviouralSimulator\.generateKeyboardCadence: durationMs must be finite/);
  });

  it('generateScrollPattern produces ticks of profile.meanScrollPxPerTick magnitude', () => {
    const sim = new MockBehaviouralSimulator();
    const sc = sim.generateScrollPattern({
      direction: 'down',
      totalDistancePx: 200,
      profile: PROFILE,
    });
    // 200 / 50 = 4 ticks
    expect(sc.ticks).toHaveLength(4);
    expect(sc.ticks.every((t) => t.deltaPx === 50)).toBe(true);
    expect(sc.totalDistancePx).toBe(200);
    expect(sc.direction).toBe('down');
  });

  it('generateScrollPattern applies physical signs for every direction', () => {
    const sim = new MockBehaviouralSimulator();
    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const pattern = sim.generateScrollPattern({
        direction,
        totalDistancePx: 100,
        profile: PROFILE,
      });
      const expectedSign = direction === 'up' || direction === 'left' ? -1 : 1;
      expect(pattern.ticks.every((tick) => Math.sign(tick.deltaPx) === expectedSign)).toBe(true);
    }
  });

  it('generateScrollPattern rejects invalid distance and tick magnitudes', () => {
    const sim = new MockBehaviouralSimulator();
    for (const totalDistancePx of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        sim.generateScrollPattern({ direction: 'down', totalDistancePx, profile: PROFILE }),
      ).toThrow(/totalDistancePx/);
    }
    for (const meanScrollPxPerTick of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        sim.generateScrollPattern({
          direction: 'down',
          totalDistancePx: 100,
          profile: { ...PROFILE, meanScrollPxPerTick },
        }),
      ).toThrow(/meanScrollPxPerTick/);
    }
  });

  it('generateScrollPattern caps caller-controlled tick allocation', () => {
    const sim = new MockBehaviouralSimulator();
    expect(() =>
      sim.generateScrollPattern({
        direction: 'down',
        totalDistancePx: (MAX_SCROLL_PATTERN_TICKS + 1) * PROFILE.meanScrollPxPerTick,
        profile: PROFILE,
      }),
    ).toThrow(/tick count must be <=/);
    expect(
      sim.generateScrollPattern({
        direction: 'down',
        totalDistancePx: MAX_SCROLL_PATTERN_TICKS * PROFILE.meanScrollPxPerTick,
        profile: PROFILE,
      }).ticks,
    ).toHaveLength(MAX_SCROLL_PATTERN_TICKS);
  });

  it('listProfiles returns the default catalogue when none injected', () => {
    const sim = new MockBehaviouralSimulator();
    const profiles = sim.listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('casual_browser_us');
  });

  it('listProfiles surfaces an injected catalogue', () => {
    const sim = new MockBehaviouralSimulator([PROFILE]);
    expect(sim.listProfiles()).toEqual([PROFILE]);
  });

  it('snapshots and freezes injected profiles for session-lifetime consistency', () => {
    const source = { ...PROFILE };
    const injected = [source];
    const sim = new MockBehaviouralSimulator(injected);
    source.meanKeyDelayMs = 1;
    injected.pop();

    const snapshot = sim.listProfiles();
    expect(snapshot).toEqual([PROFILE]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(() => {
      (snapshot[0] as { meanKeyDelayMs: number }).meanKeyDelayMs = 2;
    }).toThrow(TypeError);
    expect(sim.listProfiles()).toEqual([PROFILE]);
  });
});
