// W524.A (refactored R1, Fleet v2 2026-07-03) — drift guard for
// apps/marketing-site/src/styles/base.css. Site-wide Tailwind base layer +
// two-axis design tokens + the component recipe set. Drift here either
// changes the brand accent used by every CTA or breaks the typography
// stack (would create cross-page divergence).
//
//   • 2026-09-25: the token values come from @driftstack/design-tokens
//     (tokens.css + web-aliases.css, imported first) — the desktop app's
//     light and dark themes and the one oxblood accent #a83b4d; this file
//     keeps only the web extensions (--glow, --code-bg, --code-ink,
//     --code-label). Light is the default.
//   • 3 Tailwind directives: @tailwind base / components / utilities.
//   • Self-hosted @font-face set (Fleet v2 port 2026-07-03): Geist VF +
//     JetBrains Mono Regular/Bold from public/fonts/, font-display: swap.
//   • Geist + Berkeley Mono font-family with system-stack fallback
//     (JetBrains Mono ships as the vendored mono; Berkeley Mono stays
//     first-family for licensed local installs, never vendored).
//   • Radial-glow body background (accent top + soft bottom), each in its
//     own band, scrolling with the page.
//   • ::selection bg-tk-accent-strong text-white.
//   • btn-primary: the app's .btn-primary — FLAT bg-tk-accent, hover darkens
//     to accent-fill-hover (v2: the glow ring + hover lift are retired —
//     negative-pinned below).
//   • btn-secondary: the app's elevated face + divider hairline, hover to
//     the divider tone (glass retired).
//   • nav-link: text-tk-ink-2 + hover:text-tk-accent-text (AA-safe).
//   • section-label: mono // label in tk-accent-text (AA-safe).
//   • card: solid rounded-card surface + shadow-ambient + subtle accent
//     border on hover (glass + top-edge shimmer retired).
//   • v2 recipes ported from the dashboard kit: panel/stat-*/status-dot/
//     pill/themer (signatures match apps/customer-dashboard).
//   • --accent-text: AA-safe accent TEXT tone per mode (from the package).
//   • badge: the site's one chip recipe (the app's status badge).
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

  it('3 Tailwind directives + the shared-token imports first + light-first framing pinned (2026-09-25: was "Dark-mode-first"; the site now opens in the desktop app\'s light theme and takes every token value from @driftstack/design-tokens)', () => {
    expect(body).toMatch(/@tailwind base;/);
    expect(body).toMatch(/@tailwind components;/);
    expect(body).toMatch(/@tailwind utilities;/);
    // The imports precede every other statement (an @import after a rule is
    // dropped), so they come before the Tailwind directives.
    const tokensAt = body.indexOf("@import '@driftstack/design-tokens/tokens.css';");
    const aliasesAt = body.indexOf("@import '@driftstack/design-tokens/web-aliases.css';");
    expect(tokensAt).toBeGreaterThanOrEqual(0);
    expect(aliasesAt).toBeGreaterThan(tokensAt);
    expect(aliasesAt).toBeLessThan(body.indexOf('@tailwind base;'));
    expect(body).toMatch(/Light-first marketing surface/);
    expect(body).not.toMatch(/Dark-mode-first marketing surface/);
    expect(body).toMatch(/Tokens shared with apps\/customer-dashboard and the desktop app/);
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
    // graphite surface breathes (outseta-style restraint). 2026-09-25: the
    // bottom pool is a flat 5% accent, and each wash is painted in its own
    // band scrolling with the page — `background-attachment: fixed` tinted
    // every screen of reading, and a radial sized to the body stretched with
    // a long page.
    expect(body).toMatch(/radial-gradient\(ellipse 90% 60% at 50% -10%, var\(--glow\)/);
    expect(body).toMatch(
      /radial-gradient\(ellipse 80% 50% at 50% 100%, rgb\(var\(--accent-rgb\) \/ 0\.05\)/,
    );
    expect(body).toMatch(/background-repeat: no-repeat;/);
    expect(body).toMatch(/background-size:\s*100% 900px,\s*100% 600px;/);
    expect(body).not.toMatch(/background-attachment: fixed;/);
  });

  it('code/pre/kbd mono framing pinned — Berkeley Mono first-family (licensed local installs), vendored JetBrains Mono second (what actually ships), system fallback after (F-1 also adds overflow-wrap:anywhere + word-break:break-word + pre overflow-x:auto so long strings wrap or scroll internally on iPhone Safari)', () => {
    expect(body).toMatch(
      /code,\s*pre,\s*kbd \{\s*font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;\s*font-feature-settings: normal;[\s\S]*?overflow-wrap: anywhere;\s*word-break: break-word;\s*\}/,
    );
    expect(body).toMatch(/pre \{[\s\S]*?overflow-x: auto;\s*\}/);
  });

  it("running text breaks a long token at its box edge (html overflow-wrap: break-word, 2026-09-25): three changelog entries at 390px and a /docs/ card at 768px were cut off by the card's overflow-hidden (32-116px of text unreachable) while the page stayed viewport-wide, so a body-width check could not see it. break-word, not anywhere, so flex and grid min-content sizing is unchanged", () => {
    const htmlBlock = body.match(/\n {2}html \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(htmlBlock).toMatch(/overflow-x: clip;/);
    expect(htmlBlock).toMatch(/overflow-wrap: break-word;/);
    expect(htmlBlock).not.toMatch(/overflow-wrap: anywhere;/);
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

  it("btn-primary framing pinned (the desktop app's .btn-primary, 2026-09-25): FLAT bg-tk-accent + transition-colors + hover:bg-tk-accent-fill-hover (white 7.11:1 — it DARKENS; the old hover to the lighter rose dropped white text under 4.5:1) + active:bg-tk-accent-strong + focus-visible outline-tk-accent + disabled states, no shadow (the app's buttons carry none) — the v1 glow ring (shadow-glow-accent) and hover lift (hover:-translate-y-0.5) are RETIRED and negative-pinned so they cannot silently return", () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent px-5/);
    expect(body).toMatch(
      /transition-colors duration-150\s*\n\s*hover:bg-tk-accent-fill-hover active:bg-tk-accent-strong/,
    );
    expect(body).toMatch(/focus-visible:outline-tk-accent/);
    expect(body).toMatch(/disabled:opacity-50 disabled:cursor-not-allowed/);
    // scope the negative pins to the .btn-primary block only — glow-accent
    // legitimately survives elsewhere (e.g. tailwind shadow for hot elements)
    const btnPrimaryBlock = body.match(/\.btn-primary \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(btnPrimaryBlock).not.toMatch(/shadow-glow-accent/);
    expect(btnPrimaryBlock).not.toMatch(/hover:-translate-y-0\.5/);
    expect(btnPrimaryBlock).not.toMatch(/active:translate-y-0/);
  });

  it("btn-secondary framing pinned (the desktop app's .btn-secondary, 2026-09-25): the elevated face (bg-tk-raised) + a divider hairline (it sits on the page ground, not in a card) + hover to the divider tone — glass (backdrop-blur) retired", () => {
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border bg-tk-raised/);
    expect(body).toMatch(/font-medium text-tk-ink\b/);
    expect(body).toMatch(/hover:bg-tk-border/);
    const btnSecondaryBlock = body.match(/\.btn-secondary \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(btnSecondaryBlock).not.toMatch(/backdrop-blur/);
  });

  it('nav-link framing pinned (Fleet v2): text-sm + tk-ink-2 + hover:text-tk-accent-text (the AA-safe accent text tone — raw --accent is ~3.0:1 on the dark bg)', () => {
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent-text;/,
    );
  });

  it("section-label framing pinned (Fleet v2): mono uppercase tk-accent-text (AA-safe) + the // mission-control prefix — 2026-09-25: calmer tracking (0.16em), and the prefix keeps its space through a flex gap (a flex item's trailing space collapses: the old '// ' rendered as \"//LABEL\")", () => {
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/gap-2 font-mono text-xs uppercase/);
    expect(body).toMatch(/tracking-\[0\.16em\] text-tk-accent-text/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\/\/';/);
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
    // 2026-09-25: panel and stat-card take the card's padding family (p-6 /
    // p-5), so a panel beside a card no longer reads as another component.
    expect(body).toMatch(
      /\.panel \{\s*\n\s*@apply rounded-card border border-tk-border bg-tk-surface p-6 shadow-ambient;/,
    );
    expect(body).toMatch(/\.panel-title \{/);
    expect(body).toMatch(
      /\.stat-card \{\s*\n\s*@apply rounded-card border border-tk-border bg-tk-surface p-5 shadow-ambient;/,
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

  it('AA-safe --accent-text comes from the shared tokens (2026-09-25): the per mode × accent compound selectors (and the violet / teal axes) are gone from this file — tokens.css declares accent-text per mode (#8f3241 light 6.64:1 on #ebedf2 / #e8a0ab dark 8.54:1 on #0f172a) and the preset maps tk-accent-text onto it; raw --accent stays for fills/borders, text roles use tk-accent-text', () => {
    for (const mode of ['dark', 'light']) {
      for (const accent of ['oxblood', 'violet', 'teal']) {
        expect(body).not.toContain(`[data-mode='${mode}'][data-accent='${accent}']`);
      }
    }
    const tokens = readFileSync(
      resolve(REPO_ROOT, 'packages/design-tokens/dist/tokens.css'),
      'utf8',
    );
    expect(tokens).toMatch(/\[data-mode='light'\] \{[^}]*--accent-text: #8f3241;/);
    expect(tokens).toMatch(/\[data-mode='dark'\] \{[^}]*--accent-text: #e8a0ab;/);
  });

  it('the retired accents do not come back as declarations here (2026-09-25: #a83b4d is the one accent; the web oxblood #9b3b46 / #c04b58 / #722f37, its old accent-text tones #d4626e / #8d2c3e, and the violet and teal axes are gone)', () => {
    for (const hex of [
      '#9b3b46',
      '#c04b58',
      '#722f37',
      '#d4626e',
      '#8d2c3e',
      '#6d5efc',
      '#109a82',
    ]) {
      expect(body).not.toMatch(new RegExp(`--[a-z0-9-]+:\\s*${hex};`, 'i'));
    }
  });

  it('grid-bg framing pinned: dual linear-gradient grid pattern with radial mask (2026-09-25: lines a step fainter — 0.03 light / 0.045 dark — atmosphere at lower alpha behind the light theme)', () => {
    expect(body).toMatch(/\.grid-bg \{/);
    expect(body).toMatch(
      /linear-gradient\(to right, rgb\(var\(--ink-rgb\) \/ 0\.03\) 1px, transparent 1px\)/,
    );
    expect(body).toMatch(
      /linear-gradient\(to bottom, rgb\(var\(--ink-rgb\) \/ 0\.03\) 1px, transparent 1px\)/,
    );
    expect(body).toMatch(
      /\[data-mode='dark'\] \.grid-bg \{[\s\S]*?rgb\(var\(--ink-rgb\) \/ 0\.045\) 1px/,
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
    // 2026-09-25: the island's ink is a web extension (always the dark
    // theme's light ink — the island is dark in both modes).
    expect(body).toMatch(/color: var\(--code-ink\);/);
  });

  it("the one badge / link / code-block recipes (2026-09-25): .badge is the desktop app's status badge (rounded-full, border, the status hue as a /10 wash + /30 border + its AA-safe text tone), .accent-link keeps accent-text on hover (heavier underline, never the rose accent-2), .code-block puts a bare <pre> on the dark island", () => {
    expect(body).toMatch(
      /\.badge \{\s*\n\s*@apply inline-flex items-center gap-1\.5 whitespace-nowrap rounded-full border/,
    );
    expect(body).toMatch(
      /\.badge--ready \{\s*\n\s*@apply border-tk-ready\/30 bg-tk-ready\/10 text-tk-ready-text;/,
    );
    expect(body).toMatch(
      /\.badge--busy \{\s*\n\s*@apply border-tk-busy\/30 bg-tk-busy\/10 text-tk-busy-text;/,
    );
    expect(body).toMatch(
      /\.badge--err \{\s*\n\s*@apply border-tk-err\/30 bg-tk-err\/10 text-tk-err-text;/,
    );
    expect(body).toMatch(
      /\.badge--accent \{\s*\n\s*@apply border-tk-accent\/30 bg-tk-accent\/10 text-tk-accent-text;/,
    );
    expect(body).toMatch(
      /\.badge--neutral \{\s*\n\s*@apply border-tk-border bg-tk-inset text-tk-ink-2;/,
    );
    // The brand chip is a solid fill, so it never reads as the error wash.
    expect(body).toMatch(
      /\.badge--brand \{\s*\n\s*@apply border-tk-accent bg-tk-accent text-tk-accent-ink;/,
    );
    expect(body).toMatch(
      /\.accent-link \{\s*\n\s*@apply text-tk-accent-text underline decoration-1 underline-offset-4\s*\n\s*hover:decoration-2/,
    );
    expect(body).not.toMatch(/tk-accent-2/);
    expect(body).toMatch(
      /\.code-block \{[\s\S]*?background: var\(--code-bg\);\s*\n\s*color: var\(--code-ink\);/,
    );
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

  it('token layer (2026-09-25): the values come from @driftstack/design-tokens — this file declares only the web extensions (--glow per mode at 0.12 light / 0.14 dark, --code-bg = the dark-island token, and the island inks --code-ink / --code-label); the two-axis blocks of the 2026-06-12 rework (violet/oxblood/teal × #f2f3f6 / #060608) are gone', () => {
    const ext = body.slice(body.indexOf('/* ── Web extensions on top of the shared tokens'));
    expect(ext).toMatch(
      /\[data-mode='light'\] \{\s*\n\s*--glow: rgba\(168, 59, 77, 0\.12\);\s*\n\s*--code-bg: var\(--island\);/,
    );
    expect(ext).toMatch(
      /\[data-mode='dark'\] \{\s*\n\s*--glow: rgba\(168, 59, 77, 0\.14\);\s*\n\s*--code-bg: var\(--island\);/,
    );
    expect(ext).toMatch(/--code-ink: #cfd2dc;/);
    expect(ext).toMatch(/--code-label: #94a3b8;/);
    // Nothing else redeclares a token the package owns.
    for (const name of [
      '--bg',
      '--bg-rgb',
      '--surface',
      '--ink',
      '--ink-2',
      '--ink-3',
      '--border',
      '--accent',
      '--accent-rgb',
      '--accent-text',
      '--ready',
      '--err',
    ]) {
      expect(body).not.toMatch(new RegExp(`\\n\\s*${name}:`));
    }
    expect(body).not.toMatch(/\[data-accent='(?:violet|teal)'\]/);
    expect(body).not.toMatch(/#f2f3f6|#060608/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
