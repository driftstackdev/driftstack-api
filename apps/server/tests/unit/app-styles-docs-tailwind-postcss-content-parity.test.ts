// W626 — drift guard for 5 small styling-side meta files:
//  - 3 base.css (admin-panel + customer-dashboard + docs).
//  - gui-client/postcss.config.js (minimal pass-through).
//  - gui-client/src/styles/index.css (GUI dark-mode brand atoms).
//
// V-1180 — this said SIX, and listed `docs/tailwind.config.mjs (V-254 typography plugin +
// palette)` as one of them. Commit 337e07519 migrated the docs site to Astro 6 + Tailwind v4,
// which is CSS-first: the JS config file was deleted, and the typography plugin and palette
// now live in `apps/docs/src/styles/base.css` as `@import 'tailwindcss'` +
// `@plugin '@tailwindcss/typography'` — both of which the base.css arms below already pin.
//
// No assertion in this file ever read a tailwind config, so nothing failed when it went away.
// The header simply kept claiming coverage of a file that had stopped existing, which is the
// worse outcome: someone auditing what is guarded reads the list, not the assertions. The last
// arm now derives the guarded set from the file itself, so the count and the list cannot drift
// apart again.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('W626 app styles + docs tailwind + postcss content parity', () => {
  it('admin-panel src/styles/base.css: 3-layer Tailwind base + light color-scheme + Geist+Berkeley font stacks + 4 brand atoms (btn-primary oxblood-700 + btn-secondary white + nav-link + dashboard-card) — admin-panel still on the legacy light theme pinned', () => {
    const body = read('apps/admin-panel/src/styles/base.css');
    expect(body).toMatch(/^@tailwind base;$/m);
    expect(body).toMatch(/^@tailwind components;$/m);
    expect(body).toMatch(/^@tailwind utilities;$/m);
    expect(body).toMatch(/^@layer base \{$/m);
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/@apply bg-slate-50 text-slate-900;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;/);
    expect(body).toMatch(/@apply bg-oxblood-700 text-white;/);
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(
      /@apply inline-flex items-center justify-center rounded-md bg-oxblood-700/,
    );
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-slate-300 bg-white/);
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(/@apply text-sm text-slate-600 transition-colors hover:text-oxblood-700;/);
    expect(body).toMatch(/\.dashboard-card \{/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/styles/base.css'))).toBe(true);
  });

  it('customer-dashboard src/styles/base.css (Fleet v2, 2026-07-02 redesign): mode-axis color-scheme + tk token bg + FLAT btn-primary on accent tokens (no glow ring / no hover lift — accent discipline) + solid btn-secondary/dashboard-card/auth-card (glass + glow-on-everything retired; shadow-ambient replaces shadow-glow-accent on default chrome) + form-input/form-label/banner-warn + section-label mono + self-hosted Geist/JetBrains-Mono font faces — tokens-shared-with-marketing-site framing pinned', () => {
    const body = read('apps/customer-dashboard/src/styles/base.css');
    expect(body).toMatch(/^@tailwind base;$/m);
    expect(body).toMatch(/^@tailwind components;$/m);
    expect(body).toMatch(/^@tailwind utilities;$/m);
    expect(body).toMatch(
      /Fleet two-axis dashboard surface \(light\+violet default, 2026-06-12 rework\)\./,
    );
    expect(body).toMatch(/Tokens shared with apps\/marketing-/);
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-tk-bg text-tk-ink;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(
      /font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
    expect(body).toMatch(/@apply bg-tk-accent text-white;/);
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent/);
    expect(body).toMatch(/shadow-ambient/);
    expect(body).toMatch(/hover:bg-tk-accent-strong/);
    // Fleet v2 accent discipline: glow ring + hover lift are GONE from
    // default button/card chrome (glow-accent is reserved for hot elements).
    expect(body).not.toMatch(/shadow-glow-accent/);
    expect(body).not.toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border/);
    expect(body).toMatch(/\.btn-ghost \{/);
    expect(body).toMatch(/\.btn-danger \{/);
    expect(body).toMatch(/\.nav-link \{/);
    // S23 2026-07-06 — dashboard nav-link hover re-pinned to the AA-safe
    // tk-accent-text tone (raw --accent is ~3.0:1 on the dark bg), matching
    // the marketing recipe below.
    expect(body).toMatch(
      /@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent-text;/,
    );
    expect(body).toMatch(/\.dashboard-card \{/);
    expect(body).toMatch(/rounded-card border border-tk-border bg-tk-surface p-6 shadow-ambient/);
    expect(body).toMatch(/\.form-input \{/);
    expect(body).toMatch(/\.form-label \{/);
    expect(body).toMatch(/\.form-helper \{/);
    expect(body).toMatch(/\.banner-info \{/);
    expect(body).toMatch(/\.banner-warn \{/);
    expect(body).toMatch(/\.banner-err \{/);
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/font-mono text-xs uppercase/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\/\/ ';/);
    expect(body).toMatch(/\.auth-card \{/);
    expect(body).toMatch(/bg-tk-surface shadow-ambient-lg/);
    // Self-hosted fonts (OFL): Geist variable + JetBrains Mono, vendored
    // under public/fonts/ — Berkeley Mono is licensed and never vendored.
    expect(body).toMatch(/url\('\/fonts\/geist\/GeistVF\.woff2'\)/);
    expect(body).toMatch(/url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2'\)/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/styles/base.css'))).toBe(
      true,
    );
  });

  it('S22.1 docs/src/styles/base.css (2026-07-06 brand-parity port — supersedes the R11 light+violet pins): Tailwind v4 @import + mode-axis color-scheme + tk token bg + Geist/JetBrains-Mono self-hosted fonts + 3 utility atoms (btn-primary flat accent + btn-secondary solid + nav-link accent-text hover) so the docs read as one product with driftstack.dev (dark+oxblood default, light toggle)', () => {
    const body = read('apps/docs/src/styles/base.css');
    // W368 — Tailwind v4: @import + typography @plugin (was the 3-directive header);
    // component atoms are @utility (was @layer components).
    expect(body).toMatch(/@import 'tailwindcss';/);
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
    expect(body).toMatch(/^@layer base \{$/m);
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/\[data-mode='dark'\] \{\s*\n\s*color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-tk-bg text-tk-ink;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(
      /font-family: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
    expect(body).toMatch(/@utility btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent/);
    expect(body).toMatch(/hover:bg-tk-accent-strong/);
    expect(body).toMatch(/@utility btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border/);
    expect(body).toMatch(/@utility nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent-text;/,
    );
    // Fleet v2 accent discipline: no glow ring / hover lift on default chrome.
    expect(body).not.toMatch(/shadow-glow-red/);
    expect(body).not.toMatch(/hover:-translate-y-0\.5/);
    // Self-hosted fonts (OFL): Geist variable + JetBrains Mono, vendored
    // under public/fonts/ — Berkeley Mono is licensed and never vendored.
    expect(body).toMatch(/url\('\/fonts\/geist\/GeistVF\.woff2'\)/);
    expect(body).toMatch(/url\('\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2'\)/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/styles/base.css'))).toBe(true);
  });

  it('apps/docs/src/styles/base.css @theme (S22.1 — the W368 legacy palette ramps are RETIRED: the violet-valued oxblood ladder + baked slate scale are gone; the Tailwind v4 CSS-first adaptation now maps the Fleet two-axis custom properties into the tk namespace via @theme inline, values byte-identical to marketing). Geist/Berkeley+JetBrains font vars + prose 65ch container + 14px card radius pinned', () => {
    const body = read('apps/docs/src/styles/base.css');
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
    // Legacy single-axis ramps are gone (tk-* replaces them).
    expect(body).not.toMatch(/--color-oxblood-/);
    expect(body).not.toMatch(/--color-glow-red/);
    expect(body).not.toMatch(/--color-surface-base/);
    expect(body).not.toMatch(/--color-ink-primary/);
    // tk namespace maps to the mode-scoped two-axis custom properties.
    expect(body).toMatch(/@theme inline \{/);
    expect(body).toMatch(/--color-tk-bg: var\(--bg\);/);
    expect(body).toMatch(/--color-tk-ink: var\(--ink\);/);
    expect(body).toMatch(/--color-tk-accent-text: var\(--accent-text\);/);
    expect(body).toMatch(/--font-sans: Geist, ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(
      /--font-mono: 'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;/,
    );
    expect(body).toMatch(/--container-prose: 65ch;/);
    expect(body).toMatch(/--radius-card: 14px;/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/styles/base.css'))).toBe(true);
  });

  it('apps/gui-client/postcss.config.js: minimal pass-through (tailwindcss + autoprefixer plugins) pinned', () => {
    const body = read('apps/gui-client/postcss.config.js');
    expect(body).toMatch(/^export default \{$/m);
    expect(body).toMatch(/^\s+plugins: \{$/m);
    expect(body).toMatch(/^\s+tailwindcss: \{\},$/m);
    expect(body).toMatch(/^\s+autoprefixer: \{\},$/m);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/postcss.config.js'))).toBe(true);
  });

  it('apps/gui-client/src/styles/index.css: GUI dark-mode brand atoms + color-scheme:dark + no-default-focus-ring (use accent-ring) + selection theme(accent.subtle/ink.primary) + Tauri WebKit text-size-adjust opt-out + 5 brand atoms (btn-primary single-primary-per-screen + btn-secondary + btn-danger status-error/15 + .mono Berkeley + status-pip 1.5×1.5 + section-label 2xs uppercase + form-input surface-inset) pinned', () => {
    const body = read('apps/gui-client/src/styles/index.css');
    expect(body).toMatch(/^@tailwind base;$/m);
    expect(body).toMatch(/^@tailwind components;$/m);
    expect(body).toMatch(/^@tailwind utilities;$/m);
    expect(body).toMatch(/^@layer base \{$/m);
    expect(body).toMatch(/color-scheme: dark;/);
    expect(body).toMatch(/\/\* Stop the default browser focus ring; we use the accent ring$/m);
    expect(body).toMatch(/defined in tailwind\.config\.ts instead\. \*\//);
    expect(body).toMatch(/:focus \{/);
    expect(body).toMatch(/outline: none;/);
    expect(body).toMatch(/background: theme\('colors\.accent\.subtle'\);/);
    expect(body).toMatch(/color: theme\('colors\.ink\.primary'\);/);
    expect(body).toMatch(/\/\* Disable text-size adjustment on macOS \/ iOS rendering surfaces$/m);
    expect(body).toMatch(/\(Tauri uses WebKit\)\. Keeps the dense layout dense\. \*\//);
    expect(body).toMatch(/-webkit-text-size-adjust: 100%;/);
    expect(body).toMatch(/text-size-adjust: 100%;/);
    expect(body).toMatch(/Primary action button — oxblood accent, the only saturated color/);
    expect(body).toMatch(/Multiple primary buttons on one screen is a design smell\. \*\//);
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-accent text-ink-inverted/);
    expect(body).toMatch(/hover:bg-accent-hover active:bg-accent-active/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/bg-surface-elevated text-ink-primary/);
    expect(body).toMatch(/\.btn-danger \{/);
    expect(body).toMatch(/bg-status-error\/15 text-status-error/);
    expect(body).toMatch(/\/\* Mono-text: session ids, IPs, command output\. Berkeley Mono\. \*\//);
    expect(body).toMatch(/\.mono \{/);
    expect(body).toMatch(/@apply font-mono text-\[0\.8125rem\] tracking-tight;/);
    expect(body).toMatch(
      /\/\* Status pip: the colored dot next to a session's status label\. \*\//,
    );
    expect(body).toMatch(/\.status-pip \{/);
    expect(body).toMatch(/@apply inline-block w-1\.5 h-1\.5 rounded-full;/);
    expect(body).toMatch(/\/\* Section label: caps \+ tracking, used over panel groups\. \*\//);
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/@apply text-2xs font-medium tracking-widest uppercase/);
    expect(body).toMatch(/\.form-input \{/);
    expect(body).toMatch(/@apply w-full rounded bg-surface-inset px-2\.5 py-1\.5 text-sm/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/src/styles/index.css'))).toBe(true);
  });

  // V-1180 — the header used to list a sixth file that had been deleted, and nothing noticed
  // because no assertion read it. This derives the guarded set out of THIS FILE rather than
  // restating it, so the header's count and the assertions cannot drift apart again: adding a
  // file to the guard without listing it, or listing one without guarding it, fails here.
  it('CRITICAL the set of files this guard actually reads is the set its header claims. A header is what an auditor reads to learn what is covered; the assertions are what covers it. When those two disagree the header wins the audit and loses the drift, which is how a deleted tailwind config stayed on the list.', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const guarded = [
      ...new Set([...self.matchAll(/resolve\(REPO_ROOT, '([^']+)'\)/g)].map((m) => m[1] ?? '')),
    ].sort();

    expect(guarded, 'the guarded-file set changed — update the header list and count').toEqual([
      'apps/admin-panel/src/styles/base.css',
      'apps/customer-dashboard/src/styles/base.css',
      'apps/docs/src/styles/base.css',
      'apps/gui-client/postcss.config.js',
      'apps/gui-client/src/styles/index.css',
    ]);

    // Every guarded file is real, and the header's count matches the set.
    for (const rel of guarded) {
      expect(existsSync(resolve(REPO_ROOT, rel)), `${rel} is guarded but does not exist`).toBe(
        true,
      );
    }
    expect(self, 'the header count no longer matches the guarded set').toMatch(
      new RegExp(`drift guard for ${guarded.length} small styling-side meta files`),
    );
    // The deleted config must not creep back into the header without coming back to disk.
    expect(self, 'the deleted docs tailwind config is being listed as guarded again').not.toMatch(
      /^\/\/ {2}- docs\/tailwind\.config\.mjs/m,
    );
  });
});
