// Owner 2026-09-24, item 1 (verbatim): "GUI profiles grid view, we made this
// darker , which is fine, but on light mode, this stays extremely dark and
// barely visible text. Should match with light/dark theme."
//
// ROOT CAUSE. The Profiles card's two surfaces — the bezel (`.pf-card`) and the
// phone glass (`.pf-screen`) — were written as dark LITERALS
// (`linear-gradient(180deg, rgb(20 28 47), rgb(12 19 34))` and
// `linear-gradient(165deg, rgb(27 33 48), rgb(6 8 16) 72%)`), the same in both
// themes, while every word on them is a mode token. In the light theme the
// words take the light theme's dark ink and sit on a near-black slab: the name
// at 1.1:1.
//
// WHY THE WCAG GATE SAID 0. scripts/gui-text-quality.mjs composites
// `background-color` up the tree and never reads `background-image`. Both rules
// used the `background:` SHORTHAND with a gradient, which also resets
// `background-color` to transparent (it even erased the screen's
// `bg-surface-raised` utility), so the walk passed through both layers to the
// page behind the card and measured dark ink on a light page.
//
// This file measures, from styles/index.css itself, in EACH mode:
//   1. both surfaces are built only from tokens (no numeric colour literal) and
//      never from the `background:` shorthand;
//   2. every ink the card writes with clears 4.5:1 on every stop of both
//      gradients (the stops are resolved through the mode's token blocks);
//   3. each surface declares a `background-color` that is its least-contrasting
//      stop, so a reader that sees only `background-color` measures the floor.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Mode = 'light' | 'dark';
type Rgb = readonly [number, number, number];

const CSS_PATH = resolve(__dirname, '../../src/styles/index.css');
const CSS = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { body }` block with no nested braces (the token blocks and
 *  plain rules; @keyframes bodies are skipped by construction). */
const BLOCKS = Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
  selector: (m[1] ?? '').trim(),
  body: m[2] ?? '',
}));

/** A custom property's raw value in a mode: a block whose selector is that
 *  bare `[data-mode='…']` wins (the LAST such block, as the cascade does);
 *  a block on the accent axis is the fallback. Throws when absent. */
function rawVar(name: string, mode: Mode): string {
  let modeValue: string | null = null;
  let fallback: string | null = null;
  const decl = new RegExp(`(?:^|;|\\s)--${name}:\\s*([^;]+);`);
  for (const { selector, body } of BLOCKS) {
    const m = decl.exec(body);
    if (m === null) continue;
    const value = (m[1] ?? '').trim();
    if (new RegExp(`^\\[data-mode=['"]${mode}['"]\\]$`).test(selector)) modeValue = value;
    else if (/^\[data-accent/.test(selector)) fallback = value;
  }
  const v = modeValue ?? fallback;
  if (v === null) throw new Error(`--${name} is not defined for ${mode} in styles/index.css`);
  return v;
}

/** `--x-rgb` → "R G B", following `var(--other-rgb)` through the same mode. */
function rgbVar(name: string, mode: Mode, depth = 0): Rgb {
  if (depth > 6) throw new Error(`--${name}: var() chain too deep`);
  const v = rawVar(name, mode);
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref !== null) return rgbVar(ref[1] ?? '', mode, depth + 1);
  const parts = v.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`--${name} for ${mode} is not "R G B": ${v}`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The first plain rule for exactly this selector. */
function rule(selector: string): string {
  const hit = BLOCKS.find((b) => b.selector === selector);
  if (hit === undefined) throw new Error(`${selector} { … } not found in styles/index.css`);
  return hit.body;
}
const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(body);
  return m === null ? null : (m[1] ?? '').replace(/\s+/g, ' ').trim();
};

/** The colour stops of a surface, each as the `--…-rgb` token it names, or —
 *  so the contrast arm can measure what HEAD shipped — a literal `rgb(R G B)`,
 *  reported as such (the token arm refuses literals separately). */
type Stop = { token: string | null; literal: Rgb | null; text: string };
function stops(image: string): Stop[] {
  const inner = /^linear-gradient\((.*)\)$/.exec(image)?.[1];
  if (inner === undefined) throw new Error(`not a linear-gradient: ${image}`);
  return inner
    .split(/,(?![^()]*\))/)
    .slice(1)
    .map((raw) => {
      const text = raw.trim();
      const tok = /^rgb\(var\(--([\w-]+-rgb)\)\)(?:\s+[\d.]+%)?$/.exec(text);
      if (tok !== null) return { token: tok[1] ?? '', literal: null, text };
      const lit = /^rgb\((\d+) (\d+) (\d+)\)(?:\s+[\d.]+%)?$/.exec(text);
      if (lit !== null)
        return {
          token: null,
          literal: [Number(lit[1]), Number(lit[2]), Number(lit[3])] as const,
          text,
        };
      throw new Error(`a gradient stop this test cannot resolve: "${text}"`);
    });
}
/** The surface's gradient — from `background-image`, or from the shorthand
 *  (HEAD's form), so the measurement runs either way. */
