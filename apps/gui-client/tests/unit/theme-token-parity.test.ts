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
const readSource = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

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
    expect(rule).toContain('text-accent-on');
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

// ─── 2026-09-12 text-contrast batch (T1–T4) ──────────────────────────────────
// scripts/gui-text-quality.mjs measured every text leaf of the six harness
// scenes in both themes: 305 findings, clustered by TOKEN. These arms read the
// tokens OUT of index.css / tailwind.config.ts and recompute the ratios, so a
// "lighten it a touch" lands red on a number. Each arm names what reverting the
// production line does to it.

/** The `[data-mode='light'] { … }` / `[data-mode='dark'] { … }` /
 *  `[data-accent='oxblood'] { … }` token block. */
function tokenBlock(selector: string): string {
  const re = new RegExp(`\\[${selector}\\]\\s*\\{([^}]*)\\}`);
  const m = re.exec(CSS);
  if (m === null) throw new Error(`token block [${selector}] not found in index.css`);
  return m[1] ?? '';
}
function token(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*(\\d+) (\\d+) (\\d+);`).exec(block);
  if (m === null) throw new Error(`--${name} not found in block`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/** `fg` at `alpha` composited over `bg` — a Tailwind `/20` wash. */
function wash(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

const LIGHT = tokenBlock("data-mode='light'");
const DARK = tokenBlock("data-mode='dark'");
const ACCENT_BLOCK = tokenBlock("data-accent='oxblood'");
const ACCENT = token(ACCENT_BLOCK, 'accent-rgb');
const TAILWIND = readFileSync(join(__dirname, '..', '..', 'tailwind.config.ts'), 'utf8');

describe('T1 — the ink ON an accent fill is white in both modes (--on-accent-rgb)', () => {
  it('--on-accent-rgb is 255 255 255 on the ACCENT axis, so no mode can flip it', () => {
    // It lives in [data-accent] on purpose: a per-mode value is exactly what
    // put slate-900 on oxblood in dark. Moving it into [data-mode='dark'] or
    // changing the triple reds this arm.
    expect(token(ACCENT_BLOCK, 'on-accent-rgb')).toEqual([255, 255, 255]);
    expect(LIGHT).not.toContain('--on-accent-rgb');
    expect(DARK).not.toContain('--on-accent-rgb');
  });

  it('tailwind maps accent.on → --on-accent-rgb and accent.text → --accent-text-rgb', () => {
    expect(TAILWIND).toMatch(/on:\s*'rgb\(var\(--on-accent-rgb\) \/ <alpha-value>\)'/);
    expect(TAILWIND).toMatch(/text:\s*'rgb\(var\(--accent-text-rgb\) \/ <alpha-value>\)'/);
  });

  it('.btn-primary and .btn-primary-bright wear text-accent-on, not text-ink-inverted', () => {
    // Reverting either @apply line to text-ink-inverted reds this: in dark
    // --ink-inverted-rgb is 15 23 42, and the arm below shows what that costs.
    const primary = /\.btn-primary\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(primary).toContain('bg-accent text-accent-on');
    expect(primary).not.toContain('text-ink-inverted');
    expect(brightBaseRule()).toContain('text-accent-on');
    expect(brightBaseRule()).not.toContain('text-ink-inverted');
  });

  it('CRITICAL white clears 4.5 on the accent; dark ink-inverted on the accent does not (2.89)', () => {
    const on = token(ACCENT_BLOCK, 'on-accent-rgb');
    expect(contrast(on, ACCENT)).toBeGreaterThanOrEqual(4.5);
    // The reason the fill cannot use the mode-axis inverted ink: measured in the
    // shipped dark capture on New profile / New proxy / Save changes.
    expect(contrast(token(DARK, 'ink-inverted-rgb'), ACCENT)).toBeCloseTo(2.89, 1);
  });
});

describe('T2 — the accent AS TEXT (--accent-text-rgb) clears 4.5 on every surface it sits on', () => {
  const darkRaised = token(DARK, 'surface-raised-rgb');
  const darkBase = token(DARK, 'surface-base-rgb');
  const lightRaised = token(LIGHT, 'surface-raised-rgb');
  const lightBase = token(LIGHT, 'surface-base-rgb');
  const lightInset = token(LIGHT, 'surface-inset-rgb');

  it('dark: a tint of the SAME hue — 4.5+ on raised (#1e293b), base (#0f172a) and the active sidebar badge wash', () => {
    const t = token(DARK, 'accent-text-rgb');
    expect(t).toEqual([232, 160, 171]);
    expect(contrast(t, darkRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t, darkBase)).toBeGreaterThanOrEqual(4.5);
    // The "8/10" badge: bg-accent/20 over the bg-accent-subtle row (alpha .25
    // in dark) over raised — the surface the darkest raised-only tint (#c47a86,
    // 4.51 on raised) failed at 3.42. Reverting to the accent itself (2.37 on
    // raised) or to that tint reds this arm.
    const badge = wash(ACCENT, 0.2, wash(ACCENT, 0.25, darkRaised));
    expect(contrast(t, badge)).toBeGreaterThanOrEqual(4.5);
    // still oxblood: red channel leads, hue unchanged (r > b > g, as the accent)
    expect(t[0]).toBeGreaterThan(t[2]);
    expect(t[2]).toBeGreaterThan(t[1]);
  });

  it('dark: the accent itself is the failure the token replaces (2.37 on raised)', () => {
    // Vacuity control for the surface arithmetic above.
    expect(contrast(ACCENT, darkRaised)).toBeCloseTo(2.37, 1);
  });

  it('light: a deeper oxblood — 4.5+ on raised, base, inset AND the badge wash where the accent itself is 3.69', () => {
    const t = token(LIGHT, 'accent-text-rgb');
    expect(t).toEqual([143, 50, 65]);
    for (const s of [lightRaised, lightBase, lightInset]) {
      expect(contrast(t, s)).toBeGreaterThanOrEqual(4.5);
    }
    const badge = wash(ACCENT, 0.2, wash(ACCENT, 0.12, lightRaised));
    expect(contrast(ACCENT, badge), 'the accent itself fails the badge wash').toBeLessThan(4.5);
    expect(contrast(t, badge)).toBeGreaterThanOrEqual(4.5);
    // darkest-necessary: one scale step lighter (148 52 68) already fails there
    expect(contrast([148, 52, 68], badge)).toBeLessThan(4.5);
  });

  it('the accent that drives fills, rings and the logo did NOT move with the text token', () => {
    expect(ACCENT).toEqual([168, 59, 77]);
    expect(ACCENT_BLOCK).not.toContain('--accent-text-rgb');
  });
});

describe('T3 — light --ink-muted-rgb clears 4.5 on the worst surface it sits on (inset)', () => {
  it('91 98 112 — 4.5+ on inset, base, raised, elevated and the selected-row accent wash', () => {
    const muted = token(LIGHT, 'ink-muted-rgb');
    expect(muted).toEqual([91, 98, 112]);
    const inset = token(LIGHT, 'surface-inset-rgb');
    const raised = token(LIGHT, 'surface-raised-rgb');
    for (const s of [
      inset,
      token(LIGHT, 'surface-base-rgb'),
      raised,
      token(LIGHT, 'surface-elevated-rgb'),
    ]) {
      expect(contrast(muted, s)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(muted, wash(ACCENT, 0.12, raised))).toBeGreaterThanOrEqual(4.5);
    // Reverting to the old 133 140 152 reds the inset arm at 2.64 — and the old
    // value is what 229 of the light theme's 276 findings were.
    expect(contrast([133, 140, 152], inset)).toBeCloseTo(2.64, 1);
  });

  it('dark --ink-muted-rgb is untouched (slate-400)', () => {
    expect(token(DARK, 'ink-muted-rgb')).toEqual([148, 163, 184]);
  });
});

describe('T4 — light status hues as 10px text clear 4.5 on raised, base and their own /20 wash', () => {
  const raised = token(LIGHT, 'surface-raised-rgb');
  const base = token(LIGHT, 'surface-base-rgb');
  const cases: Array<[string, [number, number, number], [number, number, number]]> = [
    ['ready', [8, 106, 64], [12, 154, 93]],
    ['busy', [123, 84, 11], [201, 138, 18]],
    ['error', [166, 53, 46], [216, 69, 60]],
  ];
  for (const [name, expected, old] of cases) {
    it(`--status-${name}-rgb = ${expected.join(' ')} — and the old ${old.join(' ')} failed on its pill`, () => {
      const c = token(LIGHT, `status-${name}-rgb`);
      expect(c).toEqual(expected);
      expect(contrast(c, raised)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, base)).toBeGreaterThanOrEqual(4.5);
      // the pill: `bg-status-X/15 text-status-X` and the /20 variants are the
      // same hue washed over the card — the surface that decides. Reverting to
      // the old triple reds this at 2.4–3.6.
      expect(contrast(c, wash(c, 0.2, raised))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(old, wash(old, 0.15, raised))).toBeLessThan(4.5);
      // hue preserved: the same channel ordering as the old value
      const order = (v: [number, number, number]): string =>
        [...v.keys()].sort((a, b) => v[b] - v[a]).join('');
      expect(order(c)).toBe(order(old));
    });
  }

  it('dark status tokens are untouched (they pass on slate)', () => {
    expect(token(DARK, 'status-ready-rgb')).toEqual([52, 211, 153]);
    expect(token(DARK, 'status-busy-rgb')).toEqual([251, 191, 36]);
    expect(token(DARK, 'status-error-rgb')).toEqual([248, 113, 113]);
    for (const n of ['ready', 'busy', 'error']) {
      expect(
        contrast(token(DARK, `status-${n}-rgb`), token(DARK, 'surface-raised-rgb')),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('T2 sweep — accent on a TEXT leaf wears text-accent-text; fills, glyphs and the wordmark keep text-accent', () => {
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

  it('section labels, form headers, links and the active sidebar badge are text-accent-text', () => {
    expect(read('views/ProxiesView.tsx')).toContain(
      'section-label text-accent-text">Network egress',
    );
    expect(read('views/ProxiesView.tsx')).toMatch(
      /section-label text-accent-text">\s*\{mode === 'add' \? 'Add proxy' : 'Edit proxy'\}/,
    );
    expect(read('views/CommandCenterView.tsx')).toContain(
      'section-label text-accent-text">{hello}',
    );
    expect(read('visual-harness/gallery.tsx')).toContain(
      'section-label text-accent-text">Network egress',
    );
    expect(read('visual-harness/gallery.tsx')).toContain(
      'section-label text-accent-text">Good morning',
    );
    expect(read('components/Sidebar.tsx')).toContain("'bg-accent/20 text-accent-text'");
    expect(read('components/TierBadge.tsx')).toContain(
      "enterprise: 'bg-accent/15 text-accent-text border-accent/30'",
    );
    expect(read('views/SettingsView.tsx')).toContain(
      'bg-accent px-3 py-1.5 text-xs font-semibold text-accent-on',
    );
  });

  it('no bare `section-label text-accent` survives in the swept views', () => {
    // Re-introducing one (the pattern every hero header used) reds this.
    const swept = [
      'views/ProxiesView.tsx',
      'views/CommandCenterView.tsx',
      'views/SessionsView.tsx',
      'views/FleetView.tsx',
      'views/RecordingsView.tsx',
      'views/ConnectivityView.tsx',
      'views/ProfilesView.tsx',
      'visual-harness/gallery.tsx',
    ];
    for (const rel of swept) {
      expect(read(rel), rel).not.toMatch(/section-label text-accent[" ]/);
    }
  });

  it('the wordmark keeps text-accent and is marked data-contrast-decorative (a brand mark, not copy)', () => {
    const bar = read('components/TitleBar.tsx');
    // JSX drops whitespace that contains a newline between text and a tag, so
    // the rendered wordmark is still exactly "DRIFTSTACK" however prettier wraps it.
    expect(bar).toMatch(
      /DRIFT\s*<span className="text-accent" data-contrast-decorative="true">\s*STACK\s*<\/span>/,
    );
  });

  it('the inactive sidebar badge reads in secondary ink — muted on elevated is 4.04 in dark', () => {
    expect(read('components/Sidebar.tsx')).toContain("'bg-surface-elevated text-ink-secondary'");
    expect(
      contrast(token(DARK, 'ink-muted-rgb'), token(DARK, 'surface-elevated-rgb')),
    ).toBeLessThan(4.5);
    expect(
      contrast(token(DARK, 'ink-secondary-rgb'), token(DARK, 'surface-elevated-rgb')),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

// ─── 2026-09-12 review of the batch — the states and scopes the first pass missed ──
// Each arm names the production line whose reversal reds it.
describe('review — hover states, opacity, and the simulator dark scope', () => {
  const readSrc = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
  const CHROME: [number, number, number] = [0x1d, 0x1e, 0x24]; // toolbar + drawer
  const CARD: [number, number, number] = [0x17, 0x18, 0x1d]; // bg-black/20 over it

  it('.btn-primary hovers to --accent-fill-hover-rgb (oxblood-550), which DARKENS — white on --accent-hover-rgb is 3.92', () => {
    // Reverting index.css `.btn-primary` to `hover:bg-accent-hover` reds the
    // class pin; moving the fill-hover triple up to the -400 rose reds the ratio.
    // comments stripped: the rule's own note names the class it replaced
    const primary = (/\.btn-primary\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(primary).toContain('hover:bg-accent-fill-hover active:bg-accent-active');
    expect(primary).not.toContain('hover:bg-accent-hover');
    const fill = token(ACCENT_BLOCK, 'accent-fill-hover-rgb');
    expect(fill).toEqual([154, 52, 70]);
    expect(TAILWIND).toMatch(
      /'fill-hover':\s*'rgb\(var\(--accent-fill-hover-rgb\) \/ <alpha-value>\)'/,
    );
    expect(contrast(WHITE, fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, fill)).toBeCloseTo(7.11, 1);
    // between the resting 500 and the pressed 600, and darker than rest
    expect(luminance(fill)).toBeLessThan(luminance(ACCENT));
    expect(luminance(fill)).toBeGreaterThan(luminance(token(ACCENT_BLOCK, 'accent-active-rgb')));
    // the value the hover used to be — the failure this replaces
    const rose = token(ACCENT_BLOCK, 'accent-hover-rgb');
    expect(rose).toEqual([200, 96, 110]);
    expect(contrast(WHITE, rose)).toBeCloseTo(3.92, 1);
    expect(contrast(WHITE, rose)).toBeLessThan(4.5);
  });

  it('every text-carrying accent fill in the swept components hovers to the fill token, never the rose', () => {
    // The Launch buttons (table + tile) and "+ New chat" are `bg-accent text-white`
    // with a hover; `hover:bg-accent-hover` back on any of them reds this.
    for (const rel of [
      'components/ProfilesTable.tsx',
      'components/ProfilePhoneCard.tsx',
      'views/AgentChatView.tsx',
      'views/TeamView.tsx',
    ]) {
      const src = readSrc(rel);
      expect(src, rel).toContain('hover:bg-accent-fill-hover');
      // one className: `bg-accent … text-white … hover:bg-accent-hover` (the tile's
      // aria-hidden ✓ selection dot keeps `group-hover:` — a glyph, not copy)
      expect(src, rel).not.toMatch(
        /bg-accent [^"'`\n]*text-white[^"'`\n]*(?<!group-)hover:bg-accent-hover/,
      );
    }
  });

  it('the sign-out shortcut hint carries no opacity — opacity-70 painted it at 3.02 (dark) / 3.16 (light) on the sign-out wash', () => {
    const sidebar = readSource('components/Sidebar.tsx');
    expect(sidebar).toMatch(/<span className="text-2xs">⌘⇧L<\/span>/);
    expect(sidebar).not.toMatch(/opacity-\d+">⌘⇧L/);
    // The arithmetic: the button is text-status-error on bg-status-error/10 over
    // the raised sidebar. At full ink it clears 4.5 in both modes; faded to 70%
    // (the ink composited at .7 over the wash) it does not. Putting the opacity
    // back reds the source pin above; this is why.
    for (const [block, expectedFull, expectedFaded] of [
      [DARK, 4.66, 3.02],
      [LIGHT, 5.37, 3.16],
    ] as const) {
      const err = token(block, 'status-error-rgb');
      const bg = wash(err, 0.1, token(block, 'surface-raised-rgb'));
      expect(contrast(err, bg)).toBeCloseTo(expectedFull, 1);
      expect(contrast(err, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(wash(err, 0.7, bg), bg)).toBeCloseTo(expectedFaded, 1);
      expect(contrast(wash(err, 0.7, bg), bg)).toBeLessThan(4.5);
    }
  });

  it('the simulator chrome is a DARK token scope: every mode token it uses fails on #1d1e24 at the light value and passes at the dark one', () => {
    // T3/T4 darkened the light tokens for light surfaces; the simulator's chrome
    // is #1d1e24 in both themes, so under a light <html> "Live" (status-ready),
    // "Connecting…" (busy), "Video unavailable" / the WebRTC leak line (error),
    // "· ws ✓" (ink-secondary) and the pane captions (ink-muted) all fell to
    // 2.5–2.7. The fix is a scope, not a per-line literal: data-mode="dark" on
    // the roots that own the chrome. Removing any of the three attributes, or
    // hoisting the token layer to :root/html so a nested scope cannot re-resolve
    // it, reds this arm.
    for (const name of [
      'status-ready-rgb',
      'status-busy-rgb',
      'status-error-rgb',
      'ink-secondary-rgb',
      'ink-muted-rgb',
    ]) {
      expect(contrast(token(DARK, name), CHROME), `dark ${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(LIGHT, name), CHROME), `light ${name}`).toBeLessThan(4.5);
    }
    expect(contrast(token(LIGHT, 'status-ready-rgb'), CARD)).toBeCloseTo(2.66, 1);
    expect(contrast(token(DARK, 'status-ready-rgb'), CARD)).toBeCloseTo(9.22, 1);
    expect(contrast(token(LIGHT, 'status-error-rgb'), CARD)).toBeCloseTo(2.68, 1);
    const sw = readSource('views/SimulatorWindow.tsx');
    expect(sw).toMatch(/<div\s+data-mode="dark"\s+data-component="simulator-shell"/);
    expect(sw).toMatch(/data-mode="dark"\s+data-component="simulator-empty"/);
    expect(sw).toMatch(/data-mode="dark"\s+data-component="simulator-toolbar-wrap"/);
    // the harness scene's window carries the same scope, so the gate measures
    // the chrome as shipped in BOTH themes
    expect(readSrc('visual-harness/gallery.tsx')).toMatch(
      /data-mode="dark"\s+className="[^"]*bg-\[#1d1e24\]/,
    );
    // the theme axis is an attribute selector, which is what lets a nested
    // element re-scope it — a :root/html-qualified selector would not
    expect(CSS).toMatch(/^\[data-mode='dark'\]\s*\{/m);
    expect(CSS).not.toMatch(/(?::root|html)\[data-mode=/);
  });

  it('the harness replica drawer mirrors the real drawer — white/50 captions and "· ws ✓", a titled Egress line', () => {
    // The gate measures the scene, not SimulatorWindow.tsx; a replica that lags
    // the real drawer is how S1/S2 shipped "fixed" with 13 findings still open.
    const g = readSrc('visual-harness/gallery.tsx');
    expect(g).toContain(
      "const infoLabel = 'text-[9.5px] uppercase tracking-[0.04em] text-white/50'",
    );
    expect(g).toContain('<span className="text-white/50"> · ws ✓</span>');
    expect(g).toContain('title="🌍 Residential NL #3 · Europe/Amsterdam"');
    expect(g).not.toMatch(/text-white\/40/);
    expect(g).not.toContain('text-ink-secondary"> · ws ✓');
    // and the real drawer still says the same
    const sw = readSource('views/SimulatorWindow.tsx');
    expect(sw).toContain('{info && <span className="text-white/50"> · ws ✓</span>}');
    expect(sw).not.toMatch(/text-\[9\.5px\] uppercase tracking-\[0\.04em\] text-white\/40/);
  });

  it('the gate reads mixed-content text, multiplies opacity in, exempts inactive controls — and its control exercises the first two', () => {
    // scripts/gui-text-quality.mjs is a browser script; its executable guard is
    // `--control` (12/12 cells must see FOUR injected findings). This arm pins
    // the shape so a "simplification" that restores the `children.length !== 0
    // → continue` skip is caught in the unit suite, not only on a runbook step.
    const gate = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'gui-text-quality.mjs'),
      'utf8',
    );
    expect(gate).toContain('const ownText = (el) =>');
    expect(gate).toContain('const fade = (el) =>');
    expect(gate).toContain('const fa = fg[3] * alpha;');
    expect(gate).toContain(`el.closest('[disabled], [aria-disabled="true"]')`);
    expect(gate).toContain(
      'opacity:0.3;color:#fff"><i aria-hidden="true">•</i> control faded mixed',
    );
    expect(gate).toContain('seen.contrast === 2');
    expect(gate).not.toMatch(/if \(el\.children\.length !== 0\) \{[^}]*continue;/);
  });
});

