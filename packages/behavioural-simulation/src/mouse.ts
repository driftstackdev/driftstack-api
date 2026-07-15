// Deterministic profile-driven mouse trajectories for the private reference
// package. The production harness retains ownership of the canonical rich
// behavioral model; this pure generator provides a coherent, testable package
// implementation without claiming capture-derived production fidelity.

import type { GenerateMouseTrajectoryOpts } from './interfaces.js';
import type { MouseTrajectory } from './types.js';
import { requireFinite, requireIntegerInRange, requirePositiveFinite } from './validation.js';

export const MIN_MOUSE_TRAJECTORY_SAMPLES = 1;
export const MAX_MOUSE_TRAJECTORY_SAMPLES = 1000;
export const MOUSE_ARC_LENGTH_SEGMENTS = 256;

const DEFAULT_MOUSE_TRAJECTORY_SAMPLES = 32;
const MIN_MOUSE_SPEED_PX_PER_MS = 0.01;
const MAX_MOUSE_SPEED_PX_PER_MS = 10;

interface Point {
  x: number;
  y: number;
}

interface ArcLengthEntry {
  parameter: number;
  cumulativePx: number;
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultSeed(opts: GenerateMouseTrajectoryOpts, samples: number): string {
  return `mouse:${JSON.stringify({
    from: opts.from,
    to: opts.to,
    profileId: opts.profile.id,
    meanMouseSpeedPxPerMs: opts.profile.meanMouseSpeedPxPerMs,
    samples,
  })}`;
}

function cubicBezier(from: Point, control1: Point, control2: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  const inverseSquared = inverse * inverse;
  const tSquared = t * t;
  return {
    x:
      inverseSquared * inverse * from.x +
      3 * inverseSquared * t * control1.x +
      3 * inverse * tSquared * control2.x +
      tSquared * t * to.x,
    y:
      inverseSquared * inverse * from.y +
      3 * inverseSquared * t * control1.y +
      3 * inverse * tSquared * control2.y +
      tSquared * t * to.y,
  };
}

function minimumJerk(progress: number): number {
  const squared = progress * progress;
  const cubed = squared * progress;
  return cubed * (10 - 15 * progress + 6 * squared);
}

function buildArcLengthTable(
  from: Point,
  control1: Point,
  control2: Point,
  to: Point,
): ArcLengthEntry[] {
  const table: ArcLengthEntry[] = [{ parameter: 0, cumulativePx: 0 }];
  let previous = from;
  let cumulativePx = 0;
  for (let i = 1; i <= MOUSE_ARC_LENGTH_SEGMENTS; i += 1) {
    const parameter = i / MOUSE_ARC_LENGTH_SEGMENTS;
    const point = cubicBezier(from, control1, control2, to, parameter);
    requireFinite('generateMouseTrajectory: derived curve x', point.x);
    requireFinite('generateMouseTrajectory: derived curve y', point.y);
    cumulativePx += Math.hypot(point.x - previous.x, point.y - previous.y);
    requireFinite('generateMouseTrajectory: derived arc length', cumulativePx);
    table.push({ parameter, cumulativePx });
    previous = point;
  }
  return table;
}

function parameterAtArcFraction(
  table: readonly ArcLengthEntry[],
  totalArcLengthPx: number,
  fraction: number,
): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  const targetPx = totalArcLengthPx * fraction;
  let low = 1;
  let high = table.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (table[middle]!.cumulativePx < targetPx) low = middle + 1;
    else high = middle;
  }
  const right = table[low]!;
  const left = table[low - 1]!;
  const segmentPx = right.cumulativePx - left.cumulativePx;
  const segmentFraction = segmentPx === 0 ? 0 : (targetPx - left.cumulativePx) / segmentPx;
  return left.parameter + (right.parameter - left.parameter) * segmentFraction;
}

/**
 * Generate one bounded cubic path with minimum-jerk temporal progress.
 * `pauseProbability` and `meanPauseMs` intentionally remain between-action
 * concerns; injecting them into a single movement would conflate two layers.
 */
