// W624 — drift guard for app-level meta files (10 files):
//  - 5 Astro tsconfig.json: admin-panel + customer-dashboard + docs +
//    marketing-site + status-site (shared astro/tsconfigs/strict shape).
//  - gui-client tsconfig.json (Vite/React/TS strict, distinct shape).
//  - customer-dashboard README.md + gui-client README.md.
//  - gui-client PACKAGING.md (macOS notarisation runbook).
//  - gui-client tailwind.config.ts (locked brand identity).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('W624 app tsconfigs + READMEs + tailwind content parity', () => {
  it('4 Astro tsconfig.json (admin-panel + customer-dashboard + docs + marketing-site) shared shape: extends astro/tsconfigs/strict + jsx=preserve + paths @/* → src/* + include src/**/*+astro.config.mjs+tailwind.config.mjs + exclude dist pinned', () => {
    const sharedShape = (app: string) => {
      const body = read(`apps/${app}/tsconfig.json`);
      expect(body).toMatch(/"extends": "astro\/tsconfigs\/strict"/);
      expect(body).toMatch(/"jsx": "preserve"/);
      expect(body).toMatch(/"baseUrl": "\."/);
      expect(body).toMatch(/"@\/\*": \["src\/\*"\]/);
      expect(body).toMatch(
        /"include": \["src\/\*\*\/\*", "astro\.config\.mjs", "tailwind\.config\.mjs"\]/,
      );
      expect(body).toMatch(/"exclude": \["dist"\]/);
      expect(existsSync(resolve(REPO_ROOT, `apps/${app}/tsconfig.json`))).toBe(true);
    };
    sharedShape('admin-panel');
    sharedShape('customer-dashboard');
    sharedShape('docs');
    sharedShape('marketing-site');
  });

  it('apps/status-site/tsconfig.json: distinct minimal shape (extends astro/tsconfigs/strict + include .astro/types.d.ts + **/* + exclude dist) pinned', () => {
    const body = read('apps/status-site/tsconfig.json');
    expect(body).toMatch(/"extends": "astro\/tsconfigs\/strict"/);
    expect(body).toMatch(/"include": \[".astro\/types\.d\.ts", "\*\*\/\*"\]/);
    expect(body).toMatch(/"exclude": \["dist"\]/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/tsconfig.json'))).toBe(true);
  });

  it('apps/gui-client/tsconfig.json: Vite/React/TS strict shape (target ES2022 + lib ES2023+DOM+DOM.Iterable + module ESNext + moduleResolution bundler + jsx react-jsx + strict + noUncheckedIndexedAccess + noUnusedLocals/Parameters + verbatimModuleSyntax + types [vite/client] + exclude src-tauri) pinned', () => {
    const body = read('apps/gui-client/tsconfig.json');
    expect(body).toMatch(/"target": "ES2022"/);
    expect(body).toMatch(/"lib": \["ES2023", "DOM", "DOM\.Iterable"\]/);
    expect(body).toMatch(/"module": "ESNext"/);
    expect(body).toMatch(/"moduleResolution": "bundler"/);
    expect(body).toMatch(/"allowImportingTsExtensions": true/);
    expect(body).toMatch(/"resolveJsonModule": true/);
    expect(body).toMatch(/"isolatedModules": true/);
    expect(body).toMatch(/"noEmit": true/);
    expect(body).toMatch(/"jsx": "react-jsx"/);
    expect(body).toMatch(/"strict": true/);
    expect(body).toMatch(/"noUncheckedIndexedAccess": true/);
    expect(body).toMatch(/"noImplicitOverride": true/);
    expect(body).toMatch(/"noFallthroughCasesInSwitch": true/);
    expect(body).toMatch(/"noUnusedLocals": true/);
    expect(body).toMatch(/"noUnusedParameters": true/);
    expect(body).toMatch(/"skipLibCheck": true/);
    expect(body).toMatch(/"esModuleInterop": true/);
    expect(body).toMatch(/"verbatimModuleSyntax": true/);
    expect(body).toMatch(/"types": \["vite\/client"\]/);
    expect(body).toMatch(/"include": \["src", "vite\.config\.ts"\]/);
    expect(body).toMatch(/"exclude": \["node_modules", "dist", "src-tauri"\]/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/tsconfig.json'))).toBe(true);
  });

  it('apps/customer-dashboard/README.md pins the current Astro 7 static Pages, auth, and deployment contract', () => {
    const body = read('apps/customer-dashboard/README.md');
    expect(body).toMatch(/^# @driftstack\/customer-dashboard$/m);
    expect(body).toMatch(/The pre-launch customer account portal served at `app\.driftstack\.io`/);
    expect(body).toMatch(/^## Stack$/m);
    expect(body).toMatch(/Astro 7 static output on Cloudflare Pages/);
    expect(body).toMatch(/Tailwind CSS 3 through PostCSS/);
    expect(body).toMatch(/No current route requires server-side rendering or a Pages Function/);
    expect(body).toMatch(/^## Local development$/m);
    expect(body).toMatch(/npm run dev --workspace @driftstack\/customer-dashboard/);
    expect(body).toMatch(/^## Authentication$/m);
    expect(body).toMatch(/web-session flow under `\/v1\/auth\/\*`/);
    expect(body).toMatch(/^## Build and deploy$/m);
    expect(body).toMatch(/deploy-customer-dashboard\.yml/);
    expect(body).toMatch(/scripts\/deploy-frontend\.sh customer-dashboard/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/README.md'))).toBe(true);
  });

  it('apps/gui-client/README.md: Driftstack GUI client Tauri 2.x + React 18 + TS 5 strict + Tailwind brand identity (slate base + oxblood + Geist + Berkeley) + macOS first + GUI1 scaffold + tauri:dev/build + 7-row brand-token table (surface-base/raised/elevated + accent oxblood + ink-primary + font-sans/mono) + 8 GUI1-NOT-included items (GUI2 IPC → GUI8 founder usability) + MIT pinned', () => {
    const body = read('apps/gui-client/README.md');
    expect(body).toMatch(/^# Driftstack GUI client$/m);
    expect(body).toMatch(/Self-hosted desktop GUI for running modified-WebKit-fork sessions/);
    expect(body).toMatch(
      /Tauri \(Rust backend\) \+ React \+ TypeScript \+ Tailwind on the frontend\./,
    );
    expect(body).toMatch(/\*\*Status:\*\* GUI1 — scaffold only\./);
    expect(body).toMatch(/^## Stack$/m);
    expect(body).toMatch(/\*\*Tauri 2\.x\*\* — chosen over Electron for smaller bundle/);
    expect(body).toMatch(/\*\*React 18 \+ TypeScript 5 strict\*\*/);
    expect(body).toMatch(/\*\*Tailwind CSS\*\* with the locked Driftstack brand identity/);
    expect(body).toMatch(/\*\*macOS first\*\* — primary target\. Windows \+ Linux later\./);
    expect(body).toMatch(/^## Develop$/m);
    expect(body).toMatch(/Prerequisites: Node 22\+, Rust 1\.95\+/);
    expect(body).toMatch(/^npm run tauri:dev\s+# opens the desktop app with hot-reload$/m);
    expect(body).toMatch(/^npm run tauri:build$/m);
    expect(body).toMatch(/^## Layout$/m);
    expect(body).toMatch(/^## Brand identity \(locked per file 128\)$/m);
    expect(body).toMatch(/`surface-base`\s+\| `#0f172a`/);
    expect(body).toMatch(/`surface-raised`\s+\| `#1e293b`/);
    expect(body).toMatch(/`surface-elevated` \| `#334155`/);
    expect(body).toMatch(/`accent` \(oxblood\) \| `#a83b4d`/);
    expect(body).toMatch(/`ink-primary`\s+\| `#f1f5f9`/);
    expect(body).toMatch(/`font-sans`\s+\| Geist Sans → system-ui fallback/);
    expect(body).toMatch(/`font-mono`\s+\| Berkeley Mono → JetBrains Mono fb/);
    expect(body).toMatch(/^## What's NOT in GUI1$/m);
    expect(body).toMatch(
      /IPC `#\[tauri::command\]` handlers beyond a `ping` health probe → GUI2\./,
    );
    expect(body).toMatch(/Connection to the local Driftstack API server → GUI2\./);
    expect(body).toMatch(/Live session viewport → GUI3\./);
    expect(body).toMatch(/Manual input forwarding → GUI4\./);
    expect(body).toMatch(/SOCKS5 proxy management → GUI5\./);
    expect(body).toMatch(/Session recording \+ playback → GUI6\./);
    expect(body).toMatch(/macOS native packaging \+ signing → GUI7\./);
    expect(body).toMatch(/Founder usability pass → GUI8\./);
    expect(body).toMatch(/^## License$/m);
    expect(body).toMatch(/^MIT\.$/m);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/README.md'))).toBe(true);
  });

  it('apps/gui-client/PACKAGING.md: current Apple-silicon app-only target + direct-distribution signing/notarisation + 4-env-var table + 6-step build + honest DMG/architecture/updater/sandbox boundaries pinned', () => {
    const body = read('apps/gui-client/PACKAGING.md');
    expect(body).toMatch(/^# Driftstack self-hosted GUI — macOS packaging runbook$/m);
    expect(body).toMatch(/The current build emits a macOS `\.app` for Apple silicon/);
    expect(body).toMatch(/distributed\s*\n?outside the App Store\. Sandboxing is off/);
    expect(body).toMatch(/customer-distributed build must use the hardened runtime/);
    expect(body).toMatch(/^## One-time setup \(founder\)$/m);
    expect(body).toMatch(/\*\*Developer ID Application\*\* \(signs the `\.app` bundle\)\./);
    expect(body).toMatch(/\*\*Developer ID Installer\*\* \(required only for a signed `\.pkg`/);
    expect(body).toMatch(/Create an \*\*app-specific password\*\*/);
    expect(body).toMatch(/^## Per-build env vars$/m);
    expect(body).toMatch(/`APPLE_SIGNING_IDENTITY` \| The cert's common name/);
    expect(body).toMatch(/`APPLE_ID`\s+\| Apple ID email/);
    expect(body).toMatch(/`APPLE_PASSWORD`\s+\| App-specific password from setup step 3/);
    expect(body).toMatch(/`APPLE_TEAM_ID`\s+\| Team id from setup step 4/);
    expect(body).toMatch(/^## Build$/m);
    expect(body).toMatch(/Compile the React frontend \(`vite build`\)\./);
    expect(body).toMatch(/Compile the Rust binary in release mode\./);
    expect(body).toMatch(/Codesign the bundle with `APPLE_SIGNING_IDENTITY`/);
    expect(body).toMatch(/Submit the bundle to Apple for notarisation/);
    expect(body).toMatch(/\(`xcrun notarytool submit --wait`\)\./);
    expect(body).toMatch(/Staple the notarisation ticket to the bundle\./);
    expect(body).toMatch(/^## Known limits$/m);
    // V-1148 — this froze "DMG bundling currently disabled (targets: [\"app\"])". Both
    // halves went false when dmg joined the bundle targets and the release workflow
    // began publishing a .dmg its own notes tell customers to download. The local
    // AppleScript limitation is real and kept; the state claim was not.
    expect(body).toMatch(/\*\*DMG bundling is enabled, and can still fail LOCALLY\.\*\*/);
    expect(body, 'the retired DMG-disabled claim is back').not.toMatch(
      /DMG bundling currently disabled/,
    );
    expect(body).toMatch(/`AppleEvent timed out \(-1712\)`/);
    expect(body).toMatch(/\*\*Apple silicon only\.\*\*/);
    expect(body).toMatch(/no Intel binary is distributed\./);
    expect(body).toMatch(/\*\*Signed updater active\.\*\*/);
    expect(body).toMatch(/Tauri verifies the\s*\n?manifest signature/);
    expect(body).toMatch(/\*\*Sandbox off\.\*\*/);
    expect(body).not.toMatch(/queued for a later phase|if we ever|when it matters/i);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/PACKAGING.md'))).toBe(true);
  });

  it('apps/gui-client/tailwind.config.ts: Fleet token palette (2026-06-12 rework) — Config TS-import + content [index.html + src/**/*.{ts,tsx}] + darkMode [data-mode=dark] selector + 4 semantic namespaces resolving to the two-axis CSS vars (rgb()/<alpha-value> form) incl the status.success/.warning latent-no-op fix + fontFamily sans=Geist + mono=Berkeley + 2xs fontSize + ringWidth DEFAULT=1px pinned', () => {
    const body = read('apps/gui-client/tailwind.config.ts');
    expect(body).toMatch(/^import type \{ Config \} from 'tailwindcss';$/m);
    expect(body).toMatch(/\/\/ Driftstack brand identity \(locked per file 128\)\./);
    expect(body).toMatch(/Oxblood accent: the only highlight color/);
    expect(body).toMatch(/Geist Sans for body \/ UI; Berkeley Mono for technical accents/);
    expect(body).toMatch(/content: \['\.\/index\.html', '\.\/src\/\*\*\/\*\.\{ts,tsx\}'\],/);
    expect(body).toMatch(/darkMode: \['selector', '\[data-mode="dark"\]'\],/);
    expect(body).toMatch(/^\s+surface: \{$/m);
    expect(body).toMatch(/base: 'rgb\(var\(--surface-base-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/raised: 'rgb\(var\(--surface-raised-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/elevated: 'rgb\(var\(--surface-elevated-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/inset: 'rgb\(var\(--surface-inset-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/divider: 'rgb\(var\(--surface-divider-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/^\s+ink: \{$/m);
    expect(body).toMatch(/primary: 'rgb\(var\(--ink-primary-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/secondary: 'rgb\(var\(--ink-secondary-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/muted: 'rgb\(var\(--ink-muted-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/inverted: 'rgb\(var\(--ink-inverted-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/^\s+accent: \{$/m);
    expect(body).toMatch(/\/\/ Follows the data-accent axis \(violet default per the rework\)\./);
    expect(body).toMatch(/DEFAULT: 'rgb\(var\(--accent-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/hover: 'rgb\(var\(--accent-hover-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/active: 'rgb\(var\(--accent-active-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(
      /subtle: 'rgb\(var\(--accent-subtle-rgb\) \/ var\(--accent-subtle-alpha\)\)',/,
    );
    expect(body).toMatch(/ring: 'var\(--accent-ring\)',/);
    expect(body).toMatch(/^\s+status: \{$/m);
    expect(body).toMatch(/ready: 'rgb\(var\(--status-ready-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/busy: 'rgb\(var\(--status-busy-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/error: 'rgb\(var\(--status-error-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/idle: 'rgb\(var\(--status-idle-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/success: 'rgb\(var\(--status-ready-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/warning: 'rgb\(var\(--status-busy-rgb\) \/ <alpha-value>\)',/);
    expect(body).toMatch(/sans: \[/);
    expect(body).toMatch(/'Geist Sans',/);
    expect(body).toMatch(/mono: \[/);
    expect(body).toMatch(/'Berkeley Mono',/);
    expect(body).toMatch(/'JetBrains Mono',/);
    expect(body).toMatch(/'2xs': \['0\.625rem', \{ lineHeight: '0\.875rem' \}\],/);
    expect(body).toMatch(/DEFAULT: '0\.25rem',/);
    expect(body).toMatch(/lg: '0\.375rem',/);
    expect(body).toMatch(/ringWidth: \{/);
    expect(body).toMatch(/DEFAULT: '1px',/);
    expect(body).toMatch(/\} satisfies Config;/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/tailwind.config.ts'))).toBe(true);
  });
});
