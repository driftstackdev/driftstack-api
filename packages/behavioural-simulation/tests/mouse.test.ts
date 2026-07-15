import { describe, expect, it } from 'vitest';
import {
  generateMouseTrajectory,
  MAX_MOUSE_TRAJECTORY_SAMPLES,
  MIN_MOUSE_TRAJECTORY_SAMPLES,
  MOUSE_ARC_LENGTH_SEGMENTS,
  type BehaviouralProfile,
} from '../src/index.js';

const REGULAR: BehaviouralProfile = {
  id: 'regular-test',
  meanKeyDelayMs: 100,
  meanMouseSpeedPxPerMs: 1,
  meanScrollPxPerTick: 40,
  pauseProbability: 0.1,
  meanPauseMs: 700,
};

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe('generateMouseTrajectory', () => {
  it('is byte-deterministic for identical inputs and differs by seed', () => {
    const opts = {
      from: { x: 10, y: 20 },
      to: { x: 610, y: 260 },
      profile: REGULAR,
      samples: 48,
      seed: 'session-a:move-1',
    } as const;
    expect(generateMouseTrajectory(opts)).toEqual(generateMouseTrajectory(opts));
    expect(generateMouseTrajectory({ ...opts, seed: 'session-b:move-1' }).points).not.toEqual(
      generateMouseTrajectory(opts).points,
    );
  });

  it('emits exact endpoints, samples+1 points, and finite monotonic timestamps', () => {
    const result = generateMouseTrajectory({
      from: { x: -50, y: 25 },
      to: { x: 420, y: 315 },
      profile: REGULAR,
      samples: 64,
      seed: 'shape',
    });
    expect(result.points).toHaveLength(65);
    expect(result.points[0]).toEqual({ x: -50, y: 25, tMs: 0 });
    expect(result.points.at(-1)).toEqual({ x: 420, y: 315, tMs: result.durationMs });
    for (let i = 0; i < result.points.length; i += 1) {
      const point = result.points[i]!;
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Number.isFinite(point.tMs)).toBe(true);
      if (i > 0) expect(point.tMs).toBeGreaterThan(result.points[i - 1]!.tMs);
    }
  });

  it('uses a curved path rather than collinear interpolation', () => {
    const result = generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 500, y: 0 },
      profile: REGULAR,
      samples: 32,
      seed: 'curve-proof',
    });
    expect(result.points.slice(1, -1).some((point) => Math.abs(point.y) > 0.01)).toBe(true);
    expect(result.durationMs).toBeGreaterThan(500 / REGULAR.meanMouseSpeedPxPerMs);
  });

  it('derives duration from the same arc length and the explicit profile speed', () => {
    const slow = generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 800, y: 300 },
      profile: { ...REGULAR, id: 'slow', meanMouseSpeedPxPerMs: 0.5 },
      seed: 'same-curve',
    });
    const fast = generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 800, y: 300 },
      profile: { ...REGULAR, id: 'fast', meanMouseSpeedPxPerMs: 2 },
      seed: 'same-curve',
    });
    expect(slow.durationMs).toBeCloseTo(fast.durationMs * 4, 10);
    expect(slow.durationMs * 0.5).toBeCloseTo(fast.durationMs * 2, 10);
    expect(slow.points.map(({ x, y }) => ({ x, y }))).toEqual(
      fast.points.map(({ x, y }) => ({ x, y })),
    );
  });

  it('uses minimum-jerk progress: early and late travel are smaller than mid-trajectory travel', () => {
    const result = generateMouseTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 1000, y: 250 },
      profile: REGULAR,
      samples: 20,
      seed: 'minimum-jerk',
    });
    const steps = result.points
      .slice(1)
      .map((point, index) => distance(result.points[index]!, point));
    expect(steps[0]).toBeLessThan(steps[9]!);
    expect(steps.at(-1)).toBeLessThan(steps[9]!);
  });

  it('returns a stationary zero-duration path for equal endpoints', () => {
    const result = generateMouseTrajectory({
      from: { x: 12.5, y: -9 },
      to: { x: 12.5, y: -9 },
      profile: REGULAR,
      samples: 4,
      seed: 'stationary',
    });
    expect(result.durationMs).toBe(0);
    expect(result.points).toHaveLength(5);
    expect(result.points).toEqual(Array.from({ length: 5 }, () => ({ x: 12.5, y: -9, tMs: 0 })));
  });

  it('accepts both sample bounds and keeps the fixed arc table bounded', () => {
    expect(MOUSE_ARC_LENGTH_SEGMENTS).toBe(256);
    for (const samples of [MIN_MOUSE_TRAJECTORY_SAMPLES, MAX_MOUSE_TRAJECTORY_SAMPLES]) {
      expect(
        generateMouseTrajectory({
          from: { x: 0, y: 0 },
          to: { x: 100, y: 100 },
          profile: REGULAR,
          samples,
          seed: `bound-${samples.toString()}`,
        }).points,
      ).toHaveLength(samples + 1);
    }
  });

  it('rejects missing/invalid profiles, invalid samples, non-finite coordinates and derived overflow', () => {
    const base = { from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, profile: REGULAR };
    expect(() =>
      generateMouseTrajectory({ ...base, profile: undefined } as unknown as Parameters<
        typeof generateMouseTrajectory
      >[0]),
    ).toThrow(/profile is required/);
    for (const speed of [0, -1, 0.001, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        generateMouseTrajectory({
          ...base,
          profile: { ...REGULAR, meanMouseSpeedPxPerMs: speed },
        }),
      ).toThrow(/meanMouseSpeedPxPerMs/);
    }
    for (const samples of [0, -1, 1.5, MAX_MOUSE_TRAJECTORY_SAMPLES + 1, Number.NaN]) {
      expect(() => generateMouseTrajectory({ ...base, samples })).toThrow(/samples must/);
    }
    expect(() =>
      generateMouseTrajectory({ ...base, to: { x: Number.POSITIVE_INFINITY, y: 10 } }),
    ).toThrow(/must be finite/);
    expect(() =>
      generateMouseTrajectory({
        ...base,
        from: { x: Number.MAX_VALUE, y: 0 },
        to: { x: -Number.MAX_VALUE, y: 0 },
      }),
    ).toThrow(/derived x span must be finite/);
    expect(() =>
      generateMouseTrajectory({
        ...base,
        from: { x: 0, y: Number.MAX_VALUE },
        to: { x: Number.MAX_VALUE, y: Number.MAX_VALUE },
        seed: 'control-overflow',
      }),
    ).toThrow(/derived .* must be finite/);
  });
});
