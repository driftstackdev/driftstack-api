// Drift guard for apps/docs/src/styles/base.css.
//
// P4 (2026-09-25) — SUPERSEDES the S22.1 pins, which held this file's own copy
// of the marketing site's token VALUES (dark+oxblood default, #060608 ground,
// #9b3b46 accent, violet/teal axes) byte-identical to marketing. The docs now
// take every colour, radius, shadow and font stack from packages/design-tokens,
// which is the desktop app's own theme (its tests fail when the two disagree),
// and light is the default. What this file still owns, and what is pinned here:
// the package imports, the rule that it declares no token value itself, the
// light-first wash and the dark code island, the prose hooks, the self-hosted
// fonts, the F-1 overflow guards, the three utility atoms, the callout, table
// and inline-code recipes, and the method chips — whose contrast is MEASURED
// here from the package's values, over both grounds a chip sits on.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/styles/base.css');
const TOKENS_JSON = resolve(REPO_ROOT, 'packages/design-tokens/tokens.json');
const TOKENS_CSS = resolve(REPO_ROOT, 'packages/design-tokens/dist/tokens.css');
const ALIASES_CSS = resolve(REPO_ROOT, 'packages/design-tokens/dist/web-aliases.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

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

type ModeTokens = Record<string, string>;
const tokens = JSON.parse(read(TOKENS_JSON)) as { modes: { light: ModeTokens; dark: ModeTokens } };

describe('docs styles/base content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Tailwind v4 @import + typography @plugin header pinned (W368 — replaces the v3 3-directive header)', () => {
    expect(body).toMatch(/@import 'tailwindcss';/);
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
  });

  it('S22.1 dark: variant follows the data-mode axis (was the scaffold .dark class, which nothing set) — the theme-toggle icons (hidden dark:block) depend on it', () => {
    expect(body).toMatch(
      /@custom-variant dark \(&:where\(\[data-mode='dark'\], \[data-mode='dark'\] \*\)\);/,
    );
    expect(body).not.toMatch(/&:is\(\.dark \*\)/);
  });

  it('P4 — the tokens come from the shared package: tokens.css, web-aliases.css and theme-v4.css are imported right after tailwindcss, in that order', () => {
    const imports = [...body.matchAll(/^@import '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      'tailwindcss',
      '@driftstack/design-tokens/tokens.css',
      '@driftstack/design-tokens/web-aliases.css',
      '@driftstack/design-tokens/theme-v4.css',
    ]);
  });

  it('P4 — the file declares no token VALUE of its own: no canonical token and no web alias the package defines is re-declared here (a redeclaration is how the five hand-kept palettes drifted apart)', () => {
    const packageNames = new Set(
      [...`${read(TOKENS_CSS)}\n${read(ALIASES_CSS)}`.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map(
        (m) => m[1] as string,
      ),
    );
    // Vacuity: the package really does define the names this looks for.
    for (const name of ['--surface-base-rgb', '--accent', '--bg', '--ink-2', '--accent-soft']) {
      expect(packageNames.has(name), name).toBe(true);
    }
    const declaredHere = [...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string);
    expect(declaredHere.filter((name) => packageNames.has(name))).toEqual([]);
    // CONTROL — the same scan does see a redeclaration.
    const planted = `${body}\n[data-mode='light'] {\n  --bg: #f2f3f6;\n}\n`;
    const plantedHere = [...planted.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string);
    expect(plantedHere.filter((name) => packageNames.has(name))).toEqual(['--bg']);
    // The retired palettes are gone, not just unused.
    for (const retired of ['#060608', '#9b3b46', '#f2f3f6', '#6d5efc', '#109a82', '#d4626e']) {
      expect(body, retired).not.toContain(retired);
    }
    expect(body).not.toMatch(/\[data-accent='(violet|teal)'\]/);
  });

  it('P4 — light-first posture: color-scheme follows the mode axis, the page ground is tk-bg, and the two web-only additions are set per mode — a faint accent glow and fenced code on the app’s dark-island colour in BOTH modes', () => {
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-tk-bg text-tk-ink;/);
    expect(body).toMatch(
      /\[data-mode='light'\] \{\s*\n\s*--glow: rgb\(var\(--accent-rgb\) \/ 0\.07\);\s*\n\s*--code-bg: var\(--island\);/,
    );
    expect(body).toMatch(
      /\[data-mode='dark'\] \{\s*\n\s*--glow: rgb\(var\(--accent-rgb\) \/ 0\.12\);\s*\n\s*--code-bg: var\(--island\);/,
    );
  });

  it('the docs tk namespace map is kept: every tk colour the markup uses resolves to a web alias, which the package points at the app’s tokens', () => {
    expect(body).toMatch(/@theme inline \{/);
    for (const [tk, alias] of [
      ['bg', 'bg'],
      ['surface', 'surface'],
      ['raised', 'raised'],
      ['hover', 'hover'],
      ['inset', 'inset'],
      ['ink', 'ink'],
      ['ink-2', 'ink-2'],
      ['ink-3', 'ink-3'],
      ['border', 'border'],
      ['accent', 'accent'],
      ['accent-strong', 'accent-strong'],
      ['accent-soft', 'accent-soft'],
      ['accent-text', 'accent-text'],
      ['ready-text', 'ready-text'],
      ['busy-text', 'busy-text'],
      ['err-text', 'err-text'],
    ]) {
      expect(body, tk).toContain(`--color-tk-${tk}: var(--${alias});`);
    }
  });

  it('S22.1 self-hosted fonts pinned: Geist VF + JetBrains Mono Regular/Bold @font-face at public/fonts/ (OFL, license files ship alongside); Berkeley Mono first in the mono stack but NEVER vendored (commercial). The stacks themselves now come from the package', () => {
    expect(body).toMatch(/url\('\/fonts\/geist\/GeistVF\.woff2'\) format\('woff2'\)/);
    expect(body).toMatch(
      /url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2'\) format\('woff2'\)/,
    );
    expect(body).toMatch(
      /url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Bold\.woff2'\) format\('woff2'\)/,
    );
    expect(body).toMatch(/font-display: swap;/);
    expect(body).toMatch(/NEVER vendored/);
    expect(body).toMatch(
      /font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
    expect(body).not.toMatch(/--font-sans:/);
  });

  it('F-1 code-overflow containment pinned: base.css keeps code/pre from pushing the page width (overflow-wrap:anywhere + pre overflow-x:auto) — the iPhone-Safari horizontal-scroll guard', () => {
    expect(body).toMatch(/code blocks scroll internally rather than pushing page/);
    expect(body).toMatch(/long unbreakable strings wrap or scroll internally/);
    expect(body).toMatch(/overflow-wrap: anywhere;/);
    expect(body).toMatch(/word-break: break-word;/);
  });

  it('F-1 iPhone-Safari horizontal-scroll prevention pinned: overflow-x:clip + max-width:100vw. Drift to overflow:hidden would break sticky positioning on docs pages', () => {
    expect(body).toMatch(/F-1 — prevent iPhone Safari horizontal scroll/);
    expect(body).toMatch(/overflow-x: clip;/);
    expect(body).toMatch(/max-width: 100vw;/);
  });

  it('P4 page wash: ONE faint radial reading var(--glow), sized to the first screen and scrolling with the page (a fixed or full-height wash tinted a whole long read); no baked red', () => {
    expect(body).toMatch(
      /background-image: radial-gradient\(ellipse 90% 60% at 50% -10%, var\(--glow\), transparent 70%\);\s*\n\s*background-size: 100% 56rem;\s*\n\s*background-repeat: no-repeat;/,
    );
    expect(body).not.toMatch(/background-attachment: fixed;/);
    expect(body).not.toMatch(/226, 56, 71/);
  });

  it('3 utility atoms pinned — the app’s recipes: btn-primary (flat accent, hover DARKENS to accent-fill-hover, pressed accent-strong, no shadow) + btn-secondary (raised face + hairline) + nav-link (hover = AA-safe tk-accent-text)', () => {
    expect(body).toMatch(/@utility btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent\s/);
    expect(body).toMatch(/hover:bg-tk-accent-fill-hover active:bg-tk-accent-strong/);
    const primary = body.slice(body.indexOf('@utility btn-primary {'));
    expect(primary.slice(0, primary.indexOf('}'))).not.toMatch(/box-shadow/);
    expect(body).toMatch(/@utility btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border bg-tk-raised/);
    expect(body).toMatch(/@utility nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent-text;/,
    );
    expect(body).not.toMatch(/shadow-glow-red/);
    expect(body).not.toMatch(/hover:-translate-y-0\.5/);
  });

  it('tk-driven prose hooks pinned: un-layered .prose --tw-prose-* overrides read the mode-scoped tokens (single class set, no prose-invert flip); links = --accent-text; fenced pre bg = var(--code-bg), a DARK island in BOTH modes', () => {
    expect(body).toMatch(/\.prose \{/);
    expect(body).toMatch(/--tw-prose-body: var\(--ink-2\);/);
    expect(body).toMatch(/--tw-prose-headings: var\(--ink\);/);
    expect(body).toMatch(/--tw-prose-links: var\(--accent-text\);/);
    expect(body).toMatch(/--tw-prose-pre-bg: var\(--code-bg\);/);
    expect(body).toMatch(/--tw-prose-th-borders: var\(--border\);/);
    expect(body).toMatch(/fenced code stays a DARK island in BOTH modes/);
  });

  it('P4 fenced code: Shiki’s inline theme background is repainted to the dark island (!important is the only way past an inline style), and every token colour github-dark-default emits that the comment cites clears AA on the island in both modes', () => {
    expect(body).toMatch(
      /\.prose pre\.astro-code \{\s*\n\s*background-color: var\(--tw-prose-pre-bg\) !important;/,
    );
    const comment = rgb('#8b949e');
    expect(contrast(comment, rgb(tokens.modes.light.island as string))).toBeCloseTo(5.8, 1);
    expect(contrast(comment, rgb(tokens.modes.dark.island as string))).toBeCloseTo(6.51, 1);
    expect(body).toMatch(/#8b949e\) is 5\.80:1 on #0f172a and 6\.51:1 on #050811/);
  });

  it('P4 inline code is a neutral chip scoped to code OUTSIDE a pre, so a fenced block’s own <code> never paints stripes across the island; a language-tab group sits flush (un-layered, because the plugin’s pre margin outranks a runtime utility)', () => {
    expect(body).toMatch(
      /\.prose :where\(:not\(pre\) > code\):not\(:where\(\[class~='not-prose'\] \*\)\) \{\s*\n\s*background: var\(--inset\);/,
    );
    expect(body).toMatch(/\.prose :where\(pre code\) \{\s*\n\s*background: transparent;/);
    expect(body).toMatch(
      /\[data-langtabs\] pre,\s*\n\[data-langtabs\] pre\.astro-code \{\s*\n\s*margin-top: 0;\s*\n\s*margin-bottom: 0;/,
    );
  });

  it('P4 tables are one card (raised surface, hairline, the app’s 12px radius) with separate borders so the radius holds, and the row rules moved onto the cells', () => {
    expect(body).toMatch(
      /\.prose table \{\s*\n\s*border-collapse: separate;\s*\n\s*border-spacing: 0;\s*\n\s*border: 1px solid var\(--border\);\s*\n\s*border-radius: 0\.75rem;\s*\n\s*background: var\(--surface\);/,
    );
    expect(body).toMatch(/\.prose tbody td \{\s*\n\s*border-top: 1px solid var\(--border\);/);
  });

  it('S22.2 (2026-07-06, Stoplight relayout) — blockquote = info callout: an accent-2 left rule on the elevated surface with a hairline and the 12px card radius, normal weight, the plugin’s auto quote marks removed — ZERO .md edits, every markdown `>` note renders as a callout', () => {
    expect(body).toMatch(/S22\.2 \(2026-07-06, Stoplight relayout\) — blockquote = info callout/);
    expect(body).toMatch(
      /\.prose blockquote \{\s*\n\s*background: var\(--raised\);\s*\n\s*border: 1px solid var\(--border\);\s*\n\s*border-left: 3px solid var\(--accent-2\);\s*\n\s*border-radius: 0\.75rem;/,
    );
    expect(body).toMatch(
      /\.prose blockquote p:first-of-type::before,\s*\n\s*\.prose blockquote p:last-of-type::after \{\s*\n\s*content: none;\s*\n\}/,
    );
    expect(body).toMatch(/--tw-prose-quote-borders: var\(--accent-2\);/);
  });

  // The method chips: GET/PUT/PATCH/DELETE read the app's status tokens through
  // the web aliases (--ready-text → status-ready, --busy-text → status-busy,
  // --err-text → status-error-text; the washes → the status fill), POST keeps a
  // blue of its own per mode. A chip sits on the page ground at rest and on the
  // raised surface when its row is hovered (DocLayout's endpoint rows).
  const chipAlpha = (): number => {
    const m = body.match(
      /\.method-chip--get \{\s*\n\s*color: var\(--ready-text\);\s*\n\s*background: rgb\(var\(--ready-rgb\) \/ ([0-9.]+)\);/,
    );
    return Number(m?.[1]);
  };
  const chips = (mode: 'light' | 'dark'): Array<[string, string, string]> => {
    const t = tokens.modes[mode] as Record<string, string>;
    return [
      ['GET', t['status-ready'] as string, t['status-ready'] as string],
      ['PUT/PATCH', t['status-busy'] as string, t['status-busy'] as string],
      ['DELETE', t['status-error-text'] as string, t['status-error'] as string],
      mode === 'light' ? ['POST', '#1d4ed8', '#2563eb'] : ['POST', '#93c5fd', '#60a5fa'],
    ];
  };

  it('S22.4 .method-chip recipes pinned: tiny mono uppercase badges, wash = rgb()/alpha of the mode’s status triplet (NOT color-mix — its Lightning-CSS fallback degrades to a solid same-colour background), text = the status token; POST keeps its own blue per mode', () => {
    expect(body).toMatch(
      /\.method-chip \{\s*\n\s*display: inline-block;\s*\n\s*flex-shrink: 0;\s*\n\s*min-width: 2\.75rem;/,
    );
    expect(body).toMatch(/font-size: 0\.625rem;/);
    expect(body).toMatch(/text-transform: uppercase;/);
    expect(chipAlpha()).toBe(0.12);
    expect(body).toMatch(
      /\.method-chip--post \{\s*\n\s*color: #93c5fd;\s*\n\s*background: rgb\(96 165 250 \/ 0\.12\);/,
    );
    expect(body).toMatch(
      /\.method-chip--put,\s*\n\s*\.method-chip--patch \{\s*\n\s*color: var\(--busy-text\);\s*\n\s*background: rgb\(var\(--busy-rgb\) \/ 0\.12\);/,
    );
    expect(body).toMatch(
      /\.method-chip--delete \{\s*\n\s*color: var\(--err-text\);\s*\n\s*background: rgb\(var\(--err-rgb\) \/ 0\.12\);/,
    );
    expect(body).toMatch(
      /\[data-mode='light'\] \.method-chip--post \{\s*\n\s*color: #1d4ed8;\s*\n\s*background: rgb\(37 99 235 \/ 0\.12\);/,
    );
    expect(body).not.toMatch(/color-mix\([^)]*--ready/);
  });

  it('P4 — every method chip clears AA (4.5:1) over its wash composited on BOTH grounds it sits on (page ground at rest, raised surface on hover), in both modes, measured from the package’s values', () => {
    // The hover ground measured here IS the one DocLayout's endpoint rows use.
    const layout = read(resolve(REPO_ROOT, 'apps/docs/src/layouts/DocLayout.astro'));
    const row = layout.match(/<a\s+href=\{child\.href\}\s+class="([^"]+)"/);
    expect(row?.[1]).toMatch(/\bhover:bg-tk-surface\b/);
    const alpha = chipAlpha();
    for (const mode of ['light', 'dark'] as const) {
      const t = tokens.modes[mode] as Record<string, string>;
      for (const ground of ['surface-base', 'surface-raised']) {
        for (const [name, text, fill] of chips(mode)) {
          const ratio = contrast(rgb(text), wash(rgb(fill), alpha, rgb(t[ground] as string)));
          expect(ratio, `${mode} ${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    // CONTROL — the measurement does fail a real near-miss: the old 15% wash on
    // the old hover ground (surface-inset) put the light DELETE chip at 4.14.
    const light = tokens.modes.light as Record<string, string>;
    const nearMiss = contrast(
      rgb(light['status-error-text'] as string),
      wash(rgb(light['status-error'] as string), 0.15, rgb(light['surface-inset'] as string)),
    );
    expect(nearMiss).toBeLessThan(4.5);
  });
});
