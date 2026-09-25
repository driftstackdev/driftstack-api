// W525.B (Fleet v2 2026-07-03) — drift guard for
// apps/marketing-site/tailwind.config.mjs. Two-axis tk token namespace +
// typography stacks + @tailwindcss/typography plugin. Drift here either
// changes the brand accent plumbing (would create cross-page brand
// divergence on every CTA/nav/selection) or breaks the typography
// plugin wiring (would break prose styling on legal/docs pages).
//
// 2026-07-03 SUPERSESSION — the legacy baked palettes are RETIRED: the
// oxblood 50→950 ladder ("locked accent per founder direction, #722F37"),
// the custom slate ladder (byte-identical to Tailwind 3's built-in), the
// graphite surface/ink sets, glow reds, and gradient-accent. Zero markup
// used them (verified repo-wide) and the locked #722F37 accent lives on
// as --accent-strong in the [data-accent='oxblood'] axis (styles/base.css)
// per the 2026-06-15 "Fleet Mission Control — Dark + Red" verdict.
// Negative pins below keep them from silently returning.
//
// 2026-09-25 — the colours, radii, fonts and ambient shadows moved to the
// shared preset (@driftstack/design-tokens/tailwind-preset, the desktop app's
// theme); this file keeps only what is the site's own.
//
//   • presets: [the design-tokens preset] — tk-* colours (+ accent-text),
//     fontFamily (Geist / Berkeley Mono + JetBrains Mono), the app's radius
//     scale (rounded-card 12px), ambient/ambient-lg shadows.
//   • maxWidth: prose 65ch.
//   • boxShadow: glow-accent (hot elements); the radial washes; fade-up.
//   • typography theme `tk` — the site's one prose recipe (prose-tk).
//   • @tailwindcss/typography plugin.
//   • content glob: ./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/tailwind.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W525.B apps/marketing-site/tailwind.config.mjs content parity', () => {
  const body = read(LIB);

  it("Content glob + JSDoc-type + typography-plugin framing pinned: '@type {import(\"tailwindcss\").Config}' JSDoc + 'content: [\"./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}\"]' + 'import typography from \"@tailwindcss/typography\"' + 'plugins: [typography]' — pinned so the JSDoc-typecheck + 8-extension-content-glob + typography-plugin commitment survives", () => {
    expect(body).toMatch(/\/\*\* @type \{import\('tailwindcss'\)\.Config\} \*\//);
    expect(body).toMatch(/content: \['\.\/src\/\*\*\/\*\.\{astro,html,js,jsx,md,mdx,ts,tsx\}'\],/);
    expect(body).toMatch(/import typography from '@tailwindcss\/typography';/);
    expect(body).toMatch(/plugins: \[typography\],/);
  });

  it("Legacy palette retirement pinned (2026-07-03 supersession; 2026-09-25 the config declares no colours at all): the oxblood ladder, custom slate ladder, graphite surface/ink sets, glow reds, gradient-accent, and glow-radial-red variants are GONE and must stay gone — every colour now comes from the @driftstack/design-tokens preset (the desktop app's palette, one accent #a83b4d)", () => {
    expect(body).not.toMatch(/colors: \{/);
    // negative pins — none of the retired blocks may silently return
    expect(body).not.toMatch(/oxblood: \{/);
    expect(body).not.toMatch(/slate: \{/);
    expect(body).not.toMatch(/surface: \{/);
    expect(body).not.toMatch(/ink: \{/);
    expect(body).not.toMatch(/glow: \{/);
    expect(body).not.toMatch(/'gradient-accent'/);
    expect(body).not.toMatch(/'glow-radial-red'/);
    expect(body).not.toMatch(/'glow-red'/);
    expect(body).not.toMatch(/#722F37|#9b3b46/i);
  });

  it("the shared token preset is the first layer (2026-09-25): fonts (Geist + the shipped mono stack), radii (the app's 4 / 6 / 12 / 16 / full; rounded-card 12px, was 14px), the tk-* colours and the ambient shadows come from @driftstack/design-tokens/tailwind-preset; this file keeps maxWidth.prose 65ch and the site's own atmosphere", () => {
    expect(body).toMatch(/import tokens from '@driftstack\/design-tokens\/tailwind-preset';/);
    expect(body).toMatch(/presets: \[tokens\],/);
    expect(body).toMatch(/maxWidth: \{\s*prose: '65ch',\s*\},/);
    expect(body).not.toMatch(/fontFamily: \{/);
    expect(body).not.toMatch(/borderRadius: \{/);
    expect(body).not.toMatch(/card: '14px'/);
    const preset = readFileSync(
      resolve(REPO_ROOT, 'packages/design-tokens/dist/tailwind-preset.mjs'),
      'utf8',
    );
    expect(preset).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\],/);
    expect(preset).toMatch(
      /mono: \['Berkeley Mono', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\],/,
    );
    expect(preset).toMatch(/card: '0\.75rem',/);
    expect(preset).toMatch(/'accent-text': 'rgb\(var\(--accent-text-rgb\) \/ <alpha-value>\)',/);
    expect(preset).toMatch(/ambient: 'var\(--shadow-lift\)',/);
  });

  it("the site's own theme extensions survive the preset: the 'glow-accent' shadow for hot elements, the accent radial washes, the fade-up animation, and the ONE prose recipe (`prose-tk`, 2026-09-25) whose colours read the tokens so long-form pages follow data-mode without prose-invert", () => {
    expect(body).toMatch(/'glow-accent': '0 0 0 1px var\(--accent\), 0 0 26px var\(--glow\)',/);
    expect(body).toMatch(/'glow-radial-accent':/);
    expect(body).toMatch(/'fade-up': 'fade-up 0\.6s ease-out',/);
    expect(body).toMatch(/typography: \{\s*\n\s*tk: \{/);
    expect(body).toMatch(/'--tw-prose-links': 'rgb\(var\(--accent-text-rgb\)\)',/);
    expect(body).toMatch(/'--tw-prose-pre-bg': 'var\(--code-bg\)',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
