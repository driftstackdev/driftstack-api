// scripts/gui-visual-check.mjs, Phase E — the hole that let the Simulator ship
// a status-bar clock reading "7:4" through two render gates that reported 0.
//
// At the minimum window (792x560, Session pane open) the phone's screen is
// 211px wide and the Dynamic Island was a fixed 120px: it lay over the clock's
// last digit, the Wi-Fi glyph and half the battery (and over the cellular bars
// on every screen under ~322px). Nothing was CUT — no scroller, no clipping
// box, no ellipsis — so every rule both gates apply, all of them about
// overflow, looked straight past it. The sweep now asks what is painted ABOVE
// each text run and each glyph (`coveredInWindow`).
//
// Runs the gate's REAL in-page function, extracted from the script (as the two
// gui-text-quality tests beside this one do), over a fixture DOM with stubbed
// styles, boxes and hit testing. The browser proof is the sweep itself: on the
// pre-fix status bar it reported the cellular glyph in all 18 simulator cells
// and the clock + three glyphs in both 792x560 ones; after the fix, 0.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GATE = readFileSync(resolve(__dirname, '../../../../scripts/gui-visual-check.mjs'), 'utf8');
const FN_SRC = ((): string => {
  const start = GATE.indexOf('function coveredInWindow(root) {');
  const end = GATE.indexOf('/** One Phase E cell');
  if (start < 0 || end < 0) throw new Error('coveredInWindow not found in gui-visual-check.mjs');
  return GATE.slice(start, end);
})();

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Paint {
  opacity?: string;
  backgroundColor?: string;
  visibility?: string;
}
type Covered = Array<{
  el: string;
  text: string;
  by: string | null;
  covered: number;
  sampled: number;
}>;

const paints = new Map<Element, Paint>();
const boxes = new Map<Element, Box>();
/** The rendered box of each element's OWN text. */
const textBoxes = new Map<Element, Box>();
/** Paint order, TOPMOST FIRST — what `elementsFromPoint` walks. */
let paintOrder: Element[] = [];
/** Whether every `elementsFromPoint` call saw the pointer-events override. */
let overrideSeen: boolean[] = [];

function rect(b: Box): DOMRect {
  return {
    ...b,
    width: b.right - b.left,
    height: b.bottom - b.top,
    x: b.left,
    y: b.top,
    toJSON: () => ({}),
  };
}
const inside = (b: Box, x: number, y: number): boolean =>
  x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

function computed(el: Element): Record<string, string> {
  const p = paints.get(el) ?? {};
  return {
    opacity: p.opacity ?? '1',
    backgroundColor: p.backgroundColor ?? 'rgba(0, 0, 0, 0)',
    visibility: p.visibility ?? 'visible',
  };
}

const doc = {
  createElement: (tag: string) => document.createElement(tag),
  get head() {
    return document.head;
  },
  createRange: () => {
    let node: Node | null = null;
    return {
      selectNodeContents: (n: Node) => {
        node = n;
      },
      getClientRects: () => {
        const owner = node?.parentElement ?? null;
        const b = owner === null ? undefined : textBoxes.get(owner);
        return b === undefined ? [] : [rect(b)];
      },
    };
  },
  elementsFromPoint: (x: number, y: number): Element[] => {
    overrideSeen.push(
      Array.from(document.head.querySelectorAll('style')).some((s) =>
        (s.textContent ?? '').includes('pointer-events: auto !important'),
      ),
    );
    return paintOrder.filter((el) => {
      const b = boxes.get(el);
      return b !== undefined && inside(b, x, y);
    });
  },
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- runs the gate script's own in-page function: that function IS the thing under test
const coveredInWindow = new Function(
  'getComputedStyle',
  'document',
  `${FN_SRC}; return coveredInWindow;`,
)(computed, doc) as (root: Element) => Covered;

const SVG = 'http://www.w3.org/2000/svg';

function add(
  parent: Element,
  tag: string,
  opts: { box: Box; paint?: Paint; text?: string; textBox?: Box; attrs?: Record<string, string> },
): Element {
  const el = tag === 'svg' ? document.createElementNS(SVG, 'svg') : document.createElement(tag);
  if (opts.text !== undefined) el.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);
  parent.appendChild(el);
  boxes.set(el, opts.box);
  if (opts.paint !== undefined) paints.set(el, opts.paint);
  if (opts.textBox !== undefined) textBoxes.set(el, opts.textBox);
  (el as HTMLElement).getBoundingClientRect = () => rect(opts.box);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  paints.clear();
  boxes.clear();
  textBoxes.clear();
  paintOrder = [];
  overrideSeen = [];
});

/** The phone's status strip on a 211px screen (10…221), with the island at
 *  `island` and the clock + Wi-Fi glyph at their measured places. The island is
 *  absolutely positioned, so it paints ABOVE the in-flow clock and glyphs. */
function statusBar(island: { left: number; right: number }, clock: Box, wifi: Box): Covered {
  const root = document.createElement('div');
  document.body.appendChild(root);
  boxes.set(root, { left: 0, right: 792, top: 0, bottom: 560 });
  const strip = add(root, 'div', {
    box: { left: 10, right: 221, top: 100, bottom: 140 },
    paint: { backgroundColor: 'rgb(0, 0, 0)' },
    attrs: { 'data-component': 'simulator-statusbar', 'aria-hidden': 'true' },
  });
  const isl = add(strip, 'div', {
    box: { ...island, top: 104, bottom: 136 },
    paint: { backgroundColor: 'rgb(0, 0, 0)' },
    attrs: { 'data-component': 'sim-island' },
  });
  const time = add(strip, 'span', {
    box: clock,
    text: '7:48',
    textBox: clock,
    attrs: { 'data-component': 'sim-status-clock' },
  });
  const glyph = add(strip, 'svg', { box: wifi });
  paintOrder = [isl, time, glyph, strip, root];
  return coveredInWindow(root);
}

