// W536.B — drift guard for apps/gui-client/vitest.config.ts.
// V-288 jsdom-needing GUI client tests project. Registered by the
// root vitest.config.ts (W528.B). Drift here either widens the
// include glob from .tsx (would double-run pure-function .test.ts in
// both node + jsdom — the ts/tsx discriminator is load-bearing) or
// enables coverage (would conflict with the root project's load-
// bearing coverage report).
//
//   • V-288 anchor + 'apps/gui-client/tests/**/*.test.tsx' scope.
//   • Registered by root vitest.config.ts.
//   • environment: jsdom + name: 'gui-jsdom'.
//   • include: tests/**/*.test.tsx only (NOT .test.ts — node project
//     handles those).
//   • Setup file: ./tests/setup.ts.
//   • testTimeout + hookTimeout: 10_000 (parity with root config).
//   • coverage.enabled: false (informational only; root project's
//     report is load-bearing).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/vitest.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W536.B apps/gui-client/vitest.config.ts content parity', () => {
  const body = read(LIB);

  it('V-288 framing + .tsx-discriminator + root-project registration pinned — pinned so the V-288 anchor + .tsx-discriminator + .ts-stays-in-node + no-DOM-overhead-for-pure-fn commitment survives', () => {
    expect(body).toMatch(/\/\/ V-288 — Vitest project config for jsdom-needing GUI client tests\./);
    expect(body).toMatch(
      /\/\/ Scoped to `apps\/gui-client\/tests\/\*\*\/\*\.test\.tsx` \(the \.tsx extension\s*\n?\s*\/\/ is the discriminator\)\. Pure-function `\.test\.ts` files in this dir\s*\n?\s*\/\/ continue to run in the root project's node environment — no DOM\s*\n?\s*\/\/ overhead for tests that don't need it\./,
    );
    expect(body).toMatch(/\/\/ Registered by the root `vitest\.config\.ts` project list\./);
  });

  it("jsdom-project + include + setup framing pinned: 'plugins: [react()]' (transforms .tsx via @vitejs/plugin-react) + 'name: \"gui-jsdom\"' + 'environment: \"jsdom\"' + 'include: [\"tests/**/*.test.tsx\"]' (.tsx-only — parity with V-288 ts/tsx discriminator) + 'exclude: [\"**/node_modules/**\", \"**/dist/**\"]' + 'setupFiles: [\"./tests/setup.ts\"]' + 'testTimeout: 10_000' + 'hookTimeout: 10_000' (parity with root project) — pinned so the gui-jsdom-project-name + jsdom-environment + tsx-include + 2-exclude + setup-file + 10s-timeouts (matches root config) commitment survives", () => {
    expect(body).toMatch(/import \{ defineConfig \} from 'vitest\/config';/);
    expect(body).toMatch(/import react from '@vitejs\/plugin-react';/);
    expect(body).toMatch(/plugins: \[react\(\)\],/);
    expect(body).toMatch(/name: 'gui-jsdom',/);
    expect(body).toMatch(/environment: 'jsdom',/);
    expect(body).toMatch(/include: \['tests\/\*\*\/\*\.test\.tsx'\],/);
    expect(body).toMatch(/exclude: \['\*\*\/node_modules\/\*\*', '\*\*\/dist\/\*\*'\],/);
    expect(body).toMatch(/setupFiles: \['\.\/tests\/setup\.ts'\],/);
    expect(body).toMatch(/testTimeout: 10_000,/);
    expect(body).toMatch(/hookTimeout: 10_000,/);
  });

  it("Coverage-disabled framing pinned: 'Don't measure coverage from this project — the root project's coverage report is the load-bearing one. Component-level coverage is informational; if a feature gap surfaces, write the test, don't gate on a separate threshold.' + 'coverage: { enabled: false }' — pinned so the no-coverage-in-jsdom-project (root's V-107 thresholds are the load-bearing gate, component-coverage is informational, gap → write test not threshold) commitment survives (drift to coverage.enabled:true would let CI fork into 2 conflicting coverage reports)", () => {
    expect(body).toMatch(
      /\/\/ Don't measure coverage from this project — the root project's\s*\n?\s*\/\/ coverage report is the load-bearing one\. Component-level\s*\n?\s*\/\/ coverage is informational; if a feature gap surfaces, write the\s*\n?\s*\/\/ test, don't gate on a separate threshold\./,
    );
    expect(body).toMatch(/coverage: \{\s*\n?\s*enabled: false,\s*\n?\s*\},/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
