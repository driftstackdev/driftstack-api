import { describe, expect, it } from 'vitest';
import {
  CLICK_REGIONS,
  DWELL_SHAPES,
  generateRegionAwareTouchEvent,
  type ClickRegion,
  type ElementBounds,
  type ElementClass,
} from '../src/index.js';

const ALL_CLASSES: readonly ElementClass[] = [
  'button',
  'link',
  'input',
  'image',
  'video',
  'scroll-container',
  'generic',
];

const SAMPLE_BOUNDS: ElementBounds = { x: 100, y: 200, width: 100, height: 50 };

function seeds(count: number, label: string): readonly string[] {
  return Array.from({ length: count }, (_, i) => `${label}:${i}`);
}

describe('V-530.C dwell + region tables — invariants', () => {
  it('every element class has a registered dwell shape', () => {
    for (const klass of ALL_CLASSES) {
      expect(DWELL_SHAPES[klass]).toBeDefined();
    }
  });

  it('every element class has at least one click region', () => {
    for (const klass of ALL_CLASSES) {
      expect(CLICK_REGIONS[klass].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all click region centres + radii are within [0, 1]', () => {
    for (const klass of ALL_CLASSES) {
      for (const region of CLICK_REGIONS[klass]) {
        expect(region.center.x).toBeGreaterThanOrEqual(0);
        expect(region.center.x).toBeLessThanOrEqual(1);
        expect(region.center.y).toBeGreaterThanOrEqual(0);
        expect(region.center.y).toBeLessThanOrEqual(1);
        expect(region.radius.x).toBeGreaterThan(0);
        expect(region.radius.x).toBeLessThanOrEqual(0.5);
        expect(region.radius.y).toBeGreaterThan(0);
        expect(region.radius.y).toBeLessThanOrEqual(0.5);
        expect(region.weight).toBeGreaterThan(0);
      }
    }
  });

  it('click regions stay within element bounds [0, 1] when centre ± radius', () => {
    for (const klass of ALL_CLASSES) {
      for (const region of CLICK_REGIONS[klass]) {
        expect(region.center.x - region.radius.x).toBeGreaterThanOrEqual(0);
        expect(region.center.x + region.radius.x).toBeLessThanOrEqual(1);
        expect(region.center.y - region.radius.y).toBeGreaterThanOrEqual(0);
        expect(region.center.y + region.radius.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('button + link have tight dwell; image + video + scroll-container have long-tailed', () => {
    expect(DWELL_SHAPES.button).toBe('tight');
    expect(DWELL_SHAPES.link).toBe('tight');
    expect(DWELL_SHAPES.image).toBe('long-tailed');
    expect(DWELL_SHAPES.video).toBe('long-tailed');
    expect(DWELL_SHAPES['scroll-container']).toBe('long-tailed');
  });
});

describe('V-530.C region-aware touch generator — properties', () => {
  it('is deterministic: identical inputs → identical event', () => {
    for (const klass of ALL_CLASSES) {
      const a = generateRegionAwareTouchEvent({
        elementClass: klass,
        bounds: SAMPLE_BOUNDS,
        seed: 'detX',
      });
      const b = generateRegionAwareTouchEvent({
        elementClass: klass,
        bounds: SAMPLE_BOUNDS,
        seed: 'detX',
      });
      expect(a).toEqual(b);
    }
  });

  it('start + end + sample points stay within original element bounds', () => {
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(64, `bounds-${klass}`)) {
        const ev = generateRegionAwareTouchEvent({
          elementClass: klass,
          bounds: SAMPLE_BOUNDS,
          seed,
        });
        for (const point of [ev.start, ev.end, ...ev.samples]) {
          expect(point.x).toBeGreaterThanOrEqual(SAMPLE_BOUNDS.x);
          expect(point.x).toBeLessThanOrEqual(SAMPLE_BOUNDS.x + SAMPLE_BOUNDS.width);
          expect(point.y).toBeGreaterThanOrEqual(SAMPLE_BOUNDS.y);
          expect(point.y).toBeLessThanOrEqual(SAMPLE_BOUNDS.y + SAMPLE_BOUNDS.height);
        }
      }
    }
  });

  it('tiny (<2px) target keeps every emitted point within opts.bounds (region-floor clip)', () => {
    // A sub-~2px element: the Math.max(1, …) region-bounds floor inflates the
    // region past the element edge, so the underlying generator (clipping only
    // to the widened region) could emit start/end/sample coords OUTSIDE the
    // element. Assert the FINAL emitted points are clipped to opts.bounds.
    const tinyBounds: ElementBounds = { x: 300, y: 400, width: 1, height: 1 };
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(64, `tiny-${klass}`)) {
        const ev = generateRegionAwareTouchEvent({
          elementClass: klass,
          bounds: tinyBounds,
          seed,
        });
        for (const point of [ev.start, ev.end, ...ev.samples]) {
          expect(point.x).toBeGreaterThanOrEqual(tinyBounds.x);
          expect(point.x).toBeLessThanOrEqual(tinyBounds.x + tinyBounds.width);
          expect(point.y).toBeGreaterThanOrEqual(tinyBounds.y);
          expect(point.y).toBeLessThanOrEqual(tinyBounds.y + tinyBounds.height);
        }
      }
    }
  });

  it('selectedRegionIndex is a valid index into CLICK_REGIONS for that class', () => {
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(32, `rindex-${klass}`)) {
        const ev = generateRegionAwareTouchEvent({
          elementClass: klass,
          bounds: SAMPLE_BOUNDS,
          seed,
        });
        expect(ev.selectedRegionIndex).toBeGreaterThanOrEqual(0);
        expect(ev.selectedRegionIndex).toBeLessThan(CLICK_REGIONS[klass].length);
      }
    }
  });

  it('dwellShape matches the class table', () => {
    for (const klass of ALL_CLASSES) {
      const ev = generateRegionAwareTouchEvent({
        elementClass: klass,
        bounds: SAMPLE_BOUNDS,
        seed: 'shape',
      });
      expect(ev.dwellShape).toBe(DWELL_SHAPES[klass]);
    }
  });

  it('dwellMultiplier is positive', () => {
    for (const klass of ALL_CLASSES) {
      for (const seed of seeds(32, `mult-${klass}`)) {
        const ev = generateRegionAwareTouchEvent({
          elementClass: klass,
          bounds: SAMPLE_BOUNDS,
          seed,
        });
        expect(ev.dwellMultiplier).toBeGreaterThan(0);
      }
    }
  });

  it('image (2 regions) selects both regions over many seeds', () => {
    // Image has 2 regions with weight 0.7 + 0.3. Across 200 seeds we
    // expect to see both indices appear at least once.
    const seenRegions = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const ev = generateRegionAwareTouchEvent({
        elementClass: 'image',
        bounds: SAMPLE_BOUNDS,
        seed: `image-region-${i}`,
      });
      seenRegions.add(ev.selectedRegionIndex);
    }
    expect(seenRegions.has(0)).toBe(true);
    expect(seenRegions.has(1)).toBe(true);
  });

  it('button (1 region) always selects region 0', () => {
    for (const seed of seeds(50, 'button-region')) {
      const ev = generateRegionAwareTouchEvent({
        elementClass: 'button',
        bounds: SAMPLE_BOUNDS,
        seed,
      });
      expect(ev.selectedRegionIndex).toBe(0);
    }
  });

  it('image region 0 (weight 0.7) is chosen more often than region 1 (weight 0.3)', () => {
    let r0Count = 0;
    let r1Count = 0;
    for (let i = 0; i < 500; i += 1) {
      const ev = generateRegionAwareTouchEvent({
        elementClass: 'image',
        bounds: SAMPLE_BOUNDS,
        seed: `image-weight-${i}`,
      });
      if (ev.selectedRegionIndex === 0) r0Count += 1;
      else if (ev.selectedRegionIndex === 1) r1Count += 1;
    }
    expect(r0Count).toBeGreaterThan(r1Count);
    // Allow some statistical slack; 0.7/0.3 ratio implies r0 ≈ 2.33 * r1.
    expect(r0Count / r1Count).toBeGreaterThan(1.5);
  });

  it('long-tailed dwell has higher max multiplier than tight dwell', () => {
    let buttonMax = -Infinity;
    let imageMax = -Infinity;
    for (let i = 0; i < 500; i += 1) {
      buttonMax = Math.max(
        buttonMax,
        generateRegionAwareTouchEvent({
          elementClass: 'button',
          bounds: SAMPLE_BOUNDS,
          seed: `tight-${i}`,
        }).dwellMultiplier,
      );
      imageMax = Math.max(
        imageMax,
        generateRegionAwareTouchEvent({
          elementClass: 'image',
          bounds: SAMPLE_BOUNDS,
          seed: `lt-${i}`,
        }).dwellMultiplier,
      );
    }
    expect(imageMax).toBeGreaterThan(buttonMax * 1.5);
  });

  it('custom regions override class defaults', () => {
    const customRegion: ClickRegion = {
      center: { x: 0.9, y: 0.9 },
      radius: { x: 0.05, y: 0.05 },
      weight: 1.0,
    };
    for (const seed of seeds(20, 'custom-region')) {
      const ev = generateRegionAwareTouchEvent({
        elementClass: 'button',
        bounds: SAMPLE_BOUNDS,
        regions: [customRegion],
        seed,
      });
      // The custom region is at (0.9, 0.9) with radius 0.05 — bottom-right.
      // start.x should land in [bounds.x + 0.85*width, bounds.x + 0.95*width].
      const xLo = SAMPLE_BOUNDS.x + SAMPLE_BOUNDS.width * 0.85;
      const xHi = SAMPLE_BOUNDS.x + SAMPLE_BOUNDS.width * 0.95;
      expect(ev.start.x).toBeGreaterThanOrEqual(xLo);
      expect(ev.start.x).toBeLessThanOrEqual(xHi);
    }
  });

  it('rejects empty regions list', () => {
    expect(() =>
      generateRegionAwareTouchEvent({
        elementClass: 'button',
        bounds: SAMPLE_BOUNDS,
        regions: [],
      }),
    ).toThrow(/at least one region/);
  });

  it('rejects zero-area bounds', () => {
    expect(() =>
      generateRegionAwareTouchEvent({
        elementClass: 'button',
        bounds: { x: 0, y: 0, width: 0, height: 50 },
      }),
    ).toThrow(/positive width/);
  });

  it('rejects a custom region that spills past the element edge (would touch off-element)', () => {
    expect(() =>
      generateRegionAwareTouchEvent({
        elementClass: 'button',
        bounds: SAMPLE_BOUNDS,
        // center 0.9 + radius 0.3 → 1.2, past the right edge.
        regions: [{ center: { x: 0.9, y: 0.5 }, radius: { x: 0.3, y: 0.2 }, weight: 1 }],
      }),
    ).toThrow(/must lie within the element/);
  });

  it('rejects a custom region with non-positive radius', () => {
    expect(() =>
      generateRegionAwareTouchEvent({
        elementClass: 'button',
        bounds: SAMPLE_BOUNDS,
        regions: [{ center: { x: 0.5, y: 0.5 }, radius: { x: 0, y: 0.2 }, weight: 1 }],
      }),
    ).toThrow(/must lie within the element/);
  });

  it('accepts a custom region exactly filling the element (center 0.5, radius 0.5)', () => {
    const ev = generateRegionAwareTouchEvent({
      elementClass: 'button',
      bounds: SAMPLE_BOUNDS,
      regions: [{ center: { x: 0.5, y: 0.5 }, radius: { x: 0.5, y: 0.5 }, weight: 1 }],
    });
    expect(ev.selectedRegionIndex).toBe(0);
  });

  it('regression pin — deterministic shape for fixed inputs', () => {
    const ev = generateRegionAwareTouchEvent({
      elementClass: 'button',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      seed: 'regression-v530c',
    });
    expect(ev.elementClass).toBe('button');
    expect(ev.selectedRegionIndex).toBe(0);
    expect(ev.dwellShape).toBe('tight');
    expect(ev.dwellMultiplier).toBeGreaterThan(0);
    expect(ev.start.x).toBeGreaterThanOrEqual(0);
    expect(ev.start.x).toBeLessThanOrEqual(100);
    // Re-call yields identical output.
    const evAgain = generateRegionAwareTouchEvent({
      elementClass: 'button',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      seed: 'regression-v530c',
    });
    expect(evAgain).toEqual(ev);
  });
});
