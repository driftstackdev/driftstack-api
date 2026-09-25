// scripts/gui-text-quality.mjs — two holes that let the Simulator ship clipped
// text through a gate that reported 0 findings (gui-v0.1.72):
//
//   1. CLIPPED — the agent-driving pill read "…switch to Manual to take cont":
//      `whitespace-nowrap`, wider than the phone, cut by the phone's own
//      `overflow: hidden`. The truncation rule looked only at an element with
//      `text-overflow: ellipsis` on itself, so a hard cut by an ANCESTOR was
//      invisible to it. The gate now measures the rendered text against every
//      clipping box above it (a scroller ends the walk: what it hides is
//      reachable).
//   2. CUT-NO-TITLE — the rail label read "Downlo…" and passed, because the
//      rule accepted an `aria-label` anywhere within six ancestors as the way to
//      the full text. An aria-label is read to a screen reader and shown to
//      nobody; the rule now takes a `title` only.
//
// Runs the gate's REAL in-page measurement (`measureStage`, extracted from the
// script, as the-text-quality-gate-reads-a-gradient-as-a-background does) over a
// fixture DOM with stubbed styles and boxes. The script's `--control` run is the
// matching browser proof (two more injected elements).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GATE = readFileSync(resolve(__dirname, '../../../../scripts/gui-text-quality.mjs'), 'utf8');
const MEASURE_SRC = ((): string => {
  const start = GATE.indexOf('function measureStage(root, opts) {');
  const end = GATE.indexOf('/** Runs INSIDE the page: the positive control');
  if (start < 0 || end < 0) throw new Error('measureStage not found in gui-text-quality.mjs');
  return GATE.slice(start, end);
})();

interface Box {
  left: number;
  right: number;
  top?: number;
  bottom?: number;
}
interface Style {
  overflowX?: string;
  overflowY?: string;
  textOverflow?: string;
  position?: string;
}
type Measured = {
  leafCount: number;
  truncatedNoTitle: Array<{ el: string }>;
  clipped?: Array<{ el: string; by: string; over: number }>;
};

const styles = new Map<Element, Style>();
const boxes = new Map<Element, Box>();
/** The rendered extent of each element's OWN text. */
const textBoxes = new Map<Element, Box>();

function rect(b: Box): DOMRect {
  const top = b.top ?? 0;
  const bottom = b.bottom ?? 16;
  return {
    left: b.left,
    right: b.right,
    top,
    bottom,
    width: b.right - b.left,
    height: bottom - top,
    x: b.left,
    y: top,
    toJSON: () => ({}),
  };
}

function computed(el: Element): Record<string, string> {
  const s = styles.get(el) ?? {};
  const ox = s.overflowX ?? 'visible';
  const oy = s.overflowY ?? 'visible';
  return {
    backgroundColor: el === document.body ? 'rgb(0, 0, 0)' : 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    color: 'rgb(255, 255, 255)',
    opacity: '1',
    fontSize: '12px',
    fontWeight: '400',
    display: 'block',
    visibility: 'visible',
    textOverflow: s.textOverflow ?? 'clip',
    overflow: ox === oy ? ox : `${ox} ${oy}`,
    overflowX: ox,
    overflowY: oy,
    webkitLineClamp: 'none',
    position: s.position ?? 'static',
    transform: 'none',
    filter: 'none',
    perspective: 'none',
    contain: 'none',
  };
}

/** `document`, with a createRange whose rects are the element's text box. */
const doc = {
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
  get body() {
    return document.body;
  },
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- runs the gate script's own in-page measurement: that function IS the thing under test
const measureStage = new Function(
  'getComputedStyle',
  'document',
  'Node',
  `${MEASURE_SRC}; return measureStage;`,
)(computed, doc, Node) as (root: Element, opts: unknown) => Measured;

function stage(build: (root: HTMLElement) => void): Measured {
  document.body.innerHTML = '';
  styles.clear();
  boxes.clear();
  textBoxes.clear();
  const root = document.createElement('div');
  document.body.appendChild(root);
  boxes.set(root, { left: 0, right: 800, bottom: 600 });
  build(root);
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const b = boxes.get(el) ?? { left: 0, right: 100 };
    (el as HTMLElement).getBoundingClientRect = () => rect(b);
  }
  return measureStage(root, { MIN_PX: 9, CONTROL_COMPONENT: 'scene-quality-control' });
}
function add(
  parent: Element,
  tag: string,
  opts: { style?: Style; box?: Box; text?: string; textBox?: Box; attrs?: Record<string, string> },
): HTMLElement {
  const el = document.createElement(tag);
  if (opts.text !== undefined) el.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);
  parent.appendChild(el);
  if (opts.style !== undefined) styles.set(el, opts.style);
  if (opts.box !== undefined) boxes.set(el, opts.box);
  if (opts.textBox !== undefined) textBoxes.set(el, opts.textBox);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  styles.clear();
  boxes.clear();
  textBoxes.clear();
});

