// W675 — cross-SDK error-class parity. Drift guard that asserts the
// 3 first-party SDKs (sdk-go + sdk-python + sdk-typescript) all
// expose the SAME canonical set of typed error classes.
//
// Companion to W649 (cross-SDK verb parity) — that one pinned the
// /v1/* wire path surface; this one pins the typed-error class
// surface customers `instanceof`-check against. Drift here would
// silently fragment the cross-language error-handling contract:
// customer code that catches `RateLimitError` on the TS SDK would
// have no equivalent in the Go SDK if it got renamed.
//
// Methodology: each SDK uses a different declaration syntax —
//
//   - sdk-typescript: `export class FooError extends DriftstackError`
//   - sdk-go:         `type FooError struct{ apiError }`
//   - sdk-python:     `class FooError(DriftstackError):`
//
// We extract the set of "FooError" symbols from each error file and
// assert the canonical 21-class shared set is a subset of every
// SDK\'s declared classes. SDK-specific extras are allowed:
//   - sdk-go has UnknownError + QuotaExceededError + apiError
//     (the embedded base struct) + BadRequestError
//   - sdk-python has SessionNotFoundError (subclass of NotFoundError)
//     + QuotaExceededError + BadRequestError
//   - sdk-typescript has BadRequestError + InternalError +
//     TierLimitError (some Go/Python equivalents subclass differently)
//   NOTE: BadRequestError now exists in all 3 SDKs (the generic-400
//   `bad-request` problem-type maps to it everywhere, distinct from
//   `validation-failed` → ValidationError); it stays out of the
//   canonical SHARED set below for backward compat with that pinned set.
//
// The 21-shared-class invariant is what threads error handling
// across the 3 SDKs. Drift to renaming any one in any SDK would
// break customer's `catch (err) { if (err instanceof FooError) ... }`
// pattern.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const GO_ERRORS = resolve(REPO_ROOT, 'packages/sdk-go/errors.go');
const PY_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');

/** Extract the set of typed error class names from each SDK's error file. */
function extractTsErrorClasses(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/export class (\w+Error) extends/g)) {
    out.add(m[1]!);
  }
  return out;
}

function extractGoErrorClasses(source: string): Set<string> {
  const out = new Set<string>();
  // `type FooError struct{ ... }` declarations.
  for (const m of source.matchAll(/^type (\w+Error) struct/gm)) {
    out.add(m[1]!);
  }
  return out;
}

