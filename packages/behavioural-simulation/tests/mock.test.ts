import { describe, expect, it } from 'vitest';
import {
  MAX_MOUSE_TRAJECTORY_SAMPLES,
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
});
