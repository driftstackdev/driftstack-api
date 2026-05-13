// W535.C — drift guard for apps/gui-client/package.json.
// Self-hosted GUI client manifest (Tauri + React + TS + Tailwind per
// file 128). Drift here either drops a Tauri plugin (would break
// deep-link / filesystem / shell / store / updater wiring) or drops
// the SDK runtime dep (would un-type every API call from the GUI).
//
//   • Name: @driftstack/gui-client + 'Driftstack self-hosted GUI
//     client (Tauri + React + TS + Tailwind). Per file 128.'.
//   • private: true + type: module.
//   • 7 scripts: dev (vite) + build (tsc -b && vite build) + preview
//     + typecheck + tauri + tauri:dev + tauri:build.
//   • Critical runtime deps: @driftstack/sdk + @sentry/browser +
//     @tauri-apps/api + 5 Tauri plugins (deep-link / fs / shell /
//     store / updater) + react + react-dom.
//   • Critical devDeps: @tauri-apps/cli + 3 testing-library + vite +
//     @vitejs/plugin-react + jsdom + autoprefixer + postcss + tailwind
//     + typescript.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W535.C apps/gui-client/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    description: string;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("Identity + Tauri-React-TS-Tailwind stack framing pinned: 'name: @driftstack/gui-client' + 'private: true' + 'description: \"Driftstack self-hosted GUI client (Tauri + React + TS + Tailwind). Per file 128.\"' + 'type: module' — pinned so the monorepo-scoped name + private + Tauri+React+TS+Tailwind stack + file-128 anchor commitment survives (drift to private:false would risk publishing the desktop binary metadata to npm)", () => {
    expect(pkg.name).toBe('@driftstack/gui-client');
    expect(pkg.private).toBe(true);
    expect(pkg.description).toBe(
      'Driftstack self-hosted GUI client (Tauri + React + TS + Tailwind). Per file 128.',
    );
    expect(pkg.type).toBe('module');
  });

  it("7-script pipeline framing pinned: 'dev: vite' + 'build: tsc -b && vite build' (typecheck-then-build) + 'preview: vite preview' + 'typecheck: tsc --noEmit' + 'tauri: tauri' + 'tauri:dev: tauri dev' + 'tauri:build: tauri build' — pinned so the vite-dev + tsc-then-vite-build (typecheck blocks bundle) + 3-tauri-script (raw tauri CLI + tauri-dev + tauri-build) commitment survives", () => {
    expect(pkg.scripts.dev).toBe('vite');
    expect(pkg.scripts.build).toBe('tsc -b && vite build');
    expect(pkg.scripts.preview).toBe('vite preview');
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    expect(pkg.scripts.tauri).toBe('tauri');
    expect(pkg.scripts['tauri:dev']).toBe('tauri dev');
    expect(pkg.scripts['tauri:build']).toBe('tauri build');
  });

  it('Tauri 5-plugin + SDK runtime-dep framing pinned: @driftstack/sdk + @sentry/browser + @tauri-apps/api + 5 Tauri plugins (@tauri-apps/plugin-deep-link + plugin-fs + plugin-shell + plugin-store + plugin-updater) + react + react-dom — pinned so the SDK-via-monorepo-link + browser-Sentry telemetry + 5-Tauri-plugin (deep-link for protocol handlers + fs for self-hosted storage + shell for OS-level processes + store for persistent settings + updater for in-app upgrade) commitment survives (drift to dropping plugin-updater would break in-app upgrade flow; drift to dropping plugin-deep-link would break the dashboard→app deep-link protocol)', () => {
    expect(pkg.dependencies).toHaveProperty('@driftstack/sdk');
    expect(pkg.dependencies).toHaveProperty('@sentry/browser');
    expect(pkg.dependencies).toHaveProperty('@tauri-apps/api');
    expect(pkg.dependencies).toHaveProperty('@tauri-apps/plugin-deep-link');
    expect(pkg.dependencies).toHaveProperty('@tauri-apps/plugin-fs');
    expect(pkg.dependencies).toHaveProperty('@tauri-apps/plugin-shell');
    expect(pkg.dependencies).toHaveProperty('@tauri-apps/plugin-store');
    expect(pkg.dependencies).toHaveProperty('@tauri-apps/plugin-updater');
    expect(pkg.dependencies).toHaveProperty('react');
    expect(pkg.dependencies).toHaveProperty('react-dom');
  });

  it('devDeps framing pinned: @tauri-apps/cli + 3 testing-library (@testing-library/jest-dom + react + user-event) + vite + @vitejs/plugin-react + jsdom + autoprefixer + postcss + tailwindcss + typescript + @types/react + @types/react-dom — pinned so the Tauri-CLI + 3-testing-library + jsdom (for vitest-component tests) + Vite + React-types commitment survives', () => {
    expect(pkg.devDependencies).toHaveProperty('@tauri-apps/cli');
    expect(pkg.devDependencies).toHaveProperty('@testing-library/jest-dom');
    expect(pkg.devDependencies).toHaveProperty('@testing-library/react');
    expect(pkg.devDependencies).toHaveProperty('@testing-library/user-event');
    expect(pkg.devDependencies).toHaveProperty('vite');
    expect(pkg.devDependencies).toHaveProperty('@vitejs/plugin-react');
    expect(pkg.devDependencies).toHaveProperty('jsdom');
    expect(pkg.devDependencies).toHaveProperty('autoprefixer');
    expect(pkg.devDependencies).toHaveProperty('postcss');
    expect(pkg.devDependencies).toHaveProperty('tailwindcss');
    expect(pkg.devDependencies).toHaveProperty('typescript');
    expect(pkg.devDependencies).toHaveProperty('@types/react');
    expect(pkg.devDependencies).toHaveProperty('@types/react-dom');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
