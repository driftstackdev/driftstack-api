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

  it('apps/customer-dashboard/README.md: @driftstack/customer-dashboard scaffolding V-099+V-108 + Astro 5 CF Pages + Tailwind (tokens shared with marketing-site) + Geist+Berkeley + V-084 dashboard-stack proposal + 9-item sidebar nav + V-079 driftstack_web_session cookie + path-filtered deploy mirror of marketing pinned', () => {
    const body = read('apps/customer-dashboard/README.md');
    expect(body).toMatch(/^# @driftstack\/customer-dashboard$/m);
    expect(body).toMatch(
      /The signed-in customer dashboard for Driftstack — `app\.driftstack\.dev`/,
    );
    expect(body).toMatch(/\*\*Status:\*\* scaffolding only as of V-099 \+ V-108\./);
    expect(body).toMatch(/^## Stack$/m);
    expect(body).toMatch(/Astro 5 \(static-build output\) → Cloudflare Pages/);
    expect(body).toMatch(/Tailwind CSS \(tokens shared with `apps\/marketing-site\/`\)/);
    expect(body).toMatch(/Geist Sans \+ Berkeley Mono \(same as marketing site\)/);
    expect(body).toMatch(/React islands TBD \(per V-084 dashboard-stack proposal/);
    expect(body).toMatch(/`docs\/architecture\/customer-dashboard-stack\.md`/);
    expect(body).toMatch(/^## Local dev$/m);
    expect(body).toMatch(
      /npm run dev --workspace apps\/customer-dashboard\s+# → http:\/\/localhost:4322/,
    );
    expect(body).toMatch(/Pages currently use mock data from `src\/data\/mocks\.ts`/);
    expect(body).toMatch(/^## Layout$/m);
    expect(body).toMatch(
      /data\/mocks\.ts\s+— MOCK_ACCOUNT, MOCK_SUBSCRIPTION, MOCK_PROFILES, etc\./,
    );
    expect(body).toMatch(/DashboardLayout\.astro\s+— sidebar nav \+ main slot, withSidebar prop/);
    expect(body).toMatch(
      /The sidebar nav lists 9 items \(Overview, Profiles, Sessions, API keys, Usage, Billing, Webhooks, Team, Settings\)\./,
    );
    expect(body).toMatch(/^## Auth model$/m);
    expect(body).toMatch(
      /The page reads a `driftstack_web_session` cookie \(sha256-hashed token from V-079 web sessions\)\./,
    );
    expect(body).toMatch(/^## Build \+ deploy$/m);
    expect(body).toMatch(/Pattern will mirror `\.github\/workflows\/deploy-marketing\.yml`/);
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
    expect(body).toMatch(/`surface-base`\s+\| `#0b0f14`/);
    expect(body).toMatch(/`surface-raised`\s+\| `#111722`/);
    expect(body).toMatch(/`surface-elevated` \| `#1a2230`/);
    expect(body).toMatch(/`accent` \(oxblood\) \| `#722f37`/);
    expect(body).toMatch(/`ink-primary`\s+\| `#e5e7eb`/);
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

  it('apps/gui-client/PACKAGING.md: macOS notarised .app + .dmg outside-App-Store + sandbox-off + hardened-runtime+notarisation on + 4-env-var table (APPLE_SIGNING_IDENTITY/APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID) + tauri:build 7-step (vite+rust+wrap+codesign+notarytool+staple+dmg) + 4-known-limit (DMG-bundling-disabled-AppleScript + no-universal-binary + no-auto-update + sandbox-off) pinned', () => {
    const body = read('apps/gui-client/PACKAGING.md');
    expect(body).toMatch(/^# Driftstack self-hosted GUI — macOS packaging runbook$/m);
    expect(body).toMatch(
      /The GUI ships as a notarised `\.app` bundle inside a `\.dmg`, distributed/,
    );
    expect(body).toMatch(/outside the App Store\. Sandboxing is off/);
    expect(body).toMatch(/hardened runtime \+ notarisation are on/);
    expect(body).toMatch(/^## One-time setup \(founder\)$/m);
    expect(body).toMatch(/\*\*Developer ID Application\*\* \(signs the `\.app` bundle\)\./);
    expect(body).toMatch(/\*\*Developer ID Installer\*\* \(signs `\.pkg` if we ever ship one;/);
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
    expect(body).toMatch(/Wrap it as `Driftstack_<version>_aarch64\.dmg`\./);
    expect(body).toMatch(/^## Known limits$/m);
    expect(body).toMatch(/\*\*DMG bundling currently disabled\*\* \(`targets: \["app"\]`\)/);
    expect(body).toMatch(/`AppleEvent timed out \(-1712\)`/);
    expect(body).toMatch(/\*\*Universal binary not configured\.\*\*/);
    expect(body).toMatch(/Apple Silicon-only is fine for the/);
    expect(body).toMatch(/founder's personal dev tool\./);
    expect(body).toMatch(/\*\*No auto-update mechanism\.\*\*/);
    expect(body).toMatch(/\*\*Sandbox off\.\*\*/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/PACKAGING.md'))).toBe(true);
  });

  it('apps/gui-client/tailwind.config.ts: locked brand identity file 128 + Config TS-import + content [index.html + src/**/*.{ts,tsx}] + darkMode class + 4 colors namespaces (surface{base/raised/elevated/inset/divider}, ink{primary/secondary/muted/inverted}, accent oxblood + status{ready/busy/error/idle}) + fontFamily sans=Geist + mono=Berkeley + 2xs fontSize + ringWidth DEFAULT=1px pinned', () => {
    const body = read('apps/gui-client/tailwind.config.ts');
    expect(body).toMatch(/^import type \{ Config \} from 'tailwindcss';$/m);
    expect(body).toMatch(/\/\/ Driftstack brand identity \(locked per file 128\)\./);
    expect(body).toMatch(/Oxblood accent: the only highlight color/);
    expect(body).toMatch(/Geist Sans for body \/ UI; Berkeley Mono for technical accents/);
    expect(body).toMatch(/content: \['\.\/index\.html', '\.\/src\/\*\*\/\*\.\{ts,tsx\}'\],/);
    expect(body).toMatch(/darkMode: 'class',/);
    expect(body).toMatch(/^\s+surface: \{$/m);
    expect(body).toMatch(/base: '#0b0f14',/);
    expect(body).toMatch(/raised: '#111722',/);
    expect(body).toMatch(/elevated: '#1a2230',/);
    expect(body).toMatch(/inset: '#070a0e',/);
    expect(body).toMatch(/divider: '#1f2937',/);
    expect(body).toMatch(/^\s+ink: \{$/m);
    expect(body).toMatch(/primary: '#e5e7eb',/);
    expect(body).toMatch(/secondary: '#9ca3af',/);
    expect(body).toMatch(/muted: '#6b7280',/);
    expect(body).toMatch(/inverted: '#0b0f14',/);
    expect(body).toMatch(/^\s+accent: \{$/m);
    expect(body).toMatch(/\/\/ Oxblood — locked\. Sole accent color\./);
    expect(body).toMatch(/DEFAULT: '#722f37',/);
    expect(body).toMatch(/hover: '#823942',/);
    expect(body).toMatch(/active: '#5e252c',/);
    expect(body).toMatch(/subtle: '#3a1a1f',/);
    expect(body).toMatch(/ring: 'rgba\(114, 47, 55, 0\.4\)',/);
    expect(body).toMatch(/^\s+status: \{$/m);
    expect(body).toMatch(/ready: '#34d399',/);
    expect(body).toMatch(/busy: '#fbbf24',/);
    expect(body).toMatch(/error: '#f87171',/);
    expect(body).toMatch(/idle: '#6b7280',/);
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
