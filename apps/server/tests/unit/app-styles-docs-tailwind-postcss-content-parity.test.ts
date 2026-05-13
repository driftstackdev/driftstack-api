// W626 — drift guard for 6 small styling-side meta files:
//  - 3 base.css (admin-panel + customer-dashboard + docs).
//  - docs/tailwind.config.mjs (V-254 typography plugin + palette).
//  - gui-client/postcss.config.js (minimal pass-through).
//  - gui-client/src/styles/index.css (GUI dark-mode brand atoms).

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

  it('customer-dashboard src/styles/base.css (R2 dark refactor): dark color-scheme + surface-base bg + glass btn-primary with shadow-glow-red + form-input/form-label/banner-warn/auth-card + section-label [BRACKETED] mono + dashboard-card glass — tokens-shared-with-marketing-site framing pinned', () => {
    const body = read('apps/customer-dashboard/src/styles/base.css');
    expect(body).toMatch(/^@tailwind base;$/m);
    expect(body).toMatch(/^@tailwind components;$/m);
    expect(body).toMatch(/^@tailwind utilities;$/m);
    expect(body).toMatch(/Dark-mode-first dashboard surface\./);
    expect(body).toMatch(/Tokens shared with apps\/marketing-/);
    expect(body).toMatch(/color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-surface-base text-ink-primary;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;/);
    expect(body).toMatch(/@apply bg-oxblood-700 text-white;/);
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-oxblood-700/);
    expect(body).toMatch(/shadow-glow-red/);
    expect(body).toMatch(/hover:bg-oxblood-600/);
    expect(body).toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-white\/10/);
    expect(body).toMatch(/backdrop-blur-sm/);
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(
      /@apply text-sm text-ink-secondary transition-colors hover:text-glow-red;/,
    );
    expect(body).toMatch(/\.dashboard-card \{/);
    expect(body).toMatch(/rounded-xl border border-white\/10/);
    expect(body).toMatch(/\.form-input \{/);
    expect(body).toMatch(/\.form-label \{/);
    expect(body).toMatch(/\.form-helper \{/);
    expect(body).toMatch(/\.banner-info \{/);
    expect(body).toMatch(/\.banner-warn \{/);
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/font-mono text-xs uppercase/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\[ ';/);
    expect(body).toMatch(/\.auth-card \{/);
    expect(body).toMatch(/bg-surface-raised\/70 backdrop-blur-md/);
    expect(body).toMatch(/shadow-glow-red/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/styles/base.css'))).toBe(
      true,
    );
  });

  it('R11 docs/src/styles/base.css: Tailwind base + dark color-scheme + bg-surface-base graphite body + Geist+Berkeley font stack + 3 brand atoms (btn-primary + btn-secondary + nav-link). The earlier light-theme baseline (color-scheme: light + bg-slate-50) was migrated to dark so the docs read as one product with driftstack.dev rather than the prior context switch', () => {
    const body = read('apps/docs/src/styles/base.css');
    expect(body).toMatch(/^@tailwind base;$/m);
    expect(body).toMatch(/^@tailwind components;$/m);
    expect(body).toMatch(/^@tailwind utilities;$/m);
    expect(body).toMatch(/^@layer base \{$/m);
    expect(body).toMatch(/color-scheme: dark;/);
    expect(body).toMatch(/@apply bg-surface-base text-ink-primary;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;/);
    expect(body).toMatch(/@apply bg-oxblood-700 text-white;/);
    expect(body).toMatch(/^@layer components \{$/m);
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/\.nav-link \{/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/styles/base.css'))).toBe(true);
  });

  it('apps/docs/tailwind.config.mjs: V-254 typography plugin + sync default export + content {astro/html/js/jsx/md/mdx/ts/tsx} + locked oxblood palette (11-shade w/ #722F37 base at 700) + slate scale + Geist/Berkeley fontFamily + prose 65ch maxWidth + DocLayout.astro V-254 prose rationale pinned', () => {
    const body = read('apps/docs/tailwind.config.mjs');
    expect(body).toMatch(/^\/\/ V-254 — typography plugin imported at top-level so the config$/m);
    expect(body).toMatch(/itself stays synchronous \(Tailwind's config loader expects a sync/);
    expect(body).toMatch(/default export\)\./);
    expect(body).toMatch(/^import typography from '@tailwindcss\/typography';$/m);
    expect(body).toMatch(/^\/\*\* @type \{import\('tailwindcss'\)\.Config\} \*\/$/m);
    expect(body).toMatch(/content: \['\.\/src\/\*\*\/\*\.\{astro,html,js,jsx,md,mdx,ts,tsx\}'\],/);
    expect(body).toMatch(/\/\/ Oxblood — locked accent per founder direction \(#722F37\)\./);
    expect(body).toMatch(/oxblood: \{/);
    expect(body).toMatch(/50: '#fbf3f4',/);
    expect(body).toMatch(/100: '#f5e1e3',/);
    expect(body).toMatch(/200: '#ebbfc4',/);
    expect(body).toMatch(/300: '#dc939c',/);
    expect(body).toMatch(/400: '#c8606e',/);
    expect(body).toMatch(/500: '#a83b4d',/);
    expect(body).toMatch(/600: '#8d2c3e',/);
    expect(body).toMatch(/700: '#722F37', \/\/ base — primary accent, locked/);
    expect(body).toMatch(/800: '#5e2730',/);
    expect(body).toMatch(/900: '#4f242b',/);
    expect(body).toMatch(/950: '#2b0f15',/);
    expect(body).toMatch(/\/\/ Slate base — body text \+ surfaces\./);
    expect(body).toMatch(/slate: \{/);
    expect(body).toMatch(/50: '#f8fafc',/);
    expect(body).toMatch(/950: '#020617',/);
    expect(body).toMatch(/sans: \['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'\],/);
    expect(body).toMatch(
      /mono: \['Berkeley Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'\],/,
    );
    expect(body).toMatch(/prose: '65ch',/);
    expect(body).toMatch(/\/\/ V-254 — typography plugin enables `prose` classes for markdown/);
    expect(body).toMatch(/\/\/ content rendering in DocLayout\.astro\./);
    expect(body).toMatch(/plugins: \[typography\],/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/tailwind.config.mjs'))).toBe(true);
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
});
