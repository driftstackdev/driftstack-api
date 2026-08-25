// W536.A — drift guard for apps/gui-client/vite.config.ts.
// Tauri-Vite frontend config. Drift here either changes the strict
// port (would break Tauri's dev-server discovery), the platform-
// conditional build target (would break the Tauri-bundled webview
// compatibility), or the envPrefix (would break Tauri env-var pass-
// through into the frontend).
//
//   • React Vite plugin.
//   • clearScreen: false (Tauri-vite reference recommendation).
//   • server: port 1420 + strictPort:true + host from TAURI_DEV_HOST.
//   • envPrefix: ['VITE_', 'TAURI_ENV_'] (both Vite-standard + Tauri-
//     environment vars).
//   • Conditional build target: chrome105 on windows + safari13
//     elsewhere (matches Tauri's bundled webview baseline).
//   • Conditional minify + sourcemap from TAURI_ENV_DEBUG.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/vite.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W536.A apps/gui-client/vite.config.ts content parity', () => {
  const body = read(LIB);

  it("Tauri-integration framing pinned: 'https://vitejs.dev/config/' + 'Tauri integration: https://tauri.app/v2/start/frontend/vite/' + 'import react from \"@vitejs/plugin-react\"' + 'plugins: [react()]' + 'Vite assumes `index.html` is at the project root; Tauri reads from the same directory, so no `root:` override needed.' + 'clearScreen: false' — pinned so the Tauri-v2-vite-integration reference + React Vite plugin + no-root-override-because-Tauri-shares-cwd + clearScreen:false (Tauri-vite reference recommendation — preserves prior terminal output during dev) commitment survives", () => {
    expect(body).toMatch(/import \{ defineConfig \} from 'vite';/);
    expect(body).toMatch(/import react from '@vitejs\/plugin-react';/);
    expect(body).toMatch(
      /\/\/ https:\/\/vitejs\.dev\/config\/\s*\/\/ Tauri integration: https:\/\/tauri\.app\/v2\/start\/frontend\/vite\//,
    );
    expect(body).toMatch(/plugins: \[react\(\)\],/);
    expect(body).toMatch(
      /\/\/ Vite assumes `index\.html` is at the project root; Tauri reads from\s*\/\/ the same directory, so no `root:` override needed\./,
    );
    expect(body).toMatch(/clearScreen: false,/);
  });

  it("Strict-port + Tauri-dev-host framing pinned: 'port: 1420' + 'strictPort: true' + 'host: process.env.TAURI_DEV_HOST ?? false' — pinned so the 1420 fixed-port + strict-port (Vite fails if 1420 is taken instead of auto-incrementing — Tauri can't discover a moving port) + TAURI_DEV_HOST passthrough commitment survives (drift to strictPort:false would let Vite drift to 1421 and break Tauri's webview load)", () => {
    expect(body).toMatch(/port: 1420,/);
    expect(body).toMatch(/strictPort: true,/);
    expect(body).toMatch(/host: process\.env\.TAURI_DEV_HOST \?\? false,/);
  });

  it("Tauri-bundled-binary + envPrefix framing pinned: 'Tauri builds the frontend to `dist/` and bundles it into the application binary; no need to publish dist to a CDN.' + 'envPrefix: [\"VITE_\", \"TAURI_ENV_\"]' — pinned so the no-CDN-publish (Tauri bundles dist into app binary) + 2-envPrefix (both Vite-standard VITE_ + Tauri's TAURI_ENV_) commitment survives (drift to dropping TAURI_ENV_ prefix would block Tauri env-var pass-through into the frontend)", () => {
    expect(body).toMatch(
      /\/\/ Tauri builds the frontend to `dist\/` and bundles it into the\s*\/\/ application binary; no need to publish dist to a CDN\./,
    );
    expect(body).toMatch(/envPrefix: \['VITE_', 'TAURI_ENV_'\],/);
  });

  it("Platform-conditional build framing pinned: 'target: process.env.TAURI_ENV_PLATFORM === \"windows\" ? \"chrome105\" : \"safari13\"' (matches Tauri's bundled webview baseline — WebView2 on Windows ≈ Chrome 105+, WKWebView on macOS/Linux ≈ Safari 13+) + 'minify: !process.env.TAURI_ENV_DEBUG' + 'sourcemap: !!process.env.TAURI_ENV_DEBUG' — pinned so the chrome105-on-windows / safari13-elsewhere target split + DEBUG-conditional minify+sourcemap commitment survives (drift to ES2020 target without Tauri-platform check would silently break WebView2 on older Windows or WKWebView on older macOS)", () => {
    expect(body).toMatch(
      /target: process\.env\.TAURI_ENV_PLATFORM === 'windows' \? 'chrome105' : 'safari13',/,
    );
    expect(body).toMatch(/minify: !process\.env\.TAURI_ENV_DEBUG,/);
    expect(body).toMatch(/sourcemap: !!process\.env\.TAURI_ENV_DEBUG,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
