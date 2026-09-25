// The contrast matrix: every text token, on every ground it may sit on, in both
// modes, clears WCAG AA (4.5:1) — computed from tokens.json, so a token tweak
// fails here once, for every surface, before any page is rendered.
//
// ⛔ WHERE A TOKEN MAY SIT IS PART OF THE DESIGN, AND IT IS WRITTEN DOWN BELOW.
// The app's values are the reference and are not changed here (owner decision:
// the light theme is not a draft), and measured over them not every text token
// clears AA on every ground: dark muted ink on the elevated surface is 4.04, a
// status pill's /20 wash over the page ground is 4.2–4.3 in light. The app never
// puts them there. So PLACEMENT is the contract every surface inherits, and the
// matrix measures all of it. Each thing a surface must NOT do is in NEVER, with
// the measurement that makes it a rule — and that measurement is re-taken here,
// so a rule that stops being true (a token moved and the pair now passes) fails
// too and has to be deleted rather than left to shrink the matrix for nothing.
//
// Also here: the ink on an accent fill, and the ≥25° hue gap between the brand
// accent and the status hues (the app's own rule,
// apps/gui-client/tests/unit/the-ai-views-light-is-derived-from-the-accent-axis.test.ts).

import { describe, expect, it } from 'vitest';
import { MODES, MODE_COLOURS, loadTokens } from '../build.mjs';
import type { Mode, ModeColour } from '../build.mjs';

