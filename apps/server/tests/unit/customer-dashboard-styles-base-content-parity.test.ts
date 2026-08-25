// Drift guard for apps/customer-dashboard/src/styles/base.css.
// Pins the dark-mode-first posture + the tokens-shared-with-
// marketing commitment + the F-1 iPhone-Safari horizontal-scroll
// prevention.

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

  it('Fleet two-axis posture pinned: light+violet default + mode-axis color-scheme. Cross-app brand consistency with marketing-site (same token layer)', () => {
    expect(body).toMatch(
      /Fleet two-axis dashboard surface \(light\+violet default, 2026-06-12 rework\)\./,
    );
    expect(body).toMatch(/color-scheme: light;/);
  });

  it("tokens-shared-with-marketing commitment pinned: 'Tokens shared with apps/marketing-site/src/styles/base.css. Keep synchronised — customer experience reads as one product.' — drift would let the two apps drift visually apart", () => {
    expect(body).toMatch(
      /Tokens shared with apps\/marketing-\s*site\/src\/styles\/base\.css\. Keep synchronised — customer experience\s*reads as one product\./,
    );
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

  it('::selection bg-tk-accent pinned: brand-accent color for text selection. Drift to a different selection color would break cross-app brand recognition on selection', () => {
    expect(body).toMatch(/::selection \{\s*@apply bg-tk-accent text-white;\s*\}/);
  });
});