function extractPythonErrorClasses(source: string): Set<string> {
  const out = new Set<string>();
  // `class FooError(BaseClass):` declarations.
  for (const m of source.matchAll(/^class (\w+Error)\(/gm)) {
    out.add(m[1]!);
  }
  return out;
}

// The CANONICAL shared error classes. Every SDK MUST declare every
// class in this set; SDK-specific extras are allowed but not asserted
// here. Sorted for diff-friendly drift detection.
const SHARED_ERROR_CLASSES = new Set([
  'AuthError',
  'ConcurrencyLimitError',
  'ConflictError',
  'DriverError',
  'EmailAlreadyRegisteredError',
  'EmailNotVerifiedError',
  'ExpiredKeyError',
  'FeatureUnavailableError',
  'ForbiddenError',
  'InvalidAuthTokenError',
  'InvalidCredentialsError',
  'InvalidKeyError',
  'LegalAcceptanceRequiredError',
  'MfaStepUpRequiredError',
  'NotFoundError',
  'RateLimitError',
  'RevokedKeyError',
  'SessionDestroyedError',
  'SessionTimeoutError',
  'TransportError',
  'ValidationError',
]);

describe('W675 cross-SDK error-class parity', () => {
  it('all 3 SDK error files exist at canonical paths', () => {
    expect(existsSync(TS_ERRORS), `missing ${TS_ERRORS}`).toBe(true);
    expect(existsSync(GO_ERRORS), `missing ${GO_ERRORS}`).toBe(true);
    expect(existsSync(PY_ERRORS), `missing ${PY_ERRORS}`).toBe(true);
  });

  it('sdk-typescript declares the 21 canonical shared error classes', () => {
    const ts = extractTsErrorClasses(read(TS_ERRORS));
    for (const cls of SHARED_ERROR_CLASSES) {
      expect(ts.has(cls), `sdk-typescript missing ${cls}`).toBe(true);
    }
  });

  it('sdk-go declares the 21 canonical shared error classes', () => {
    const go = extractGoErrorClasses(read(GO_ERRORS));
    for (const cls of SHARED_ERROR_CLASSES) {
      expect(go.has(cls), `sdk-go missing ${cls}`).toBe(true);
    }
  });

  it('sdk-python declares the 21 canonical shared error classes', () => {
    const py = extractPythonErrorClasses(read(PY_ERRORS));
    for (const cls of SHARED_ERROR_CLASSES) {
      expect(py.has(cls), `sdk-python missing ${cls}`).toBe(true);
    }
  });

  it("CROSS-SDK invariant — the 21 canonical shared error classes are a SUBSET of every SDK's declared error classes. Drift to renaming any one would break customer `catch` blocks that use `instanceof`/`as`/`isinstance` on that class name.", () => {
    const ts = extractTsErrorClasses(read(TS_ERRORS));
    const go = extractGoErrorClasses(read(GO_ERRORS));
    const py = extractPythonErrorClasses(read(PY_ERRORS));

    // Each SDK must contain every class in the canonical set.
    for (const cls of SHARED_ERROR_CLASSES) {
      expect(ts.has(cls), `sdk-typescript missing canonical ${cls}`).toBe(true);
      expect(go.has(cls), `sdk-go missing canonical ${cls}`).toBe(true);
      expect(py.has(cls), `sdk-python missing canonical ${cls}`).toBe(true);
    }

    // Drift-detection sanity: every SDK has at least 21 classes (the
    // canonical set). Drift to a smaller error surface would be a
    // breaking change worth catching here.
    expect(ts.size, `sdk-typescript error class count`).toBeGreaterThanOrEqual(21);
    expect(go.size, `sdk-go error class count`).toBeGreaterThanOrEqual(21);
    expect(py.size, `sdk-python error class count`).toBeGreaterThanOrEqual(21);
  });

  it("SDK-extras roster pinned per SDK — drift to dropping any extra would silently shrink that SDK's typed-error surface. sdk-typescript: BadRequestError + InternalError + TierLimitError. sdk-go: BadRequestError + QuotaExceededError + UnknownError + InternalError (NOT TierLimitError — that type exists only in the TypeScript SDK; Go maps `tier-limit` to QuotaExceededError). sdk-python: BadRequestError + QuotaExceededError + SessionNotFoundError. (BadRequestError now exists in ALL 3 SDKs — the generic-400 `bad-request` problem-type maps to it everywhere, distinct from `validation-failed` → ValidationError.)", () => {
    const ts = extractTsErrorClasses(read(TS_ERRORS));
    // sdk-typescript extras: BadRequestError (4xx generic) + InternalError (5xx generic) + TierLimitError.
    expect(ts.has('BadRequestError'), 'sdk-typescript should declare BadRequestError').toBe(true);
    expect(ts.has('InternalError'), 'sdk-typescript should declare InternalError').toBe(true);
    expect(ts.has('TierLimitError'), 'sdk-typescript should declare TierLimitError').toBe(true);

    const go = extractGoErrorClasses(read(GO_ERRORS));
    // sdk-go extras: BadRequestError + QuotaExceededError + UnknownError + InternalError.
    expect(go.has('BadRequestError'), 'sdk-go should declare BadRequestError').toBe(true);
    expect(go.has('QuotaExceededError'), 'sdk-go should declare QuotaExceededError').toBe(true);
    expect(go.has('UnknownError'), 'sdk-go should declare UnknownError').toBe(true);
    expect(go.has('InternalError'), 'sdk-go should declare InternalError').toBe(true);

    const py = extractPythonErrorClasses(read(PY_ERRORS));
    // sdk-python extras: BadRequestError + QuotaExceededError + SessionNotFoundError (subclass of NotFoundError).
    expect(py.has('BadRequestError'), 'sdk-python should declare BadRequestError').toBe(true);
    expect(py.has('QuotaExceededError'), 'sdk-python should declare QuotaExceededError').toBe(true);
    expect(py.has('SessionNotFoundError'), 'sdk-python should declare SessionNotFoundError').toBe(
      true,
    );
  });

  it('test file metadata — file exists at canonical path + 21 canonical shared classes pinned in module-level SHARED_ERROR_CLASSES set. Drift to a different count would mean the canonical set itself was modified — review carefully.', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-error-parity.test.ts')),
    ).toBe(true);
    expect(SHARED_ERROR_CLASSES.size, 'canonical shared error class count').toBe(21);
  });
});
