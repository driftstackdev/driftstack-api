// W530.C — drift guard for apps/server/playwright.config.ts.
// V-009 Postgres enum serialisation constraint forces workers=1 + no
// parallel. Drift here either changes the e2e isolation model (would
// break enum-type-conflicts) or shortens timeouts past Postgres
// truncate-between-tests overhead.
//
//   • testDir: ./tests/e2e + testMatch: **/*.spec.ts.
//   • V-009 single-shared-Postgres + truncate-between-tests + workers=1
//     framing comment.
//   • fullyParallel: false.
//   • retries: 1 in CI + 0 locally.
//   • reporter: ['list', ['html', open:never]] in CI + 'list' locally.
//   • timeout: 30_000 (30s test-step ceiling).
//   • expect.timeout: 5_000 (5s assertion ceiling).
//   • extraHTTPHeaders: { x-driftstack-test-suite: 'phase-8-e2e' }
//     (every e2e request tagged so server-side logs can attribute the
//     load to e2e runs).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/playwright.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W530.C apps/server/playwright.config.ts content parity', () => {
  const body = read(LIB);

  it("testDir + testMatch + CI detection framing pinned: 'import { defineConfig } from \"@playwright/test\"' + 'const isCi = !!process.env.CI' + 'testDir: \"./tests/e2e\"' + 'testMatch: \"**/*.spec.ts\"' — pinned so the @playwright/test config + CI-detection-from-env + tests/e2e-dir + .spec.ts-suffix commitment survives (drift to .test.ts would collide with vitest's discovery)", () => {
    expect(body).toMatch(/import \{ defineConfig \} from '@playwright\/test';/);
    expect(body).toMatch(/const isCi = !!process\.env\.CI;/);
    expect(body).toMatch(/testDir: '\.\/tests\/e2e',/);
    expect(body).toMatch(/testMatch: '\*\*\/\*\.spec\.ts',/);
  });

  it("V-009 workers=1 + fullyParallel=false framing pinned: 'Single shared Postgres DB with truncate-between-tests; workers=1 to serialise. Postgres enum types aren't schema-scoped, so per-worker schema isolation doesn't work without per-worker databases (V-009).' + 'workers: 1' + 'fullyParallel: false' — pinned so the V-009 anchor + single-shared-DB + truncate-between-tests + workers=1-serialisation + fullyParallel:false commitment survives (drift to workers>1 would surface Postgres enum-type-conflict failures intermittently)", () => {
    expect(body).toMatch(
      /\/\/ Single shared Postgres DB with truncate-between-tests; workers=1 to\s*\/\/ serialise\. Postgres enum types aren't schema-scoped, so per-worker\s*\/\/ schema isolation doesn't work without per-worker databases \(V-009\)\./,
    );
    expect(body).toMatch(/workers: 1,/);
    expect(body).toMatch(/fullyParallel: false,/);
  });

  it('retries + reporter framing pinned: \'retries: isCi ? 1 : 0\' (1 retry in CI to absorb single flake, 0 locally for immediate feedback) + \'reporter: isCi ? [["list"], ["html", { open: "never" }]] : "list"\' (list + html-no-auto-open in CI, list-only locally) — pinned so the CI-only-1-retry + CI-html-no-auto-open commitment survives (drift to retries>1 in CI would mask multi-step flakes; drift to html-open:always would block CI runner)', () => {
    expect(body).toMatch(/retries: isCi \? 1 : 0,/);
    expect(body).toMatch(
      /reporter: isCi \? \[\['list'\], \['html', \{ open: 'never' \}\]\] : 'list',/,
    );
  });

  it("Timeouts + e2e-tagging-header framing pinned: 'timeout: 30_000' (30s per-test) + 'expect: { timeout: 5_000 }' (5s per-assertion) + 'extraHTTPHeaders: { \"x-driftstack-test-suite\": \"phase-8-e2e\" }' — pinned so the 30s-per-test + 5s-per-assertion + e2e-tagging-header (every e2e request gets x-driftstack-test-suite=phase-8-e2e so server logs can attribute) commitment survives (drift to dropping the e2e header would un-tag every e2e request from server-side log attribution)", () => {
    expect(body).toMatch(/timeout: 30_000,/);
    expect(body).toMatch(/expect: \{ timeout: 5_000 \},/);
    expect(body).toMatch(/extraHTTPHeaders: \{\s*'x-driftstack-test-suite': 'phase-8-e2e',\s*\},/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
