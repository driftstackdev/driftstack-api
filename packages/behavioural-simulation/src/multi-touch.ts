// V-530.E — multi-touch gesture sequencing.
//
// Closes the V-530 series. V-530.D shipped idle-period jitter but
// explicitly deferred the multi-touch half. This module is that
// deferred half: per-finger track interleaving for common multi-
// touch gestures (pinch, two-finger scroll, three-finger swipe).
//
// Each gesture produces a `MultiTouchGesture` — N synchronized
// `FingerTrack`s, each with its own sample sequence. The driver
// dispatches the per-finger samples in interleaved order so they
// reach the host with the right (touch-id, t) shape.
//
// Pure data + seeded determinism, same pattern as touch.ts /
// scroll.ts / dwell.ts / idle.ts (mulberry32 + FNV-1a).
//
// Gestures shipped:
//   - generatePinchGesture: two fingers, starting from `startCentre`,
//     moving APART (zoom in) or TOGETHER (zoom out).
//   - generateTwoFingerScrollGesture: two fingers moving in the same
//     direction by `distancePx`.
//   - generateThreeFingerSwipeGesture: three fingers moving in the
//     same direction (gesture macOS / iOS use for app switching,
//     mission control, etc).

export interface FingerSample {
  /** Wall-clock ms since gesture start. */
  tMs: number;
  /** Screen x (CSS px). */
  x: number;
  /** Screen y (CSS px). */
  y: number;
  /** Pressure 0..1. */
  pressure: number;
}

export interface FingerTrack {
  /** Stable id for this finger within the gesture (1, 2, 3, ...). */
  fingerId: number;
  /** Touch-start coordinate. */
  start: { x: number; y: number };
  /** Touch-end coordinate. */
  end: { x: number; y: number };
  /** Ordered samples from start → end. */
  samples: readonly FingerSample[];
}

export type GestureKind = 'pinch' | 'two-finger-scroll' | 'three-finger-swipe';

export interface MultiTouchGesture {
  kind: GestureKind;
  /** Ordered per-finger tracks. Index 0 is "finger 1" by convention. */
  fingers: readonly FingerTrack[];
  /** Total gesture duration (max sample tMs across all fingers). */
  durationMs: number;
  /** RNG seed used to generate this gesture. */
  seed: string;
}

export interface GeneratePinchOpts {
  /** Centre point the two fingers start from + return relative to. */
  startCentre: { x: number; y: number };
  /** Starting span between the two fingers (CSS px). */
  startSpanPx: number;
  /** Ending span between the two fingers (CSS px). Larger than
   *  startSpanPx → zoom in; smaller → zoom out. */
  endSpanPx: number;
  /** Total gesture duration (ms). Default 320. */
  durationMs?: number;
  /** Sample count per finger (≥ 2). Default 12. */
  samples?: number;
  /** Optional seed override. */
  seed?: string;
}

export interface GenerateTwoFingerScrollOpts {
  /** Starting position of finger 1; finger 2 is `fingerSeparationPx`
   *  to the right. */
  start: { x: number; y: number };
  /** Distance between the two fingers (CSS px). Default 80. */
  fingerSeparationPx?: number;
  /** Direction of scroll. */
  direction: 'up' | 'down' | 'left' | 'right';
  /** Total scroll distance (CSS px). */
  distancePx: number;
  /** Total gesture duration (ms). Default 220. */
  durationMs?: number;
  /** Sample count per finger (≥ 2). Default 10. */
  samples?: number;
  /** Optional seed override. */
  seed?: string;
}

export interface GenerateThreeFingerSwipeOpts {
  /** Starting position of the MIDDLE finger. Fingers are laid out
   *  left→right as fingerId 1/2/3, so the middle finger is `fingerId 2`
   *  (`fingers[1]`) — NOT finger 1. The other two fingers start
   *  `fingerSeparationPx` to either side. */
  start: { x: number; y: number };
  /** Distance between adjacent fingers (CSS px). Default 60. */
  fingerSeparationPx?: number;
  direction: 'up' | 'down' | 'left' | 'right';
  /** Total swipe distance (CSS px). */
  distancePx: number;
  /** Total gesture duration (ms). Default 280. */
  durationMs?: number;
  /** Sample count per finger (≥ 2). Default 10. */
  samples?: number;
  /** Optional seed override. */
  seed?: string;
}

