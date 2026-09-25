// Drift guard for apps/customer-dashboard/src/styles/base.css.
// Pins the light-default posture on the shared design tokens + the F-1
// iPhone-Safari horizontal-scroll prevention.
//
// 2026-09-25 — the "light+violet default" header and the "Keep synchronised"
// pledge were pins on a hand-kept copy of marketing's colour blocks; that copy
// is gone. The dashboard now imports packages/design-tokens (the desktop app's
// own theme), so the pledge is structural: the arms below pin the import and
// that this file declares no token value of its own.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/styles/base.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard styles/base content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Tailwind 3-directive header pinned: @tailwind base + components + utilities. Drift to dropping any would break the entire Tailwind stylesheet generation', () => {
    expect(body).toMatch(/@tailwind base;/);
    expect(body).toMatch(/@tailwind components;/);
    expect(body).toMatch(/@tailwind utilities;/);
  });

  it('light-default posture pinned on the shared tokens: the header says light is the default and nothing follows the system theme; color-scheme comes with each mode block of the imported tokens', () => {
    expect(body).toMatch(/Customer dashboard surface \(light default, 2026-09-25\)/);
    expect(body).toMatch(/nothing follows the system\s+theme/);
    const tokens = read(resolve(REPO_ROOT, 'packages/design-tokens/dist/tokens.css'));
    expect(tokens).toMatch(/\[data-mode='light'\] \{\s*color-scheme: light;/);
    expect(tokens).toMatch(/\[data-mode='dark'\] \{\s*color-scheme: dark;/);
  });

  it('one token set with every surface: base.css imports the shared tokens and aliases first, and declares no token value of its own (a redeclaration is drift)', () => {
    expect(body.indexOf("@import '@driftstack/design-tokens/tokens.css';")).toBe(
      body.indexOf('@import'),
    );
    expect(body).toMatch(/@import '@driftstack\/design-tokens\/web-aliases\.css';/);
    expect(body.indexOf('@import')).toBeLessThan(body.indexOf('@tailwind base;'));
    const declared = [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    // The atmosphere glow is the one web-only value, derived from the accent;
    // --tk-state-rgb is the state-light pip's own per-state variable, which
    // only points at a token (var(--busy-rgb) and kin).
    expect([...new Set(declared)].sort()).toEqual(['--glow', '--tk-state-rgb']);
    expect(body).not.toMatch(/--tk-state-rgb:\s*(?:#|\d)/);
    expect(body).toMatch(/--glow: rgb\(var\(--accent-rgb\) \/ 0\.\d+\);/);
  });

  it('F-1 iPhone-Safari horizontal-scroll prevention pinned: overflow-x:clip on html + body + max-width:100vw on body. Drift to overflow:hidden would break sticky positioning across dashboard pages — a real visual bug previously seen on iPhone Safari', () => {
    expect(body).toMatch(/F-1 — prevent iPhone Safari horizontal scroll/);
    expect(body).toMatch(/overflow-x: clip;/);
    expect(body).toMatch(/max-width: 100vw;/);
  });

  it('Font stack pinned: Geist (display, self-hosted variable woff2) + Berkeley Mono → JetBrains Mono (code; Berkeley Mono stays FIRST for locally-licensed users, the vendored OFL JetBrains Mono is what ships). Drift to a different font would break cross-app typographic consistency', () => {
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(
      /font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
    // Self-hosted font faces (Fleet v2 2026-07-02): Geist VF + JetBrains
    // Mono Regular/Bold from public/fonts/, all font-display: swap.
    expect(body).toMatch(/src: url\('\/fonts\/geist\/GeistVF\.woff2'\) format\('woff2'\);/);
    expect(body).toMatch(
      /src: url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2'\) format\('woff2'\);/,
    );
    expect(body).toMatch(/font-display: swap;/);
  });

  it('Geist font-feature-settings cv11 + ss01 pinned: the OpenType features that give Geist its tabular-numeric + alternate-glyph polish. Drift to dropping would weaken the typography', () => {
    expect(body).toMatch(/font-feature-settings: 'cv11', 'ss01';/);
  });

  it('::selection bg-tk-accent pinned: brand-accent color for text selection, with the on-accent ink token (2026-09-25: was the raw text-white literal; on-accent is white, 6.18:1 on the accent). Drift to a different selection color would break cross-app brand recognition on selection', () => {
    expect(body).toMatch(/::selection \{\s*@apply bg-tk-accent text-tk-accent-ink;\s*\}/);
  });
});
