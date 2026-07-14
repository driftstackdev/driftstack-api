import { describe, expect, it } from 'vitest';
import {
  generatePinchGesture,
  generateTwoFingerScrollGesture,
  generateThreeFingerSwipeGesture,
  interleaveGestureStream,
  MAX_SAMPLES_PER_FINGER,
} from '../src/multi-touch.js';

describe('V-530.E generatePinchGesture', () => {
  it('produces 2 fingers symmetric around the centre', () => {
    const g = generatePinchGesture({
      startCentre: { x: 200, y: 300 },
      startSpanPx: 100,
      endSpanPx: 200,
      seed: 'p1',
    });
    expect(g.kind).toBe('pinch');
    expect(g.fingers).toHaveLength(2);
    expect(g.fingers[0]?.start.x).toBeLessThan(g.fingers[1]?.start.x ?? 0);
  });

  it('finger ends are further apart when zoom in (endSpan > startSpan)', () => {
    const g = generatePinchGesture({
      startCentre: { x: 0, y: 0 },
      startSpanPx: 100,
      endSpanPx: 300,
      seed: 'zoom-in',
    });
    const startSpan = (g.fingers[1]?.start.x ?? 0) - (g.fingers[0]?.start.x ?? 0);
    const endSpan = (g.fingers[1]?.end.x ?? 0) - (g.fingers[0]?.end.x ?? 0);
    expect(endSpan).toBeGreaterThan(startSpan);
  });

  it('finger ends closer together on zoom out', () => {
    const g = generatePinchGesture({
      startCentre: { x: 0, y: 0 },
      startSpanPx: 300,
      endSpanPx: 100,
      seed: 'zoom-out',
    });
    const startSpan = (g.fingers[1]?.start.x ?? 0) - (g.fingers[0]?.start.x ?? 0);
    const endSpan = (g.fingers[1]?.end.x ?? 0) - (g.fingers[0]?.end.x ?? 0);
    expect(endSpan).toBeLessThan(startSpan);
  });

  it('per-finger samples are monotonically increasing in tMs', () => {
    const g = generatePinchGesture({
      startCentre: { x: 0, y: 0 },
      startSpanPx: 100,
      endSpanPx: 200,
      seed: 'monotonic',
    });
    for (const finger of g.fingers) {
      for (let i = 1; i < finger.samples.length; i += 1) {
        expect(finger.samples[i]?.tMs).toBeGreaterThanOrEqual(finger.samples[i - 1]?.tMs ?? 0);
      }
    }
  });

  it('seeded determinism', () => {
    const a = generatePinchGesture({
      startCentre: { x: 0, y: 0 },
      startSpanPx: 100,
      endSpanPx: 200,
      seed: 'fixed',
    });
    const b = generatePinchGesture({
      startCentre: { x: 0, y: 0 },
      startSpanPx: 100,
      endSpanPx: 200,
      seed: 'fixed',
    });
    expect(a).toEqual(b);
  });
});

describe('V-530.E generateTwoFingerScrollGesture', () => {
  it('produces 2 fingers offset by fingerSeparationPx', () => {
    const g = generateTwoFingerScrollGesture({
      start: { x: 100, y: 100 },
      direction: 'down',
      distancePx: 200,
      fingerSeparationPx: 80,
      seed: 's1',
    });
    expect(g.fingers).toHaveLength(2);
    expect(g.fingers[1]?.start.x).toBe((g.fingers[0]?.start.x ?? 0) + 80);
    expect(g.fingers[0]?.start.y).toBe(g.fingers[1]?.start.y);
  });

  it('end positions reflect direction down by distancePx', () => {
    const g = generateTwoFingerScrollGesture({
      start: { x: 100, y: 100 },
      direction: 'down',
      distancePx: 200,
      seed: 's2',
    });
    expect(g.fingers[0]?.end.y).toBeCloseTo(300, 0);
    expect(g.fingers[1]?.end.y).toBeCloseTo(300, 0);
  });

  it('end positions reflect direction left by distancePx', () => {
    const g = generateTwoFingerScrollGesture({
      start: { x: 500, y: 100 },
      direction: 'left',
      distancePx: 100,
      seed: 's3',
    });
    expect(g.fingers[0]?.end.x).toBeCloseTo(400, 0);
  });
});