export function generateMouseTrajectory(opts: GenerateMouseTrajectoryOpts): MouseTrajectory {
  if (typeof opts.profile !== 'object' || opts.profile === null) {
    throw new Error('generateMouseTrajectory: profile is required');
  }
  for (const [name, value] of [
    ['from.x', opts.from.x],
    ['from.y', opts.from.y],
    ['to.x', opts.to.x],
    ['to.y', opts.to.y],
  ] as const) {
    requireFinite(`generateMouseTrajectory: ${name}`, value);
  }
  requirePositiveFinite(
    'generateMouseTrajectory: profile.meanMouseSpeedPxPerMs',
    opts.profile.meanMouseSpeedPxPerMs,
  );
  if (
    opts.profile.meanMouseSpeedPxPerMs < MIN_MOUSE_SPEED_PX_PER_MS ||
    opts.profile.meanMouseSpeedPxPerMs > MAX_MOUSE_SPEED_PX_PER_MS
  ) {
    throw new Error(
      `generateMouseTrajectory: profile.meanMouseSpeedPxPerMs must be between ` +
        `${MIN_MOUSE_SPEED_PX_PER_MS.toString()} and ${MAX_MOUSE_SPEED_PX_PER_MS.toString()} ` +
        `(got ${opts.profile.meanMouseSpeedPxPerMs.toString()})`,
    );
  }

  const samples = opts.samples ?? DEFAULT_MOUSE_TRAJECTORY_SAMPLES;
  requireIntegerInRange(
    'generateMouseTrajectory: samples',
    samples,
    MIN_MOUSE_TRAJECTORY_SAMPLES,
    MAX_MOUSE_TRAJECTORY_SAMPLES,
  );

  const dx = opts.to.x - opts.from.x;
  const dy = opts.to.y - opts.from.y;
  requireFinite('generateMouseTrajectory: derived x span', dx);
  requireFinite('generateMouseTrajectory: derived y span', dy);
  const directDistancePx = Math.hypot(dx, dy);
  requireFinite('generateMouseTrajectory: derived direct distance', directDistancePx);
  const seed = opts.seed ?? defaultSeed(opts, samples);

  if (directDistancePx === 0) {
    const points = Array.from({ length: samples + 1 }, () => ({
      x: opts.from.x,
      y: opts.from.y,
      tMs: 0,
    }));
    return {
      from: { ...opts.from },
      to: { ...opts.to },
      points,
      durationMs: 0,
      seed,
    };
  }

  const random = mulberry32(hashSeed(seed));
  const perpendicularX = -dy / directDistancePx;
  const perpendicularY = dx / directDistancePx;
  const curveSign = random() < 0.5 ? -1 : 1;
  const curvaturePx = directDistancePx * (0.08 + random() * 0.12) * curveSign;
  const firstForward = 0.22 + random() * 0.16;
  const secondForward = 0.62 + random() * 0.16;
  const firstLateral = curvaturePx * (0.75 + random() * 0.5);
  const secondLateral = curvaturePx * (0.75 + random() * 0.5);
  const control1 = {
    x: opts.from.x + dx * firstForward + perpendicularX * firstLateral,
    y: opts.from.y + dy * firstForward + perpendicularY * firstLateral,
  };
  const control2 = {
    x: opts.from.x + dx * secondForward + perpendicularX * secondLateral,
    y: opts.from.y + dy * secondForward + perpendicularY * secondLateral,
  };
  requireFinite('generateMouseTrajectory: first control x', control1.x);
  requireFinite('generateMouseTrajectory: first control y', control1.y);
  requireFinite('generateMouseTrajectory: second control x', control2.x);
  requireFinite('generateMouseTrajectory: second control y', control2.y);

  const arcTable = buildArcLengthTable(opts.from, control1, control2, opts.to);
  const totalArcLengthPx = arcTable.at(-1)!.cumulativePx;
  requirePositiveFinite('generateMouseTrajectory: total arc length', totalArcLengthPx);
  const durationMs = totalArcLengthPx / opts.profile.meanMouseSpeedPxPerMs;
  requirePositiveFinite('generateMouseTrajectory: derived durationMs', durationMs);

  const points: Array<{ x: number; y: number; tMs: number }> = [];
  for (let i = 0; i <= samples; i += 1) {
    const timeFraction = i / samples;
    if (i === 0) {
      points.push({ x: opts.from.x, y: opts.from.y, tMs: 0 });
      continue;
    }
    if (i === samples) {
      points.push({ x: opts.to.x, y: opts.to.y, tMs: durationMs });
      continue;
    }
    const arcFraction = minimumJerk(timeFraction);
    const parameter = parameterAtArcFraction(arcTable, totalArcLengthPx, arcFraction);
    const point = cubicBezier(opts.from, control1, control2, opts.to, parameter);
    const tMs = durationMs * timeFraction;
    requireFinite('generateMouseTrajectory: sampled x', point.x);
    requireFinite('generateMouseTrajectory: sampled y', point.y);
    requireFinite('generateMouseTrajectory: sampled tMs', tMs);
    points.push({ ...point, tMs });
  }

  return {
    from: { ...opts.from },
    to: { ...opts.to },
    points,
    durationMs,
    seed,
  };
}
