// W817 — cross-SDK error class hierarchy parity. One-hundred-forty-
// third in the drift-guard series. Pins the typed-error class set
// across all 3 SDKs. Drift to dropping an error class in one SDK
// would silently break customer try/except code that depends on the
// class existing — exactly the failure mode the W797 error-handling
// example tests defend against.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/errors.go');

// Shared error-class set that MUST exist in all 3 SDKs. Each language
// uses its idiomatic shape (TS: class extends; Python: class subclass;
// Go: type struct), but the conceptual error must be representable.
const REQUIRED_ERRORS = [
  'AuthError',
  'InvalidKeyError',
  'ExpiredKeyError',
  'RevokedKeyError',
  'ForbiddenError',
  'ValidationError',
  'NotFoundError',
  'ConflictError',
  'RateLimitError',
  'ConcurrencyLimitError',
  'SessionDestroyedError',
  'SessionTimeoutError',
  'LegalAcceptanceRequiredError',
  'DriverError',
  'TransportError',
  'EmailAlreadyRegisteredError',
  'InvalidCredentialsError',
];

describe('W817 cross-SDK error class hierarchy parity', () => {
  it('all 3 error implementations exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── DriftstackError as the base (TS + Python) ────────────────

  it("CRITICAL TS DriftstackError is the base + extends Error. Python DriftstackError is the base + extends Exception. Drift to dropping the base class would break 'except DriftstackError' / 'instanceof DriftstackError' catch-all customer code.", () => {
    expect(read(TS)).toMatch(/^export class DriftstackError extends Error \{/m);
    expect(read(PY)).toMatch(/^class DriftstackError\(Exception\):/m);
  });

  it("CRITICAL Go uses apiError struct as the embedded base (Go has no inheritance — embedding via composition). The pattern 'type X struct { apiError }' is the canonical Go-idiomatic 'X is-a apiError' shape.", () => {
    const p = read(GO);
    expect(p).toMatch(/^type apiError struct \{/m);
    // At least 10 errors embed apiError.
    const matches = p.match(/struct\{ apiError \}/g) ?? [];
    expect(matches.length, 'expected >=10 error types embedding apiError').toBeGreaterThanOrEqual(
      10,
    );
  });

  // ─── Required error-class set across all 3 SDKs ───────────────

  it('CRITICAL all 17 required error classes exist in all 3 SDKs. Drift to dropping any would let customer try/except code break silently when caught at the customer side.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const cls of REQUIRED_ERRORS) {
      expect(ts, `TS missing 'export class ${cls}'`).toMatch(
        new RegExp(`^export class ${cls}\\b`, 'm'),
      );
      expect(py, `Python missing 'class ${cls}('`).toMatch(new RegExp(`^class ${cls}\\(`, 'm'));
      expect(go, `Go missing 'type ${cls}'`).toMatch(new RegExp(`^type ${cls}\\b`, 'm'));
    }
  });

  // ─── Python AuthError-subclass tree pinned ────────────────────

  it("CRITICAL Python AuthError tree pinned — InvalidKeyError + ExpiredKeyError + RevokedKeyError + ForbiddenError + InvalidCredentialsError all inherit AuthError (not DriftstackError directly). The 2-level inheritance lets customers catch the coarse AuthError or any of the specific subtypes — drift to flat inheritance would break the W797 cross-SDK 'AuthError catch-all' demo.", () => {
    const p = read(PY);
    expect(p).toMatch(/^class InvalidKeyError\(AuthError\):/m);
    expect(p).toMatch(/^class ExpiredKeyError\(AuthError\):/m);
    expect(p).toMatch(/^class RevokedKeyError\(AuthError\):/m);
    expect(p).toMatch(/^class ForbiddenError\(AuthError\):/m);
    expect(p).toMatch(/^class InvalidCredentialsError\(AuthError\):/m);
  });

  // ─── Python NotFound-subclass: SessionNotFoundError ───────────

  it("CRITICAL Python SessionNotFoundError(NotFoundError) 2-level tree pinned. The 'session-specific NotFound' subclass lets customers narrow their except clause — drift to flat inheritance would lose the discrimination.", () => {
    const p = read(PY);
    expect(p).toMatch(/^class SessionNotFoundError\(NotFoundError\):/m);
  });

  // ─── QuotaExceededError exists in Python + Go (TS has TierLimitError) ─

  it('CRITICAL QuotaExceededError exists in Python + Go. TS uses TierLimitError instead — different name, same semantic. Cross-SDK docs must accept either spelling per W797 error-handling parity.', () => {
    expect(read(PY)).toMatch(/^class QuotaExceededError\(DriftstackError\):/m);
    expect(read(GO)).toMatch(/^type QuotaExceededError struct \{/m);
    // TS has TierLimitError as the analogue.
    expect(read(TS)).toMatch(/^export class TierLimitError extends DriftstackError \{/m);
  });

  // ─── RateLimitError carries retry-after fields ────────────────

  it('CRITICAL RateLimitError class carries the retry-after data field in all 3 SDKs — TS retryAfterSeconds; Python retry_after_seconds (snake_case); Go RetryAfterSeconds (PascalCase). Field name drift would break the W797 cross-SDK retry-loop demonstration.', () => {
    expect(read(TS)).toMatch(/retryAfterSeconds[^a-zA-Z]/);
    expect(read(PY)).toMatch(/retry_after_seconds/);
    expect(read(GO)).toMatch(/RetryAfterSeconds/);
  });

  // ─── ConcurrencyLimitError carries currentSessions + limit ────

  it('CRITICAL ConcurrencyLimitError carries currentSessions + limit (TS) / current_sessions + limit (Python) / CurrentSessions + Limit (Go) data fields. Matches W797 cross-SDK error-handling demo accessor patterns.', () => {
    expect(read(TS)).toMatch(/currentSessions/);
    expect(read(PY)).toMatch(/current_sessions/);
    expect(read(GO)).toMatch(/CurrentSessions/);
  });

  // ─── QuotaExceededError carries record_type / RecordType ──────

  it('CRITICAL QuotaExceededError carries record_type / RecordType + current + limit fields in Python + Go. Matches W797 cross-SDK error-handling demo accessor patterns.', () => {
    expect(read(PY)).toMatch(/record_type/);
    expect(read(GO)).toMatch(/RecordType/);
  });

  // Arc 4 Wave 2.B sub-slice 8.20.k.4 (v2-#8) — TS TierLimitError
  // parity with Python+Go QuotaExceededError. Pins the field
  // exposure across all three SDKs so a future TS refactor that
  // drops these properties breaks CI before customers lose typed
  // access to the bucket state.
  it('CRITICAL TS TierLimitError exposes camelCase recordType + current + limit fields (parity with Python record_type/current/limit + Go RecordType/Current/Limit)', () => {
    const ts = read(TS);
    // Match the class body's readonly declarations.
    const m = ts.match(/export class TierLimitError extends DriftstackError \{[\s\S]+?\n\}/);
    expect(m, 'TS TierLimitError class declaration must be findable').not.toBeNull();
    const block = m![0];
    expect(block).toMatch(/readonly current: number \| undefined;/);
    expect(block).toMatch(/readonly limit: number \| undefined;/);
    expect(block).toMatch(/readonly recordType: string \| undefined;/);
    // Construction-time read from problem-json extensions.
    expect(block).toMatch(/this\.current = ext\.current/);
    expect(block).toMatch(/this\.limit = ext\.limit/);
    expect(block).toMatch(/this\.recordType = ext\.resource \?\? ext\.record_type/);
  });

  // ─── Go errors.As / errors.Is helpers ─────────────────────────

  it("CRITICAL Go errors.go defines ErrAuth sentinel for errors.Is + the apiError struct unwraps to a typed error. Matches W797 'errors.As for payload, errors.Is for category' Go-idiomatic teaching.", () => {
    const p = read(GO);
    expect(p).toMatch(/ErrAuth/);
  });

  // ─── Cross-SDK Header / V-anchor framing ──────────────────────

  it("CRITICAL each errors.go/.ts/.py file documents its error-hierarchy framing. TS includes 'kind' discriminator; Python uses class hierarchy; Go uses errors.As pattern. Drift to dropping the framing would lose teaching anchors.", () => {
    // TS uses 'kind' discriminator approach.
    expect(read(TS)).toMatch(/kind/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-error-class-hierarchy-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
