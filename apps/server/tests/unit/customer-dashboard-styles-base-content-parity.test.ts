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

  it("Dark-mode-first posture pinned: 'Dark-mode-first dashboard surface' + color-scheme: dark. Drift to dropping the dark-mode framing would break the cross-app brand consistency with marketing-site (also dark-mode-first)", () => {
    expect(body).toMatch(/Dark-mode-first dashboard surface/);
    expect(body).toMatch(/color-scheme: dark;/);
  });

  it("tokens-shared-with-marketing commitment pinned: 'Tokens shared with apps/marketing-site/src/styles/base.css. Keep synchronised — customer experience reads as one product.' — drift would let the two apps drift visually apart", () => {
    expect(body).toMatch(
      /Tokens shared with apps\/marketing-\s*\n?\s*site\/src\/styles\/base\.css\. Keep synchronised — customer experience\s*\n?\s*reads as one product\./,
    );
  });

  it('F-1 iPhone-Safari horizontal-scroll prevention pinned: overflow-x:clip on html + body + max-width:100vw on body. Drift to overflow:hidden would break sticky positioning across dashboard pages — a real visual bug previously seen on iPhone Safari', () => {
    expect(body).toMatch(/F-1 — prevent iPhone Safari horizontal scroll/);
    expect(body).toMatch(/overflow-x: clip;/);
    expect(body).toMatch(/max-width: 100vw;/);
  });

  it('Font stack pinned: Geist (display) + Berkeley Mono (code). Drift to a different font would break cross-app typographic consistency', () => {
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;/);
  });

  it('Geist font-feature-settings cv11 + ss01 pinned: the OpenType features that give Geist its tabular-numeric + alternate-glyph polish. Drift to dropping would weaken the typography', () => {
    expect(body).toMatch(/font-feature-settings: 'cv11', 'ss01';/);
  });

  it('::selection bg-oxblood-700 pinned: brand-accent color for text selection. Drift to a different selection color would break cross-app brand recognition on selection', () => {
    expect(body).toMatch(/::selection \{\s*\n?\s*@apply bg-oxblood-700 text-white;\s*\n?\s*\}/);
  });
});
