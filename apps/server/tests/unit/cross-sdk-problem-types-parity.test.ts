// v2-#24 — cross-SDK PROBLEM_TYPES → error class parity.
//
// Pins that every customer-visible problem-type URI exported from
// `@driftstack/api-types` (PROBLEM_TYPES) is mapped to a typed error
// subclass in every SDK:
//
//   - TypeScript SDK: packages/sdk-typescript/src/errors.ts — the
//     TYPE_TO_CTOR mapping table + special-cased RateLimited.
//   - Python SDK: packages/sdk-python/src/driftstack/errors.py — the
//     PROBLEM_TYPE_TO_ERROR mapping table.
//   - Go SDK: packages/sdk-go/error_mapping.go — the
//     problemTypeToFactory mapping table.
//
// Drift example this catches:
//   • api-types gains a new PROBLEM_TYPES entry → all 3 SDKs must
//     reference the URI (otherwise customers see DriftstackError /
//     UnknownError generic fallback when they could've caught a
//     specific subclass).
//   • SDK references a problem-type URI that api-types doesn't export
//     → the SDK is mapping against a phantom contract; production
//     server never emits that URI so the typed branch is dead code.
//
// The test reads each SDK source file as text + greps for the URI
// substring. We don't try to load Python or Go modules from the
// TypeScript test runner — string-level parity is sufficient since the
// URIs are the wire-stable contract and any typo would also fail the
// SDK's own runtime mapping.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const TS_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const PY_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');
const GO_ERROR_MAPPING = resolve(REPO_ROOT, 'packages/sdk-go/error_mapping.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2-#24 cross-SDK PROBLEM_TYPES → error class parity', () => {
  it('SDK error files exist at canonical paths', () => {
    expect(existsSync(TS_ERRORS)).toBe(true);
    expect(existsSync(PY_ERRORS)).toBe(true);
    expect(existsSync(GO_ERROR_MAPPING)).toBe(true);
  });

  it('CRITICAL every PROBLEM_TYPES URI is referenced in the TypeScript SDK errors.ts (TYPE_TO_CTOR map OR special-cased in errorFromProblem)', () => {
    const body = read(TS_ERRORS);
    for (const [name, uri] of Object.entries(PROBLEM_TYPES)) {
      expect(body, `TS SDK is missing a mapping for PROBLEM_TYPES.${name} (${uri})`).toContain(uri);
    }
  });

  it('CRITICAL every PROBLEM_TYPES URI is referenced in the Python SDK errors.py (PROBLEM_TYPE_TO_ERROR map)', () => {
    const body = read(PY_ERRORS);
    for (const [name, uri] of Object.entries(PROBLEM_TYPES)) {
      expect(body, `Python SDK is missing a mapping for PROBLEM_TYPES.${name} (${uri})`).toContain(
        uri,
      );
    }
  });

  it('CRITICAL every PROBLEM_TYPES URI is referenced in the Go SDK error_mapping.go (problemTypeToFactory map)', () => {
    const body = read(GO_ERROR_MAPPING);
    for (const [name, uri] of Object.entries(PROBLEM_TYPES)) {
      expect(body, `Go SDK is missing a mapping for PROBLEM_TYPES.${name} (${uri})`).toContain(uri);
    }
  });

  it('CRITICAL no SDK references a problem-type URI that api-types does NOT export — drift would surface a typed error class for an URI the server can never emit', () => {
    const known = new Set<string>(Object.values(PROBLEM_TYPES));
    const URI_RE = /https:\/\/errors\.driftstack\.dev\/[a-z-]+/g;
    for (const [label, path] of [
      ['TS SDK', TS_ERRORS],
      ['Python SDK', PY_ERRORS],
      ['Go SDK', GO_ERROR_MAPPING],
    ] as const) {
      const body = read(path);
      const found = body.match(URI_RE) ?? [];
      const unique = new Set(found);
      for (const uri of unique) {
        expect(known, `${label} references unknown problem-type URI ${uri}`).toContain(uri);
      }
    }
  });
});
