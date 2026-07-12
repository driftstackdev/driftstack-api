// W540.C — drift guard for /tsconfig.eslint.json (workspace root).
// Dedicated tsconfig for type-aware ESLint passes. Drift here either
// flips noEmit to false (would scatter built JS into the source tree
// during eslint runs), drops the bundler-moduleResolution override
// (would re-break the eslint-pass over React types that ship without
// `exports` maps), or accidentally excludes apps/**/tests (would
// strip type-aware lint coverage from the test surface).
//
// NOTE: This file is JSON-with-comments (// override … comment), so
// regex matching is used rather than JSON.parse.
//
//   • extends: ./tsconfig.base.json.
//   • compilerOptions: noEmit:true + composite:false + declaration:
//     false + sourceMap:false + allowJs:true + jsx:react-jsx.
//   • lib: ['ES2023', 'DOM', 'DOM.Iterable'].
//   • module:ESNext + moduleResolution:bundler — overrides base's
//     NodeNext because React types lack exports maps.
//   • types: node + vitest/globals + react + react-dom.
//   • include: eslint.config.js + vitest configs + drizzle.config +
//     playwright configs + apps/**/src + apps/**/tests +
//     apps/**/vite.config + apps/**/tailwind.config + apps/**/
//     postcss.config + packages/**/src + packages/**/tests +
//     packages/**/examples + packages/**/tsup.config + perf/**.
//   • exclude: node_modules + dist + build + coverage + apps/
//     gui-client/src-tauri (Rust side) + apps/gui-client/dist.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'tsconfig.eslint.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W540.C /tsconfig.eslint.json content parity', () => {
  const body = read(LIB);

  it('extends + compilerOptions-noEmit-emit-suppression framing pinned: \'"extends": "./tsconfig.base.json"\' + \'"noEmit": true\' + \'"composite": false\' + \'"declaration": false\' + \'"declarationMap": false\' + \'"sourceMap": false\' + \'"allowJs": true\' — pinned so the extends-base + 5-emit-suppression-keys + allowJs-for-eslint-config-and-postcss-config commitment survives (drift to noEmit:false would scatter built JS during eslint runs; drift to composite:true would require this config to participate in project references and break the eslint typecheck pass)', () => {
    expect(body).toMatch(/"extends": "\.\/tsconfig\.base\.json"/);
    expect(body).toMatch(/"noEmit": true,/);
    expect(body).toMatch(/"composite": false,/);
    expect(body).toMatch(/"declaration": false,/);
    expect(body).toMatch(/"declarationMap": false,/);
    expect(body).toMatch(/"sourceMap": false,/);
    expect(body).toMatch(/"allowJs": true,/);
  });

  it('lib + jsx + ESNext/bundler-override framing pinned: \'"lib": ["ES2023", "DOM", "DOM.Iterable"]\' + \'"jsx": "react-jsx"\' + bundler-override comment \'Override the base\'s NodeNext for the eslint pass — React\'s types ship without `exports` maps, which NodeNext rejects. Bundler resolution covers both the React/Vite source files (gui-client) and the Node/server source files in one pass.\' + \'"module": "ESNext"\' + \'"moduleResolution": "bundler"\' — pinned so the ES2023-DOM-DOM.Iterable lib + react-jsx + ESNext-module + bundler-resolution-with-React-exports-rationale commitment survives (drift to NodeNext for eslint pass would re-break the eslint typecheck on React imports because React\'s package.json lacks `exports` maps)', () => {
    expect(body).toMatch(/"lib": \["ES2023", "DOM", "DOM\.Iterable"\]/);
    expect(body).toMatch(/"jsx": "react-jsx"/);
    expect(body).toMatch(
      /\/\/ Override the base's NodeNext for the eslint pass — React's types\s*\n?\s*\/\/ ship without `exports` maps, which NodeNext rejects\. Bundler\s*\n?\s*\/\/ resolution covers both the React\/Vite source files \(gui-client\)\s*\n?\s*\/\/ and the Node\/server source files in one pass\./,
    );
    expect(body).toMatch(/"module": "ESNext"/);
    expect(body).toMatch(/"moduleResolution": "bundler"/);
  });

  it('types-array framing pinned: \'"types": ["node", "vitest/globals", "react", "react-dom"]\' (4-type-anchor exact set) — pinned so the node + vitest/globals + react + react-dom 4-type-anchor commitment survives (drift to dropping vitest/globals would break the type-aware eslint pass over describe/it/expect; drift to dropping react-dom would break the JSX-type checks across the gui-client + Astro-app islands)', () => {
    expect(body).toMatch(/"types": \["node", "vitest\/globals", "react", "react-dom"\]/);
  });

  it("include-array framing pinned: 'eslint.config.js' + Vitest root/node configs + 'drizzle.config.ts' + app/package/perf globs — pinned so workspace configs and source/test/tooling surfaces remain in the typed ESLint project", () => {
    expect(body).toMatch(/"eslint\.config\.js"/);
    expect(body).toMatch(/"vitest\.config\.ts"/);
    expect(body).toMatch(/"vitest\.node\.config\.ts"/);
    expect(body).toMatch(/"drizzle\.config\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/playwright\.config\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/src\/\*\*\/\*\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/src\/\*\*\/\*\.tsx"/);
    expect(body).toMatch(/"apps\/\*\*\/tests\/\*\*\/\*\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/tests\/\*\*\/\*\.tsx"/);
    expect(body).toMatch(/"apps\/\*\*\/vite\.config\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/vitest\.config\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/tailwind\.config\.ts"/);
    expect(body).toMatch(/"apps\/\*\*\/postcss\.config\.js"/);
    expect(body).toMatch(/"packages\/\*\*\/src\/\*\*\/\*\.ts"/);
    expect(body).toMatch(/"packages\/\*\*\/tests\/\*\*\/\*\.ts"/);
    expect(body).toMatch(/"packages\/\*\*\/examples\/\*\*\/\*\.ts"/);
    expect(body).toMatch(/"packages\/\*\*\/tsup\.config\.ts"/);
    expect(body).toMatch(/"perf\/\*\*\/\*\.ts"/);
  });

  it("exclude-array framing pinned: 'node_modules' + 'dist' + 'build' + 'coverage' + 'apps/gui-client/src-tauri' (Rust side — not eslint-scanned) + 'apps/gui-client/dist' — pinned so the 4-standard-build-artefact + Rust-src-tauri-excluded + gui-client-dist-excluded commitment survives (drift to including apps/gui-client/src-tauri would attempt to eslint Rust files and crash the pass)", () => {
    expect(body).toMatch(/"node_modules"/);
    expect(body).toMatch(/"dist"/);
    expect(body).toMatch(/"build"/);
    expect(body).toMatch(/"coverage"/);
    expect(body).toMatch(/"apps\/gui-client\/src-tauri"/);
    expect(body).toMatch(/"apps\/gui-client\/dist"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