describe("review follow-ups — the simulator's accent-as-text sites and the sign-out hover wash", () => {
  it('SimulatorWindow: the four accent-coloured TEXT sites on the fixed-dark chrome wear text-accent-text (7.9:1), never bare text-accent (2.7:1)', () => {
    // Icons (aria-hidden glyphs) keep text-accent; these four are copy a user
    // reads: the active tab label, the active pane pill, the Retry button and
    // the file drop-zone. Reverting any one of them to 'text-accent' reds it.
    const src = readSource('views/SimulatorWindow.tsx');
    expect(src).toContain("active === true ? 'text-accent-text' : 'text-ink-secondary");
    expect(src).toContain("'bg-accent/20 text-accent-text ring-1 ring-accent/40'");
    expect(src).toContain('font-medium text-accent-text transition-colors hover:bg-white/10');
    expect(src).toContain("'border-accent bg-accent/5 text-accent-text'");
    expect(src).toContain('hover:bg-accent/5 hover:text-accent-text');
    expect(src).not.toContain("active === true ? 'text-accent' :");
    expect(src).not.toContain("'bg-accent/20 text-accent ring-1");
    const chrome: [number, number, number] = [29, 30, 36];
    expect(contrast(token(DARK, 'accent-text-rgb'), chrome)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(ACCENT_BLOCK, 'accent-rgb'), chrome)).toBeLessThan(4.5);
  });

  it('the sign-out hover wash is /10: the error ink clears 4.5 on it over the sidebar surfaces in both modes (the /20 wash was 4.17 light / 3.93 dark)', () => {
    const src = readSource('components/Sidebar.tsx');
    expect(src).toContain('hover:bg-status-error/10');
    expect(src).not.toContain('hover:bg-status-error/20');
    const mix = (
      c: [number, number, number],
      a: number,
      bg: [number, number, number],
    ): [number, number, number] => [
      c[0] * a + bg[0] * (1 - a),
      c[1] * a + bg[1] * (1 - a),
      c[2] * a + bg[2] * (1 - a),
    ];
    for (const block of [LIGHT, DARK]) {
      const err = token(block, 'status-error-rgb');
      for (const surface of ['surface-base-rgb', 'surface-raised-rgb']) {
        const bg = token(block, surface);
        expect(contrast(err, mix(err, 0.1, bg)), surface).toBeGreaterThanOrEqual(4.5);
      }
      // control: the old /20 wash failed — light on the base surface (4.17),
      // dark on the raised one (3.93); dark base at /20 was 4.81, so the
      // surface that failed differs per mode and the control names each.
      const failedOn = block === LIGHT ? 'surface-base-rgb' : 'surface-raised-rgb';
      expect(contrast(err, mix(err, 0.2, token(block, failedOn)))).toBeLessThan(4.5);
    }
  });
});

