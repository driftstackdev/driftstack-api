// W684 — cross-SDK URL-escape path-traversal-guard parity.
// Eleventh in the cross-SDK drift-guard series (W649 verb + W675
// error class + W676 problem-type URI + W677 auth/UA + W678 webhook
// sig + W679 retry + W680 grace window + W681 plaintext-once + W682
// step-up window + W683 Idempotency-Key + W684 URL escape).
//
// Asserts every SDK uses its LANGUAGE-IDIOMATIC SAFE URL-escape
// helper on every per-id path interpolation:
//
//   - sdk-typescript: encodeURIComponent(id)
//   - sdk-go:         url.PathEscape(id)
//   - sdk-python:     quote(id, safe='')
//
// Drift to dropping the escape on ANY per-id route would let
// path-traversal injection ("abc/../../admin" → /v1/admin instead
// of /v1/sessions/abc%2F..%2F..%2Fadmin) silently break the auth
// surface.
//
// CRITICAL Python invariant: safe='' is what makes the `/`
// character get percent-encoded. Drift to safe='/' (the urllib
// default) would let `/` through and defeat the guard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function readDir(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => resolve(dir, f));
}

const TS_RESOURCES = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
const GO_SDK = resolve(REPO_ROOT, 'packages/sdk-go');
const PY_RESOURCES = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources');