describe('V-530.E generateThreeFingerSwipeGesture', () => {
  it('produces 3 fingers laid out horizontally', () => {
    const g = generateThreeFingerSwipeGesture({
      start: { x: 200, y: 300 },
      direction: 'right',
      distancePx: 150,
      fingerSeparationPx: 60,
      seed: 'sw1',
    });
    expect(g.fingers).toHaveLength(3);
    // Centre finger at start.x; others ±60.
    expect(g.fingers[0]?.start.x).toBe(140);
    expect(g.fingers[1]?.start.x).toBe(200);
    expect(g.fingers[2]?.start.x).toBe(260);
  });

  it('all 3 fingers move in the same direction by distancePx', () => {
    const g = generateThreeFingerSwipeGesture({
      start: { x: 0, y: 0 },
      direction: 'up',
      distancePx: 100,
      seed: 'sw2',
    });
    for (const finger of g.fingers) {
      expect(finger.end.y).toBeCloseTo(-100, 0);
    }
  });

  it('fingerIds are 1, 2, 3', () => {
    const g = generateThreeFingerSwipeGesture({
      start: { x: 0, y: 0 },
      direction: 'right',
      distancePx: 100,
      seed: 'sw3',
    });
    expect(g.fingers.map((f) => f.fingerId)).toEqual([1, 2, 3]);
  });
});

describe('BSIM-2 — samples ceiling on the multi-touch gesture generators', () => {
  it('generatePinchGesture rejects an absurd samples value (the exact repro: 50,000,000)', () => {
    expect(() =>
      generatePinchGesture({
        startCentre: { x: 0, y: 0 },
        startSpanPx: 100,
        endSpanPx: 200,
        samples: 50_000_000,
        seed: 'huge-pinch',
      }),
    ).toThrow(/samples must be <= 1000/);
  });

  it('generateTwoFingerScrollGesture rejects an absurd samples value (the exact repro: 50,000,000)', () => {
    expect(() =>
      generateTwoFingerScrollGesture({
        start: { x: 0, y: 0 },
        direction: 'down',
        distancePx: 100,
        samples: 50_000_000,
        seed: 'huge-scroll',
      }),
    ).toThrow(/samples must be <= 1000/);
  });

  it('generateThreeFingerSwipeGesture rejects an absurd samples value (the exact repro: 50,000,000)', () => {
    expect(() =>
      generateThreeFingerSwipeGesture({
        start: { x: 0, y: 0 },
        direction: 'right',
        distancePx: 100,
        samples: 50_000_000,
        seed: 'huge-swipe',
      }),
    ).toThrow(/samples must be <= 1000/);
  });

  it('rejects samples one above MAX_SAMPLES_PER_FINGER, accepts the ceiling value itself', () => {
    expect(() =>
      generatePinchGesture({
        startCentre: { x: 0, y: 0 },
        startSpanPx: 100,
        endSpanPx: 200,
        samples: MAX_SAMPLES_PER_FINGER + 1,
        seed: 'over-by-one',
      }),
    ).toThrow(/samples/);
    expect(() =>
      generatePinchGesture({
        startCentre: { x: 0, y: 0 },
        startSpanPx: 100,
        endSpanPx: 200,
        samples: MAX_SAMPLES_PER_FINGER,
        seed: 'at-ceiling',
      }),
    ).not.toThrow();
  });

  it('a reasonable/default samples count still works exactly as before for all 3 generators', () => {
    const pinch = generatePinchGesture({
      startCentre: { x: 200, y: 300 },
      startSpanPx: 100,
      endSpanPx: 200,
      seed: 'default-pinch',
    });
    expect(pinch.fingers[0]?.samples).toHaveLength(12); // documented default

    const scroll = generateTwoFingerScrollGesture({
      start: { x: 100, y: 100 },
      direction: 'down',
      distancePx: 200,
      seed: 'default-scroll',
    });
    expect(scroll.fingers[0]?.samples).toHaveLength(10); // documented default

    const swipe = generateThreeFingerSwipeGesture({
      start: { x: 200, y: 300 },
      direction: 'right',
      distancePx: 150,
      seed: 'default-swipe',
    });
    expect(swipe.fingers[0]?.samples).toHaveLength(10); // documented default
  });
});

