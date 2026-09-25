// W526.B — drift guard for apps/customer-dashboard/tailwind.config.mjs.
//
// 2026-09-25 — re-pinned for the shared design tokens. The config used to hold
// a hand-kept copy of marketing's tokens (a verbatim slate palette, dark-only
// surface/ink sets, glow reds and a tk table) under a "keep these synchronised"
// comment that nothing checked. It now takes every colour, radius, font stack,
// shadow and the easing from the packages/design-tokens preset — the desktop
// app's own theme — so the pins below hold:
//   • the preset import + the 8-extension content glob;
//   • that the retired hand-kept sets (slate, surface, ink, glow reds, the
//     local tk table and the legacy oxblood ladder) do not come back;
//   • fontFamily from the preset: sans=Geist + system fallback, mono=Berkeley
//     Mono → JetBrains Mono → system; maxWidth prose 65ch; plugins: [];
//   • the AA-safe status TEXT trio (ready-text / busy-text / err-text) in the
//     preset's tk table, each on its own text token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/tailwind.config.mjs');
const PRESET = resolve(REPO_ROOT, 'packages/design-tokens/dist/tailwind-preset.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W526.B apps/customer-dashboard/tailwind.config.mjs content parity', () => {
  const body = read(LIB);
  const preset = read(PRESET);

  it('shared design-tokens framing pinned: the preset import + presets: [preset] + @type JSDoc + 8-extension content glob — one token set with the desktop app and every web surface, not a copy that drifts', () => {
    expect(body).toMatch(/\/\*\* @type \{import\('tailwindcss'\)\.Config\} \*\//);
    expect(body).toMatch(
      /\/\/ Design tokens shared with every Driftstack surface, from one package:/,
    );
    expect(body).toMatch(/import preset from '@driftstack\/design-tokens\/tailwind-preset';/);
    expect(body).toMatch(/presets: \[preset\],/);
    expect(body).toMatch(/content: \['\.\/src\/\*\*\/\*\.\{astro,html,js,jsx,md,mdx,ts,tsx\}'\],/);
  });

  it('the retired hand-kept sets stay retired: no local colour table, no slate palette, no dark-only surface/ink sets, no glow reds, no oxblood ladder (S24 2026-07-06 retired the ladder; 2026-09-25 retired the rest onto the preset)', () => {
    expect(body).not.toMatch(/colors:\s*\{/);
    expect(body).not.toMatch(/slate: \{/);
    expect(body).not.toMatch(/oxblood: \{/);
    expect(body).not.toMatch(/'#2b0f15'/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(body).not.toMatch(/glow-red|gradient-accent/);
  });

  it('fontFamily + maxWidth + plugins-empty framing pinned: the preset carries sans=Geist + system fallback and mono=Berkeley Mono → JetBrains Mono → system; the dashboard keeps maxWidth prose 65ch and plugins: [] (no @tailwindcss/typography — the dashboard has no prose pages, only forms/tables)', () => {
    expect(preset).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\],/);
    expect(preset).toMatch(
      /mono: \['Berkeley Mono', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\],/,
    );
    expect(body).toMatch(/maxWidth: \{\s*prose: '65ch',\s*\},/);
    expect(body).toMatch(/plugins: \[\],/);
  });

  it("AA-safe status-toned TEXT trio pinned in the preset's tk table: 'ready-text'/'busy-text'/'err-text' each read their own text token (the raw ready/busy/err fills are not text tones). Drift to dropping these would silently revert status-coloured text", () => {
    expect(preset).toMatch(/'ready-text': 'rgb\(var\(--status-ready-rgb\) \/ <alpha-value>\)',/);
    expect(preset).toMatch(/'busy-text': 'rgb\(var\(--status-busy-rgb\) \/ <alpha-value>\)',/);
    expect(preset).toMatch(/'err-text': 'rgb\(var\(--status-error-text-rgb\) \/ <alpha-value>\)',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
