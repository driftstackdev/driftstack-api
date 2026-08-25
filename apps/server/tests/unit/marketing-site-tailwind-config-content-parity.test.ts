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
//   • tk token namespace → two-axis CSS custom properties (+ accent-text).
//   • fontFamily: sans=Geist + system fallback, mono=Berkeley Mono +
//     JetBrains Mono (vendored) + system fallback.
//   • maxWidth: prose 65ch; borderRadius.card 14px.
//   • boxShadow: glow-accent (hot elements) + ambient/ambient-lg (v2 kit).
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

  it("Legacy palette retirement pinned (2026-07-03 supersession): the oxblood ladder, custom slate ladder, graphite surface/ink sets, glow reds, gradient-accent, and glow-radial-red variants are GONE and must stay gone — the locked #722F37 accent lives on as --accent-strong in the [data-accent='oxblood'] axis (styles/base.css), and stock Tailwind slate-* utilities in legacy markup render unchanged (the removed custom ladder was byte-identical to the built-in)", () => {
    // supersession note must stay in the config so the retirement is
    // self-documenting at the source
    expect(body).toMatch(/legacy baked palettes RETIRED \(Fleet v2 port\)/);
    expect(body).toMatch(/#722F37 accent lives on as --accent-strong/);
    // negative pins — none of the retired blocks may silently return
    expect(body).not.toMatch(/oxblood: \{/);
    expect(body).not.toMatch(/slate: \{/);
    expect(body).not.toMatch(/surface: \{/);
    expect(body).not.toMatch(/ink: \{/);
    expect(body).not.toMatch(/glow: \{/);
    expect(body).not.toMatch(/'gradient-accent'/);
    expect(body).not.toMatch(/'glow-radial-red'/);
    expect(body).not.toMatch(/'glow-red'/);
  });

  it('fontFamily + maxWidth framing pinned: \'sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"]\' + \'mono: ["Berkeley Mono", "JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"]\' (Fleet v2 2026-07-03: vendored JetBrains Mono ships; Berkeley Mono stays first-family for licensed local installs, never vendored) + \'maxWidth: { prose: "65ch" }\' — pinned so the Geist+system-fallback sans-stack + the shipped-mono-stack + 65ch-prose-max-width commitment survives', () => {
    expect(body).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\],/);
    expect(body).toMatch(
      /mono: \['Berkeley Mono', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\],/,
    );
    expect(body).toMatch(/maxWidth: \{\s*prose: '65ch',\s*\},/);
  });

  it("Fleet tk token namespace + shadows pinned (v2 2026-07-03): tk.* resolves to the two-axis CSS custom properties (styles/base.css) so tk-* classes flip with <html data-mode>/<html data-accent>; tk-accent-text = the AA-safe accent TEXT tone; 'glow-accent' shadow survives for hot elements while ambient/ambient-lg are the v2 kit's calm card shadows; borderRadius.card = 14px (spec §3)", () => {
    // rgb-triplet + <alpha-value> form so Tailwind alpha modifiers
    // (bg-tk-accent\/10, ring-tk-accent\/30) work on token colors.
    expect(body).toMatch(/tk: \{\s*\n\s*bg: 'rgb\(var\(--bg-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/accent: 'rgb\(var\(--accent-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/'accent-strong': 'rgb\(var\(--accent-strong-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/'accent-text': 'var\(--accent-text\)',/);
    // S24 2026-07-06 — AA-safe status-toned TEXT trio (raw ready/busy/err
    // are FILL tones, 2.7–4.3:1 as small light-mode text; base.css carries
    // the per-mode values + computed ratios).
    expect(body).toMatch(/'ready-text': 'var\(--ready-text\)',/);
    expect(body).toMatch(/'busy-text': 'var\(--busy-text\)',/);
    expect(body).toMatch(/'err-text': 'var\(--err-text\)',/);
    expect(body).toMatch(/'glow-accent': '0 0 0 1px var\(--accent\), 0 0 26px var\(--glow\)',/);
    // S20 2026-07-06 — ambient shadows became mode-aware vars: the original
    // gray shadows composite to a measured 1.0000:1 on the near-black dark
    // bg (zero elevation cue); the per-mode values live in base.css.
    expect(body).toMatch(/ambient: 'var\(--shadow-ambient\)',/);
    expect(body).toMatch(/'ambient-lg': 'var\(--shadow-ambient-lg\)',/);
    expect(body).toMatch(/card: '14px',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
