import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// 2026-09-25 — the dashboard's colours come from the shared design-tokens preset
// (packages/design-tokens), not from a tk table of its own in tailwind.config.mjs.
// So "defined" now means what Tailwind actually resolves from the dashboard's
// config, preset included — read through Tailwind's own resolveConfig, the way
// the build sees it, instead of a regex over one file.
const requireFromDashboard = createRequire(new URL('../../package.json', import.meta.url));
const resolveConfig = requireFromDashboard('tailwindcss/resolveConfig') as (config: object) => {
  theme: { colors: Record<string, unknown> };
};

const SRC = new URL('../../src', import.meta.url).pathname;

function sourceFiles(directory: string): Array<{ path: string; text: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(astro|ts|css)$/.test(entry.name)
      ? [{ path: absolute.slice(SRC.length + 1), text: readFileSync(absolute, 'utf8') }]
      : [];
  });
}

function astroSources(): string[] {
  return sourceFiles(SRC)
    .filter((f) => f.path.endsWith('.astro'))
    .map((f) => f.text);
}

async function resolvedTkColours(): Promise<Set<string>> {
  const config = (await import('../../tailwind.config.mjs')).default as object;
  const colours = resolveConfig(config).theme.colors;
  return new Set(Object.keys((colours.tk ?? {}) as Record<string, unknown>));
}

