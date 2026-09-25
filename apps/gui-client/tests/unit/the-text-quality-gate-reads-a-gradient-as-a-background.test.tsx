// scripts/gui-text-quality.mjs — the WCAG gate over every harness scene — read
// `background-color` only. A surface painted with a gradient (the `background:`
// shorthand leaves `background-color` transparent) was walked THROUGH, and its
// text measured against whatever lay behind it. The Profiles card shipped as a
// near-black gradient in the LIGHT theme with 1.05:1 names on it, and the gate
// reported 0 findings: it measured the dark ink against the light page behind
// the card (owner item 1, 2026-09-24).
//
// This file runs the gate's REAL in-page measurement (`measureStage`, extracted
// from the script) over a fixture DOM whose computed styles are stubbed, and pins:
//   · text on a dark gradient over a light page is a CONTRAST finding, measured
//     against the gradient's WORST stop — and the finding records that a
//     background-colour-only walk would have passed it (the old gate's miss);
//   · a gradient over an opaque background-colour hides that colour (it is
//     painted over it), so the gradient's stops are what the text sits on;
//   · a translucent gradient stop is composited over what is behind it;
//   · VACUITY: text on a plain readable surface is not a finding, and text on a
//     gradient that IS readable at every stop is not one either.
//
// The script's own `--control` run carries the matching browser proof (a fourth
// injected element that only a gradient-aware walk can see).

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

interface Style {
  backgroundColor?: string;
  backgroundImage?: string;
  color?: string;
  fontSize?: string;
}
type Measured = {
  leafCount: number;
  unmeasured: number;
  contrast: Array<{
    el: string;
    ratio: number;
    gradient?: true;
    ratioIgnoringGradients?: number;
    bg: string;
  }>;
};

const styles = new Map<Element, Style>();
function computed(el: Element): Record<string, string> {
  const s = styles.get(el) ?? {};
  return {
    backgroundColor: s.backgroundColor ?? 'rgba(0, 0, 0, 0)',
    backgroundImage: s.backgroundImage ?? 'none',
    color: s.color ?? 'rgb(0, 0, 0)',
    opacity: '1',
    fontSize: s.fontSize ?? '12px',
    fontWeight: '400',
    display: 'block',
    visibility: 'visible',
    textOverflow: 'clip',
    overflow: 'visible',
  };
}
// The gate measures RENDERED text extents too (its CLIPPED rule, 2026-09-25), with
// Range#getClientRects — which jsdom does not implement. No text here is cut, so
// every range reports no boxes, exactly what a browser reports for text that
// renders nothing; the-text-quality-gate-sees-text-cut-off-without-an-ellipsis
// covers the rule itself.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = (() => []) as unknown as Range['getClientRects'];
}
// eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- runs the gate script's own in-page measurement: that function IS the thing under test
const measureStage = new Function(
  'getComputedStyle',
  'document',
  'Node',
  `${MEASURE_SRC}; return measureStage;`,
)(computed, document, Node) as (root: Element, opts: unknown) => Measured;

/** A stage on a LIGHT page (the light theme's base), with `build` inside it. */
function stage(build: (root: HTMLElement) => void): Measured {
  document.body.innerHTML = '';
  styles.clear();
  styles.set(document.body, { backgroundColor: 'rgb(235, 237, 242)' });
  const root = document.createElement('div');
  document.body.appendChild(root);
  build(root);
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ width: 100, height: 16, top: 0, left: 0, right: 100, bottom: 16 }) as DOMRect;
  }
  return measureStage(root, { MIN_PX: 9, CONTROL_COMPONENT: 'scene-quality-control' });
}
function add(parent: Element, tag: string, style: Style, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  styles.set(el, style);
  return el;
}

const INK = 'rgb(26, 29, 35)'; // the light theme's --ink-primary
// The Profiles card's dark stage, exactly as HEAD shipped it in both themes.
const DARK_CARD = 'linear-gradient(rgb(20, 28, 47), rgb(12, 19, 34))';

afterEach(() => {
  document.body.innerHTML = '';
  styles.clear();
});

describe('the text-quality gate reads a gradient as a background', () => {
  it('CRITICAL dark ink on a dark GRADIENT over a light page is a finding — and a background-colour-only walk would have passed it', () => {
    const res = stage((root) => {
      const card = add(root, 'article', { backgroundImage: DARK_CARD });
      add(card, 'p', { color: INK }, 'amsterdam shopper');
    });
    expect(res.leafCount).toBe(1);
    expect(res.contrast).toHaveLength(1);
    const f = res.contrast[0]!;
    expect(f.ratio).toBeLessThan(1.2); // 1.01 on the lighter stop
    expect(f.bg).toBe('#141c2f');
    // The old gate's reading of the same text: the light page behind the card.
    expect(f.gradient).toBe(true);
    expect(f.ratioIgnoringGradients).toBeGreaterThan(4.5);
  });

  it('a gradient paints OVER its own background-colour: the stops decide, not the colour under them', () => {
    const res = stage((root) => {
      add(
        root,
        'span',
        {
          backgroundColor: 'rgb(0, 0, 0)',
          backgroundImage: 'linear-gradient(rgb(250, 250, 250), rgb(250, 250, 250))',
          color: 'rgb(255, 255, 255)',
        },
        'control on a gradient',
      );
    });
    expect(res.contrast).toHaveLength(1);
    expect(res.contrast[0]!.ratio).toBeLessThan(1.1);
    expect(res.contrast[0]!.gradient).toBe(true);
    expect(res.contrast[0]!.ratioIgnoringGradients).toBe(21);
  });

  it('a translucent stop is composited over what is behind it (a 10% black wash on white is still readable dark text… and unreadable light text)', () => {
    const wash = 'linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0))';
    const readable = stage((root) => {
      const box = add(root, 'div', { backgroundColor: 'rgb(255, 255, 255)' });
      add(box, 'p', { backgroundImage: wash, color: INK }, 'dark on a light wash');
    });
    expect(readable.contrast).toEqual([]);
    const pale = stage((root) => {
      const box = add(root, 'div', { backgroundColor: 'rgb(255, 255, 255)' });
      add(box, 'p', { backgroundImage: wash, color: 'rgb(200, 200, 200)' }, 'pale text');
    });
    expect(pale.contrast).toHaveLength(1);
  });

  it('VACUITY: readable text on a plain surface, and on a gradient readable at every stop, is not a finding', () => {
    const res = stage((root) => {
      const plain = add(root, 'div', { backgroundColor: 'rgb(248, 249, 251)' });
      add(plain, 'p', { color: INK }, 'plain surface');
      const lit = add(root, 'article', {
        backgroundColor: 'rgb(235, 237, 242)',
        backgroundImage: 'linear-gradient(rgb(253, 253, 254), rgb(235, 237, 242))',
      });
      add(lit, 'p', { color: INK }, 'lit card');
    });
    expect(res.leafCount).toBe(2);
    expect(res.contrast).toEqual([]);
    expect(res.unmeasured).toBe(0);
  });
});
