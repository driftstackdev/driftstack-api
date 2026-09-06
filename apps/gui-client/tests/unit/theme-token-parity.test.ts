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

/**
 * The contrast floor this button's OWN face requires, derived from its classes.
 *
 * ⛔ This used to be hand-labelled, and the label was wrong. The suite asserted a
 * 3.0–4.5 band and titled it "bold-text AA", while pinning `text-sm` +
 * `font-semibold` in the very same arm. WCAG large text is 24px at ANY weight or
 * 18.66px at BOLD (700); 14px semibold (600) is neither, so the band the guard
 * enforced was the band that fails. A guard cannot certify a class it decides by
 * hand — so the threshold is computed from the face, and a future restyle to
 * genuinely large type relaxes it automatically instead of silently keeping a
 * floor that no longer matches the text.
 */
const TW_PX: Record<string, number> = {
  'text-xs': 12,
  'text-sm': 14,
  'text-base': 16,
  'text-lg': 18,
  'text-xl': 20,
  'text-2xl': 24,
};
const TW_WEIGHT: Record<string, number> = {
  'font-normal': 400,
  'font-medium': 500,
  'font-semibold': 600,
  'font-bold': 700,
  'font-extrabold': 800,
};
function requiredRatio(rule: string): number {
  const px = Object.entries(TW_PX).find(([cls]) => rule.includes(cls))?.[1];
  const weight = Object.entries(TW_WEIGHT).find(([cls]) => rule.includes(cls))?.[1];
  if (px === undefined || weight === undefined) {
    throw new Error('cannot read the button face — size or weight class missing');
  }
  // WCAG 2.x §1.4.3: large text is >=18pt (24px), or >=14pt (18.66px) BOLD.
  const isLarge = px >= 24 || (px >= 18.66 && weight >= 700);
  return isLarge ? 3.0 : 4.5;
}

describe('the bright first-action button clears the AA floor its own type requires', () => {
  it('.btn-primary-bright exists with base background rgb(189 83 98) (#bd5362)', () => {
    const rule = brightBaseRule();
    expect(rule).toContain('background-color: rgb(189 83 98)');
    expect(rule).toContain('#bd5362');
    // The face is still pinned — it is an INPUT to the floor above, not a
    // justification for ignoring it.
    expect(rule).toContain('font-semibold');
    expect(rule).toContain('text-sm');
    expect(rule).toContain('text-ink-inverted');
    expect(rule).toContain('focus-visible:ring-accent-ring');
  });

  it('hover DARKENS toward oxblood-500 and active lands on it', () => {
    // The direction is the point. Lightening on hover is what dropped the label
    // to 2.57:1 on the one interaction that says "this is about to be pressed".
    const hover = /\.btn-primary-bright:hover[^{]*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const active = /\.btn-primary-bright:active[^{]*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rgbTriple(hover)).toEqual([176, 74, 90]);
    expect(luminance(rgbTriple(hover)), 'hover must not be lighter than the base').toBeLessThan(
      luminance(rgbTriple(brightBaseRule())),
    );
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

  it('CRITICAL white on the base clears the floor its own face requires', () => {
    const rule = brightBaseRule();
    const ratio = contrast(WHITE, rgbTriple(rule));
    const floor = requiredRatio(rule);
    // 4.5 for this face, derived — not asserted here, so a restyle moves it.
    expect(floor, 'a 14px semibold label is not WCAG large text').toBe(4.5);
    expect(ratio).toBeGreaterThanOrEqual(floor);
    // Still meaningfully brighter than .btn-primary (oxblood-500, 6.18:1), which
    // is the whole reason this variant exists — the owner read that as too dark.
    expect(ratio, 'as dark as .btn-primary would make the variant pointless').toBeLessThan(6.0);
  });

  it('CRITICAL the HOVER state clears the floor too — it used to drop to 2.57:1', () => {
    // ⛔ The old hover lightened to oxblood-300, so the label became hardest to
    // read at the exact moment the pointer was on it. A hover is a state, not a
    // decoration: every state a customer can put the control into is a state the
    // text has to survive.
    const hover = /\.btn-primary-bright:hover:not\(:disabled\)\s*\{([^}]*)\}/.exec(CSS)?.[1];
    if (hover === undefined) throw new Error('hover rule not found');
    expect(contrast(WHITE, rgbTriple(hover))).toBeGreaterThanOrEqual(
      requiredRatio(brightBaseRule()),
    );
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
