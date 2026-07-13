// W846 — workspace .npmrc + .prettierrc.json content parity. One-
// hundred-seventy-second in the drift-guard series. Pins critical
// workspace-level config files I haven't directly covered:
//   - .npmrc (NPM_TOKEN auth for publishing).
//   - .prettierrc.json (canonical formatter settings).
// Drift in .npmrc would either break npm publish or leak the token
// into the wrong registry. Drift in .prettierrc would create
// formatter-vs-codebase mismatch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// 2026-05-20 — .npmrc is gitignored (contains the NPM_TOKEN auth
// pattern + may carry per-operator publish credentials). On CI the
// runner has no .npmrc; skip the populated-file assertions when the
// file is absent so CI stays green while the local operator-side
// drift guard still fires.
const NPMRC_EXISTS = existsSync(resolve(REPO_ROOT, '.npmrc'));

describe('W846 workspace .npmrc + .prettierrc parity', () => {
  it('.prettierrc.json exists at canonical path (.npmrc is gitignored so existence-check is operator-side only)', () => {
    expect(existsSync(resolve(REPO_ROOT, '.prettierrc.json'))).toBe(true);
  });

  // ─── .npmrc (operator-side; gitignored so skipped on CI) ─────

  it.skipIf(!NPMRC_EXISTS)(
    "CRITICAL .npmrc declares NPM_TOKEN env-var auth for npmjs registry. The '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' line is the canonical CI-publish auth pattern. Drift to hardcoding a real token would catastrophically leak; drift to dropping the auth line would break npm publish.",
    () => {
      const p = read(resolve(REPO_ROOT, '.npmrc'));
      expect(p).toMatch(/\/\/registry\.npmjs\.org\/:_authToken=\$\{NPM_TOKEN\}/);
    },
  );

  it.skipIf(!NPMRC_EXISTS)(
    'CRITICAL .npmrc registry pinned to https://registry.npmjs.org/. Drift to a different registry (e.g. private fork, mirror) would let npm install pull tampered packages.',
    () => {
      const p = read(resolve(REPO_ROOT, '.npmrc'));
      expect(p).toMatch(/^registry=https:\/\/registry\.npmjs\.org\/$/m);
    },
  );

  it.skipIf(!NPMRC_EXISTS)(
    "CRITICAL .npmrc omits the removed 'always-auth' project setting. npm 11 warns for either value and the next major will stop accepting it; registry-scoped _authToken already limits credential use to registry.npmjs.org.",
    () => {
      const p = read(resolve(REPO_ROOT, '.npmrc'));
      expect(p).not.toMatch(/^always-auth\s*=/m);
    },
  );

  it.skipIf(!NPMRC_EXISTS)(
    'CRITICAL .npmrc does NOT contain a hardcoded token (must use ${NPM_TOKEN} env-var substitution). Defense against accidental token commits.',
    () => {
      const p = read(resolve(REPO_ROOT, '.npmrc'));
      // No literal 'npm_' token (40+ chars) shape.
      expect(p, '.npmrc must not contain hardcoded npm_* token').not.toMatch(
        /npm_[A-Za-z0-9]{30,}/,
      );
    },
  );

  // ─── .prettierrc.json ────────────────────────────────────────

  it("CRITICAL .prettierrc.json declares the 8-canonical-setting set — semi:true + singleQuote:true + trailingComma:'all' + printWidth:100 + tabWidth:2 + useTabs:false + arrowParens:'always' + endOfLine:'lf'. Drift would cause formatter-vs-codebase mismatch + churn on every save.", () => {
    const p = JSON.parse(read(resolve(REPO_ROOT, '.prettierrc.json'))) as Record<string, unknown>;
    expect(p.semi).toBe(true);
    expect(p.singleQuote).toBe(true);
    expect(p.trailingComma).toBe('all');
    expect(p.printWidth).toBe(100);
    expect(p.tabWidth).toBe(2);
    expect(p.useTabs).toBe(false);
    expect(p.arrowParens).toBe('always');
    expect(p.endOfLine).toBe('lf');
  });

  it('CRITICAL .prettierrc.json contains EXACTLY 8 settings (snapshot). Drift to adding a new setting without updating this test would let formatter behavior change silently.', () => {
    const p = JSON.parse(read(resolve(REPO_ROOT, '.prettierrc.json'))) as Record<string, unknown>;
    expect(Object.keys(p).length).toBe(8);
  });

  // ─── .prettierignore ─────────────────────────────────────────

  it('CRITICAL .prettierignore blocks formatting on generated files — node_modules + dist + build + coverage + *.tsbuildinfo + package-lock.json + LICENSE + Drizzle migrations. Drift to formatting Drizzle migrations would corrupt the migration journal hash chain.', () => {
    const p = read(resolve(REPO_ROOT, '.prettierignore'));
    expect(p).toMatch(/^node_modules\/$/m);
    expect(p).toMatch(/^dist\/$/m);
    expect(p).toMatch(/^build\/$/m);
    expect(p).toMatch(/^coverage\/$/m);
    expect(p).toMatch(/^\*\.tsbuildinfo$/m);
    expect(p).toMatch(/^package-lock\.json$/m);
    expect(p).toMatch(/^LICENSE$/m);
    expect(p).toMatch(/apps\/server\/src\/db\/migrations\//);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/workspace-npmrc-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