describe('the simulator sweep sees text painted under the Dynamic Island', () => {
  it('CRITICAL the minimum window’s status bar: the fixed 120px island over the clock and the Wi-Fi glyph — both findings, both naming the island', () => {
    // Measured at 792x560 before the fix: island 55.5…175.5, clock 34…64.3,
    // Wi-Fi 150…166.
    const res = statusBar(
      { left: 55.5, right: 175.5 },
      { left: 34, right: 64.3, top: 109.5, bottom: 130.5 },
      { left: 150, right: 166, top: 114, bottom: 126 },
    );
    expect(res.map((f) => f.el)).toEqual(['sim-status-clock', 'simulator-statusbar <svg>']);
    expect(res.every((f) => f.by === 'sim-island')).toBe(true);
    const clock = res[0]!;
    expect(clock.text).toBe('7:48');
    // Part of the clock is covered, not all of it — the "7:4" a reader saw.
    expect(clock.covered).toBeGreaterThan(0);
    expect(clock.covered).toBeLessThan(clock.sampled);
  });

  it('the same strip after the fix (island 72.8…138.2, the insets shrunk, the glyph moved clear) is not a finding', () => {
    const res = statusBar(
      { left: 82.8, right: 148.2 },
      { left: 24, right: 54.3, top: 109.5, bottom: 130.5 },
      { left: 160, right: 176, top: 114, bottom: 126 },
    );
    expect(res).toEqual([]);
  });

  it('every element is hit-testable while it samples (the strip is pointer-events: none), and the override is gone afterwards', () => {
    statusBar(
      { left: 55.5, right: 175.5 },
      { left: 34, right: 64.3, top: 109.5, bottom: 130.5 },
      { left: 150, right: 166, top: 114, bottom: 126 },
    );
    expect(overrideSeen.length).toBeGreaterThan(0);
    expect(overrideSeen.every(Boolean)).toBe(true);
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
  });
});

describe('VACUITY — only what HIDES the text counts as covering it', () => {
  /** A label with one element painted above it. */
  function labelUnder(over: Paint, attrs: Record<string, string> = {}): Covered {
    const root = document.createElement('div');
    document.body.appendChild(root);
    boxes.set(root, { left: 0, right: 400, top: 0, bottom: 400 });
    const label = add(root, 'span', {
      box: { left: 10, right: 90, top: 10, bottom: 26 },
      text: 'Controls',
      textBox: { left: 10, right: 90, top: 10, bottom: 26 },
      attrs,
    });
    const layer = add(root, 'span', {
      box: { left: 0, right: 100, top: 0, bottom: 40 },
      paint: over,
      attrs: { 'data-component': 'layer' },
    });
    paintOrder = [layer, label, root];
    return coveredInWindow(root);
  }

  it('an opaque layer over a label IS covering it (the positive arm of the three below)', () => {
    expect(labelUnder({ backgroundColor: 'rgb(29, 30, 36)' })).toHaveLength(1);
  });

  it('a hover flyout at opacity 0 covers nothing', () => {
    expect(labelUnder({ backgroundColor: 'rgb(29, 30, 36)', opacity: '0' })).toEqual([]);
  });

  it('a transparent layer (a click target, a gradient glow with no background colour) covers nothing', () => {
    expect(labelUnder({})).toEqual([]);
  });

  it('a faint wash (under half opaque) covers nothing', () => {
    expect(labelUnder({ backgroundColor: 'rgba(255, 255, 255, 0.3)' })).toEqual([]);
  });

  it('what the screen host holds stands for the live video, which the window’s overlays float over by design — skipped', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    boxes.set(root, { left: 0, right: 400, top: 0, bottom: 400 });
    const host = add(root, 'div', {
      box: { left: 0, right: 300, top: 0, bottom: 400 },
      attrs: { 'data-component': 'simulator-screen-host' },
    });
    const page = add(host, 'span', {
      box: { left: 20, right: 200, top: 350, bottom: 366 },
      text: 'shop.example.com',
      textBox: { left: 20, right: 200, top: 350, bottom: 366 },
    });
    const pill = add(root, 'button', {
      box: { left: 10, right: 290, top: 330, bottom: 390 },
      paint: { backgroundColor: 'rgba(20, 20, 24, 0.92)' },
      attrs: { 'data-component': 'ai-driving-badge' },
    });
    paintOrder = [pill, page, host, root];
    expect(coveredInWindow(root)).toEqual([]);
  });

  it('a point where the text is not painted at all (clipped away, off screen) is not sampled — that is the text gate’s CLIPPED rule', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    boxes.set(root, { left: 0, right: 400, top: 0, bottom: 400 });
    const label = add(root, 'span', {
      box: { left: 10, right: 90, top: 10, bottom: 26 },
      text: 'Controls',
      textBox: { left: 10, right: 90, top: 10, bottom: 26 },
    });
    const layer = add(root, 'span', {
      box: { left: 0, right: 100, top: 0, bottom: 40 },
      paint: { backgroundColor: 'rgb(0, 0, 0)' },
    });
    // Hit testing never reaches the label: it is clipped out of the picture.
    paintOrder = [layer, root];
    expect(label.isConnected).toBe(true);
    expect(coveredInWindow(root)).toEqual([]);
  });
});
