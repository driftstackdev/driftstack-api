// Theme-token parity — the bright first-action button is SCOPED to itself.
//
// Owner (T-8, 2026-09-03): the "Create your first profile" red is too dark;
// make it lighter, matching our accent/theme. MEASURED: .btn-primary is
// bg-accent, and --accent-rgb is 168 59 77 (oxblood-500, #a83b4d) under
// [data-accent='oxblood'] — the same var drives the logo, focus rings and
// progress bars, and was deliberately settled there. The fix therefore adds a
// separate .btn-primary-bright at oxblood-400 (#c8606e) rather than moving the
// accent. White on #c8606e is 3.92:1 — AA for LARGE/BOLD text only — so the
// button stays semibold at text-sm and the base must not lighten past
// oxblood-400.
//
// Three properties, each its own arm: the class exists at the pinned base
// colour; the accent did NOT move; the contrast computed from the base colour
// actually in the file sits in the [3.0, 4.5) band. The third arm reads the
// colour OUT of the CSS, so "lighten it a bit more" (oxblood-300, 2.57:1) goes
// red on the number, not on a string.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');
const CSS = readFileSync(join(SRC, 'styles', 'index.css'), 'utf8');

/** The `.btn-primary-bright { … }` block — its own base rule, not the
 *  :hover/:active companions, which carry the other two ramp colours. */
function brightBaseRule(): string {
  const m = /\.btn-primary-bright\s*\{([^}]*)\}/.exec(CSS);
  if (m === null) throw new Error('.btn-primary-bright base rule not found in index.css');
  return m[1] ?? '';
}

function rgbTriple(rule: string): [number, number, number] {
  const m = /background-color:\s*rgb\((\d+)\s+(\d+)\s+(\d+)\)/.exec(rule);
  if (m === null) throw new Error(`no rgb() background-color in rule: ${rule}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// WCAG 2.x relative luminance + contrast ratio (sRGB linearisation).
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: [number, number, number] = [255, 255, 255];

describe('the bright first-action button is oxblood-400, scoped, and bold-text AA', () => {
  it('.btn-primary-bright exists with base background rgb(200 96 110) (#c8606e)', () => {
    const rule = brightBaseRule();
    expect(rule).toContain('background-color: rgb(200 96 110)');
    expect(rule).toContain('#c8606e');
    // Bold at 14px is what makes 3.9:1 acceptable — both are part of the pin.
    expect(rule).toContain('font-semibold');
    expect(rule).toContain('text-sm');
    expect(rule).toContain('text-ink-inverted');
    expect(rule).toContain('focus-visible:ring-accent-ring');
  });

  it('hover lightens to oxblood-300 and active returns to oxblood-500', () => {
    const hover = /\.btn-primary-bright:hover[^{]*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const active = /\.btn-primary-bright:active[^{]*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rgbTriple(hover)).toEqual([220, 139, 150]);
    expect(rgbTriple(active)).toEqual([168, 59, 77]);
  });

  it('--accent-rgb is STILL 168 59 77 and .btn-primary still uses bg-accent', () => {
    // The scoped change must not move the accent that drives the logo/rings.
    expect(/--accent-rgb:\s*168 59 77;/.test(CSS)).toBe(true);
    expect(/--accent-hover-rgb:\s*200 96 110;/.test(CSS)).toBe(true);
    expect(/--accent:\s*#a83b4d;/.test(CSS)).toBe(true);
    const primary = /\.btn-primary\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(primary).toContain('bg-accent');
    expect(primary).not.toContain('rgb(');
  });

  it('white on the base colour in the file is 3.92:1 — bold-text AA, not normal-text AA', () => {
    const base = rgbTriple(brightBaseRule());
    const ratio = contrast(WHITE, base);
    // The real number, pinned: lightening to oxblood-300 (220 139 150) reads
    // 2.57 and fails the floor; darkening back to oxblood-500 reads 6.18 and
    // fails the ceiling (that would just be .btn-primary again).
    expect(ratio).toBeCloseTo(3.92, 2);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
    expect(ratio).toBeLessThan(4.5);
  });

  it('VACUITY CONTROL — the same contrast function reads the accent at 6.18:1 (normal-text AA)', () => {
    // Proves the band above is a property of the bright colour, not of a
    // contrast() that returns ~3.9 for everything.
    const m = /--accent-rgb:\s*(\d+) (\d+) (\d+);/.exec(CSS);
    if (m === null) throw new Error('--accent-rgb not found');
    const accent: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(contrast(WHITE, accent)).toBeCloseTo(6.18, 2);
    expect(contrast(WHITE, accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the two first-action CTAs wear the bright class', () => {
  const profiles = readFileSync(join(SRC, 'views', 'ProfilesView.tsx'), 'utf8');
  const wizard = readFileSync(join(SRC, 'views', 'FirstRunWizard.tsx'), 'utf8');

  it('ProfilesView "Create your first profile" is .btn-primary-bright', () => {
    expect(
      /className="btn-primary-bright"[\s\S]{0,600}?Create your first profile/.test(profiles),
    ).toBe(true);
  });

  it('FirstRunWizard "Get started" is .btn-primary-bright', () => {
    expect(/className="btn-primary-bright"[^>]*>\s*Get started/.test(wizard)).toBe(true);
    // The wizard's OTHER primary buttons keep .btn-primary — the bright variant
    // is for the first action only, not a global restyle.
    expect(wizard).toContain('className="btn-primary"');
  });
});