/** The phone (a 261px screen that clips) and, on it, a one-line pill. */
function phoneWithPill(
  pillText: Box,
  screenStyle: Style = { overflowX: 'hidden', overflowY: 'hidden' },
) {
  return stage((root) => {
    const screen = add(root, 'div', {
      style: screenStyle,
      box: { left: 10, right: 271, bottom: 600 },
      attrs: { 'data-component': 'simulator-screen' },
    });
    add(screen, 'button', {
      box: { left: pillText.left - 16, right: pillText.right + 16 },
      text: 'Agent is driving — switch to Manual to take control',
      textBox: pillText,
      attrs: { 'data-component': 'ai-driving-badge' },
    });
  });
}

describe('the text-quality gate sees text cut off without an ellipsis', () => {
  it('CRITICAL a one-line pill wider than the phone, cut by the phone’s overflow, is a CLIPPED finding — measured on the text, naming the box that cut it', () => {
    // The 842×718 window, measured: the pill's text ran 33…304 inside a 10…271
    // screen, cut at the right.
    const res = phoneWithPill({ left: 33, right: 304 });
    expect(res.clipped).toHaveLength(1);
    expect(res.clipped![0]!.el).toMatch(/ai-driving-badge/);
    expect(res.clipped![0]!.by).toMatch(/simulator-screen/);
    expect(res.clipped![0]!.over).toBe(33);
  });

  it('the same pill once it wraps inside the phone is not a finding', () => {
    expect(phoneWithPill({ left: 54, right: 202 }).clipped).toEqual([]);
  });

  it('text a SCROLLER hides is reachable by scrolling — not a finding in that axis', () => {
    const res = phoneWithPill({ left: 33, right: 304 }, { overflowX: 'auto', overflowY: 'auto' });
    expect(res.clipped).toEqual([]);
  });

  it('a box that marks its own cut with an ellipsis is the truncation rule’s, not this one’s', () => {
    const res = stage((root) => {
      add(root, 'span', {
        style: { overflowX: 'hidden', overflowY: 'hidden', textOverflow: 'ellipsis' },
        box: { left: 0, right: 42 },
        text: 'Downloads',
        textBox: { left: 0, right: 47 },
        attrs: { title: 'Downloads' },
      });
    });
    expect(res.clipped).toEqual([]);
  });

  it('only boxes on the CONTAINING-BLOCK chain clip: an absolutely positioned flyout escapes an unpositioned `overflow: hidden` parent — and is cut by a POSITIONED one', () => {
    const flyout = (parentStyle: Style): Measured =>
      stage((root) => {
        const clip = add(root, 'div', {
          style: { overflowX: 'hidden', overflowY: 'hidden', ...parentStyle },
          box: { left: 0, right: 44, bottom: 40 },
        });
        add(clip, 'span', {
          style: { position: 'absolute' },
          box: { left: -80, right: -4 },
          text: 'Downloads',
          textBox: { left: -76, right: -8 },
        });
      });
    // Unpositioned parent: not the flyout's containing block, so it does not
    // clip it — the Simulator rail's hover label sits over the phone this way.
    expect(flyout({}).clipped).toEqual([]);
    // Positioned parent: it IS the containing block, and it cuts the text.
    expect(flyout({ position: 'relative' }).clipped).toHaveLength(1);
  });

  it('VACUITY: a 1px visually-hidden label (sr-only) is not text anyone sees cut', () => {
    const res = stage((root) => {
      const wrap = add(root, 'div', {
        style: { overflowX: 'hidden', overflowY: 'hidden' },
        box: { left: 0, right: 1, bottom: 1 },
      });
      add(wrap, 'span', {
        box: { left: 0, right: 1, bottom: 1 },
        text: 'Search',
        textBox: { left: 0, right: 40 },
      });
    });
    expect(res.clipped).toEqual([]);
  });
});

describe('the truncation rule takes a TITLE, never an aria-label alone', () => {
  const railLabel = (buttonAttrs: Record<string, string>): Measured =>
    stage((root) => {
      // The rail's button, named for a screen reader; its visible label is 42px
      // wide and "Downloads" needs 47.
      const button = add(root, 'button', { attrs: buttonAttrs });
      const label = add(button, 'span', {
        style: { overflowX: 'hidden', overflowY: 'hidden', textOverflow: 'ellipsis' },
        box: { left: 0, right: 42 },
        text: 'Downloads',
        textBox: { left: 0, right: 47 },
        attrs: { 'aria-hidden': 'true', 'data-component': 'sim-rail-label-downloads' },
      });
      Object.defineProperty(label, 'scrollWidth', { value: 47 });
      Object.defineProperty(label, 'clientWidth', { value: 42 });
    });

  it('CRITICAL an ellipsed label whose only name is its button’s aria-label is CUT-NO-TITLE — a sighted reader has no way to the rest of the word', () => {
    const res = railLabel({ 'aria-label': 'Downloads' });
    expect(res.truncatedNoTitle).toHaveLength(1);
    expect(res.truncatedNoTitle[0]!.el).toMatch(/sim-rail-label-downloads/);
  });

  it('VACUITY: the same label with a title (the full text on hover) passes, as it always did', () => {
    expect(railLabel({ 'aria-label': 'Downloads', title: 'Downloads' }).truncatedNoTitle).toEqual(
      [],
    );
  });
});
