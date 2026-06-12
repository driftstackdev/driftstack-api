// W524.A (refactored R1) — drift guard for apps/marketing-site/src/styles/base.css.
// Site-wide Tailwind base layer + dark-mode-first design tokens + the
// 4-utility-component set (btn-primary, btn-secondary, nav-link,
// section-label, card, code-preview, accent-rule). Drift here either
// changes the brand red used by every CTA or breaks the Geist + Berkeley
// Mono font stack (would create cross-page typography divergence).
//
//   • 3 Tailwind directives: @tailwind base / components / utilities.
//   • Dark mode by default: color-scheme: dark; surface-base bg.
//   • Geist + Berkeley Mono font-family with system-stack fallback.
//   • Radial-glow body background (oxblood top + soft bottom).
//   • ::selection bg-oxblood-700 text-white.
//   • btn-primary: bg-oxblood-700 + shadow-glow-red + hover lift.
//   • btn-secondary: glass border-white/10 + bg-white/5 + backdrop-blur.
//   • nav-link: text-ink-secondary + hover:text-glow-red.
//   • section-label: mono [BRACKETED] glow-red accent.
//   • card: rounded-xl glass surface with red-tinted top edge on hover.
//   • code-preview: monospace dark inset with window-chrome pip header.
//   • accent-rule: red glow vertical bar for callouts.

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

  it('3 Tailwind directives + dark-mode-first design-token framing pinned', () => {
    expect(body).toMatch(/@tailwind base;/);
    expect(body).toMatch(/@tailwind components;/);
    expect(body).toMatch(/@tailwind utilities;/);
    expect(body).toMatch(/Dark-mode-first marketing surface\./);
    expect(body).toMatch(/Tokens shared with apps\/customer-/);
  });

  it('base layer html/body framing pinned: color-scheme: dark + surface-base bg + Geist Sans font stack + cv11/ss01 OpenType + radial-glow body background', () => {
    expect(body).toMatch(/color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-surface-base text-ink-primary;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-feature-settings: 'cv11', 'ss01';/);
    expect(body).toMatch(/-webkit-font-smoothing: antialiased;/);
    expect(body).toMatch(/-moz-osx-font-smoothing: grayscale;/);
    expect(body).toMatch(/@apply min-h-screen flex flex-col;/);
    // R7 — softened radial alphas (0.12→0.07 + 0.08→0.05) so the
    // graphite surface breathes (outseta-style restraint).
    expect(body).toMatch(
      /radial-gradient\(ellipse 90% 60% at 50% -10%, rgba\(226, 56, 71, 0\.07\)/,
    );
    expect(body).toMatch(
      /radial-gradient\(ellipse 80% 50% at 50% 100%, rgba\(114, 47, 55, 0\.05\)/,
    );
    expect(body).toMatch(/background-attachment: fixed;/);
  });

  it('code/pre/kbd Berkeley-Mono framing pinned (F-1 also adds overflow-wrap:anywhere + word-break:break-word + pre overflow-x:auto so long strings wrap or scroll internally on iPhone Safari)', () => {
    expect(body).toMatch(
      /code,\s*\n?\s*pre,\s*\n?\s*kbd \{\s*\n?\s*font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;\s*\n?\s*font-feature-settings: normal;[\s\S]*?overflow-wrap: anywhere;\s*\n?\s*word-break: break-word;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/pre \{[\s\S]*?overflow-x: auto;\s*\n?\s*\}/);
  });

  it('::selection oxblood framing pinned (brand-locked selection)', () => {
    expect(body).toMatch(/::selection \{\s*\n?\s*@apply bg-oxblood-700 text-white;\s*\n?\s*\}/);
  });

  it('hairline divider hr: 1px gradient with red glimmer in middle', () => {
    expect(body).toMatch(/hr \{/);
    expect(body).toMatch(/@apply border-0 h-px;/);
    expect(body).toMatch(/rgba\(226, 56, 71, 0\.25\)/);
  });

  it('btn-primary framing pinned: bg-oxblood-700 + shadow-glow-red + hover lift (hover:bg-oxblood-600 + hover:shadow-glow-red-lg + hover:-translate-y-0.5) + focus-visible outline-glow-red', () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-oxblood-700/);
    expect(body).toMatch(/shadow-glow-red/);
    expect(body).toMatch(/hover:bg-oxblood-600/);
    expect(body).toMatch(/hover:shadow-glow-red-lg/);
    expect(body).toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/focus-visible:outline-glow-red/);
    expect(body).toMatch(/active:translate-y-0/);
  });

  it('btn-secondary framing pinned: glass-on-dark border-white/10 + bg-white/5 + backdrop-blur-sm + hover:border-white/20 + hover:bg-white/10', () => {
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-white\/10/);
    expect(body).toMatch(/bg-white\/5/);
    expect(body).toMatch(/text-ink-primary/);
    expect(body).toMatch(/backdrop-blur-sm/);
    expect(body).toMatch(/hover:border-white\/20/);
    expect(body).toMatch(/hover:bg-white\/10/);
  });

  it('nav-link framing pinned: text-sm + text-ink-secondary + hover:text-glow-red', () => {
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-ink-secondary transition-colors hover:text-glow-red;/,
    );
  });

  it('section-label framing pinned: mono uppercase tracking-[0.2em] text-glow-red + [BRACKETED] pseudo-element before/after', () => {
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/font-mono text-xs uppercase/);
    expect(body).toMatch(/tracking-\[0\.2em\] text-glow-red/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\[ ';/);
    expect(body).toMatch(/\.section-label::after \{/);
    expect(body).toMatch(/content: ' \]';/);
  });

  it('card framing pinned: rounded-xl glass border-white/10 + bg-surface-raised/60 + backdrop-blur-sm + hover red-tinted top edge accent', () => {
    expect(body).toMatch(/\.card \{/);
    expect(body).toMatch(/rounded-xl border border-white\/10/);
    expect(body).toMatch(/bg-surface-raised\/60 backdrop-blur-sm/);
    expect(body).toMatch(/hover:border-glow-red\/30/);
    expect(body).toMatch(/\.card::before \{/);
    expect(body).toMatch(/rgba\(226, 56, 71, 0\.6\)/);
    expect(body).toMatch(/\.card:hover::before \{/);
    expect(body).toMatch(/@apply opacity-100;/);
  });

  it('grid-bg framing pinned: dual linear-gradient grid pattern with radial mask', () => {
    expect(body).toMatch(/\.grid-bg \{/);
    expect(body).toMatch(
      /linear-gradient\(to right, rgba\(255, 255, 255, 0\.04\) 1px, transparent 1px\)/,
    );
    expect(body).toMatch(
      /linear-gradient\(to bottom, rgba\(255, 255, 255, 0\.04\) 1px, transparent 1px\)/,
    );
    expect(body).toMatch(/background-size: 40px 40px;/);
    expect(body).toMatch(/mask-image: radial-gradient/);
  });

  it('code-preview framing pinned: monospace dark inset + window-chrome pip 3-circle header', () => {
    expect(body).toMatch(/\.code-preview \{/);
    expect(body).toMatch(/rounded-xl border border-white\/10 bg-surface-inset/);
    expect(body).toMatch(/font-mono text-xs leading-6/);
    expect(body).toMatch(/\.code-preview \.code-window-chrome \{/);
    expect(body).toMatch(/\.code-preview \.code-window-chrome span\.pip \{/);
    expect(body).toMatch(/h-2\.5 w-2\.5 rounded-full bg-white\/15/);
  });

  it('accent-rule framing pinned: vertical glow-red border-left + box-shadow red glow', () => {
    expect(body).toMatch(/\.accent-rule \{/);
    expect(body).toMatch(/border-l-2 border-glow-red pl-6/);
    expect(body).toMatch(/box-shadow: -2px 0 16px -4px rgba\(226, 56, 71, 0\.4\)/);
  });

  it('arrow-bullet framing pinned: text-glow-red font-mono', () => {
    expect(body).toMatch(/\.arrow-bullet \{/);
    expect(body).toMatch(/@apply text-glow-red font-mono;/);
  });

  it('Fleet token layer pinned (2026-06-12 rework): two-axis data-mode/data-accent custom-property blocks — violet/oxblood/teal accents + light/dark modes — referencing the locked spec; ADDITIVE (legacy classes keep their baked palette until each page ports)', () => {
    expect(body).toMatch(/docs\/internal\/2026-06-12-design-system-spec\.md/);
    // each axis block carries the full-color var AND its -rgb triplet twin
    // (alpha-capable Tailwind colors); the hex + triplet must stay in sync.
    expect(body).toMatch(/\[data-accent='violet'\] \{\s*\n\s*--accent-rgb: 109 94 252;/);
    expect(body).toMatch(/--accent: #6d5efc;/);
    expect(body).toMatch(/\[data-accent='oxblood'\] \{\s*\n\s*--accent-rgb: 155 59 70;/);
    expect(body).toMatch(/--accent: #9b3b46;/);
    expect(body).toMatch(/\[data-accent='teal'\] \{\s*\n\s*--accent-rgb: 16 154 130;/);
    expect(body).toMatch(/--accent: #109a82;/);
    expect(body).toMatch(/\[data-mode='light'\] \{\s*\n\s*--bg-rgb: 242 243 246;/);
    expect(body).toMatch(/--bg: #f2f3f6;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*--bg-rgb: 6 6 8;/);
    expect(body).toMatch(/--bg: #060608;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
