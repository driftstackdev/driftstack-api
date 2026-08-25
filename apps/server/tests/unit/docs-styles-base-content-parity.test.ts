// Drift guard for apps/docs/src/styles/base.css.
//
// S22.1 (2026-07-06, brand-parity port) — SUPERSEDES the R11 static
// light+violet pins: docs now ships the Fleet two-axis tk-* token system
// (dark+oxblood default, light toggle, S20 dark surface ladder) with
// values byte-identical to apps/marketing-site/src/styles/base.css,
// adapted to Tailwind v4 CSS-first (@theme inline tk namespace). Pins
// the token values + the F-1 mobile-scroll prevention + the 3 utility
// atoms + the self-hosted fonts + the tk-driven prose hooks.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/styles/base.css');
const MARKETING = resolve(REPO_ROOT, 'apps/marketing-site/src/styles/base.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs styles/base content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Tailwind v4 @import + typography @plugin header pinned (W368 — replaces the v3 3-directive header)', () => {
    expect(body).toMatch(/@import 'tailwindcss';/);
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
  });

  it('S22.1 dark: variant follows the data-mode axis (was the scaffold .dark class, which nothing set) — the theme-toggle icons (hidden dark:block) depend on it', () => {
    expect(body).toMatch(
      /@custom-variant dark \(&:where\(\[data-mode='dark'\], \[data-mode='dark'\] \*\)\);/,
    );
    expect(body).not.toMatch(/&:is\(\.dark \*\)/);
  });

  it('S22.1 two-axis posture pinned: dark+oxblood default synced with marketing/dashboard Fleet tokens, color-scheme follows the mode axis. Drift back to a static single-mode palette would break cross-app brand consistency', () => {
    expect(body).toMatch(/Fleet two-axis tk-\* token port/);
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-tk-bg text-tk-ink;/);
  });

  it('S22.1 @theme inline tk namespace pinned (Tailwind v4 CSS-first adaptation of the marketing v3 JS-config tk table): every tk color token resolves to a mode-scoped custom property', () => {
    expect(body).toMatch(/@theme inline \{/);
    expect(body).toMatch(/--color-tk-bg: var\(--bg\);/);
    expect(body).toMatch(/--color-tk-surface: var\(--surface\);/);
    expect(body).toMatch(/--color-tk-raised: var\(--raised\);/);
    expect(body).toMatch(/--color-tk-hover: var\(--hover\);/);
    expect(body).toMatch(/--color-tk-ink: var\(--ink\);/);
    expect(body).toMatch(/--color-tk-ink-2: var\(--ink-2\);/);
    expect(body).toMatch(/--color-tk-ink-3: var\(--ink-3\);/);
    expect(body).toMatch(/--color-tk-border: var\(--border\);/);
    expect(body).toMatch(/--color-tk-accent: var\(--accent\);/);
    expect(body).toMatch(/--color-tk-accent-strong: var\(--accent-strong\);/);
    expect(body).toMatch(/--color-tk-accent-soft: var\(--accent-soft\);/);
    expect(body).toMatch(/--color-tk-accent-text: var\(--accent-text\);/);
  });

  it('S20 dark surface ladder pinned BYTE-IDENTICAL to marketing (bg #060608 / surface #14141a / raised #1c1c24 / hover #24252f / border #2c2c38 + rgb triplets + ink ladder + AA ink-3 unification note — S21 unified #8c8c96 across all three apps). Drift would fork the brand dark theme across apps', () => {
    expect(body).toMatch(/--bg: #060608;/);
    expect(body).toMatch(/--surface: #14141a;/);
    expect(body).toMatch(/--raised: #1c1c24;/);
    expect(body).toMatch(/--hover: #24252f;/);
    expect(body).toMatch(/--border: #2c2c38;/);
    expect(body).toMatch(/--ink: #f5f5f7;/);
    expect(body).toMatch(/--ink-2: #b0b0bb;/);
    expect(body).toMatch(/--ink-3: #8c8c96;/);
    expect(body).toMatch(/--bg-rgb: 6 6 8;/);
    expect(body).toMatch(/--surface-rgb: 20 20 26;/);
    expect(body).toMatch(/--raised-rgb: 28 28 36;/);
    expect(body).toMatch(/--border-rgb: 44 44 56;/);
    expect(body).toMatch(/surface 1\.10:1 \/ raised 1\.20:1 vs bg \/ border 1\.47:1/);
    expect(body).toMatch(/#8c8c96 clears WCAG AA on #060608/);
  });

  it('light-mode block pinned BYTE-IDENTICAL to marketing (bg #f2f3f6 / surface #fff / ink #0f1014 / border #e4e6ec) — the light toggle target. S23 2026-07-06: light ink-3 darkened #8a8d99→#6a6d7a for AA (old value was 2.98:1 on #f2f3f6, below the 4.5:1 small-text floor; #6a6d7a = 4.64/5.15/4.60 on bg/surface/hover)', () => {
    expect(body).toMatch(/--bg: #f2f3f6;/);
    expect(body).toMatch(/--ink: #0f1014;/);
    expect(body).toMatch(/--ink-2: #474a55;/);
    expect(body).toMatch(/--ink-3: #6a6d7a;/);
    expect(body).toMatch(/--ink-3-rgb: 106 109 122;/);
    expect(body).not.toMatch(/--ink-3: #8a8d99/);
    expect(body).toMatch(/--border: #e4e6ec;/);
    expect(body).toMatch(/--bg-rgb: 242 243 246;/);
  });

  it('3 accent axes pinned (oxblood is the shipped default; violet/teal stay selectable machinery): raw accent + accent-soft wash + glow per axis', () => {
    expect(body).toMatch(/\[data-accent='oxblood'\] \{/);
    expect(body).toMatch(/--accent: #9b3b46;/);
    expect(body).toMatch(/--accent-strong: #722f37;/);
    expect(body).toMatch(/--accent-soft: rgba\(155, 59, 70, 0\.13\);/);
    expect(body).toMatch(/--glow: rgba\(155, 59, 70, 0\.32\);/);
    expect(body).toMatch(/\[data-accent='violet'\] \{/);
    expect(body).toMatch(/--accent: #6d5efc;/);
    expect(body).toMatch(/\[data-accent='teal'\] \{/);
    expect(body).toMatch(/--accent: #109a82;/);
  });

  it('all 6 AA-safe --accent-text mode × accent pairs pinned (raw accent ≈3.0:1 on the dark bg fails AA as text; these are the readable tones, all ≥4.5:1 verified). Accent-colored TEXT must consume tk-accent-text, never the raw accent', () => {
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
    expect(body).toMatch(/The accent-soft wash is a BACKGROUND token only — never text\./);
  });

  it('S20 mode-aware ambient shadows pinned: light = the original gray ambients; dark = lit-top-rim + true-black drop (gray shadows measured a 1.0000:1 no-op on near-black). Exposed as @utility shadow-ambient/-lg reading the mode-scoped vars', () => {
    expect(body).toMatch(
      /--shadow-ambient: 0 1px 2px rgb\(15 16 20 \/ 0\.04\), 0 10px 28px -18px rgb\(15 16 20 \/ 0\.12\);/,
    );
    expect(body).toMatch(
      /--shadow-ambient: inset 0 1px 0 rgb\(255 255 255 \/ 0\.05\), 0 10px 28px -18px rgb\(0 0 0 \/ 0\.7\);/,
    );
    expect(body).toMatch(/@utility shadow-ambient \{\s*\n\s*box-shadow: var\(--shadow-ambient\);/);
    expect(body).toMatch(
      /@utility shadow-ambient-lg \{\s*\n\s*box-shadow: var\(--shadow-ambient-lg\);/,
    );
  });

  it('S22.1 self-hosted fonts pinned: Geist VF + JetBrains Mono Regular/Bold @font-face at public/fonts/ (OFL, license files ship alongside); Berkeley Mono first in the mono stack but NEVER vendored (commercial). Sans stack Geist-first', () => {
    expect(body).toMatch(/url\('\/fonts\/geist\/GeistVF\.woff2'\) format\('woff2'\)/);
    expect(body).toMatch(
      /url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2'\) format\('woff2'\)/,
    );
    expect(body).toMatch(
      /url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Bold\.woff2'\) format\('woff2'\)/,
    );
    expect(body).toMatch(/font-display: swap;/);
    expect(body).toMatch(/NEVER vendored/);
    expect(body).toMatch(/--font-sans: Geist, ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(
      /--font-mono: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
    expect(body).toMatch(
      /font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
  });

  it('F-1 code-overflow containment pinned: base.css keeps code/pre from pushing the page width (overflow-wrap:anywhere + pre overflow-x:auto) — the iPhone-Safari horizontal-scroll guard', () => {
    expect(body).toMatch(/code blocks scroll internally rather than pushing page/);
    expect(body).toMatch(/long unbreakable strings wrap or scroll internally/);
    expect(body).toMatch(/overflow-wrap: anywhere;/);
    expect(body).toMatch(/word-break: break-word;/);
  });

  it('F-1 iPhone-Safari horizontal-scroll prevention pinned: overflow-x:clip + max-width:100vw. Drift to overflow:hidden would break sticky positioning on docs pages', () => {
    expect(body).toMatch(/F-1 — prevent iPhone Safari horizontal scroll/);
    expect(body).toMatch(/overflow-x: clip;/);
    expect(body).toMatch(/max-width: 100vw;/);
  });

  it('S22.1 accent-axis body wash pinned (replaces the static red rgba radial): two ambient radials reading var(--glow) + var(--accent-soft), background-attachment fixed. Any reintroduced baked-red rgba(226,56,71) would fork the brand', () => {
    expect(body).toMatch(
      /radial-gradient\(ellipse 90% 60% at 50% -10%, var\(--glow\), transparent 70%\)/,
    );
    expect(body).toMatch(
      /radial-gradient\(ellipse 80% 50% at 50% 100%, var\(--accent-soft\), transparent 75%\)/,
    );
    expect(body).toMatch(/background-attachment: fixed;/);
    expect(body).not.toMatch(/226, 56, 71/);
  });

  it('3 utility atoms pinned: btn-primary (flat accent, ambient shadow, NO glow ring / NO hover lift — Fleet v2 accent discipline) + btn-secondary (solid surface) + nav-link (hover = AA-safe tk-accent-text)', () => {
    expect(body).toMatch(/@utility btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent/);
    expect(body).toMatch(/hover:bg-tk-accent-strong/);
    expect(body).toMatch(/@utility btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border bg-tk-surface/);
    expect(body).toMatch(/@utility nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent-text;/,
    );
    // Fleet v2 accent discipline: the R11 glow ring + hover lift are gone.
    expect(body).not.toMatch(/shadow-glow-red/);
    expect(body).not.toMatch(/hover:-translate-y-0\.5/);
  });

  it('S22.1 tk-driven prose hooks pinned: un-layered .prose --tw-prose-* overrides read the mode-scoped tokens (single class set, no prose-invert flip); links = --accent-text; fenced pre bg = var(--code-bg) so code stays a DARK terminal in BOTH modes (founder-pinned)', () => {
    expect(body).toMatch(/\.prose \{/);
    expect(body).toMatch(/--tw-prose-body: var\(--ink-2\);/);
    expect(body).toMatch(/--tw-prose-headings: var\(--ink\);/);
    expect(body).toMatch(/--tw-prose-links: var\(--accent-text\);/);
    expect(body).toMatch(/--tw-prose-pre-bg: var\(--code-bg\);/);
    expect(body).toMatch(/--tw-prose-th-borders: var\(--border\);/);
    expect(body).toMatch(/--code-bg: #16171c;/);
    expect(body).toMatch(/--code-bg: #0c0c11;/);
    expect(body).toMatch(/fenced code stays a DARK terminal in\s*BOTH modes/);
  });

  it('S22.2 (2026-07-06, Stoplight relayout) — blockquote info-callout pinned: raised surface + rounded right edge + normal weight at the prose level (accent-2 left rule comes from the --tw-prose-quote-borders hook), and the typography plugin auto quote marks removed — ZERO .md edits, every markdown `>` note renders as a callout', () => {
    expect(body).toMatch(/S22\.2 \(2026-07-06, Stoplight relayout\) — blockquote = info callout/);
    expect(body).toMatch(
      /\.prose blockquote \{\s*\n\s*background: var\(--raised\);\s*\n\s*border-top-right-radius: 0\.5rem;\s*\n\s*border-bottom-right-radius: 0\.5rem;\s*\n\s*padding: 0\.75rem 1\.25rem;\s*\n\s*font-weight: 400;\s*\n\}/,
    );
    expect(body).toMatch(
      /\.prose blockquote p:first-of-type::before,\s*\n\s*\.prose blockquote p:last-of-type::after \{\s*\n\s*content: none;\s*\n\}/,
    );
    // the accent-2 quote-border hook the callout rule leans on.
    expect(body).toMatch(/--tw-prose-quote-borders: var\(--accent-2\);/);
  });

  it('S22.4 (2026-07-06, Stoplight reference furniture) — .method-chip recipes pinned: tiny mono uppercase badges; wash = 15%-alpha rgb() of the mode status token (NOT color-mix — its Lightning-CSS fallback degrades to a solid same-color background on pre-color-mix browsers); text = readable direction per mode, all pairs AA-verified ≥4.5:1 over BOTH --bg and --hover composites. S24 2026-07-06: the chip precedent got promoted to the shared --ready-text/--busy-text/--err-text tokens, so GET/PUT/PATCH/DELETE consume the tokens and flip per mode with NO light overrides (light tones moved to the shared values #097245/#845a09/#ad3229, re-verified over the washes). POST stays hardcoded per mode (no --sync-text token; sync is docs-chip-only, and no --sync-rgb exists because the mode blocks stay byte-identical to marketing)', () => {
    expect(body).toMatch(
      /S22\.4 \(2026-07-06, Stoplight reference furniture\) — HTTP method chips/,
    );
    expect(body).toMatch(
      /\.method-chip \{\s*\n\s*display: inline-block;\s*\n\s*flex-shrink: 0;\s*\n\s*min-width: 2\.75rem;/,
    );
    expect(body).toMatch(/font-size: 0\.625rem;/);
    expect(body).toMatch(/text-transform: uppercase;/);
    // S24 — status-text tokens carry the text tone; washes stay rgb()/alpha.
    expect(body).toMatch(
      /\.method-chip--get \{\s*\n\s*color: var\(--ready-text\);\s*\n\s*background: rgb\(var\(--ready-rgb\) \/ 0\.15\);/,
    );
    expect(body).toMatch(
      /\.method-chip--post \{\s*\n\s*color: var\(--sync\);\s*\n\s*background: rgb\(96 165 250 \/ 0\.15\);/,
    );
    expect(body).toMatch(
      /\.method-chip--put,\s*\n\s*\.method-chip--patch \{\s*\n\s*color: var\(--busy-text\);\s*\n\s*background: rgb\(var\(--busy-rgb\) \/ 0\.15\);/,
    );
    // DELETE rides --err-text (raw #ff6b61 is 4.35:1 over a hovered row —
    // the S22.4 finding that seeded the token).
    expect(body).toMatch(
      /\.method-chip--delete \{\s*\n\s*color: var\(--err-text\);\s*\n\s*background: rgb\(var\(--err-rgb\) \/ 0\.15\);/,
    );
    // POST keeps its per-mode hardcoded pair (wash triplet + text tone);
    // the GET/PUT/PATCH/DELETE light overrides are GONE (tokens flip).
    expect(body).toMatch(/\[data-mode='light'\] \.method-chip--post \{\s*\n\s*color: #1d4ed8;/);
    expect(body).toMatch(
      /\[data-mode='light'\] \.method-chip--post \{\s*\n\s*background: rgb\(37 99 235 \/ 0\.15\);/,
    );
    expect(body).not.toMatch(/\[data-mode='light'\] \.method-chip--get/);
    expect(body).not.toMatch(/\[data-mode='light'\] \.method-chip--delete/);
    expect(body).not.toMatch(/color: #06663d;/);
    // The AA evidence table ships in the comment (S24 values).
    expect(body).toMatch(/dark : GET var\(--ready-text\) #2fe39a 9\.49\/6\.50/);
    expect(body).toMatch(/light: GET #097245 4\.58\/4\.54/);
    expect(body).toMatch(/DELETE var\(--err-text\) #ff7d74 6\.91\/4\.88/);
    // color-mix must not come back for the chip washes.
    expect(body).not.toMatch(/color-mix\([^)]*--ready/);
  });

  it('cross-app token-value parity: every dark/light ladder hex + all 6 accent-text pairs + all 6 S24 status-text pairs in the docs file also appear in the marketing source of truth (S22.1 byte-identical port)', () => {
    const marketing = read(MARKETING);
    for (const token of [
      '--bg: #060608;',
      '--surface: #14141a;',
      '--raised: #1c1c24;',
      '--hover: #24252f;',
      '--border: #2c2c38;',
      '--ink: #f5f5f7;',
      '--ink-2: #b0b0bb;',
      '--ink-3: #8c8c96;',
      // S23 2026-07-06 — AA light ink-3, unified same-commit in all three apps.
      '--ink-3: #6a6d7a;',
      '--ink-3-rgb: 106 109 122;',
      '--bg: #f2f3f6;',
      '--accent: #9b3b46;',
      '--accent-text: #d4626e;',
      '--accent-text: #8d2c3e;',
      '--accent-text: #8b7dff;',
      '--accent-text: #5847e0;',
      '--accent-text: #1bc7a8;',
      '--accent-text: #0c7d69;',
      // S24 2026-07-06 — AA status-text pairs (light needs darker-than-token
      // tones; dark reuses ready/busy and lifts err to the S22.4 DELETE
      // value), unified same-commit in all three apps.
      '--ready-text: #097245;',
      '--busy-text: #845a09;',
      '--err-text: #ad3229;',
      '--ready-text: #2fe39a;',
      '--busy-text: #ffc24d;',
      '--err-text: #ff7d74;',
      '--code-bg: #16171c;',
      '--code-bg: #0c0c11;',
    ]) {
      expect(body).toContain(token);
      expect(marketing).toContain(token);
    }
  });

  it('S24 (2026-07-06) — AA-safe status-toned TEXT tokens pinned: --ready-text/--busy-text/--err-text per data-mode block (raw ready/busy/err are FILL tones — light err #d8453c is 3.91:1 on --bg, ready 3.27:1, busy 2.66:1 as small text; dark err #ff6b61 is 4.35:1 over its 15% wash on hover) + the @theme inline tk mapping so text-tk-*-text utilities exist. Status-colored TEXT consumes the *-text pair; dots/fills/washes/borders keep the raw tokens', () => {
    expect(body).toMatch(
      /--ready-text: #097245;\s*\n\s*--busy-text: #845a09;\s*\n\s*--err-text: #ad3229;/,
    );
    expect(body).toMatch(
      /--ready-text: #2fe39a;\s*\n\s*--busy-text: #ffc24d;\s*\n\s*--err-text: #ff7d74;/,
    );
    expect(body).toMatch(/--color-tk-ready-text: var\(--ready-text\);/);
    expect(body).toMatch(/--color-tk-busy-text: var\(--busy-text\);/);
    expect(body).toMatch(/--color-tk-err-text: var\(--err-text\);/);
  });
});
