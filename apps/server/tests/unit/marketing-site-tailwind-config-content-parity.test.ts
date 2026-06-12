// W525.B — drift guard for apps/marketing-site/tailwind.config.mjs.
// Oxblood (#722F37) brand-color palette + Geist/Berkeley-Mono font
// stacks + slate palette + @tailwindcss/typography plugin. Drift here
// either changes the brand-color (would create cross-page brand-color
// divergence on every CTA/nav/selection) or breaks the typography
// plugin wiring (would break prose styling on legal/docs pages).
//
//   • Locked oxblood 50→950 palette anchored at #722F37 (700 base —
//     "primary accent, locked" per founder direction).
//   • Slate 50→950 base palette for body text + surfaces.
//   • fontFamily: sans=Geist + system fallback, mono=Berkeley Mono +
//     ui-monospace fallback.
//   • maxWidth: prose 65ch.
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

  it("Oxblood palette + locked-#722F37 framing pinned: 'Oxblood — locked accent per founder direction (#722F37).' + 11-step (50→950) palette: 50=#fbf3f4 / 100=#f5e1e3 / 200=#ebbfc4 / 300=#dc939c / 400=#c8606e / 500=#a83b4d / 600=#8d2c3e / 700=#722F37 (base — primary accent, locked) / 800=#5e2730 / 900=#4f242b / 950=#2b0f15 — pinned so the locked #722F37 brand-color + full 11-step shade ladder commitment survives (drift to a different oxblood-700 hex would propagate to every CTA/nav/selection on the marketing site)", () => {
    expect(body).toMatch(/\/\/ Oxblood — locked accent per founder direction \(#722F37\)\./);
    expect(body).toMatch(/oxblood: \{/);
    expect(body).toMatch(/50: '#fbf3f4',/);
    expect(body).toMatch(/100: '#f5e1e3',/);
    expect(body).toMatch(/200: '#ebbfc4',/);
    expect(body).toMatch(/300: '#dc939c',/);
    expect(body).toMatch(/400: '#c8606e',/);
    expect(body).toMatch(/500: '#a83b4d',/);
    expect(body).toMatch(/600: '#8d2c3e',/);
    expect(body).toMatch(/700: '#722F37', \/\/ base — primary accent, locked/);
    expect(body).toMatch(/800: '#5e2730',/);
    expect(body).toMatch(/900: '#4f242b',/);
    expect(body).toMatch(/950: '#2b0f15',/);
  });

  it("Slate palette framing pinned: 'Slate base — body text + surfaces.' + 11-step (50→950) palette: 50=#f8fafc / 100=#f1f5f9 / 200=#e2e8f0 / 300=#cbd5e1 / 400=#94a3b8 / 500=#64748b / 600=#475569 / 700=#334155 / 800=#1e293b / 900=#0f172a / 950=#020617 — pinned so the slate-body-text + surfaces commitment + full 11-step shade ladder survives", () => {
    expect(body).toMatch(/\/\/ Slate base — body text \+ surfaces\./);
    expect(body).toMatch(/slate: \{/);
    expect(body).toMatch(/50: '#f8fafc',/);
    expect(body).toMatch(/100: '#f1f5f9',/);
    expect(body).toMatch(/200: '#e2e8f0',/);
    expect(body).toMatch(/300: '#cbd5e1',/);
    expect(body).toMatch(/400: '#94a3b8',/);
    expect(body).toMatch(/500: '#64748b',/);
    expect(body).toMatch(/600: '#475569',/);
    expect(body).toMatch(/700: '#334155',/);
    expect(body).toMatch(/800: '#1e293b',/);
    expect(body).toMatch(/900: '#0f172a',/);
    expect(body).toMatch(/950: '#020617',/);
  });

  it('fontFamily + maxWidth framing pinned: \'sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"]\' + \'mono: ["Berkeley Mono", "ui-monospace", "SFMono-Regular", "monospace"]\' + \'maxWidth: { prose: "65ch" }\' — pinned so the Geist+system-fallback sans-stack + Berkeley-Mono+ui-monospace-fallback mono-stack + 65ch-prose-max-width commitment survives', () => {
    expect(body).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\],/);
    expect(body).toMatch(
      /mono: \['Berkeley Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\],/,
    );
    expect(body).toMatch(/maxWidth: \{\s*\n?\s*prose: '65ch',\s*\n?\s*\},/);
  });

  it("Fleet tk token namespace + glow-accent shadow pinned (2026-06-12 rework): tk.* resolves to the two-axis CSS custom properties (styles/base.css) so tk-* classes flip with <html data-mode>/<html data-accent>; 'glow-accent' shadow follows the accent axis — ADDITIVE next to the legacy palettes until each page ports", () => {
    // rgb-triplet + <alpha-value> form so Tailwind alpha modifiers
    // (bg-tk-accent\/10, ring-tk-accent\/30) work on token colors.
    expect(body).toMatch(/tk: \{\s*\n\s*bg: 'rgb\(var\(--bg-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/accent: 'rgb\(var\(--accent-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/'accent-strong': 'rgb\(var\(--accent-strong-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/'glow-accent': '0 0 0 1px var\(--accent\), 0 0 26px var\(--glow\)',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