const imageOf = (body: string): string =>
  decl(body, 'background-image') ?? decl(body, 'background') ?? '';

// The inks the card's copy is written in (ProfilePhoneCard.tsx): name =
// ink-primary, device / pills / buttons = ink-secondary, 'checked 12 min' and
// the empty-row hints = ink-muted.
const INKS = ['ink-primary', 'ink-secondary', 'ink-muted'] as const;
const SURFACES = [
  { selector: '.pf-card', what: 'the bezel (and the dock that sits on it)' },
  { selector: '.pf-screen', what: 'the phone glass (every row of the card)' },
  // The Recordings thumbnail wears "the same glass the profile card's screen
  // wears" — it was a copy of the dark literals, and the gradient-aware text gate
  // found its "saved" caption at 2.62:1 in the light theme (2026-09-24).
  { selector: '.rc-thumb', what: 'the recording thumbnail glass ("saved" / "no frames")' },
] as const;
const NUMERIC_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d|hsla?\(\s*\d/i;

describe('owner item 1 — the Profiles card follows the light and dark theme', () => {
  for (const { selector, what } of SURFACES) {
    it(`${selector} — ${what} — is built from mode tokens, not the background shorthand`, () => {
      const body = rule(selector);
      // The shorthand resets background-color; the gate then sees through it.
      expect(decl(body, 'background'), `${selector} uses the background shorthand`).toBeNull();
      const image = decl(body, 'background-image');
      const color = decl(body, 'background-color');
      expect(image, `${selector} has no background-image`).not.toBeNull();
      expect(color, `${selector} has no background-color floor`).not.toBeNull();
      expect(image ?? '').not.toMatch(NUMERIC_COLOUR);
      expect(color ?? '').not.toMatch(NUMERIC_COLOUR);
      const ss = stops(image ?? '');
      expect(ss.length).toBeGreaterThanOrEqual(2);
      expect(
        ss.filter((x) => x.token === null).map((x) => x.text),
        'literal stops',
      ).toEqual([]);
    });

    for (const mode of ['light', 'dark'] as const) {
      it(`${selector} [${mode}] — every ink on it clears 4.5:1 on every stop, and its background-color is the floor`, () => {
        const body = rule(selector);
        const measured = stops(imageOf(body)).map((x) => ({
          label: x.token === null ? `literal ${x.text}` : `--${x.token}`,
          rgb: x.token === null ? (x.literal as Rgb) : rgbVar(x.token, mode),
        }));
        const failures: string[] = [];
        for (const ink of INKS) {
          const fg = rgbVar(`${ink}-rgb`, mode);
          for (const st of measured) {
            const r = ratio(fg, st.rgb);
            if (r < 4.5) failures.push(`${ink} on ${st.label} = ${r.toFixed(2)}:1`);
          }
        }
        expect(failures, `${selector} in ${mode}`).toEqual([]);
        // The floor: the declared background-color is the stop that contrasts
        // LEAST with the primary ink — what a background-color-only reader needs.
        const floorToken = /^rgb\(var\(--([\w-]+-rgb)\)\)$/.exec(
          decl(body, 'background-color') ?? '',
        )?.[1];
        expect(floorToken, `${selector} background-color is not rgb(var(--token))`).toBeDefined();
        const floor = rgbVar(floorToken ?? '', mode);
        const ink = rgbVar('ink-primary-rgb', mode);
        const worst = Math.min(...measured.map((st) => ratio(ink, st.rgb)));
        expect(ratio(ink, floor)).toBeCloseTo(worst, 5);
      });
    }
  }

  it('the dark theme keeps the darker stage the owner accepted ("we made this darker, which is fine")', () => {
    // The dark values are the ones the stage shipped with (e45abaaae).
    expect(rgbVar('pf-bezel-top-rgb', 'dark')).toEqual([20, 28, 47]);
    expect(rgbVar('pf-bezel-bottom-rgb', 'dark')).toEqual([12, 19, 34]);
    expect(rgbVar('pf-glass-top-rgb', 'dark')).toEqual([27, 33, 48]);
    expect(rgbVar('pf-glass-bottom-rgb', 'dark')).toEqual([6, 8, 16]);
    // …and the light theme's glass is lighter than its ink by the full AA margin.
    expect(lum(rgbVar('pf-glass-bottom-rgb', 'light'))).toBeGreaterThan(
      lum(rgbVar('ink-primary-rgb', 'light')),
    );
  });
});