const tokens = loadTokens();
const AA = 4.5;
const HUE_GAP_DEG = 25;

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** `fg` at `alpha` over `bg` — what a Tailwind `/15` wash paints. */
const wash = (fg: Rgb, alpha: number, bg: Rgb): Rgb => [
  fg[0] * alpha + bg[0] * (1 - alpha),
  fg[1] * alpha + bg[1] * (1 - alpha),
  fg[2] * alpha + bg[2] * (1 - alpha),
];
function hue([r, g, b]: Rgb): number {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const d = max - Math.min(rn, gn, bn);
  if (d === 0) return 0;
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// ── the grounds ──────────────────────────────────────────────────────────────
const GROUNDS = ['surface-base', 'surface-raised', 'surface-elevated', 'surface-inset'] as const;
type Ground = (typeof GROUNDS)[number];

/** A wash: a hue token at an alpha (a number, or the mode's accent-subtle-alpha). */
const WASHES = {
  'accent-subtle': ['accent', 'subtle'],
  'accent/15': ['accent', 0.15],
  'accent/20': ['accent', 0.2],
  'status-ready/15': ['status-ready', 0.15],
  'status-ready/20': ['status-ready', 0.2],
  'status-busy/15': ['status-busy', 0.15],
  'status-busy/20': ['status-busy', 0.2],
  'status-error/15': ['status-error', 0.15],
  'status-error/20': ['status-error', 0.2],
} as const;
type Wash = keyof typeof WASHES;
const ACCENT_WASHES: Wash[] = ['accent-subtle', 'accent/15', 'accent/20'];
const ALL_WASHES = Object.keys(WASHES) as Wash[];

/** A ground: a surface, or a wash over a surface. */
type Placement = Ground | `${Wash} over ${Ground}`;
const over = (washes: Wash[], grounds: readonly Ground[]): Placement[] =>
  washes.flatMap((w) => grounds.map((g): Placement => `${w} over ${g}`));

function paint(mode: Mode, name: string): Rgb {
  const m = tokens.modes[mode] as Record<string, string | number>;
  const a = tokens.accent as Record<string, string | number>;
  const hex = m[name] ?? a[name];
  if (typeof hex !== 'string') throw new Error(`no colour token ${name}`);
  return rgb(hex);
}
function ground(mode: Mode, placement: Placement): Rgb {
  const [washName, surface] = placement.includes(' over ')
    ? (placement.split(' over ') as [Wash, Ground])
    : [null, placement as Ground];
  const base = paint(mode, surface);
  if (washName === null) return base;
  const [hueToken, alpha] = WASHES[washName];
  const a = alpha === 'subtle' ? tokens.modes[mode]['accent-subtle-alpha'] : alpha;
  return wash(paint(mode, hueToken), a, base);
}

// ── the contract ─────────────────────────────────────────────────────────────
/**
 * Where each text token may sit. The minimum for every token is the page ground
 * and the card (base, raised) — the arm below refuses a contract that drops
 * either, so the matrix can never be satisfied by shrinking it.
 */
const PLACEMENT: Record<string, Placement[]> = {
  // Body and headings: anywhere, including every accent and status wash.
  'ink-primary': [...GROUNDS, ...over(ALL_WASHES, GROUNDS)],
  // Secondary copy: anywhere but a wash over an input well.
  'ink-secondary': [
    ...GROUNDS,
    ...over(ALL_WASHES, ['surface-base', 'surface-raised', 'surface-elevated']),
  ],
  // Small print: never on the elevated surface, and on a wash only as the
  // selected row's soft accent over a card.
  'ink-muted': [
    'surface-base',
    'surface-raised',
    'surface-inset',
    ...over(['accent-subtle'], ['surface-raised']),
  ],
  // Accent as copy (links, labels): any ground, and any accent wash.
  'accent-text': [...GROUNDS, ...over(ACCENT_WASHES, GROUNDS)],
  // Status as copy: any ground; as a pill, on its own /15 or /20 wash over a
  // card; inside a selected row over a card.
  'status-ready': [
    ...GROUNDS,
    ...over(['status-ready/15', 'status-ready/20', 'accent-subtle'], ['surface-raised']),
  ],
  'status-busy': [
    ...GROUNDS,
    ...over(['status-busy/15', 'status-busy/20', 'accent-subtle'], ['surface-raised']),
  ],
  'status-error-text': [
    ...GROUNDS,
    ...over(['status-error/15', 'status-error/20', 'accent-subtle'], ['surface-raised']),
  ],
};

/** What a surface must never do, each with the pair that proves it (re-measured below). */
const NEVER: Array<{ rule: string; text: string; on: Placement | 'the accent fill'; mode: Mode }> =
  [
    {
      rule: 'muted ink on the elevated surface — use secondary ink (dark 4.04)',
      text: 'ink-muted',
      on: 'surface-elevated',
      mode: 'dark',
    },
    {
      rule: 'muted ink on a status or /20 accent wash (light 4.3)',
      text: 'ink-muted',
      on: 'accent/20 over surface-raised',
      mode: 'light',
    },
    {
      rule: 'a status pill directly on the page ground at /20 — pills sit on a card (light 4.25)',
      text: 'status-ready',
      on: 'status-ready/20 over surface-base',
      mode: 'light',
    },
    {
      rule: 'a status pill on the elevated surface (dark 4.10 at /15)',
      text: 'status-ready',
      on: 'status-ready/15 over surface-elevated',
      mode: 'dark',
    },
    {
      rule: 'secondary ink on a /20 wash over an input well (light 4.2)',
      text: 'ink-secondary',
      on: 'status-ready/20 over surface-inset',
      mode: 'light',
    },
    {
      rule: 'the rose accent-hover as text — it is for borders and rings (light 3.7 on the card)',
      text: 'accent-hover',
      on: 'surface-raised',
      mode: 'light',
    },
    {
      rule: 'the error FILL tone as text on its own wash — use status-error-text (dark 4.27)',
      text: 'status-error',
      on: 'status-error/15 over surface-raised',
      mode: 'dark',
    },
    {
      rule: 'inverted ink on an accent fill — use on-accent (dark 2.89)',
      text: 'ink-inverted',
      on: 'the accent fill',
      mode: 'dark',
    },
  ];

const TEXT_TOKENS: ModeColour[] = [
  'ink-primary',
  'ink-secondary',
  'ink-muted',
  'accent-text',
  'status-ready',
  'status-busy',
  'status-error-text',
];

describe('the contrast matrix — every text token on every ground it may sit on, both modes', () => {
  it('the contract covers every text token, and every one may sit on the page ground and the card', () => {
    expect(Object.keys(PLACEMENT).sort()).toEqual([...TEXT_TOKENS].sort());
    for (const t of TEXT_TOKENS) {
      expect(PLACEMENT[t], t).toEqual(expect.arrayContaining(['surface-base', 'surface-raised']));
    }
    // …and every text token is a real mode colour (a typo would measure nothing).
    for (const t of TEXT_TOKENS) expect(MODE_COLOURS).toContain(t);
  });

  const failures: string[] = [];
  let measured = 0;
  for (const mode of MODES) {
    for (const [text, placements] of Object.entries(PLACEMENT)) {
      for (const p of placements) {
        measured += 1;
        const ratio = contrast(paint(mode, text), ground(mode, p));
        if (ratio < AA) failures.push(`${mode}: ${text} on ${p} = ${ratio.toFixed(2)}`);
      }
    }
  }

  it('CRITICAL every allowed pair clears 4.5:1 in light AND dark', () => {
    // 2 modes × (40 + 31 + 4 + 16 + 3 × 7) placements: a matrix that shrank
    // (a contract edited down to pass) fails the count before the ratios.
    expect(measured).toBeGreaterThanOrEqual(224);
    expect(failures).toEqual([]);
  });

  it('CRITICAL the ink on an accent fill clears 4.5 on the fill, its hover and its pressed state', () => {
    const on = rgb(tokens.accent['on-accent']);
    for (const fill of ['accent', 'accent-fill-hover', 'accent-active'] as const) {
      expect(contrast(on, rgb(tokens.accent[fill])), fill).toBeGreaterThanOrEqual(AA);
    }
  });

  it('every NEVER rule is still true — a rule the tokens no longer need has to be deleted, not kept', () => {
    for (const n of NEVER) {
      const bg = n.on === 'the accent fill' ? rgb(tokens.accent.accent) : ground(n.mode, n.on);
      const ratio = contrast(paint(n.mode, n.text), bg);
      expect(ratio, `${n.rule}: measured ${ratio.toFixed(2)}`).toBeLessThan(AA);
    }
  });

  it('POSITIVE CONTROL — the instrument reads 21:1 for black on white, 1:1 for a colour on itself, and the old web oxblood link hover (#c04b58) under AA on the new page ground', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast(rgb('#a83b4d'), rgb('#a83b4d'))).toBe(1);
    expect(contrast(rgb('#c04b58'), ground('light', 'surface-base'))).toBeLessThan(AA);
    // …and a wash is measured, not skipped: the same token reads differently on it.
    expect(
      contrast(paint('light', 'ink-muted'), ground('light', 'accent/20 over surface-raised')),
    ).not.toBeCloseTo(contrast(paint('light', 'ink-muted'), ground('light', 'surface-raised')), 1);
  });
});

