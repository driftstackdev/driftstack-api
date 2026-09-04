// W794 — apps/status-site src/styles/global.css content parity.
// One-hundred-twentieth in the cross-SDK drift-guard series. Pins the
// status-site theme.
//
// W368 — migrated to Tailwind v4: the theme now lives in the `@theme` block
// of global.css (the v3 tailwind.config.mjs was deleted; v4 is CSS-first +
// auto-detects content, so darkMode/content-glob config concepts are gone and
// the palette/font/prose tokens are `--color-*`/`--font-*`/`--container-*` vars).
// The brand VALUES are unchanged — this guard now pins them in their v4 home.
//
// Fleet — the status-site surface MUST stay synced with marketing-
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

const GLOBAL_CSS = resolve(REPO_ROOT, 'apps/status-site/src/styles/global.css');

describe('W794 status-site theme content parity', () => {
  it('theme file exists at canonical path', () => {
    expect(existsSync(GLOBAL_CSS)).toBe(true);
  });

  // ─── Tailwind v4 engine framing ───────────────────────────────

  it("CRITICAL `@import 'tailwindcss'` pinned (Tailwind v4 — replaces the v3 3-directive header). Drift to dropping it skips the whole engine.", () => {
    const p = read(GLOBAL_CSS);
    expect(p).toMatch(/@import 'tailwindcss';/);
  });

  it('CRITICAL darkMode-by-class pinned as the v4 `@custom-variant dark (&:is(.dark *))`. Drift to a media-query variant would let the status-site flicker light/dark on OS settings.', () => {
    const p = read(GLOBAL_CSS);
    expect(p).toMatch(/@custom-variant dark \(&:is\(\.dark \*\)\);/);
  });

  // ─── @theme palette tokens ────────────────────────────────────

  it('CRITICAL oxblood 11-shade palette pinned — locked at #722f37 base / 700. Matches marketing-site oxblood-700 brand-anchor color.', () => {
    const p = read(GLOBAL_CSS);

    const shades: Array<[string, string]> = [
      ['50', '#fbf3f4'],
      ['100', '#f5e1e3'],
      ['200', '#ebbfc4'],
      ['300', '#dc939c'],
      ['400', '#c8606e'],
      ['500', '#a83b4d'],
      ['600', '#8d2c3e'],
      ['700', '#722f37'],
      ['800', '#5e2730'],
      ['900', '#4f242b'],
      ['950', '#2b0f15'],
    ];
    for (const [shade, hex] of shades) {
      expect(p, `oxblood-${shade}`).toMatch(new RegExp(`--color-oxblood-${shade}: ${hex};`));
    }
  });

  it('CRITICAL slate 11-shade palette pinned. Slate is the neutral-color base for dark surfaces — drift to a different scale would mismatch the cross-app palette.', () => {
    const p = read(GLOBAL_CSS);

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
      expect(p, `slate-${shade}`).toMatch(new RegExp(`--color-slate-${shade}: ${hex};`));
    }
  });

  it('CRITICAL surface 5-token palette pinned — base/raised/elevated/inset/divider. Matches the dark-mode surface vocabulary across customer-dashboard + admin-panel.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/--color-surface-base: #0f172a;/);
    expect(p).toMatch(/--color-surface-raised: #1e293b;/);
    expect(p).toMatch(/--color-surface-elevated: #334155;/);
    expect(p).toMatch(/--color-surface-inset: #020617;/);
    expect(p).toMatch(/--color-surface-divider: #475569;/);
  });

  it('CRITICAL ink 4-token palette pinned — primary/secondary/muted/inverted. Drift to a different vocabulary would mismatch cross-app text-color tokens.', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/--color-ink-primary: #f8fafc;/);
    expect(p).toMatch(/--color-ink-secondary: #cbd5e1;/);
    expect(p).toMatch(/--color-ink-muted: #94a3b8;/);
    expect(p).toMatch(/--color-ink-inverted: #0f172a;/);
  });

  it('CRITICAL glow-red 3-token palette pinned — red/red-soft/red-deep. The cross-app glow-red is the brand accent for incident severity badges (matches W790 status-site index 3-severity SEVERITY_BADGE outage red).', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/--color-glow-red: #e23847;/);
    expect(p).toMatch(/--color-glow-red-soft: #f25366;/);
    expect(p).toMatch(/--color-glow-red-deep: #a8202d;/);
  });

  it('CRITICAL Geist + Berkeley Mono font-family pair pinned. Matches the cross-app font-family contract (docs + customer-dashboard + admin-panel all use Geist sans + Berkeley Mono).', () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(/--font-sans: Geist, ui-sans-serif, system-ui, sans-serif;/);
    expect(p).toMatch(/--font-mono: Berkeley Mono, ui-monospace, SFMono-Regular, monospace;/);
  });

  it('CRITICAL prose container width 65ch pinned (v4 `--container-prose`, was maxWidth.prose). The 65-char measure is the readable-line-length anchor; matches docs W786 reference contract.', () => {
    const p = read(GLOBAL_CSS);
    expect(p).toMatch(/--container-prose: 65ch;/);
  });

  // ─── src/styles/global.css base layer (unchanged by the v4 migration) ─

  it("CRITICAL R13 dark-surface-synced-with-others framing pinned. The 'R13 — status-site dark surface synced with marketing-site + customer-dashboard + docs. Customers checking status during an incident shouldn\\'t experience a brand-jarring light theme when the rest of the product is dark' wording is the load-bearing brand-consistency rationale.", () => {
    const p = read(GLOBAL_CSS);

    expect(p).toMatch(
      /\/\* Fleet rework \(2026-06-12\) — status-site synced with marketing-site \+\s*\n\s+customer-dashboard: light\+violet default/,
    );
    expect(p).toMatch(
      /Customers\s*\n\s+checking status during an incident see the same brand surface as\s*\n\s+driftstack\.io\./,
    );
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

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/status-site-theme-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