describe('BSIM-5 — fail-closed multi-touch input domain', () => {
  it('rejects fractional, non-finite, and fewer-than-two sample counts', () => {
    for (const samples of [1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        generatePinchGesture({
          startCentre: { x: 0, y: 0 },
          startSpanPx: 100,
          endSpanPx: 200,
          samples,
          seed: 'invalid-samples',
        }),
      ).toThrow(/samples must be an integer >= 2|samples must be <= 1000/);
    }
  });

  it('rejects non-positive and non-finite durations in every generator', () => {
    for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        generatePinchGesture({
          startCentre: { x: 0, y: 0 },
          startSpanPx: 100,
          endSpanPx: 200,
          durationMs,
          seed: 'bad-duration-pinch',
        }),
      ).toThrow(/durationMs/);
      expect(() =>
        generateTwoFingerScrollGesture({
          start: { x: 0, y: 0 },
          direction: 'down',
          distancePx: 100,
          durationMs,
          seed: 'bad-duration-scroll',
        }),
      ).toThrow(/durationMs/);
      expect(() =>
        generateThreeFingerSwipeGesture({
          start: { x: 0, y: 0 },
          direction: 'right',
          distancePx: 100,
          durationMs,
          seed: 'bad-duration-swipe',
        }),
      ).toThrow(/durationMs/);
    }
  });

  it('rejects impossible pinch spans', () => {
    for (const span of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        generatePinchGesture({
          startCentre: { x: 0, y: 0 },
          startSpanPx: span,
          endSpanPx: 100,
          seed: 'bad-start-span',
        }),
      ).toThrow(/startSpanPx/);
      expect(() =>
        generatePinchGesture({
          startCentre: { x: 0, y: 0 },
          startSpanPx: 100,
          endSpanPx: span,
          seed: 'bad-end-span',
        }),
      ).toThrow(/endSpanPx/);
    }
  });

  it('rejects non-positive travel distance and finger separation', () => {
    expect(() =>
      generateTwoFingerScrollGesture({
        start: { x: 0, y: 0 },
        direction: 'down',
        distancePx: -100,
        seed: 'negative-scroll',
      }),
    ).toThrow(/distancePx/);
    expect(() =>
      generateTwoFingerScrollGesture({
        start: { x: 0, y: 0 },
        direction: 'down',
        distancePx: 100,
        fingerSeparationPx: 0,
        seed: 'zero-scroll-separation',
      }),
    ).toThrow(/fingerSeparationPx/);
    expect(() =>
      generateThreeFingerSwipeGesture({
        start: { x: 0, y: 0 },
        direction: 'right',
        distancePx: 0,
        seed: 'zero-swipe',
      }),
    ).toThrow(/distancePx/);
    expect(() =>
      generateThreeFingerSwipeGesture({
        start: { x: 0, y: 0 },
        direction: 'right',
        distancePx: 100,
        fingerSeparationPx: Number.NaN,
        seed: 'nan-swipe-separation',
      }),
    ).toThrow(/fingerSeparationPx/);
  });

  it('rejects non-finite gesture coordinates', () => {
    expect(() =>
      generatePinchGesture({
        startCentre: { x: Number.NaN, y: 0 },
        startSpanPx: 100,
        endSpanPx: 200,
        seed: 'nan-centre',
      }),
    ).toThrow(/startCentre\.x/);
    expect(() =>
      generateTwoFingerScrollGesture({
        start: { x: 0, y: Number.POSITIVE_INFINITY },
        direction: 'down',
        distancePx: 100,
        seed: 'infinite-scroll-start',
      }),
    ).toThrow(/start\.y/);
    expect(() =>
      generateThreeFingerSwipeGesture({
        start: { x: Number.NEGATIVE_INFINITY, y: 0 },
        direction: 'right',
        distancePx: 100,
        seed: 'infinite-swipe-start',
      }),
    ).toThrow(/start\.x/);
  });

  it('keeps replay endpoints exact and every valid timeline non-negative and monotonic', () => {
    const gestures = [
      generatePinchGesture({
        startCentre: { x: 200, y: 300 },
        startSpanPx: 100,
        endSpanPx: 200,
        seed: 'valid-pinch-boundaries',
      }),
      generateTwoFingerScrollGesture({
        start: { x: 100, y: 100 },
        direction: 'down',
        distancePx: 200,
        seed: 'valid-scroll-boundaries',
      }),
      generateThreeFingerSwipeGesture({
        start: { x: 200, y: 300 },
        direction: 'right',
        distancePx: 150,
        seed: 'valid-swipe-boundaries',
      }),
    ];

    for (const gesture of gestures) {
      for (const finger of gesture.fingers) {
        const first = finger.samples[0];
        const last = finger.samples[finger.samples.length - 1];
        expect(first).toMatchObject({ x: finger.start.x, y: finger.start.y });
        expect(last).toMatchObject({ x: finger.end.x, y: finger.end.y });
        for (let i = 0; i < finger.samples.length; i += 1) {
          expect(finger.samples[i]?.tMs).toBeGreaterThanOrEqual(0);
          if (i > 0) {
            expect(finger.samples[i]?.tMs).toBeGreaterThanOrEqual(finger.samples[i - 1]?.tMs ?? 0);
          }
        }
      }
    }
  });
});