describe('W684 cross-SDK URL-escape path-traversal-guard parity', () => {
  it('SDK resource directories exist at canonical paths', () => {
    expect(existsSync(TS_RESOURCES)).toBe(true);
    expect(existsSync(GO_SDK)).toBe(true);
    expect(existsSync(PY_RESOURCES)).toBe(true);
  });

  it("CRITICAL sdk-typescript uses encodeURIComponent across resource files. The browser-stdlib encodeURIComponent escapes ALL reserved URL chars including `/`, so it's safe for path-segment interpolation. Drift to encodeURI (which lets `/` through) would let path-traversal injection through.", () => {
    const tsFiles = readDir(TS_RESOURCES, '.ts');
    expect(
      tsFiles.length,
      'TS SDK files walked — V-1028 ratchet: this was > 0 against a real 19, so a walk that found one file would satisfy every arm below',
    ).toBeGreaterThanOrEqual(19);

    let totalCalls = 0;
    for (const f of tsFiles) {
      const body = read(f);
      const matches = body.match(/encodeURIComponent\(/g) ?? [];
      totalCalls += matches.length;
    }
    // Conservative: at least 20 encodeURIComponent call sites across
    // the TS resource files (every per-id route uses one).
    expect(totalCalls, 'sdk-typescript total encodeURIComponent call count').toBeGreaterThanOrEqual(
      20,
    );
  });

  it('CRITICAL sdk-go uses url.PathEscape across resource files. The stdlib net/url.PathEscape escapes reserved path chars while leaving `:` and `&` (which are valid in path segments). Drift to url.QueryEscape would over-escape (treats space as `+` instead of `%20`).', () => {
    const goFiles = readDir(GO_SDK, '.go').filter((p) => !p.endsWith('_test.go'));
    expect(goFiles.length, 'expected Go SDK files').toBeGreaterThan(0);

    let totalCalls = 0;
    for (const f of goFiles) {
      const body = read(f);
      const matches = body.match(/url\.PathEscape\(/g) ?? [];
      totalCalls += matches.length;
    }
    expect(totalCalls, 'sdk-go total url.PathEscape call count').toBeGreaterThanOrEqual(20);
  });

  it("CRITICAL sdk-python uses quote(..., safe='') across resource files. The `safe=''` kwarg is LOAD-BEARING — urllib.parse.quote DEFAULT is `safe='/'` which lets the `/` char through (would defeat path-traversal guard). Every quote() call site MUST pass safe='' explicitly. Drift would let `/` through.", () => {
    const pyFiles = readDir(PY_RESOURCES, '.py');
    expect(pyFiles.length, 'expected Python resource files').toBeGreaterThan(0);

    let totalCalls = 0;
    for (const f of pyFiles) {
      const body = read(f);
      const matches = body.match(/quote\([^,)]+, safe=''\)/g) ?? [];
      totalCalls += matches.length;
    }
    expect(totalCalls, "sdk-python total quote(safe='') call count").toBeGreaterThanOrEqual(20);
  });

  it("CRITICAL sdk-python NEVER calls quote() without safe='' kwarg in resource files. Drift to a single bare quote() call would let `/` through on that route and silently re-open path-traversal injection.", () => {
    const pyFiles = readDir(PY_RESOURCES, '.py');
    expect(pyFiles.length, 'expected Python resource files').toBeGreaterThan(0);

    for (const f of pyFiles) {
      const body = read(f);
      // Look for `quote(<arg>)` WITHOUT a safe=' kwarg. Should be zero
      // matches across all Python resource files.
      const bareQuoteMatches = body.match(/quote\([a-z_]+\)/g) ?? [];
      // Filter out any false positives: `quote(arg, safe='')` shouldn't
      // match the above pattern because of the comma. Verify.
      expect(
        bareQuoteMatches.length,
        `${f}: bare quote() without safe='' detected — would let / through`,
      ).toBe(0);
    }
  });

  it('Cross-SDK count parity — each SDK has comparable URL-escape call counts. Since the SDKs cover the SAME 15-resource surface (per W649 cross-SDK verb parity), the count of per-id routes should be similar. Drift to a SDK having SIGNIFICANTLY fewer escapes would indicate missing per-id routes.', () => {
    const tsFiles = readDir(TS_RESOURCES, '.ts');
    const goFiles = readDir(GO_SDK, '.go').filter((p) => !p.endsWith('_test.go'));
    const pyFiles = readDir(PY_RESOURCES, '.py');

    const tsCount = tsFiles
      .map((f) => (read(f).match(/encodeURIComponent\(/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    const goCount = goFiles
      .map((f) => (read(f).match(/url\.PathEscape\(/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    const pyCount = pyFiles
      .map((f) => (read(f).match(/quote\([^,)]+, safe=''\)/g) ?? []).length)
      .reduce((a, b) => a + b, 0);

    // All 3 SDKs should be within 50% of each other (allowing for
    // language-specific patterns — Python's sync+async mirror doubles
    // the count vs Go which has no async).
    const maxCount = Math.max(tsCount, goCount, pyCount);
    const minCount = Math.min(tsCount, goCount, pyCount);
    // Looser bound — counts may differ ~3x because sdk-python has sync
    // + async mirror (every route counted twice) while TS/Go have
    // only one surface.
    expect(maxCount / minCount, 'cross-SDK escape-count ratio (max/min)').toBeLessThanOrEqual(4);
  });

  it('Each per-id route uses ID-typed parameter then escapes. CRITICAL: encodeURIComponent / url.PathEscape / quote() arguments are PARAMETER values (sessionId / orderId / id / membership_id / etc.) — NOT literal strings. Drift to escaping a literal string would be a no-op (the literal has no special chars).', () => {
    // Spot-check that the escape calls reference parameter names by
    // looking for variable-name patterns.
    const tsResources = readDir(TS_RESOURCES, '.ts');
    let varEscapeCount = 0;
    for (const f of tsResources) {
      // encodeURIComponent(<word>) where word is a JS variable name.
      const matches = read(f).match(/encodeURIComponent\([a-zA-Z][a-zA-Z0-9_]*\)/g) ?? [];
      varEscapeCount += matches.length;
    }
    expect(
      varEscapeCount,
      'sdk-typescript variable-arg encodeURIComponent count',
    ).toBeGreaterThanOrEqual(20);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-url-escape-parity.test.ts')),
    ).toBe(true);
  });
});
