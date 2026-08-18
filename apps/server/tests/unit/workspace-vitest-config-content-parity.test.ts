// W528.A — drift guard for /vitest.node.config.ts (node project).
// V-107 coverage regression-gate + V-086 e2e-only-Drizzle-repos +
// V-120 benchmark separation. Drift here either changes test discovery
// scope (would silently drop test files from the suite), test/hook
// timeouts (would mask slow tests or flaky hangs), or the coverage
// thresholds (would weaken the regression-gate posture).
//
//   • test.environment: node + globals: false.
//   • include glob: apps/** + packages/** + scripts/tests + .test.ts.
//   • exclude: node_modules + dist + tests/e2e.
//   • testTimeout: 10_000 + hookTimeout: 10_000.
//   • Coverage: v8 provider + text/json-summary/html reporters.
//   • Coverage include: apps/server/src/**/*.ts + packages/sdk-typescript/
//     src/**/*.ts.
//   • Coverage exclude: db/ (V-086 e2e only) + index.ts bootstrap +
//     dump-openapi.ts CLI.
//   • V-107 thresholds: 85/83/84/75 (lines/statements/functions/
//     branches). V-803 — this bullet said 80/80/80/75 while the
//     assertion below already required the ratcheted values. Read
//     them off vitest.config.ts; the assertion is authoritative and
//     a number restated in prose is the shape that goes stale.
//   • V-120 benchmark glob separation (`npm run bench` only).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'vitest.node.config.ts');
const ROOT_CONFIG = resolve(REPO_ROOT, 'vitest.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W528.A /vitest.node.config.ts content parity', () => {
  const body = read(LIB) + read(ROOT_CONFIG);

  it("test-discovery framing pinned: 'globals: false' + 'environment: \"node\"' + 3-pattern include glob (apps/**/tests/**/*.test.ts + packages/**/tests/**/*.test.ts + scripts/tests/**/*.test.ts) + 3-pattern exclude (node_modules + dist + tests/e2e) + 10s test/hook timeouts — pinned so the test-discovery scope + 10s-timeouts commitment survives (drift to dropping any include pattern would silently exclude that subtree from CI; drift to tightening timeouts would flake legitimately slow tests)", () => {
    expect(body).toMatch(/globals: false,/);
    expect(body).toMatch(/environment: 'node',/);
    expect(body).toMatch(
      /include: \[\s*\n?\s*'apps\/\*\*\/tests\/\*\*\/\*\.test\.ts',\s*\n?\s*'packages\/\*\*\/tests\/\*\*\/\*\.test\.ts',\s*\n?\s*'scripts\/tests\/\*\*\/\*\.test\.ts',\s*\n?\s*\],/,
    );
    expect(body).toMatch(
      /exclude: \['\*\*\/node_modules\/\*\*', '\*\*\/dist\/\*\*', '\*\*\/tests\/e2e\/\*\*'\],/,
    );
    expect(body).toMatch(/testTimeout: 10_000,/);
    expect(body).toMatch(/hookTimeout: 10_000,/);
  });

  it("Coverage scope + the CORRECTED db-exclusion rationale pinned: 'Coverage scope: the meaningfully unit-/integration-tested surfaces only.' + the V-086 \"e2e only\" reason recorded as EXPIRED (66 integration files import src/db and run under vitest with DATABASE_URL set) + 'api-types schemas — Zod runtime, no .test.ts imports.' + 'Astro apps (marketing-site, customer-dashboard) — typechecked by `astro check`, not under vitest scope.' + 'GUI client (Tauri) — not in scope.' + 'Generated code (sdk-python\\'s _generated/, sdk-go).' — pinned so the V-086 e2e-only-Drizzle + 4 other exclusion-rationales commitment survives", () => {
    expect(body).toMatch(/\/\/ Coverage scope: the meaningfully unit-\/integration-tested/);
    expect(body).toMatch(
      /Drizzle repos \(`apps\/server\/src\/db\/`\)\. The V-086 audit recorded[\s\S]{0,400}?NO LONGER TRUE[\s\S]{0,400}?66 integration files/,
    );
    expect(body).toMatch(/\/\/\s+- api-types schemas — Zod runtime, no \.test\.ts imports\./);
    expect(body).toMatch(
      /\/\/\s+- Astro apps \(marketing-site, customer-dashboard\) — typechecked\s*\n?\s*\/\/\s+by `astro check`, not under vitest scope\./,
    );
    expect(body).toMatch(/\/\/\s+- GUI client \(Tauri\) — not in scope\./);
    expect(body).toMatch(/\/\/\s+- Generated code \(sdk-python's _generated\/, sdk-go\)\./);
  });

  it('Coverage include/exclude framing pinned: \'include: ["apps/server/src/**/*.ts", "packages/sdk-typescript/src/**/*.ts"]\' + \'exclude: [...test files, tests/, db/** (V-086 e2e), index.ts (bootstrap), dump-openapi.ts (CLI)]\' — pinned so the coverage-scope (apps/server + sdk-typescript only) + 3 special exclusions (db + index + dump-openapi) commitment survives', () => {
    expect(body).toMatch(/provider: 'v8',/);
    expect(body).toMatch(/reporter: \['text', 'json-summary', 'html'\],/);
    expect(body).toMatch(
      /include: \['apps\/server\/src\/\*\*\/\*\.ts', 'packages\/sdk-typescript\/src\/\*\*\/\*\.ts'\],/,
    );
    // 2026-08-16: the "e2e only" reason expired — 66 integration files import
    // from src/db/ and run under vitest with DATABASE_URL set. The exclusion
    // itself is unchanged; only its stated justification moved, and the pin
    // moves with it in the same commit.
    expect(body).toMatch(
      /'apps\/server\/src\/db\/\*\*', \/\/ Drizzle repos — justification expired, see note/,
    );
    expect(body).not.toMatch(/Drizzle repos — e2e only/);
    expect(body).not.toMatch(
      /exercised by e2e\s*\n?\s*\/\/\s+against real Postgres, not by vitest/,
    );
    expect(body).toMatch(/'apps\/server\/src\/index\.ts', \/\/ bootstrap entry/);
    expect(body).toMatch(/'apps\/server\/src\/lib\/dump-openapi\.ts', \/\/ CLI tool/);
    expect(body).toMatch(/excludeAfterRemap: true,/);
  });

  it("V-107 regression-gate threshold framing pinned: 'V-107: regression gate, not aspirational target. Thresholds are set ~5% below current baseline so a meaningful drop fails CI but small noise doesn't false-positive. Ratchet upward as coverage improves; never ratchet downward to mask a regression.' + the four enforced thresholds, which the assertions below read from vitest.config.ts rather than restate — pinned so the V-107 anchor + regression-gate-posture + ratchet-upward-only commitment survives. V-803 corrected the stale figures in this file's HEADER and left them in this TITLE; V-826 removed them here, because a number in a title is the one place nothing checks it (drift to lowering any threshold without parallel ratchet-upward would silently mask coverage regressions)", () => {
    expect(body).toMatch(
      /\/\/ V-107: regression gate, not aspirational target\. Thresholds are\s*\n?\s*\/\/ set ~5% below current baseline so a meaningful drop fails CI but\s*\n?\s*\/\/ small noise doesn't false-positive\. Ratchet upward as coverage\s*\n?\s*\/\/ improves; never ratchet downward to mask a regression\./,
    );
    expect(body).toMatch(
      /thresholds: \{\s*\n?\s*lines: 85,\s*\n?\s*statements: 83,\s*\n?\s*functions: 84,\s*\n?\s*branches: 75,\s*\n?\s*\},/,
    );
  });

  it('V-120 benchmark separation framing pinned: \'V-120: bench files run via `npm run bench`. Excluded from the standard `npm test` `include` glob above so unit tests stay fast.\' + \'benchmark: { include: ["apps/**/tests/bench/**/*.bench.ts", "packages/**/tests/bench/**/*.bench.ts"], exclude: [node_modules + dist] }\' — pinned so the V-120 anchor + bench-glob-isolation (npm run bench vs npm test) + unit-tests-stay-fast commitment survives', () => {
    expect(body).toMatch(
      /\/\/ V-120: bench files run via `npm run bench`\. Excluded from the\s*\n?\s*\/\/ standard `npm test` `include` glob above so unit tests stay fast\./,
    );
    expect(body).toMatch(
      /include: \['apps\/\*\*\/tests\/bench\/\*\*\/\*\.bench\.ts', 'packages\/\*\*\/tests\/bench\/\*\*\/\*\.bench\.ts'\],/,
    );
    expect(body).toMatch(/exclude: \['\*\*\/node_modules\/\*\*', '\*\*\/dist\/\*\*'\],/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
