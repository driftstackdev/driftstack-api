// Drift-guard: the iOS fingertip touch cursor (`.ds-touch-dot`) must keep a
// dark CONTOUR ring on its box-shadow. The disc fill is a translucent
// pure-white radial gradient (rgba(255,255,255,…) → transparent), which
// vanishes over a white web page — so the only thing that keeps the
// fingertip cursor visible on light pages (Google et al.) is the dark
// `inset … rgba(0,0,0,…)` hairline that follows the 9999px radius.
//
// If a future refactor collapses the box-shadow back to a single shadowless
// drop (the pre-fix `box-shadow: 0 1px 7px rgba(0,0,0,0.18)`), the cursor
// flickers out over white content and the touchscreen illusion breaks. This
// test pins the inset contour so that regression fails loudly.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, '..', '..', 'src', 'styles', 'index.css'), 'utf8');

/** Extract the body of the first `.ds-touch-dot {…}` rule (not `--pressed`). */
function touchDotRule(): string {
  const start = CSS.indexOf('.ds-touch-dot {');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  expect(close).toBeGreaterThan(open);
  return CSS.slice(open + 1, close);
}

describe('.ds-touch-dot fingertip-cursor contour', () => {
  it('keeps an inset dark hairline so the disc stays visible on white pages', () => {
    const rule = touchDotRule();
    // An `inset … rgba(0, 0, 0, …)` layer = the contour ring that survives
    // on a white background. Whitespace-insensitive match.
    const hasInsetContour = /box-shadow:[\s\S]*inset[\s\S]*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(
      rule,
    );
    expect(hasInsetContour).toBe(true);
  });

  it('does not regress to a single shadowless/insetless drop', () => {
    const rule = touchDotRule();
    // The pre-fix value was exactly one drop shadow with no inset.
    const isBareSingleDrop =
      /box-shadow:\s*0 1px 7px rgba\(0, 0, 0, 0\.18\);/.test(rule) && !rule.includes('inset');
    expect(isBareSingleDrop).toBe(false);
  });
});