describe('audit-scene follow-ups — the error hue as text, and the saved-chat rail titles', () => {
  const readSource2 = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
  it('--status-error-text-rgb clears 4.5 on the error /15 wash over raised in both modes; .btn-danger wears it (the error token read 4.27 in dark on Stop / Delete)', () => {
    const mix = (
      c: [number, number, number],
      a: number,
      bg: [number, number, number],
    ): [number, number, number] => [
      c[0] * a + bg[0] * (1 - a),
      c[1] * a + bg[1] * (1 - a),
      c[2] * a + bg[2] * (1 - a),
    ];
    for (const block of [LIGHT, DARK]) {
      const err = token(block, 'status-error-rgb');
      const text = token(block, 'status-error-text-rgb');
      const raised = token(block, 'surface-raised-rgb');
      expect(contrast(text, mix(err, 0.15, raised)), 'text on the /15 wash').toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrast(text, mix(err, 0.2, raised)),
        'text on the /20 hover wash',
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, raised)).toBeGreaterThanOrEqual(4.5);
    }
    // control: the dark error token itself fails on the wash (what shipped)
    const dErr = token(DARK, 'status-error-rgb');
    expect(contrast(dErr, mix(dErr, 0.15, token(DARK, 'surface-raised-rgb')))).toBeLessThan(4.5);
    expect(CSS).toMatch(/\.btn-danger \{[^}]*bg-status-error\/15 text-status-error-text/);
    expect(CSS).toMatch(/\.btn-danger \{[^}]*hover:bg-status-error\/20/);
    expect(readFileSync(join(SRC, '..', 'tailwind.config.ts'), 'utf8')).toMatch(
      /'error-text':\s*'rgb\(var\(--status-error-text-rgb\) \/ <alpha-value>\)'/,
    );
  });

  it('the saved-chat rail names a clipped title: the truncating span carries title={c.title}', () => {
    const src = readSource2('views/AgentChatView.tsx');
    expect(src).toMatch(/className="block truncate text-xs text-ink-primary" title=\{c\.title\}>/);
  });
});
