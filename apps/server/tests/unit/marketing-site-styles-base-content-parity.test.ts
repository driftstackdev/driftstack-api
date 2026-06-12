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
//   • ::selection bg-tk-accent text-white.
//   • btn-primary: bg-tk-accent + shadow-glow-accent + hover lift.
//   • btn-secondary: glass border-tk-border + bg-tk-hover + backdrop-blur.
//   • nav-link: text-tk-ink-2 + hover:text-tk-accent.
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

  it('base layer html/body framing pinned (Fleet rework): color-scheme follows data-mode (light default, dark override) + tk token bg/ink + Geist Sans font stack + cv11/ss01 OpenType + accent-aware radial body wash', () => {
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-tk-bg text-tk-ink;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-feature-settings: 'cv11', 'ss01';/);
    expect(body).toMatch(/-webkit-font-smoothing: antialiased;/);
    expect(body).toMatch(/-moz-osx-font-smoothing: grayscale;/);
    expect(body).toMatch(/@apply min-h-screen flex flex-col;/);
    // R7 — softened radial alphas (0.12→0.07 + 0.08→0.05) so the
    // graphite surface breathes (outseta-style restraint).
    expect(body).toMatch(/radial-gradient\(ellipse 90% 60% at 50% -10%, var\(--glow\)/);
    expect(body).toMatch(/radial-gradient\(ellipse 80% 50% at 50% 100%, var\(--accent-soft\)/);
    expect(body).toMatch(/background-attachment: fixed;/);
  });

  it('code/pre/kbd Berkeley-Mono framing pinned (F-1 also adds overflow-wrap:anywhere + word-break:break-word + pre overflow-x:auto so long strings wrap or scroll internally on iPhone Safari)', () => {
    expect(body).toMatch(
      /code,\s*\n?\s*pre,\s*\n?\s*kbd \{\s*\n?\s*font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;\s*\n?\s*font-feature-settings: normal;[\s\S]*?overflow-wrap: anywhere;\s*\n?\s*word-break: break-word;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/pre \{[\s\S]*?overflow-x: auto;\s*\n?\s*\}/);
  });

  it('::selection accent framing pinned (follows the data-accent axis)', () => {
    expect(body).toMatch(/::selection \{[\s\S]*?@apply bg-tk-accent-strong text-white;/);
  });

  it('hairline divider hr: 1px gradient with accent glimmer in middle (token-aware)', () => {
    expect(body).toMatch(/hr \{/);
    expect(body).toMatch(/@apply border-0 h-px;/);
    expect(body).toMatch(/rgb\(var\(--accent-rgb\) \/ 0\.35\) 50%/);
  });

  it('btn-primary framing pinned (Fleet): bg-tk-accent + shadow-glow-accent + hover lift (hover:bg-tk-accent-strong + hover:-translate-y-0.5) + focus-visible outline-tk-accent', () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent px-5/);
    expect(body).toMatch(/shadow-glow-accent/);
    expect(body).toMatch(/hover:bg-tk-accent-strong/);
    expect(body).toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/focus-visible:outline-tk-accent/);
    expect(body).toMatch(/active:translate-y-0/);
  });

  it('btn-secondary framing pinned (Fleet): tokened border/surface + hover tk-hover', () => {
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border bg-tk-surface/);
    expect(body).toMatch(/font-medium text-tk-ink backdrop-blur-sm/);
    expect(body).toMatch(/backdrop-blur-sm/);
    expect(body).toMatch(/hover:border-tk-ink-3 hover:bg-tk-hover/);
  });

  it('nav-link framing pinned (Fleet): text-sm + tk-ink-2 + hover:text-tk-accent', () => {
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(/@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent;/);
  });

  it('section-label framing pinned (Fleet): mono uppercase tracking-[0.2em] tk-accent + the // mission-control prefix', () => {
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/font-mono text-xs uppercase/);
    expect(body).toMatch(/tracking-\[0\.2em\] text-tk-accent/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\/\/ ';/);
  });

  it('card framing pinned (Fleet): rounded-xl tokened border + bg-tk-surface/70 + backdrop-blur-sm + hover accent-tinted top edge', () => {
    expect(body).toMatch(/\.card \{/);
    expect(body).toMatch(/rounded-xl border border-tk-border/);
    expect(body).toMatch(/bg-tk-surface\/70 backdrop-blur-sm/);
    expect(body).toMatch(/hover:border-tk-accent\/40/);
    expect(body).toMatch(/\.card::before \{/);
    expect(body).toMatch(/rgb\(var\(--accent-rgb\) \/ 0\.6\)/);
    expect(body).toMatch(/\.card:hover::before \{/);
    expect(body).toMatch(/@apply opacity-100;/);
  });

  it('grid-bg framing pinned: dual linear-gradient grid pattern with radial mask', () => {
    expect(body).toMatch(/\.grid-bg \{/);
    expect(body).toMatch(
      /linear-gradient\(to right, rgb\(var\(--ink-rgb\) \/ 0\.04\) 1px, transparent 1px\)/,
    );
    expect(body).toMatch(
      /linear-gradient\(to bottom, rgb\(var\(--ink-rgb\) \/ 0\.04\) 1px, transparent 1px\)/,
    );
    expect(body).toMatch(/background-size: 40px 40px;/);
    expect(body).toMatch(/mask-image: radial-gradient/);
  });

  it('code-preview framing pinned (Fleet): dark terminal in BOTH modes (background: var(--code-bg)) + window-chrome pips', () => {
    expect(body).toMatch(/\.code-preview \{/);
    expect(body).toMatch(/rounded-xl border border-tk-border font-mono/);
    expect(body).toMatch(/background: var\(--code-bg\);/);
    expect(body).toMatch(/\.code-preview \.code-window-chrome \{/);
    expect(body).toMatch(/\.code-preview \.code-window-chrome span\.pip \{/);
    expect(body).toMatch(/h-2\.5 w-2\.5 rounded-full bg-white\/15/);
  });

  it('accent-rule framing pinned (Fleet): vertical tk-accent border-left + accent glow shadow', () => {
    expect(body).toMatch(/\.accent-rule \{/);
    expect(body).toMatch(/border-l-2 border-tk-accent pl-6/);
    expect(body).toMatch(/box-shadow: -2px 0 16px -4px var\(--glow\)/);
  });

  it('arrow-bullet framing pinned (Fleet): text-tk-accent font-mono', () => {
    expect(body).toMatch(/\.arrow-bullet \{/);
    expect(body).toMatch(/@apply text-tk-accent font-mono;/);
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
