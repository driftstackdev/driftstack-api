// W794 — apps/status-site src/styles/global.css content parity. Pins the
// status-site theme.
//
// W368 — migrated to Tailwind v4: the theme lives in global.css (CSS-first).
//
// P4 (2026-09-25) — SUPERSEDES the W794 palette pins. They held the status
// site's own hand-kept palette: an 11-shade oxblood and slate ramp, dark-only
// surface/ink values, and a "glow-red" (#e23847) brand accent that also
// coloured outage badges — with a light block that still resolved the accent
// to violet. The site now takes the desktop app's theme from the shared
// package (packages/design-tokens), and only its LIGHT theme — a theme switch
// would have to remember the choice in client storage, which the privacy policy
// says this page never does — and the markup's raw Tailwind palette (amber,
// orange, red, blue, indigo, emerald) is gone. What is pinned here instead:
//   - the package imports, and that no token value is re-declared locally;
//   - the one colour the status site adds: its incident red, MEASURED — at
//     least 25° of hue from the brand accent (the app's own rule for status
//     hues), AA on every ground it sits on, and its label AA on the solid fill;
//   - every incident badge's text/ground pair, MEASURED from the maps the
//     pages actually render;
//   - no raw palette class anywhere in the site's source (with a control).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const GLOBAL_CSS = resolve(REPO_ROOT, 'apps/status-site/src/styles/global.css');
const SRC = resolve(REPO_ROOT, 'apps/status-site/src');
const TOKENS = JSON.parse(read(resolve(REPO_ROOT, 'packages/design-tokens/tokens.json'))) as {
  accent: Record<string, string>;
  modes: Record<'light' | 'dark', Record<string, string>>;
};
const TOKENS_CSS = read(resolve(REPO_ROOT, 'packages/design-tokens/dist/tokens.css'));

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
const wash = (fg: Rgb, alpha: number, bg: Rgb): Rgb => [
  fg[0] * alpha + bg[0] * (1 - alpha),
  fg[1] * alpha + bg[1] * (1 - alpha),
  fg[2] * alpha + bg[2] * (1 - alpha),
];
/** HSL hue, the measure the app's own 25° rule uses. */
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