function mulberry32(seedNum: number): () => number {
  let state = seedNum >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Per-finger touchstart lag (ms). A real multi-finger gesture never lands
 * every finger on the exact same instant — finger 2 (and 3) trail finger 1
 * by a few ms. Mirrors the harness `secondFingerLagMs` (see
 * WebDriverClient.touchPinchActions): without it, every finger's first
 * sample is tMs=0, an impossible perfectly-synchronized landing a detector
 * keys on. The lag is seeded-jittered (NO Math.random) so it varies
 * gesture-to-gesture but stays deterministic per seed.
 */
const MIN_FINGER_LAG_MS = 8;
const MAX_FINGER_LAG_MS = 30;

/** Draw a seeded touchstart lag in [MIN_FINGER_LAG_MS, MAX_FINGER_LAG_MS]. */
function fingerStartLagMs(rng: () => number): number {
  return Math.round(MIN_FINGER_LAG_MS + rng() * (MAX_FINGER_LAG_MS - MIN_FINGER_LAG_MS));
}

/**
 * Hard ceiling on `samples` (per finger). `buildLinearTrack`'s loop below is
 * bounded only by `samples` — a caller-supplied absurd value (e.g. 50,000,000)
 * synchronously allocates tens of millions of objects per finger with zero
 * validation. A real multi-touch gesture lasts a few hundred ms (the
 * generators here default to 220-320ms); even sampled at a generous 1 kHz
 * that is only ~300-400 samples per finger, so 1,000 leaves comfortable
 * headroom for any realistic gesture while still bounding worst-case
 * allocation to a low thousands-element array per finger.
 */
export const MAX_SAMPLES_PER_FINGER = 1000;

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite (got ${String(value)})`);
  }
}

function requirePositiveFinite(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) {
    throw new Error(`${name} must be > 0 (got ${String(value)})`);
  }
}

function requireFinitePoint(name: string, point: { x: number; y: number }): void {
  requireFinite(`${name}.x`, point.x);
  requireFinite(`${name}.y`, point.y);
}

/** Gesture duration = the latest sample tMs across all fingers (per the
 *  MultiTouchGesture.durationMs contract), with `floor` as a lower bound. */
function gestureDurationMs(fingers: readonly FingerTrack[], floor: number): number {
  let max = floor;
  for (const finger of fingers) {
    const last = finger.samples[finger.samples.length - 1];
    if (last !== undefined && last.tMs > max) max = last.tMs;
  }
  return max;
}

/**
 * Shift every sample's `tMs` forward by `lagMs` so this finger's touchstart
 * trails an earlier finger. Returns a new track (input untouched); start/end
 * coordinates are unchanged — only the timeline is staggered.
 */
function staggerTrackStart(track: FingerTrack, lagMs: number): FingerTrack {
  if (lagMs <= 0) return track;
  return {
    ...track,
    samples: track.samples.map((s) => ({ ...s, tMs: s.tMs + lagMs })),
  };
}

function dirVector(dir: 'up' | 'down' | 'left' | 'right'): { dx: number; dy: number } {
  switch (dir) {
    case 'up':
      return { dx: 0, dy: -1 };
    case 'down':
      return { dx: 0, dy: 1 };
    case 'left':
      return { dx: -1, dy: 0 };
    case 'right':
      return { dx: 1, dy: 0 };
  }
}

function buildLinearTrack(opts: {
  fingerId: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  durationMs: number;
  samples: number;
  rng: () => number;
}): FingerTrack {
  requireFinitePoint('buildLinearTrack: start', opts.start);
  requireFinitePoint('buildLinearTrack: end', opts.end);
  requirePositiveFinite('buildLinearTrack: durationMs', opts.durationMs);
  if (!Number.isInteger(opts.samples) || opts.samples < 2) {
    throw new Error(
      `buildLinearTrack: samples must be an integer >= 2 (got ${String(opts.samples)})`,
    );
  }
  if (opts.samples > MAX_SAMPLES_PER_FINGER) {
    throw new Error(
      `buildLinearTrack: samples must be <= ${MAX_SAMPLES_PER_FINGER} (got ${opts.samples})`,
    );
  }
  const samples: FingerSample[] = [];
  const n = opts.samples;
  for (let i = 0; i < n; i += 1) {
    const fraction = i / (n - 1);
    // Light positional jitter so back-to-back gestures don't reproduce
    // pixel-perfect identical tracks (detectors love that). The first and
    // final samples must remain the declared touchstart/touchend coordinates;
    // jitter only the interior path or replay disagrees with track metadata.
    const isEndpoint = i === 0 || i === n - 1;
    const jitterX = isEndpoint ? 0 : (opts.rng() - 0.5) * 1.5;
    const jitterY = isEndpoint ? 0 : (opts.rng() - 0.5) * 1.5;
    const x = opts.start.x + (opts.end.x - opts.start.x) * fraction + jitterX;
    const y = opts.start.y + (opts.end.y - opts.start.y) * fraction + jitterY;
    // Pressure ramps up briefly then plateaus.
    const pressure = fraction < 0.15 ? fraction / 0.15 : 1;
    samples.push({
      tMs: Math.round(opts.durationMs * fraction),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      pressure: Math.round(pressure * 100) / 100,
    });
  }
  return {
    fingerId: opts.fingerId,
    start: { x: opts.start.x, y: opts.start.y },
    end: { x: opts.end.x, y: opts.end.y },
    samples,
  };
}

export function generatePinchGesture(opts: GeneratePinchOpts): MultiTouchGesture {
  requireFinitePoint('generatePinchGesture: startCentre', opts.startCentre);
  requirePositiveFinite('generatePinchGesture: startSpanPx', opts.startSpanPx);
  requirePositiveFinite('generatePinchGesture: endSpanPx', opts.endSpanPx);
  const seed = opts.seed ?? `pinch:${opts.startSpanPx}->${opts.endSpanPx}`;
  const rng = mulberry32(hashSeed(seed));
  const duration = opts.durationMs ?? 320;
  const samples = opts.samples ?? 12;
  const halfStart = opts.startSpanPx / 2;
  const halfEnd = opts.endSpanPx / 2;

  // Horizontal pinch — finger 1 left, finger 2 right.
  const finger1 = buildLinearTrack({
    fingerId: 1,
    start: { x: opts.startCentre.x - halfStart, y: opts.startCentre.y },
    end: { x: opts.startCentre.x - halfEnd, y: opts.startCentre.y },
    durationMs: duration,
    samples,
    rng,
  });
  // Finger 2's touchstart trails finger 1 by a seeded-jittered lag so the
  // two fingers never land on the exact same tick (mirrors the harness
  // secondFingerLagMs); start/end coordinates are unchanged.
  const finger2 = staggerTrackStart(
    buildLinearTrack({
      fingerId: 2,
      start: { x: opts.startCentre.x + halfStart, y: opts.startCentre.y },
      end: { x: opts.startCentre.x + halfEnd, y: opts.startCentre.y },
      durationMs: duration,
      samples,
      rng,
    }),
    fingerStartLagMs(rng),
  );

  return {
    kind: 'pinch',
    fingers: [finger1, finger2],
    durationMs: gestureDurationMs([finger1, finger2], duration),
    seed,
  };
}

export function generateTwoFingerScrollGesture(
  opts: GenerateTwoFingerScrollOpts,
): MultiTouchGesture {
  requireFinitePoint('generateTwoFingerScrollGesture: start', opts.start);
  requirePositiveFinite('generateTwoFingerScrollGesture: distancePx', opts.distancePx);
  if (opts.fingerSeparationPx !== undefined) {
    requirePositiveFinite(
      'generateTwoFingerScrollGesture: fingerSeparationPx',
      opts.fingerSeparationPx,
    );
  }
  const seed = opts.seed ?? `two-finger-scroll:${opts.direction}:${String(opts.distancePx)}`;
  const rng = mulberry32(hashSeed(seed));
  const duration = opts.durationMs ?? 220;
  const samples = opts.samples ?? 10;
  const sep = opts.fingerSeparationPx ?? 80;
  const dir = dirVector(opts.direction);

  const f1Start = { x: opts.start.x, y: opts.start.y };
  const f2Start = { x: opts.start.x + sep, y: opts.start.y };
  const f1End = {
    x: f1Start.x + dir.dx * opts.distancePx,
    y: f1Start.y + dir.dy * opts.distancePx,
  };
  const f2End = {
    x: f2Start.x + dir.dx * opts.distancePx,
    y: f2Start.y + dir.dy * opts.distancePx,
  };

  const finger1 = buildLinearTrack({
    fingerId: 1,
    start: f1Start,
    end: f1End,
    durationMs: duration,
    samples,
    rng,
  });
  // Finger 2 lands a seeded-jittered beat after finger 1 (no perfectly
  // synchronized two-finger touchstart).
  const finger2 = staggerTrackStart(
    buildLinearTrack({
      fingerId: 2,
      start: f2Start,
      end: f2End,
      durationMs: duration,
      samples,
      rng,
    }),
    fingerStartLagMs(rng),
  );

  return {
    kind: 'two-finger-scroll',
    fingers: [finger1, finger2],
    durationMs: gestureDurationMs([finger1, finger2], duration),
    seed,
  };
}

export function generateThreeFingerSwipeGesture(
  opts: GenerateThreeFingerSwipeOpts,
): MultiTouchGesture {
  requireFinitePoint('generateThreeFingerSwipeGesture: start', opts.start);
  requirePositiveFinite('generateThreeFingerSwipeGesture: distancePx', opts.distancePx);
  if (opts.fingerSeparationPx !== undefined) {
    requirePositiveFinite(
      'generateThreeFingerSwipeGesture: fingerSeparationPx',
      opts.fingerSeparationPx,
    );
  }
  const seed = opts.seed ?? `three-finger-swipe:${opts.direction}:${String(opts.distancePx)}`;
  const rng = mulberry32(hashSeed(seed));
  const duration = opts.durationMs ?? 280;
  const samples = opts.samples ?? 10;
  const sep = opts.fingerSeparationPx ?? 60;
  const dir = dirVector(opts.direction);

  // Three fingers laid out horizontally; centre finger at opts.start.
  const fingerStarts = [
    { x: opts.start.x - sep, y: opts.start.y },
    { x: opts.start.x, y: opts.start.y },
    { x: opts.start.x + sep, y: opts.start.y },
  ];

  const fingers: FingerTrack[] = fingerStarts.map((start, i) => {
    const track = buildLinearTrack({
      fingerId: i + 1,
      start,
      end: {
        x: start.x + dir.dx * opts.distancePx,
        y: start.y + dir.dy * opts.distancePx,
      },
      durationMs: duration,
      samples,
      rng,
    });
    // Finger 1 (i === 0) lands first; fingers 2/3 trail it by a seeded lag
    // so the three fingers never land on the exact same tick.
    return i === 0 ? track : staggerTrackStart(track, fingerStartLagMs(rng));
  });

  return {
    kind: 'three-finger-swipe',
    fingers,
    durationMs: gestureDurationMs(fingers, duration),
    seed,
  };
}

/** Interleave per-finger samples into a single time-ordered stream
 *  with stable ordering on ties (finger-id ascending). Useful for
 *  drivers that need a single dispatch queue. */
export function interleaveGestureStream(
  gesture: MultiTouchGesture,
): ReadonlyArray<FingerSample & { fingerId: number }> {
  const stream: Array<FingerSample & { fingerId: number }> = [];
  for (const finger of gesture.fingers) {
    for (const sample of finger.samples) {
      stream.push({ ...sample, fingerId: finger.fingerId });
    }
  }
  stream.sort((a, b) => {
    if (a.tMs !== b.tMs) return a.tMs - b.tMs;
    return a.fingerId - b.fingerId;
  });
  return stream;
}