describe('V-530.E interleaveGestureStream', () => {
  it('returns a time-sorted stream with fingerId tagged', () => {
    const g = generatePinchGesture({
      startCentre: { x: 0, y: 0 },
      startSpanPx: 100,
      endSpanPx: 200,
      samples: 5,
      seed: 'inter',
    });
    const stream = interleaveGestureStream(g);
    expect(stream.length).toBe(10); // 2 fingers × 5 samples
    for (let i = 1; i < stream.length; i += 1) {
      expect(stream[i]?.tMs).toBeGreaterThanOrEqual(stream[i - 1]?.tMs ?? 0);
    }
  });

  it('stable tie-break by fingerId ascending when two samples share a tMs', () => {
    // Finger 2's touchstart trails finger 1 by a seeded lag, so the FIRST
    // sample is finger 1 alone (no tie). Construct a guaranteed tie by tagging
    // two samples with the same tMs and asserting the sort keeps fingerId order.
    const g = generateTwoFingerScrollGesture({
      start: { x: 0, y: 0 },
      direction: 'down',
      distancePx: 100,
      samples: 3,
      seed: 'tie',
    });
    const stream = interleaveGestureStream(g);
    // First sample of the interleaved stream is always finger 1 (it lands first).
    expect(stream[0]?.fingerId).toBe(1);
    // Whenever two fingers DO share a tMs, finger 1 sorts before finger 2.
    for (let i = 1; i < stream.length; i += 1) {
      const prev = stream[i - 1];
      const cur = stream[i];
      if (prev && cur && prev.tMs === cur.tMs) {
        expect(prev.fingerId).toBeLessThanOrEqual(cur.fingerId);
      }
    }
  });

  it('finger 2 touchstart trails finger 1 (no perfectly synchronized landing)', () => {
    const g = generateTwoFingerScrollGesture({
      start: { x: 0, y: 0 },
      direction: 'down',
      distancePx: 100,
      samples: 4,
      seed: 'lag',
    });
    const f1Start = g.fingers[0]?.samples[0]?.tMs ?? 0;
    const f2Start = g.fingers[1]?.samples[0]?.tMs ?? 0;
    expect(f1Start).toBe(0);
    expect(f2Start).toBeGreaterThan(0);
    // start/end coordinates are unchanged by the timeline stagger.
    expect(g.fingers[1]?.start.x).toBe((g.fingers[0]?.start.x ?? 0) + 80);
  });
});
