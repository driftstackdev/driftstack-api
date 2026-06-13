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

  it('customer-dashboard src/styles/base.css (Fleet rework): mode-axis color-scheme + tk token bg + btn-primary on accent tokens + form-input/form-label/banner-warn/auth-card + section-label mono + dashboard-card glass — tokens-shared-with-marketing-site framing pinned', () => {
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
    expect(body).toMatch(/font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;/);
    expect(body).toMatch(/@apply bg-tk-accent text-white;/);
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/bg-tk-accent/);
    expect(body).toMatch(/shadow-glow-accent/);
    expect(body).toMatch(/hover:bg-tk-accent-strong/);
    expect(body).toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/border border-tk-border/);
    expect(body).toMatch(/backdrop-blur-sm/);
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(/@apply text-sm text-tk-ink-2 transition-colors hover:text-tk-accent;/);
    expect(body).toMatch(/\.dashboard-card \{/);
    expect(body).toMatch(/rounded-xl border border-tk-border/);
    expect(body).toMatch(/\.form-input \{/);
    expect(body).toMatch(/\.form-label \{/);
    expect(body).toMatch(/\.form-helper \{/);
    expect(body).toMatch(/\.banner-info \{/);
    expect(body).toMatch(/\.banner-warn \{/);
    expect(body).toMatch(/\.section-label \{/);
    expect(body).toMatch(/font-mono text-xs uppercase/);
    expect(body).toMatch(/\.section-label::before \{/);
    expect(body).toMatch(/content: '\/\/ ';/);
    expect(body).toMatch(/\.auth-card \{/);
    expect(body).toMatch(/bg-tk-surface\/70 backdrop-blur-md/);
    expect(body).toMatch(/shadow-glow-accent/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/styles/base.css'))).toBe(
      true,
    );
  });

  it('R11 docs/src/styles/base.css: Tailwind base + light color-scheme + bg-surface-base light body + Geist+Berkeley font stack + 3 brand atoms (btn-primary + btn-secondary + nav-link). Flipped to the Fleet light+violet palette (color-scheme: light) so the docs read as one product with driftstack.dev', () => {
    const body = read('apps/docs/src/styles/base.css');
    // W368 — Tailwind v4: @import + typography @plugin (was the 3-directive header);
    // component atoms are now @utility (was @layer components).
    expect(body).toMatch(/@import 'tailwindcss';/);
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
    expect(body).toMatch(/^@layer base \{$/m);
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/@apply bg-surface-base text-ink-primary;/);
    expect(body).toMatch(/font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/font-family: 'Berkeley Mono', ui-monospace, SFMono-Regular, monospace;/);
    expect(body).toMatch(/@apply bg-oxblood-700 text-white;/);
    expect(body).toMatch(/@utility btn-primary \{/);
    expect(body).toMatch(/@utility btn-secondary \{/);
    expect(body).toMatch(/@utility nav-link \{/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/styles/base.css'))).toBe(true);
  });

  it('apps/docs/src/styles/base.css @theme (W368 — was tailwind.config.mjs, migrated to Tailwind v4 CSS-first): V-254 typography @plugin + oxblood ramp flipped to violet (Fleet rebrand; #6d5efc base at 500) + slate scale + Geist/Berkeley font vars + prose 65ch container. The v3 JS config (content glob, JS palette, plugins:[typography]) became @plugin + @theme --color-*/--font-*/--container-* tokens; values unchanged', () => {
    const body = read('apps/docs/src/styles/base.css');
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
    // oxblood 11-shade palette (v4 @theme --color-* vars, lowercase hex)
    expect(body).toMatch(/--color-oxblood-50: #f1effe;/);
    expect(body).toMatch(/--color-oxblood-100: #e6e1fd;/);
    expect(body).toMatch(/--color-oxblood-200: #cfc7fb;/);
    expect(body).toMatch(/--color-oxblood-300: #ada0f8;/);
    expect(body).toMatch(/--color-oxblood-400: #8b7dff;/);
    expect(body).toMatch(/--color-oxblood-500: #6d5efc;/);
    expect(body).toMatch(/--color-oxblood-600: #5847e0;/);
    expect(body).toMatch(/--color-oxblood-700: #4a39c4;/); // violet base (Fleet rebrand)
    expect(body).toMatch(/--color-oxblood-800: #3d2fa0;/);
    expect(body).toMatch(/--color-oxblood-900: #332a80;/);
    expect(body).toMatch(/--color-oxblood-950: #1f1a4d;/);
    expect(body).toMatch(/--color-slate-50: #f8fafc;/);
    expect(body).toMatch(/--color-slate-950: #020617;/);
    expect(body).toMatch(/--font-sans: Geist, ui-sans-serif, system-ui, sans-serif;/);
    expect(body).toMatch(/--font-mono: Berkeley Mono, ui-monospace, SFMono-Regular, monospace;/);
    expect(body).toMatch(/--container-prose: 65ch;/);
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
});
