// Inertial-slide path math (founder 2026-06-21 "slide simulation like a new
// iphone"). computeFlingPath is the pure core of the momentum gesture: given a
// release point + velocity it returns the decelerating touch positions replayed
// as touchMove events so a fast flick keeps gliding + settles like iOS. Pins:
//
//   - decelerates: step distances trend down under friction (allowing integer rounding)
//   - empty when the release velocity is already below the stop threshold
//     (→ the caller just ends the touch, no glide)
//   - hard-bounded: release speed, per-step distance, duration/step count, and total
//     distance are capped (can never run away — it's injected into the live input path)
//   - travels along the velocity vector and overall in its direction
//   - integer coords (the Mac-side decoder expects ints)
import { describe, expect, it } from 'vitest';
import { computeFlingPath } from '../../src/lib/livekit-input-capture';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('computeFlingPath', () => {
  it('returns an empty path when the release velocity is below the stop threshold', () => {
    // 0.01 px/ms is well under the 0.05 default stopSpeed → no glide.
    expect(computeFlingPath(200, 400, 0.01, 0)).toEqual([]);
    expect(computeFlingPath(200, 400, 0, 0)).toEqual([]);
  });

  it('decelerates — each successive step covers less ground than the last', () => {
    const path = computeFlingPath(0, 0, 0, -2); // fast upward flick (scroll down)
    expect(path.length).toBeGreaterThan(2);
    const steps = [{ x: 0, y: 0 }, ...path];
    const gaps: number[] = [];
    for (let i = 1; i < steps.length; i++) gaps.push(dist(steps[i - 1], steps[i]));
    for (let i = 1; i < gaps.length; i++) {
      // Friction shrinks the unrounded step. Integer wire coordinates can make two
      // neighboring rounded gaps differ by one pixel in either direction.
      expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1] + 1);
    }
    expect(gaps[gaps.length - 1]).toBeLessThan(gaps[0]);
  });

  it('glides along the velocity vector (y decreases for an upward flick, x ~unchanged)', () => {
    const path = computeFlingPath(150, 500, 0, -1.5);
    const last = path[path.length - 1];
    expect(last.y).toBeLessThan(500); // moved up
    expect(Math.abs(last.x - 150)).toBeLessThanOrEqual(1); // no lateral drift
  });

  it('respects a diagonal velocity (both axes move in their sign direction)', () => {
    const path = computeFlingPath(100, 100, 1.2, -1.2);
    const last = path[path.length - 1];
    expect(last.x).toBeGreaterThan(100);
    expect(last.y).toBeLessThan(100);
  });

  it('never exceeds maxSteps', () => {
    // Huge velocity + no distance cap → bounded purely by maxSteps.
    const path = computeFlingPath(0, 0, 50, 0, {
      maxDist: Infinity,
      maxSpeed: Infinity,
      maxStepDist: Infinity,
      maxDurationMs: Infinity,
      maxSteps: 38,
    });
    expect(path.length).toBeLessThanOrEqual(38);
  });

  it('stops exactly at the distance cap instead of overshooting it by one fast step', () => {
    const path = computeFlingPath(0, 0, 50, 0, {
      maxDist: 300,
      maxSpeed: Infinity,
      maxStepDist: Infinity,
      maxDurationMs: Infinity,
    });
    const last = path[path.length - 1];
    expect(last.x).toBe(300);
  });

  it('defaults to the conservative re-enable envelope (speed/frame/duration/distance)', () => {
    const path = computeFlingPath(0, 0, 1_000, 0);
    const steps = [{ x: 0, y: 0 }, ...path];
    // 240ms / 16ms = at most 15 emitted frames.
    expect(path.length).toBeLessThanOrEqual(15);
    for (let i = 1; i < steps.length; i++) {
      // Integer rounding can add at most a pixel to the 20px internal cap.
      expect(dist(steps[i - 1], steps[i])).toBeLessThanOrEqual(21);
    }
    const last = path[path.length - 1];
    // Integer rounding can add at most a pixel to the 160px internal cap.
    expect(dist({ x: 0, y: 0 }, last)).toBeLessThanOrEqual(161);
  });

  it('rejects non-finite input instead of emitting NaN/Infinity touch coordinates', () => {
    expect(computeFlingPath(0, 0, Number.POSITIVE_INFINITY, 0)).toEqual([]);
    expect(computeFlingPath(Number.NaN, 0, 1, 0)).toEqual([]);
  });

  it('emits integer coordinates', () => {
    const path = computeFlingPath(10.4, 20.6, 0.9, -0.7);
    for (const p of path) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });
});
