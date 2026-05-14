// W794 — apps/status-site tailwind.config.mjs + src/styles/global.css
// content parity. One-hundred-twentieth in the cross-SDK drift-guard
// series. Pins 2 previously-unguarded status-site theme files.
//
// R13 — the status-site dark surface MUST stay synced with marketing-
// site/customer-dashboard/docs. Customers checking status during an
// incident shouldn't experience a brand-jarring light theme when the
// rest of the product is dark.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TW_CONFIG = resolve(REPO_ROOT, 'apps/status-site/tailwind.config.mjs');
const GLOBAL_CSS = resolve(REPO_ROOT, 'apps/status-site/src/styles/global.css');

describe('W794 status-site theme content parity', () => {
  it('both theme files exist at canonical paths', () => {
    expect(existsSync(TW_CONFIG)).toBe(true);
    expect(existsSync(GLOBAL_CSS)).toBe(true);
  });

  // ─── tailwind.config.mjs ──────────────────────────────────────

  it("CRITICAL R13 + 'synced-with' framing pinned. The 'R13 — status-site graphite palette synced with marketing-site + customer-dashboard + docs. Customers landing on status.driftstack.dev during an incident shouldn\\'t experience a brand-jarring light theme when the rest of the product is dark' wording is the load-bearing brand-consistency rationale.", () => {
    const p = read(TW_CONFIG);

    expect(p).toMatch(
      /\/\/ R13 — status-site graphite palette synced with marketing-site \+\s*\n\/\/ customer-dashboard \+ docs\./,
    );
    expect(p).toMatch(
      /Customers landing on status\.driftstack\.dev\s*\n\/\/ during an incident shouldn't experience a brand-jarring light theme\s*\n\/\/ when the rest of the product is dark\./,
    );
  });

  it("CRITICAL darkMode: 'class' framing pinned. Drift to 'media' (system-pref-driven) would let the status-site flicker light/dark based on OS settings.", () => {
    const p = read(TW_CONFIG);
    expect(p).toMatch(/darkMode: 'class'/);
  });

  it('CRITICAL content glob pinned — ./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}. Drift to dropping any extension would lose Tailwind class-detection.', () => {
    const p = read(TW_CONFIG);
    expect(p).toMatch(/content: \['\.\/src\/\*\*\/\*\.\{astro,html,js,jsx,md,mdx,ts,tsx\}'\]/);
  });

  it('CRITICAL oxblood 11-shade palette pinned — locked at #722F37 base / 700. Matches marketing-site oxblood-700 brand-anchor color.', () => {
    const p = read(TW_CONFIG);

    const shades: Array<[string, string]> = [
      ['50', '#fbf3f4'],
      ['100', '#f5e1e3'],
      ['200', '#ebbfc4'],
      ['300', '#dc939c'],
      ['400', '#c8606e'],
      ['500', '#a83b4d'],
      ['600', '#8d2c3e'],
      ['700', '#722F37'],
      ['800', '#5e2730'],
      ['900', '#4f242b'],
      ['950', '#2b0f15'],
    ];
    for (const [shade, hex] of shades) {
      expect(p, `oxblood-${shade}`).toMatch(new RegExp(`${shade}: '${hex}'`));
    }
  });

  it('CRITICAL Oxblood-matches-marketing-site-admin-panel framing pinned. The "Oxblood accent — matches marketing-site + admin-panel" wording is the load-bearing brand-color-source-of-truth anchor.', () => {
    const p = read(TW_CONFIG);
    expect(p).toMatch(/\/\/ Oxblood accent — matches marketing-site \+ admin-panel\./);
  });

  it('CRITICAL slate 11-shade palette pinned. Slate is the neutral-color base for dark surfaces — drift to a different scale would mismatch the cross-app palette.', () => {
    const p = read(TW_CONFIG);

    const slateShades: Array<[string, string]> = [
      ['50', '#f8fafc'],
      ['100', '#f1f5f9'],
      ['200', '#e2e8f0'],
      ['300', '#cbd5e1'],
      ['400', '#94a3b8'],
      ['500', '#64748b'],
      ['600', '#475569'],
      ['700', '#334155'],
      ['800', '#1e293b'],
      ['900', '#0f172a'],
      ['950', '#020617'],
    ];
    for (const [shade, hex] of slateShades) {
      expect(p, `slate-${shade}`).toMatch(new RegExp(`${shade}: '${hex}'`));
    }
  });

  it('CRITICAL surface 5-token palette pinned — base/raised/elevated/inset/divider. Matches the dark-mode surface vocabulary across customer-dashboard + admin-panel.', () => {
    const p = read(TW_CONFIG);

    expect(p).toMatch(/base: '#0f172a'/);
    expect(p).toMatch(/raised: '#1e293b'/);
    expect(p).toMatch(/elevated: '#334155'/);
    expect(p).toMatch(/inset: '#020617'/);
    expect(p).toMatch(/divider: '#475569'/);
  });

  it('CRITICAL ink 4-token palette pinned — primary/secondary/muted/inverted. Drift to a different vocabulary would mismatch cross-app text-color tokens.', () => {
    const p = read(TW_CONFIG);

    expect(p).toMatch(/primary: '#f8fafc'/);
    expect(p).toMatch(/secondary: '#cbd5e1'/);
    expect(p).toMatch(/muted: '#94a3b8'/);
    expect(p).toMatch(/inverted: '#0f172a'/);
  });

  it('CRITICAL glow-red 3-token palette pinned — red/red-soft/red-deep. The cross-app glow-red is the brand accent for incident severity badges (matches W790 status-site index 3-severity SEVERITY_BADGE outage red).', () => {
    const p = read(TW_CONFIG);

    expect(p).toMatch(/red: '#e23847'/);
    expect(p).toMatch(/'red-soft': '#f25366'/);
    expect(p).toMatch(/'red-deep': '#a8202d'/);
  });

  it('CRITICAL Geist + Berkeley Mono font-family pair pinned. Matches the cross-app font-family contract (docs + customer-dashboard + admin-panel all use Geist sans + Berkeley Mono).', () => {
    const p = read(TW_CONFIG);

    expect(p).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\]/);
    expect(p).toMatch(/mono: \['Berkeley Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\]/);
  });

  it('CRITICAL maxWidth.prose: 65ch pinned. The 65-char measure is the readable-line-length anchor; matches docs/tailwind W786 reference contract.', () => {
    const p = read(TW_CONFIG);
    expect(p).toMatch(/prose: '65ch'/);
  });

  // ─── src/styles/global.css ────────────────────────────────────

  it('CRITICAL 3 @tailwind directives pinned — base + components + utilities. Drift to dropping any would skip a Tailwind preflight layer.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/@tailwind base;\n@tailwind components;\n@tailwind utilities;/);
  });

  it("CRITICAL R13 dark-surface-synced-with-others framing pinned. The 'R13 — status-site dark surface synced with marketing-site + customer-dashboard + docs. Customers checking status during an incident shouldn\\'t experience a brand-jarring light theme when the rest of the product is dark' wording matches the tailwind.config R13 anchor.", () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(
      /\/\* R13 — status-site dark surface synced with marketing-site \+\s*\n\s+customer-dashboard \+ docs\./,
    );
    expect(p).toMatch(
      /Customers checking status during an\s*\n\s+incident shouldn't experience a brand-jarring light theme when\s*\n\s+the rest of the product is dark\./,
    );
  });

  it('CRITICAL :root color-scheme:dark pinned. Drift to color-scheme:light would let macOS/iOS form-control widgets render in light mode.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/:root \{\s*\n\s+color-scheme: dark;\s*\n\s+\}/);
  });

  it('CRITICAL html font-family + base @apply pinned. Geist + ui-sans-serif fallback chain + bg-surface-base + text-ink-primary @apply matches cross-app base-style contract.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(
      /html \{\s*\n\s+font-family: Geist, ui-sans-serif, system-ui, sans-serif;\s*\n\s+@apply bg-surface-base text-ink-primary;\s*\n\s+\}/,
    );
  });

  it("CRITICAL body min-h-screen + antialiased pinned. The 'min-h-screen' class ensures the status-page background extends to viewport edge; 'antialiased' enables font smoothing for sharper text.", () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(
      /body \{\s*\n\s+@apply min-h-screen bg-surface-base text-ink-primary antialiased;\s*\n\s+\}/,
    );
  });

  it('CRITICAL @layer base wrapping pinned. The 3 base styles are inside @layer base so Tailwind orders them BEFORE component + utility classes.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/@layer base \{/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/status-site-theme-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
