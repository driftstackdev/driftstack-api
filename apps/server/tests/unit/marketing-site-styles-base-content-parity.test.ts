// W524.A — drift guard for apps/marketing-site/src/styles/base.css.
// Site-wide Tailwind base layer + 3-utility-component (btn-primary +
// btn-secondary + nav-link). Drift here either changes the brand-color
// (oxblood-700) used by every CTA + nav link (would create cross-page
// brand-color divergence) or breaks the Geist + Berkeley Mono font
// stack (would create cross-page typography divergence).
//
//   • 3 Tailwind directives: @tailwind base / components / utilities.
//   • Geist + Berkeley Mono font-family with system-stack fallback.
//   • color-scheme: light + html bg-slate-50 + text-slate-900.
//   • body min-h-screen flex flex-col (footer-pinned-to-bottom shell).
//   • ::selection bg-oxblood-700 text-white.
//   • btn-primary: bg-oxblood-700 + hover:bg-oxblood-800 + focus-visible
//     outline-oxblood-700.
//   • btn-secondary: border-slate-300 + bg-white + slate-900 text.
//   • nav-link: text-sm + text-slate-600 + hover:text-oxblood-700.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/styles/base.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W524.A apps/marketing-site/src/styles/base.css content parity', () => {
  const body = read(LIB);

  it("3 Tailwind directive + Geist/Berkeley-Mono framing pinned: '@tailwind base;' + '@tailwind components;' + '@tailwind utilities;' + 'Geist Sans + Berkeley Mono are loaded via @font-face declarations that ship with the deployed site. Falling back to system stack if the font fetches fail.' — pinned so the 3-directive Tailwind base + Geist-Sans + Berkeley-Mono custom-font commitment + system-stack-fallback safety survives (drift to a different font-family would create cross-page typography divergence)", () => {
    expect(body).toMatch(/@tailwind base;/);
    expect(body).toMatch(/@tailwind components;/);
    expect(body).toMatch(/@tailwind utilities;/);
    expect(body).toMatch(
      /\/\* Geist Sans \+ Berkeley Mono are loaded via @font-face declarations\s*\n?\s*that ship with the deployed site\. Falling back to system stack if\s*\n?\s*the font fetches fail\. \*\//,
    );
  });

  it("base layer html/body framing pinned: 'color-scheme: light;' + 'html { bg-slate-50 + text-slate-900 + font-family: Geist, ui-sans-serif, system-ui, sans-serif + font-feature-settings: cv11, ss01 + -webkit-font-smoothing: antialiased + -moz-osx-font-smoothing: grayscale }' + 'body { min-h-screen flex flex-col }' — pinned so the light-mode-only + slate-50-bg + Geist-with-system-fallback + cv11/ss01-OpenType-features + antialiased-rendering + flex-column-body-shell commitment survives", () => {
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/@apply bg-slate-50 text-slate-900;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-feature-settings: 'cv11', 'ss01';/);
    expect(body).toMatch(/-webkit-font-smoothing: antialiased;/);
    expect(body).toMatch(/-moz-osx-font-smoothing: grayscale;/);
    expect(body).toMatch(/@apply min-h-screen flex flex-col;/);
  });

  it('code/pre/kbd Berkeley-Mono framing pinned: \'code, pre, kbd { font-family: "Berkeley Mono", ui-monospace, SFMono-Regular, monospace; font-feature-settings: normal; }\' — pinned so the 3-element mono-font targeting + Berkeley-Mono-with-ui-monospace-fallback + font-feature-reset commitment survives', () => {
    expect(body).toMatch(
      /code,\s*\n?\s*pre,\s*\n?\s*kbd \{\s*\n?\s*font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;\s*\n?\s*font-feature-settings: normal;\s*\n?\s*\}/,
    );
  });

  it("::selection oxblood framing pinned: '::selection { bg-oxblood-700 text-white }' — pinned so the brand-color selection-highlight (oxblood text-on-white-text) commitment survives (drift to a different selection color would create cross-page selection-highlight divergence)", () => {
    expect(body).toMatch(/::selection \{\s*\n?\s*@apply bg-oxblood-700 text-white;\s*\n?\s*\}/);
  });

  it("btn-primary framing pinned: 'inline-flex items-center justify-center rounded-md bg-oxblood-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-oxblood-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood-700' — pinned so the primary-CTA oxblood-700-fill + hover:oxblood-800-darker + 2px-outline-on-focus-visible + 2px-outline-offset commitment survives (drift to a different brand color in btn-primary would propagate to every CTA on the site)", () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-oxblood-700/);
    expect(body).toMatch(/hover:bg-oxblood-800/);
    expect(body).toMatch(/focus-visible:outline-oxblood-700/);
    expect(body).toMatch(/focus-visible:outline-2/);
    expect(body).toMatch(/focus-visible:outline-offset-2/);
  });

  it("btn-secondary framing pinned: 'inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood-700' — pinned so the secondary-CTA slate-300-border + white-fill + slate-900-text + hover:slate-100 + same-oxblood-focus-outline commitment survives", () => {
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-slate-300/);
    expect(body).toMatch(/bg-white/);
    expect(body).toMatch(/text-slate-900/);
    expect(body).toMatch(/hover:bg-slate-100/);
  });

  it("nav-link framing pinned: 'text-sm text-slate-600 transition-colors hover:text-oxblood-700' — pinned so the nav-link slate-600-default + hover:oxblood-700 commitment survives (drift to a different nav-link color would create cross-page nav-color divergence)", () => {
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(/@apply text-sm text-slate-600 transition-colors hover:text-oxblood-700;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
