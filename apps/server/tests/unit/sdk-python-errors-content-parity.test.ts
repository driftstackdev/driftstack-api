// W585.B — drift guard for packages/sdk-python/src/driftstack/errors.py.
// DriftstackError hierarchy + RFC 7807 problem-type mapping. Drift
// here either drops an exception subclass (callers lose specific
// catch granularity) or breaks the problem-type URI → subclass map
// (HTTP layer mis-routes a problem to the wrong subclass).
//
//   • Base DriftstackError carries message + status + problem_type
//     + parsed problem dict.
//   • V-490 is_retryable() predicate: TransportError + InternalError
//     + RateLimitError = retryable; everything else = not.
//   • PROBLEM_TYPE_TO_ERROR maps server problem-type URIs to subclass.
//   • Auth-flow + V-115 + V-439 + V-353e subclasses pinned.
//   • Specific fields on subclasses (retry_after_seconds, timeout_ms,
//     pending_acceptances, current_sessions, current/limit/record_type).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W585.B packages/sdk-python/src/driftstack/errors.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + RFC 7807 server mirror + problem-types.ts cross-ref + catch-with-granularity example pinned', () => {
    expect(body).toMatch(/^"""Error class hierarchy for the Driftstack Python SDK\.\n/);
    expect(body).toMatch(
      /Mirrors the server's RFC 7807 problem-types \(apps\/server\/src\/lib\/errors\.ts\)\./,
    );
    expect(body).toMatch(/The HTTP layer maps `application\/problem\+json` responses to the right/);
    expect(body).toMatch(/subclass; non-HTTP failures \(timeouts, parse errors, network\) raise/);
    expect(body).toMatch(/``TransportError``\./);
    expect(body).toMatch(/Callers can catch with the granularity they need::/);
    expect(body).toMatch(/except RateLimitError as e:/);
    expect(body).toMatch(/time\.sleep\(e\.retry_after_seconds or 1\)/);
  });

  it('Base DriftstackError(Exception): message + status + problem_type + problem dict; AuthError/InvalidKeyError/ExpiredKeyError/RevokedKeyError/ForbiddenError subclasses pinned (401/403)', () => {
    expect(body).toMatch(/^class DriftstackError\(Exception\):$/m);
    expect(body).toMatch(/"""Base for every error raised by the Driftstack SDK\./);
    expect(body).toMatch(/All HTTP-derived errors carry the parsed problem document so callers/);
    expect(body).toMatch(
      /can read additional fields \(``e\.problem\.get\("retry_after_seconds"\)``,/,
    );
    expect(body).toMatch(/``e\.problem\.get\("current_sessions"\)``, etc\.\) without knowing the/);
    expect(body).toMatch(/specific subclass shape\./);
    expect(body).toMatch(
      /def __init__\(\s*\n\s*self,\s*\n\s*message: str,\s*\n\s*\*,\s*\n\s*status: int \| None = None,\s*\n\s*problem_type: str \| None = None,\s*\n\s*problem: dict\[str, Any\] \| None = None,\s*\n\s*\) -> None:\s*\n\s*super\(\)\.__init__\(message\)\s*\n\s*self\.message = message\s*\n\s*self\.status = status\s*\n\s*self\.problem_type = problem_type\s*\n\s*self\.problem: dict\[str, Any\] = problem or \{\}/,
    );
    expect(body).toMatch(/^class AuthError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class InvalidKeyError\(AuthError\):$/m);
    expect(body).toMatch(/^class ExpiredKeyError\(AuthError\):$/m);
    expect(body).toMatch(/^class RevokedKeyError\(AuthError\):$/m);
    expect(body).toMatch(/^class ForbiddenError\(AuthError\):$/m);
  });

  it('Validation/domain subclasses pinned: ValidationError + NotFoundError + ConflictError + SessionNotFoundError(NotFoundError) + SessionDestroyedError + LegalAcceptanceRequiredError(pending_acceptances=409 default) + SessionTimeoutError(timeout_ms=504 default)', () => {
    expect(body).toMatch(/^class ValidationError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class NotFoundError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class ConflictError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class SessionNotFoundError\(NotFoundError\):$/m);
    expect(body).toMatch(/^class SessionDestroyedError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class LegalAcceptanceRequiredError\(DriftstackError\):$/m);
    expect(body).toMatch(/pending_acceptances: list\[dict\[str, str\]\] \| None = None,/);
    expect(body).toMatch(/status: int \| None = 409,/);
    expect(body).toMatch(/self\.pending_acceptances = pending_acceptances or \[\]/);
    expect(body).toMatch(/^class SessionTimeoutError\(DriftstackError\):$/m);
    expect(body).toMatch(/timeout_ms: int \| None = None,/);
    expect(body).toMatch(/status: int \| None = 504,/);
    expect(body).toMatch(/self\.timeout_ms = timeout_ms/);
  });

  it('Rate/quota subclasses pinned: RateLimitError(retry_after_seconds=429) + QuotaExceededError(current/limit/record_type=429) + ConcurrencyLimitError(current_sessions/limit=429) + DriverError + TransportError', () => {
    expect(body).toMatch(/^class RateLimitError\(DriftstackError\):$/m);
    expect(body).toMatch(
      /"""Token-bucket rate limit hit\. ``retry_after_seconds`` is the hint\."""/,
    );
    expect(body).toMatch(/retry_after_seconds: int \| None = None,/);
    expect(body).toMatch(/self\.retry_after_seconds = retry_after_seconds/);
    expect(body).toMatch(/^class QuotaExceededError\(DriftstackError\):$/m);
    expect(body).toMatch(
      /current: int \| None = None,\s*\n\s*limit: int \| None = None,\s*\n\s*record_type: str \| None = None,/,
    );
    expect(body).toMatch(/^class ConcurrencyLimitError\(DriftstackError\):$/m);
    expect(body).toMatch(/current_sessions: int \| None = None,\s*\n\s*limit: int \| None = None,/);
    expect(body).toMatch(
      /^class DriverError\(DriftstackError\):\s*\n\s*"""The driver returned an unrecoverable error during the operation\."""/m,
    );
    expect(body).toMatch(/^class TransportError\(DriftstackError\):$/m);
    expect(body).toMatch(
      /A network-level or response-parsing failure that didn't reach the server\./,
    );
  });

  it('Auth-flow V-079/V-115 + V-439 + V-353e subclasses pinned: EmailAlreadyRegisteredError + InvalidCredentialsError(AuthError) + InvalidAuthTokenError + EmailNotVerifiedError(ForbiddenError) + FeatureUnavailableError + MfaStepUpRequiredError + InternalError', () => {
    expect(body).toMatch(/^class EmailAlreadyRegisteredError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class InvalidCredentialsError\(AuthError\):$/m);
    expect(body).toMatch(/^class InvalidAuthTokenError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class EmailNotVerifiedError\(ForbiddenError\):$/m);
    expect(body).toMatch(/^class FeatureUnavailableError\(DriftstackError\):$/m);
    expect(body).toMatch(/\(e\.g\. avatar uploads when R2 isn't wired\)\. HTTP 503\./);
    expect(body).toMatch(/^class MfaStepUpRequiredError\(DriftstackError\):$/m);
    expect(body).toMatch(/V-353e — operation requires a fresh MFA proof \(15-minute step-up/);
    expect(body).toMatch(/freshness window\)\. Customer should call POST \/v1\/auth\/mfa\/step-up/);
    expect(body).toMatch(/with a TOTP code and retry the original request\./);
    expect(body).toMatch(/^class InternalError\(DriftstackError\):$/m);
    expect(body).toMatch(/Unhandled server-side error\./);
  });

  it('PROBLEM_TYPE_TO_ERROR mapping: 21 entries from server problem-types.ts pinned (bad-request → ValidationError + unauthorized + forbidden + not-found + conflict + rate-limited + concurrency-limit + tier-limit + revoked-key + expired-key + invalid-key + session-destroyed + session-timeout + legal-acceptance-required + driver-error + driver-not-integrated + validation-failed + email-already-registered + invalid-credentials + invalid-auth-token + email-not-verified + feature-unavailable + mfa-step-up-required + internal)', () => {
    expect(body).toMatch(/^PROBLEM_TYPE_TO_ERROR: dict\[str, type\[DriftstackError\]\] = \{$/m);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/bad-request": ValidationError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/unauthorized": AuthError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/forbidden": ForbiddenError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/not-found": NotFoundError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/conflict": ConflictError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/rate-limited": RateLimitError,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/concurrency-limit": ConcurrencyLimitError,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/tier-limit": QuotaExceededError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/revoked-key": RevokedKeyError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/expired-key": ExpiredKeyError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/invalid-key": InvalidKeyError,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/session-destroyed": SessionDestroyedError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/session-timeout": SessionTimeoutError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/legal-acceptance-required": LegalAcceptanceRequiredError,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/driver-error": DriverError,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/driver-not-integrated": DriverError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/validation-failed": ValidationError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/email-already-registered": EmailAlreadyRegisteredError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/invalid-credentials": InvalidCredentialsError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/invalid-auth-token": InvalidAuthTokenError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/email-not-verified": EmailNotVerifiedError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/feature-unavailable": FeatureUnavailableError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/mfa-step-up-required": MfaStepUpRequiredError,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/internal": InternalError,/);
  });

  it('V-490 is_retryable predicate + V-489 TS mirror reference + _RETRYABLE_TYPES tuple (TransportError + InternalError + RateLimitError) pinned', () => {
    expect(body).toMatch(/V-490 — public retry predicate\. Mirrors the V-489 TS implementation/);
    expect(body).toMatch(
      /\(packages\/sdk-typescript\/src\/errors\.ts:isRetryable\)\. Returns True for/,
    );
    expect(body).toMatch(/error kinds where a retry stands a reasonable chance of succeeding;/);
    expect(body).toMatch(/Retryable: TransportError \(network failure\), InternalError \(5xx\),/);
    expect(body).toMatch(/RateLimitError \(429 with Retry-After hint\)\./);
    expect(body).toMatch(/NOT retryable: ValidationError, AuthError, NotFoundError,/);
    expect(body).toMatch(/ConflictError, ConcurrencyLimitError \(state-driven, not transient\),/);
    expect(body).toMatch(/all auth-flow errors, FeatureUnavailableError \(config gate\),/);
    expect(body).toMatch(/MfaStepUpRequiredError \(needs the customer to step up\)\./);
    expect(body).toMatch(
      /^_RETRYABLE_TYPES: tuple\[type\[DriftstackError\], \.\.\.\] = \(\s*\n\s*TransportError,\s*\n\s*InternalError,\s*\n\s*RateLimitError,\s*\n\)$/m,
    );
    expect(body).toMatch(/^def is_retryable\(err: object\) -> bool:$/m);
    expect(body).toMatch(
      /"""Return True iff ``err`` is a DriftstackError whose kind is retryable\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