/** The incident red as global.css declares it (the site has one mode). */
function incidentRed(css: string): Rgb {
  const m = css.match(/:root \{\s*\n\s*--incident-red-rgb: (\d+) (\d+) (\d+);/);
  expect(m, '--incident-red-rgb').not.toBeNull();
  return [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
}

describe('W794 status-site theme content parity', () => {
  it('theme file exists at canonical path', () => {
    expect(existsSync(GLOBAL_CSS)).toBe(true);
  });

  it("CRITICAL `@import 'tailwindcss'` pinned, then the shared tokens: tokens.css (the app's two modes on data-mode) and theme-v4.css (its Tailwind v4 utilities). Drift to dropping either leaves every surface-*/ink-*/status-* class without a value", () => {
    const p = read(GLOBAL_CSS);
    const imports = [...p.matchAll(/^@import '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      'tailwindcss',
      '@driftstack/design-tokens/tokens.css',
      '@driftstack/design-tokens/theme-v4.css',
    ]);
  });

  it('CRITICAL the site has ONE mode: no `dark:` variant (the dead `.dark` class variant nothing ever set is gone), nothing follows the OS setting, and the layout pins data-mode="light" with no theme switch (a remembered choice would need client storage the privacy policy says this page never uses)', () => {
    const p = read(GLOBAL_CSS);
    expect(p).not.toMatch(/@custom-variant dark/);
    expect(p).not.toMatch(/&:is\(\.dark \*\)/);
    expect(p).not.toMatch(/prefers-color-scheme/);
    const layout = read(join(SRC, 'layouts', 'StatusLayout.astro'));
    expect(layout).toMatch(/<html lang="en" data-mode="light" data-accent="oxblood">/);
    expect(layout).not.toMatch(/data-theme-toggle/);
  });

  it('CRITICAL no hand-kept palette survives: no oxblood/slate ramp, no glow-red, no local surface/ink values, no violet, and no canonical token re-declared (the app is the only source)', () => {
    const p = read(GLOBAL_CSS);
    for (const retired of [
      '--color-oxblood-',
      '--color-slate-',
      '--color-glow-red',
      '--color-surface-',
      '--color-ink-',
      '--color-accent:',
      '#e23847',
      '#6d5efc',
      '#f2f3f6',
    ]) {
      expect(p, retired).not.toContain(retired);
    }
    const packageNames = new Set(
      [...TOKENS_CSS.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string),
    );
    expect(packageNames.has('--surface-base-rgb')).toBe(true);
    const declared = [...p.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string);
    expect(declared.filter((n) => packageNames.has(n))).toEqual([]);
  });

  it('CRITICAL the incident red is at least 25° of hue from the brand accent (the app’s rule for status hues), so an outage never reads as the brand — and the app’s own error red would not be (CONTROL: 13.4°), which is why the status site has its own', () => {
    const p = read(GLOBAL_CSS);
    const accentHue = hue(rgb(TOKENS.accent.accent as string));
    const red = incidentRed(p);
    expect(hueGap(accentHue, hue(red)), 'incident red').toBeGreaterThanOrEqual(25);
    const appError = rgb(TOKENS.modes.light['status-error'] as string);
    expect(hueGap(accentHue, hue(appError)), 'app error red').toBeLessThan(25);
    expect(p).toMatch(/:root \{\s*\n\s*--incident-red-rgb: 152 61 22;/);
    expect(p).toMatch(/--color-incident-red: rgb\(var\(--incident-red-rgb\)\);/);
  });

  it('CRITICAL the incident red clears AA (4.5:1) as text on a card, on the page ground and on its own /15 wash over a card, and the solid fill carries its label (ink-inverted) at AA — measured', () => {
    const p = read(GLOBAL_CSS);
    const t = TOKENS.modes.light;
    const red = incidentRed(p);
    const raised = rgb(t['surface-raised'] as string);
    const base = rgb(t['surface-base'] as string);
    expect(contrast(red, raised), 'on card').toBeGreaterThanOrEqual(4.5);
    expect(contrast(red, base), 'on ground').toBeGreaterThanOrEqual(4.5);
    expect(contrast(red, wash(red, 0.15, raised)), 'on /15 wash').toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(t['ink-inverted'] as string), red), 'label on fill').toBeGreaterThanOrEqual(
      4.5,
    );
  });

  // Every badge the pages render, resolved to colours. A badge sits inside an
  // incident card (surface-raised). `bg-X/NN` is a wash of X at NN% over the
  // card; `bg-X` alone is a solid fill.
  function colourOf(name: string): Rgb {
    if (name === 'incident-red') return incidentRed(read(GLOBAL_CSS));
    const hex = TOKENS.modes.light[name];
    expect(hex, `token ${name}`).toBeDefined();
    return rgb(hex as string);
  }
  function badgePairs(page: string): Array<{ key: string; text: string; bg: string }> {
    const body = read(join(SRC, 'pages', page));
    const pairs: Array<{ key: string; text: string; bg: string }> = [];
    for (const map of body.matchAll(
      /const (STATUS_BADGE|SEVERITY_BADGE) = \{([\s\S]*?)\n\s*\};/g,
    )) {
      for (const row of (map[2] ?? '').matchAll(/^\s*([a-z]+): \[([^\]]*)\]/gm)) {
        const classes = [...(row[2] ?? '').matchAll(/'([^']+)'/g)].map((c) => c[1] as string);
        const text = classes.find((c) => c.startsWith('text-'))?.slice(5);
        const bg = classes.find((c) => c.startsWith('bg-'))?.slice(3);
        expect(text && bg, `${page} ${row[1]}`).toBeTruthy();
        pairs.push({ key: `${map[1]}.${row[1]}`, text: text as string, bg: bg as string });
      }
    }
    return pairs;
  }

  it('CRITICAL every incident badge (severity + lifecycle, on the home, incident and history pages) clears AA over its own background on a card — measured from the maps the pages render', () => {
    const pages = ['index.astro', 'incident.astro', 'history.astro'];
    const byPage = pages.map((p) => badgePairs(p));
    // Anti-vacuity: 3 severities + 4 lifecycle states on each page, and the
    // three pages carry the SAME maps (one recipe, not three drifting copies).
    for (const pairs of byPage) expect(pairs).toHaveLength(7);
    expect(byPage[1]).toEqual(byPage[0]);
    expect(byPage[2]).toEqual(byPage[0]);
    const card = rgb(TOKENS.modes.light['surface-raised'] as string);
    for (const { key, text, bg } of byPage[0] ?? []) {
      const [bgName, alphaPct] = bg.split('/') as [string, string | undefined];
      const ground = alphaPct
        ? wash(colourOf(bgName), Number(alphaPct) / 100, card)
        : colourOf(bgName);
      const ratio = contrast(colourOf(text), ground);
      expect(ratio, `${key}: text-${text} on bg-${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // CONTROL — the measurement fails a real near-miss: the app's status pill
    // on the PAGE ground instead of a card (busy text on its /20 wash, 4.2).
    const nearMiss = contrast(
      colourOf('status-busy'),
      wash(colourOf('status-busy'), 0.2, rgb(TOKENS.modes.light['surface-base'] as string)),
    );
    expect(nearMiss).toBeLessThan(4.5);
    // The outage is the loudest: a SOLID incident-red fill.
    const index = read(join(SRC, 'pages', 'index.astro'));
    expect(index).toMatch(
      /outage: \['border-incident-red', 'bg-incident-red', 'text-ink-inverted'\],/,
    );
  });

  it('CRITICAL no raw Tailwind palette colour anywhere in the status site’s source — status hues are the app’s status tokens or the incident red (with a CONTROL that the scan finds one)', () => {
    const RAW =
      /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|oxblood|glow)-\d{2,3}\b/g;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : /\.(astro|css|ts)$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      );
    const files = walk(SRC);
    expect(files.length).toBeGreaterThanOrEqual(9);
    const hits = files.flatMap((f) => [...read(f).matchAll(RAW)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
    expect('class="bg-amber-50 text-emerald-700 border-red-500/30"'.match(RAW)).toEqual([
      'bg-amber-50',
      'text-emerald-700',
      'border-red-500',
    ]);
  });

  it('CRITICAL prose container width 65ch pinned (v4 `--container-prose`, was maxWidth.prose). The 65-char measure is the readable-line-length anchor; matches docs W786 reference contract.', () => {
    const p = read(GLOBAL_CSS);
    expect(p).toMatch(/--container-prose: 65ch;/);
  });

  it('CRITICAL mode-axis color-scheme pinned: :root light + [data-mode=dark] override — form-control widgets follow the axis.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/:root \{\s*\n\s+color-scheme: light;\s*\n\s+\}/);
    expect(p).toMatch(/\[data-mode='dark'\] \{\s*\n\s+color-scheme: dark;\s*\n\s+\}/);
  });

  it('CRITICAL html font-family + base @apply pinned. Geist + ui-sans-serif fallback chain + bg-surface-base + text-ink-primary @apply matches cross-app base-style contract. F-1 also adds overflow-x:clip to prevent iPhone Safari horizontal scroll.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(
      /html \{\s*\n\s+font-family: Geist, ui-sans-serif, system-ui, sans-serif;\s*\n\s+@apply bg-surface-base text-ink-primary;[\s\S]*?overflow-x: clip;\s*\n\s+\}/,
    );
  });

  it("CRITICAL body min-h-screen + antialiased pinned. The 'min-h-screen' class ensures the status-page background extends to viewport edge; 'antialiased' enables font smoothing for sharper text. F-1 adds max-width:100vw + overflow-x:clip to contain horizontal overflow.", () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(
      /body \{\s*\n\s+@apply min-h-screen bg-surface-base text-ink-primary antialiased;\s*\n\s+max-width: 100vw;\s*\n\s+overflow-x: clip;\s*\n\s+\}/,
    );
  });

  it('CRITICAL @layer base wrapping pinned. The base styles are inside @layer base so Tailwind orders them BEFORE component + utility classes.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/@layer base \{/);
  });

  it('P4 the overall status card carries a 4px rim in its state’s hue (ready / busy / incident red, idle while loading or unknown), keyed off the data-state renderOverall sets', () => {
    const p = read(GLOBAL_CSS);
    expect(p).toMatch(/\.status-banner \{\s*\n\s*border-left-width: 4px;/);
    expect(p).toMatch(
      /\.status-banner\[data-state='operational'\] \{\s*\n\s*border-left-color: rgb\(var\(--status-ready-rgb\)\);/,
    );
    expect(p).toMatch(
      /\.status-banner\[data-state='degraded'\] \{\s*\n\s*border-left-color: rgb\(var\(--status-busy-rgb\)\);/,
    );
    expect(p).toMatch(
      /\.status-banner\[data-state='outage'\] \{\s*\n\s*border-left-color: rgb\(var\(--incident-red-rgb\)\);/,
    );
    const index = read(join(SRC, 'pages', 'index.astro'));
    expect(index).toMatch(/class="status-banner /);
    expect(index).toMatch(/card\.dataset\.state = state;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/status-site-theme-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
