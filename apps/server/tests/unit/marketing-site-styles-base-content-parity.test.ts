// W524.A (refactored R1, Fleet v2 2026-07-03) — drift guard for
// apps/marketing-site/src/styles/base.css. Site-wide Tailwind base layer +
// two-axis design tokens + the component recipe set. Drift here either
// changes the brand accent used by every CTA or breaks the typography
// stack (would create cross-page divergence).
//
//   • 3 Tailwind directives: @tailwind base / components / utilities.
//   • Self-hosted @font-face set (Fleet v2 port 2026-07-03): Geist VF +
//     JetBrains Mono Regular/Bold from public/fonts/, font-display: swap.
//   • Geist + Berkeley Mono font-family with system-stack fallback
//     (JetBrains Mono ships as the vendored mono; Berkeley Mono stays
//     first-family for licensed local installs, never vendored).
//   • Radial-glow body background (accent top + soft bottom).
//   • ::selection bg-tk-accent-strong text-white.
//   • btn-primary: FLAT bg-tk-accent + shadow-ambient (v2: the glow ring +
//     hover lift are retired — negative-pinned below).
//   • btn-secondary: solid border-tk-border + hover tk-hover (glass retired).
//   • nav-link: text-tk-ink-2 + hover:text-tk-accent-text (AA-safe).
//   • section-label: mono // label in tk-accent-text (AA-safe).
//   • card: solid rounded-card surface + shadow-ambient + subtle accent
//     border on hover (glass + top-edge shimmer retired).
//   • v2 recipes ported from the dashboard kit: panel/stat-*/status-dot/
//     pill/themer (signatures match apps/customer-dashboard).
//   • --accent-text: AA-safe accent TEXT tone per mode × accent pair.
//   • code-preview: monospace dark inset with window-chrome pip header.
//   • accent-rule: accent glow vertical bar for callouts.

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

  it('code/pre/kbd mono framing pinned — Berkeley Mono first-family (licensed local installs), vendored JetBrains Mono second (what actually ships), system fallback after (F-1 also adds overflow-wrap:anywhere + word-break:break-word + pre overflow-x:auto so long strings wrap or scroll internally on iPhone Safari)', () => {
    expect(body).toMatch(
      /code,\s*pre,\s*kbd \{\s*font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;\s*font-feature-settings: normal;[\s\S]*?overflow-wrap: anywhere;\s*word-break: break-word;\s*\}/,
    );
    expect(body).toMatch(/pre \{[\s\S]*?overflow-x: auto;\s*\}/);
  });

  it('self-hosted @font-face set pinned (Fleet v2 port 2026-07-03): Geist VF (100 900 variable) + JetBrains Mono Regular/Bold from public/fonts/, all font-display: swap; Berkeley Mono is NEVER vendored (commercial license)', () => {
    expect(body).toMatch(/src: url\('\/fonts\/geist\/GeistVF\.woff2'\) format\('woff2'\);/);
    expect(body).toMatch(/font-weight: 100 900;/);
    expect(body).toMatch(
      /src: url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2'\) format\('woff2'\);/,
    );
    expect(body).toMatch(
      /src: url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Bold\.woff2'\) format\('woff2'\);/,
    );
    expect(body).toMatch(/font-display: swap;/);
    expect(body).toMatch(/NEVER vendored \(commercial license\)/);
  });

  it('::selection accent framing pinned (follows the data-accent axis)', () => {
    expect(body).toMatch(/::selection \{[\s\S]*?@apply bg-tk-accent-strong text-white;/);
  });

  it('hairline divider hr: 1px gradient with accent glimmer in middle (token-aware)', () => {
    expect(body).toMatch(/hr \{/);
    expect(body).toMatch(/@apply border-0 h-px;/);
    expect(body).toMatch(/rgb\(var\(--accent-rgb\) \/ 0\.35\) 50%/);
  });

  it('btn-primary framing pinned (Fleet v2 2026-07-03): FLAT bg-tk-accent + shadow-ambient + transition-colors + hover:bg-tk-accent-strong + focus-visible outline-tk-accent + disabled states — the v1 glow ring (shadow-glow-accent) and hover lift (hover:-translate-y-0.5) are RETIRED and negative-pinned so they cannot silently return', () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent px-5/);
    expect(body).toMatch(/shadow-ambient transition-colors duration-150/);
    expect(body).toMatch(/hover:bg-tk-accent-strong/);
    expect(body).toMatch(/focus-visible:outline-tk-accent/);
    expect(body).toMatch(/disabled:opacity-50 disabled:cursor-not-allowed/);
    // scope the negative pins to the .btn-primary block only — glow-accent
    // legitimately survives elsewhere (e.g. tailwind shadow for hot elements)
    const btnPrimaryBlock = body.match(/\.btn-primary \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(btnPrimaryBlock).not.toMatch(/shadow-glow-accent/);
    expect(btnPrimaryBlock).not.toMatch(/hover:-translate-y-0\.5/);
    expect(btnPrimaryBlock).not.toMatch(/active:translate-y-0/);
  });

  it('btn-secondary framing pinned (Fleet v2): SOLID tokened border/surface + hover tk-hover — glass (backdrop-blur) retired', () => {
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border bg-tk-surface/);
    expect(body).toMatch(/font-medium text-tk-ink\b/);
    expect(body).toMatch(/hover:border-tk-ink-3 hover:bg-tk-hover/);
    const btnSecondaryBlock = body.match(/\.btn-secondary \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(btnSecondaryBlock).not.toMatch(/backdrop-blur/);
  });

  it('nav-link framing pinned (Fleet v2): text-sm + tk-ink-2 + hover:text-tk-accent-text (the AA-safe accent text tone — raw --accent is ~3.0:1 on the dark bg)', () => {
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent-text;/,
    );
  });

  it('section-label framing pinned (Fleet v2): mono uppercase tracking-[0.2em] tk-accent-text (AA-safe) + the // mission-control prefix', () => {
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/font-mono text-xs uppercase/);
    expect(body).toMatch(/tracking-\[0\.2em\] text-tk-accent-text/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\/\/ ';/);
  });

  it('card framing pinned (Fleet v2 2026-07-03): SOLID rounded-card tokened border + bg-tk-surface + shadow-ambient + subtle accent border on hover — v1 glass (bg-tk-surface/70 + backdrop-blur) and the hover top-edge shimmer (::before gradient) are RETIRED and negative-pinned', () => {
    expect(body).toMatch(/\.card \{/);
    expect(body).toMatch(/rounded-card border border-tk-border/);
    expect(body).toMatch(/bg-tk-surface shadow-ambient/);
    expect(body).toMatch(/hover:border-tk-accent\/40/);
    const cardBlock = body.match(/\.card \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(cardBlock).not.toMatch(/backdrop-blur/);
    expect(cardBlock).not.toMatch(/bg-tk-surface\/70/);
    expect(body).not.toMatch(/\.card::before \{/);
    expect(body).not.toMatch(/\.card:hover::before \{/);
  });

  it('Fleet v2 recipe port pinned (2026-07-03, signatures match apps/customer-dashboard/src/styles/base.css; S25 2026-07-06 — status-dot label text re-toned onto the AA-safe --*-text tokens with an explicit ::before override keeping the dot on the raw status fill): panel/panel-title + stat-card/label/value/sub + status-dot family (ready/busy/err/idle/live) + pill + themer/themer-btn', () => {
    expect(body).toMatch(
      /\.panel \{\s*\n\s*@apply rounded-card border border-tk-border bg-tk-surface p-\[18px\] shadow-ambient;/,
    );
    expect(body).toMatch(/\.panel-title \{/);
    expect(body).toMatch(
      /\.stat-card \{\s*\n\s*@apply rounded-card border border-tk-border bg-tk-surface p-4 shadow-ambient;/,
    );
    expect(body).toMatch(/\.stat-label \{/);
    expect(body).toMatch(
      /\.stat-value \{\s*\n\s*@apply text-\[26px\] font-extrabold leading-tight tracking-\[-0\.6px\] text-tk-ink;/,
    );
    expect(body).toMatch(/\.stat-sub \{/);
    expect(body).toMatch(/\.status-dot \{/);
    expect(body).toMatch(/\.status-dot--ready \{\s*\n\s*@apply text-tk-ready-text;/);
    expect(body).toMatch(/\.status-dot--ready::before \{\s*\n\s*@apply bg-tk-ready;/);
    expect(body).toMatch(/\.status-dot--busy \{\s*\n\s*@apply text-tk-busy-text;/);
    expect(body).toMatch(/\.status-dot--busy::before \{\s*\n\s*@apply bg-tk-busy;/);
    expect(body).toMatch(/\.status-dot--err \{\s*\n\s*@apply text-tk-err-text;/);
    expect(body).toMatch(/\.status-dot--err::before \{\s*\n\s*@apply bg-tk-err;/);
    expect(body).toMatch(/\.status-dot--idle \{/);
    expect(body).toMatch(/\.status-dot--live::before \{\s*\n\s*animation: livepulse/);
    expect(body).toMatch(/\.pill \{/);
    expect(body).toMatch(/\.themer \{/);
    expect(body).toMatch(
      /\.themer-btn\[aria-pressed='true'\] \{\s*\n\s*@apply bg-tk-accent text-tk-accent-ink;/,
    );
  });

  it('AA-safe --accent-text token pinned (Fleet v2 2026-07-03): per mode × accent compound selectors, all ≥4.5:1 on --bg (dark oxblood #d4626e / violet #8b7dff / teal #1bc7a8; light oxblood #8d2c3e / violet #5847e0 / teal #0c7d69) — raw --accent stays for fills/borders, text roles use tk-accent-text', () => {
    expect(body).toMatch(
      /\[data-mode='dark'\]\[data-accent='oxblood'\] \{\s*\n\s*--accent-text: #d4626e;/,
    );
    expect(body).toMatch(
      /\[data-mode='dark'\]\[data-accent='violet'\] \{\s*\n\s*--accent-text: #8b7dff;/,
    );
    expect(body).toMatch(
      /\[data-mode='dark'\]\[data-accent='teal'\] \{\s*\n\s*--accent-text: #1bc7a8;/,
    );
    expect(body).toMatch(
      /\[data-mode='light'\]\[data-accent='oxblood'\] \{\s*\n\s*--accent-text: #8d2c3e;/,
    );
    expect(body).toMatch(
      /\[data-mode='light'\]\[data-accent='violet'\] \{\s*\n\s*--accent-text: #5847e0;/,
    );
    expect(body).toMatch(
      /\[data-mode='light'\]\[data-accent='teal'\] \{\s*\n\s*--accent-text: #0c7d69;/,
    );
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
    // S20 2026-07-06: pips /15 → /25 (measured 1.49:1 on the code-bg —
    // sub-visible on the dark terminal chrome).
    expect(body).toMatch(/h-2\.5 w-2\.5 rounded-full bg-white\/25/);
  });

  it('accent-rule framing pinned (Fleet): vertical tk-accent border-left + accent glow shadow', () => {
    expect(body).toMatch(/\.accent-rule \{/);
    expect(body).toMatch(/border-l-2 border-tk-accent pl-6/);
    expect(body).toMatch(/box-shadow: -2px 0 16px -4px var\(--glow\)/);
  });

  it('arrow-bullet framing pinned (Fleet v2): text-tk-accent-text font-mono (AA-safe accent text tone)', () => {
    expect(body).toMatch(/\.arrow-bullet \{/);
    expect(body).toMatch(/@apply text-tk-accent-text font-mono;/);
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