describe('a status is never mistaken for the brand', () => {
  const accentHue = hue(rgb(tokens.accent.accent));

  for (const mode of MODES) {
    it(`${mode}: ready and busy sit ≥ ${HUE_GAP_DEG}° from the accent (the app’s rule)`, () => {
      for (const s of ['status-ready', 'status-busy'] as const) {
        expect(hueGap(accentHue, hue(paint(mode, s))), s).toBeGreaterThanOrEqual(HUE_GAP_DEG);
      }
    });
  }

  it('the error red IS the accent’s neighbour (10–14°) — so a surface may never tell an error from the brand by hue alone', () => {
    // The app knows this and designs around it ("trouble is the ABSENCE of
    // light, never red — oxblood and --status-error-rgb are neighbours"). It is
    // recorded here so a surface that shows an outage (the status site) picks
    // an incident colour against this measurement instead of rediscovering it.
    for (const mode of MODES) {
      const gap = hueGap(accentHue, hue(paint(mode, 'status-error')));
      expect(gap, `${mode} error hue gap`).toBeLessThan(HUE_GAP_DEG);
      expect(gap).toBeGreaterThan(5);
    }
  });

  it('CONTROL — the gap measurement rejects a status at the accent’s own hue', () => {
    expect(hueGap(accentHue, hue(rgb(tokens.accent['accent-active'])))).toBeLessThan(HUE_GAP_DEG);
    expect(hueGap(10, 350)).toBe(20);
  });
});