// Tailwind's own palette names. A class like `text-amber-700` or `ring-slate-200`
// paints a colour that is not a token, so it cannot follow data-mode and drifts
// from the app the moment a token moves.
const RAW_PALETTE_CLASS =
  /\b(?:bg|text|border|ring|divide|from|to|via|fill|stroke|outline|placeholder|decoration|shadow|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/g;
const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * The raw colours the dashboard is allowed to keep, each with its reason. The
 * list may only shrink.
 */
const ALLOWED_RAW = new Map<string, string>([
  // Google's four-colour "G" on the sign-in buttons is Google's trademark art.
  ['pages/login.astro #4285F4', 'Google sign-in mark'],
  ['pages/login.astro #34A853', 'Google sign-in mark'],
  ['pages/login.astro #FBBC05', 'Google sign-in mark'],
  ['pages/login.astro #EA4335', 'Google sign-in mark'],
  ['pages/signup.astro #4285F4', 'Google sign-up mark'],
  ['pages/signup.astro #34A853', 'Google sign-up mark'],
  ['pages/signup.astro #FBBC05', 'Google sign-up mark'],
  ['pages/signup.astro #EA4335', 'Google sign-up mark'],
  // An authenticator QR code has to be black on white to scan in either mode.
  ['pages/security.astro #fff', 'two-factor QR code, light modules'],
  ['pages/security.astro #000', 'two-factor QR code, dark modules'],
  // A comment recording the retired oxblood-900 literal.
  ['pages/security.astro #4f242b', 'comment naming the retired literal'],
  // Issue and PR numbers in comments, not colours.
  ['pages/verify-email.astro #187', 'issue reference in a comment'],
  ['pages/auth/magic-link.astro #190', 'issue reference in a comment'],
  ['pages/auth/magic-link-request.astro #190', 'issue reference in a comment'],
  // The modal scrim is the app's own (ConfirmProvider): black at 40% under a
  // light blur, the same in both modes.
  ['layouts/DashboardLayout.astro bg-black/40', 'modal and palette scrim'],
  ['styles/base.css bg-black/40', 'modal scrim (.modal-overlay)'],
  // The browser-chrome colour (<meta name="theme-color">) takes a literal: it is
  // each mode's page ground, surface-base (#ebedf2 light, #0f172a dark).
  ['layouts/DashboardLayout.astro #ebedf2', 'theme-color meta, light page ground'],
  ['layouts/DashboardLayout.astro #0f172a', 'theme-color meta, dark page ground'],
]);

function rawColours(files: Array<{ path: string; text: string }>): string[] {
  const found = new Set<string>();
  for (const f of files) {
    for (const m of f.text.matchAll(RAW_PALETTE_CLASS)) found.add(`${f.path} ${m[0]}`);
    for (const m of f.text.matchAll(HEX_COLOUR)) {
      // HTML character references (&#39;) are not colours.
      if (f.text[m.index! - 1] === '&') continue;
      found.add(`${f.path} ${m[0]}`);
    }
  }
  return [...found].sort();
}

describe('customer dashboard design-token baseline', () => {
  it('defines every tk color utility requested by dashboard templates', async () => {
    const configured = await resolvedTkColours();
    const requested = new Set(
      astroSources().flatMap((source) =>
        [
          ...source.matchAll(
            /(?:bg|text|border|ring|divide|from|to|via|fill|stroke|outline|placeholder)-tk-([a-z0-9-]+)/g,
          ),
        ].map((match) => match[1]!),
      ),
    );

    // The preset's tk vocabulary is ~24 names; a count floor keeps a config that
    // silently lost the preset from passing with an empty set.
    expect(configured.size).toBeGreaterThanOrEqual(20);
    expect(requested.size).toBeGreaterThanOrEqual(15);
    expect([...requested].filter((token) => !configured.has(token)).sort()).toEqual([]);
  });

  it('the tk colours come from the shared design-tokens preset, and the retired hand-kept sets are gone', async () => {
    const tailwind = readFileSync(new URL('../../tailwind.config.mjs', import.meta.url), 'utf8');
    expect(tailwind).toMatch(/import preset from '@driftstack\/design-tokens\/tailwind-preset';/);
    expect(tailwind).toMatch(/presets: \[preset\],/);
    // No local colour table: slate, the dark-only surface/ink sets, the glow reds
    // and the old tk block all lived here and drifted from the app.
    expect(tailwind).not.toMatch(/colors:\s*\{/);
    expect(tailwind).not.toMatch(/#e23847|#f25366|#a8202d|#722F37/i);

    const colours = resolveConfig((await import('../../tailwind.config.mjs')).default as object)
      .theme.colors as Record<string, Record<string, string>>;
    // The canonical groups read the token variables, so they follow data-mode.
    expect(colours.surface?.base).toBe('rgb(var(--surface-base-rgb) / <alpha-value>)');
    expect(colours.tk?.bg).toBe('rgb(var(--surface-base-rgb) / <alpha-value>)');
    expect(colours.tk?.inset).toBe('rgb(var(--surface-inset-rgb) / <alpha-value>)');
  });

  it('no tk utility carries two opacity modifiers (bg-tk-accent/10/30 generated no CSS at all)', () => {
    const doubled = astroSources().flatMap((source) =>
      [...source.matchAll(/\b[a-z-]+-tk-[a-z0-9-]+\/\d+\/\d+/g)].map((m) => m[0]),
    );
    expect(doubled).toEqual([]);
    // Positive control: the scanner sees the shape it guards against.
    expect('class="bg-tk-accent/10/30 p-6"'.match(/\b[a-z-]+-tk-[a-z0-9-]+\/\d+\/\d+/g)).toEqual([
      'bg-tk-accent/10/30',
    ]);
  });

  it('no raw colour outside the tokens: every hex and raw palette class in src/ is on the reviewed list', () => {
    const files = sourceFiles(SRC);
    const found = rawColours(files);
    expect(found.filter((hit) => !ALLOWED_RAW.has(hit))).toEqual([]);
    // Every allowance is still used, so the list can only shrink.
    expect([...ALLOWED_RAW.keys()].filter((key) => !found.includes(key))).toEqual([]);
  });

  it('the raw-colour scanner flags a raw palette class and a hex literal (positive control)', () => {
    const fixture = [
      {
        path: 'pages/fixture.astro',
        text: '<p class="text-amber-700 ring-slate-200 bg-tk-surface">x</p><i style="color:#abcdef">&#39;</i>',
      },
    ];
    expect(rawColours(fixture)).toEqual([
      'pages/fixture.astro #abcdef',
      'pages/fixture.astro ring-slate-200',
      'pages/fixture.astro text-amber-700',
    ]);
  });

  it('violet and teal are retired: no swatch, accent command or stored-accent read survives', () => {
    const layout = readFileSync(
      new URL('../../src/layouts/DashboardLayout.astro', import.meta.url),
      'utf8',
    );
    expect(layout).not.toMatch(/data-set-accent|themer-swatch|Accent: /);
    expect(layout).not.toMatch(/'violet'|'teal'|#6d5efc|#109a82/);
    expect(layout).not.toMatch(/getItem\('ds_theme_accent'\)/);
  });
});

// ── The atmosphere and the focus ring (theme review, 2026-09-25) ─────────────

type Rgb = [number, number, number];
const hexRgb = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(hexRgb(a)), luminance(hexRgb(b))].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
};

type ModeTokens = Record<string, string | number>;
const TOKENS = requireFromDashboard('@driftstack/design-tokens/tokens.json') as {
  accent: Record<string, string | number>;
  modes: { light: ModeTokens; dark: ModeTokens };
};

/** The geometry of `radial-gradient(ellipse RX% RY% at CX% CY%, …, transparent S%)`. */
function radial(css: string): { rx: number; ry: number; cx: number; cy: number; stop: number } {
  const m =
    /radial-gradient\(\s*ellipse (\d+)% (\d+)% at (\d+)% (\d+)%,[\s\S]*?transparent (\d+)%\s*\)/.exec(
      css,
    );
  if (!m) throw new Error(`not an ellipse radial with a transparent stop: ${css}`);
  const [rx, ry, cx, cy, stop] = m.slice(1).map(Number) as [number, number, number, number, number];
  return { rx, ry, cx, cy, stop };
}
/** How far past each edge of its own box the visible part of the radial reaches (≤ 0 = inside). */
function overshoot(g: ReturnType<typeof radial>) {
  const x = (g.rx * g.stop) / 100;
  const y = (g.ry * g.stop) / 100;
  return { left: x - g.cx, right: g.cx + x - 100, top: y - g.cy, bottom: g.cy + y - 100 };
}

describe('customer dashboard atmosphere and focus ring', () => {
  const baseCss = readFileSync(new URL('../../src/styles/base.css', import.meta.url), 'utf8');
  const layout = readFileSync(
    new URL('../../src/layouts/DashboardLayout.astro', import.meta.url),
    'utf8',
  );
  const HALF_SOFT = 'rgb(var(--accent-rgb) / calc(var(--accent-subtle-alpha) / 2))';

  it('the keyboard focus ring reaches 3:1 in both modes on every ground a control sits on', () => {
    const grounds = ['surface-base', 'surface-raised', 'surface-elevated'];
    const { light, dark } = TOKENS.modes;
    const accent = String(TOKENS.accent.accent);
    // Light: the accent ring.
    for (const g of grounds) expect(contrast(accent, String(light[g]))).toBeGreaterThanOrEqual(3);
    // Dark: the accent is 2.9:1 on the slate ground (2.4:1 on a card), which is
    // why dark draws the ring in its accent-text tone.
    expect(contrast(accent, String(dark['surface-base']))).toBeLessThan(3);
    for (const g of grounds)
      expect(contrast(String(dark['accent-text']), String(dark[g]))).toBeGreaterThanOrEqual(3);

    expect(baseCss).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
    expect(baseCss).toMatch(
      /\[data-mode='dark'\] :focus-visible \{\s*outline-color: var\(--accent-text\);\s*\}/,
    );
    // No button recipe paints its own accent ring over the one above (a class
    // outline colour would win over the dark override).
    expect(baseCss).not.toMatch(/outline-tk-accent\b/);
  });

  it("an input's focus edge reaches 3:1 in dark too, and every input takes it from the recipe", () => {
    const { dark } = TOKENS.modes;
    const accent = String(TOKENS.accent.accent);
    // The accent edge is 2.4:1 against a dark card, so dark draws it in accent-text.
    expect(contrast(accent, String(dark['surface-raised']))).toBeLessThan(3);
    for (const g of ['surface-raised', 'surface-inset', 'surface-base'])
      expect(contrast(String(dark['accent-text']), String(dark[g]))).toBeGreaterThanOrEqual(3);
    expect(baseCss).toMatch(
      /\[data-mode='dark'\] \.form-input:focus,\s*\[data-mode='dark'\] \.form-input-group:focus-within \{\s*@apply border-tk-accent-text ring-tk-accent-text\/40;/,
    );
    // An input that draws its own accent focus edge would miss the dark tone.
    const own = sourceFiles(SRC)
      .filter((f) => f.path.endsWith('.astro'))
      .flatMap((f) =>
        [...f.text.matchAll(/focus(?:-within)?:border-tk-accent\b/g)].map(() => f.path),
      );
    expect(own).toEqual([]);
  });

  it('the soft glows are half the app’s soft-accent alpha, never the nav-row wash itself', () => {
    // 0.06 light and 0.125 dark: the old web glow was 0.13 in both modes; the
    // full --accent-soft (0.25 in dark) is the active nav row's wash.
    for (const mode of ['light', 'dark'] as const)
      expect(Number(TOKENS.modes[mode]['accent-subtle-alpha']) / 2).toBeLessThanOrEqual(0.13);
    const tailwind = readFileSync(new URL('../../tailwind.config.mjs', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
    // The .hero-glow::after rule that paints (the shared ::before/::after rule
    // and the reduced-motion one carry no background).
    const heroAfter =
      [...baseCss.matchAll(/\.hero-glow::after \{[^}]*\}/g)]
        .map((m) => m[0])
        .find((block) => block.includes('background')) ?? '';
    const lower = /'glow-radial-accent-soft':\s*'([^']+)'/.exec(tailwind)?.[1] ?? '';
    const room = /class="tk-room[^"]*"\s*style="background: ([^"]+)"/.exec(index)?.[1] ?? '';
    for (const css of [heroAfter, lower, room]) {
      expect(css).toContain(HALF_SOFT);
      expect(css).not.toContain('var(--accent-soft)');
    }
  });

  it('every soft radial fades out inside its own box, so none ends in a straight line', () => {
    const tailwind = readFileSync(new URL('../../tailwind.config.mjs', import.meta.url), 'utf8');
    const index = readFileSync(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
    // The layout's lower wash on the auth pages: inside on all four edges.
    const lower = overshoot(radial(/'glow-radial-accent-soft':\s*'([^']+)'/.exec(tailwind)![1]!));
    expect(Math.max(lower.left, lower.right, lower.top, lower.bottom)).toBeLessThanOrEqual(0);
    // The overview header wash: inside on the left (beside the sidebar), right
    // and bottom. Its top is the top of the page, under the header.
    const room = overshoot(
      radial(/class="tk-room[^"]*"\s*style="background: ([^"]+)"/.exec(index)![1]!),
    );
    expect(Math.max(room.left, room.right, room.bottom)).toBeLessThanOrEqual(0);
    // Positive control: the shape both had before, centred on an edge, is caught.
    expect(
      overshoot(radial('radial-gradient(ellipse 60% 80% at 0% 0%, red, transparent 70%)')).left,
    ).toBeGreaterThan(0);
    expect(
      overshoot(radial('radial-gradient(ellipse 45% 30% at 50% 100%, red, transparent 65%)'))
        .bottom,
    ).toBeGreaterThan(0);
  });

  it('on the pages without a sidebar, <main> hosts the hero glow, so it runs down to the footer', () => {
    expect(layout).toMatch(
      /<main[^>]*class:list=\{\['min-w-0 flex-1', !withSidebar && 'relative'\]\}/,
    );
    const pages = sourceFiles(SRC).filter((f) => f.text.includes('class="hero-glow"'));
    expect(pages.length).toBeGreaterThanOrEqual(7);
    for (const page of pages) {
      // A positioned wrapper would become the glow's box again and cut it off
      // where the page's own content ends.
      expect(page.text, page.path).not.toMatch(
        /<div class="[^"]*\brelative\b[^"]*">\s*<div class="hero-glow"/,
      );
      expect(page.text, page.path).toMatch(
        /<div>\s*<div class="hero-glow" aria-hidden="true"><\/div>/,
      );
      expect(page.text, page.path).toMatch(/withSidebar=\{false\}/);
    }
  });
});
