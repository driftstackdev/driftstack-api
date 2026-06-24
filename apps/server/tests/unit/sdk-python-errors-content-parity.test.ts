// W585.B (W648-deepened) — drift guard for packages/sdk-python/src/driftstack/errors.py.
// DriftstackError hierarchy + RFC 7807 problem-type mapping.
//
// W648 splits the 8 it() blocks (3 of which bundled multiple exception
// classes with distinct custom __init__ shapes into one block each)
// into 17 focused per-class blocks + pins previously-implicit invariants:
//
//   • Per-class default-status invariants on the 5 custom-init classes
//     (LegalAcceptanceRequiredError=409, SessionTimeoutError=504,
//     RateLimitError=429, QuotaExceededError=429,
//     ConcurrencyLimitError=429). Drift to a different default would
//     silently change the wire-shape for these classes.
//   • Per-class kwarg-only-after-message contract: every custom-init
//     class uses `message: str, *, status, problem_type, problem` so
//     the positional arg surface stays 1-wide.
//   • Subclass-of-subclass cases (SessionNotFoundError(NotFoundError),
//     InvalidCredentialsError(AuthError), EmailNotVerifiedError
//     (ForbiddenError)) pinned because the parent class drives
//     except-catch granularity.

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

  it('file exists at canonical path + module docstring + RFC 7807 server mirror (apps/server/src/lib/errors.ts) + catch-with-granularity example. CRITICAL: the example shows `except RateLimitError as e: time.sleep(e.retry_after_seconds or 1)` — drift to dropping retry_after_seconds from the example would lose the customer-facing catch pattern.', () => {
    expect(existsSync(LIB)).toBe(true);
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

  it('Base DriftstackError(Exception) — 4-field __init__ (message + kwarg-only status + problem_type + problem dict). `problem: dict[str, Any] = problem or {}` invariant: NEVER None — drift to `None` default would force callers to nil-check before .get() access. The docstring "All HTTP-derived errors carry the parsed problem document" framing pinned because it tells customers they can read additional fields via `e.problem.get("retry_after_seconds")` without knowing the specific subclass shape.', () => {
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
  });

  it('AuthError (DriftstackError) — 5-class auth-failure subtree: AuthError base + InvalidKeyError (key not recognised) + ExpiredKeyError (passed expires_at) + RevokedKeyError (DELETE) + ForbiddenError (authenticated but lacks scope). Drift to merging any of these would lose the catch granularity that lets dashboards show different UX per failure (e.g. "key revoked" → suggest minting new vs "wrong scope" → contact admin).', () => {
    expect(body).toMatch(/^class AuthError\(DriftstackError\):$/m);
    expect(body).toMatch(/"""Base for authentication \/ authorisation failures\."""/);
    expect(body).toMatch(
      /^class InvalidKeyError\(AuthError\):\s*\n\s*"""The provided API key was not recognised \(malformed or unknown\)\."""/m,
    );
    expect(body).toMatch(
      /^class ExpiredKeyError\(AuthError\):\s*\n\s*"""The API key passed its ``expires_at`` deadline\."""/m,
    );
    expect(body).toMatch(
      /^class RevokedKeyError\(AuthError\):\s*\n\s*"""The API key was revoked \(DELETE \/v1\/api-keys\/:id\)\."""/m,
    );
    expect(body).toMatch(
      /^class ForbiddenError\(AuthError\):\s*\n\s*"""The caller is authenticated but lacks the required scope\."""/m,
    );
  });

  it('Domain pass-through classes: BadRequestError + ValidationError + NotFoundError + ConflictError + SessionNotFoundError (inherits NotFoundError) + SessionDestroyedError. BadRequestError subclasses DriftstackError directly (NOT ValidationError) so `except DriftstackError` handlers are unaffected; the generic-400 `bad-request` problem-type maps to it, distinct from `validation-failed` → ValidationError. Custom subclass-of-subclass: SessionNotFoundError(NotFoundError) so `except NotFoundError` also catches session-specific 404s — drift to inheriting from DriftstackError directly would break the catch hierarchy.', () => {
    expect(body).toMatch(/^class BadRequestError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class ValidationError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class NotFoundError\(DriftstackError\):$/m);
    expect(body).toMatch(/^class ConflictError\(DriftstackError\):$/m);
    expect(body).toMatch(
      /^class SessionNotFoundError\(NotFoundError\):\s*\n\s*"""Specifically: the addressed session id has no row in our store\."""/m,
    );
    expect(body).toMatch(
      /^class SessionDestroyedError\(DriftstackError\):\s*\n\s*"""The session was destroyed; further operations on it are rejected \(410\)\."""/m,
    );
  });

  it('LegalAcceptanceRequiredError — CUSTOM __init__ with `pending_acceptances: list[dict[str, str]] | None` + DEFAULT status 409. CRITICAL: pending_acceptances carries the document keys + current versions so the client can drive the user through acceptance WITHOUT a follow-up GET to /v1/legal/required. `self.pending_acceptances = pending_acceptances or []` invariant: never None, always a list so customers can iterate without nil-check.', () => {
    expect(body).toMatch(/^class LegalAcceptanceRequiredError\(DriftstackError\):$/m);
    expect(body).toMatch(/409 when an operation \(e\.g\. creating an API key\) is gated on the/);
    expect(body).toMatch(/customer accepting one or more legal documents\./);
    expect(body).toMatch(/``pending_acceptances`` carries the document keys \+ current versions/);
    expect(body).toMatch(/so the client can drive the user through the acceptance flow without/);
    expect(body).toMatch(/a follow-up GET\./);
    expect(body).toMatch(/pending_acceptances: list\[dict\[str, str\]\] \| None = None,/);
    expect(body).toMatch(/status: int \| None = 409,/);
    expect(body).toMatch(/self\.pending_acceptances = pending_acceptances or \[\]/);
  });

  it('SessionTimeoutError — CUSTOM __init__ with `timeout_ms: int | None` + DEFAULT status 504. CRITICAL: distinguished from DriverError so customers can react specifically to "didn\'t finish in time" without conflating with downstream driver failures. timeout_ms is the bound THE SERVER ACTUALLY APPLIED (may differ from the request if the server clamped it). Drift to dropping the timeout_ms field would lose the customer-side ability to log "we asked for X but server gave us Y".', () => {
    expect(body).toMatch(/^class SessionTimeoutError\(DriftstackError\):$/m);
    expect(body).toMatch(/The operation exceeded the per-call ``timeout_ms`` \(504\)\./);
    expect(body).toMatch(/Distinguished from ``DriverError`` so customers can react specifically/);
    expect(body).toMatch(/to "didn't finish in time" without conflating with downstream driver/);
    expect(body).toMatch(/failures\. ``timeout_ms`` is the bound the server actually applied/);
    expect(body).toMatch(/\(may differ from the request if the server clamped it\)\./);
    expect(body).toMatch(/timeout_ms: int \| None = None,/);
    expect(body).toMatch(/status: int \| None = 504,/);
    expect(body).toMatch(/self\.timeout_ms = timeout_ms/);
  });

  it('RateLimitError — CUSTOM __init__ with `retry_after_seconds: int | None` + DEFAULT status 429. The retry_after_seconds field surfaces the server\'s Retry-After header so customers running their own retry loop can honour the wait without parsing headers. Drift to dropping this field would force customers to read e.problem.get("retry_after_seconds") which is more error-prone.', () => {
    expect(body).toMatch(/^class RateLimitError\(DriftstackError\):$/m);
    expect(body).toMatch(
      /"""Token-bucket rate limit hit\. ``retry_after_seconds`` is the hint\."""/,
    );
    expect(body).toMatch(/retry_after_seconds: int \| None = None,/);
    expect(body).toMatch(/status: int \| None = 429,/);
    expect(body).toMatch(/self\.retry_after_seconds = retry_after_seconds/);
  });

  it('QuotaExceededError — CUSTOM __init__ with 3 fields (current + limit + record_type) + DEFAULT status 429. The 3-field shape lets dashboards render "you used X of Y session_minutes" without parsing the problem dict. record_type is the UsageRecordType enum so customers know which quota was hit (session_minute vs navigate vs interact).', () => {
    expect(body).toMatch(/^class QuotaExceededError\(DriftstackError\):$/m);
    expect(body).toMatch(/"""Per-period usage quota exhausted\."""/);
    expect(body).toMatch(
      /current: int \| None = None,\s*\n\s*limit: int \| None = None,\s*\n\s*record_type: str \| None = None,\s*\n\s*status: int \| None = 429,/,
    );
    expect(body).toMatch(
      /self\.current = current\s*\n\s*self\.limit = limit\s*\n\s*self\.record_type = record_type/,
    );
  });

  it('ConcurrencyLimitError — CUSTOM __init__ with `current_sessions: int | None` + `limit: int | None` + DEFAULT status 429. Specifically for "active-session count would exceed tier\'s concurrent limit" — drift to merging with QuotaExceededError would conflate per-period usage caps with point-in-time concurrent caps (different remediation: wait vs destroy a session).', () => {
    expect(body).toMatch(/^class ConcurrencyLimitError\(DriftstackError\):$/m);
    expect(body).toMatch(/"""Active-session count would exceed the tier's concurrent limit\."""/);
    expect(body).toMatch(/current_sessions: int \| None = None,\s*\n\s*limit: int \| None = None,/);
    expect(body).toMatch(/status: int \| None = 429,/);
    expect(body).toMatch(/self\.current_sessions = current_sessions\s*\n\s*self\.limit = limit/);
  });

  it('DriverError + TransportError — leaf classes. DriverError is unrecoverable upstream (502). TransportError is "network-level or response-parsing failure that didn\'t reach the server" — CRITICAL distinction because retry logic uses this to decide whether the request was idempotent enough to retry without surprises.', () => {
    expect(body).toMatch(
      /^class DriverError\(DriftstackError\):\s*\n\s*"""The driver returned an unrecoverable error during the operation\."""/m,
    );
    expect(body).toMatch(/^class TransportError\(DriftstackError\):$/m);
    expect(body).toMatch(
      /A network-level or response-parsing failure that didn't reach the server\./,
    );
    expect(body).toMatch(/Distinguished from server-returned errors so retry logic can decide/);
    expect(body).toMatch(/whether the request was idempotent enough to retry without surprises\./);
  });

  it('V-079/V-115 auth-flow leaf classes: EmailAlreadyRegisteredError + InvalidCredentialsError(AuthError) + InvalidAuthTokenError + EmailNotVerifiedError(ForbiddenError). Subclass-of-subclass cases: InvalidCredentialsError inherits AuthError (so `except AuthError` catches login failures); EmailNotVerifiedError inherits ForbiddenError (so `except ForbiddenError` catches it). Drift to inheriting from DriftstackError directly would break the catch granularity.', () => {
    expect(body).toMatch(
      /^class EmailAlreadyRegisteredError\(DriftstackError\):\s*\n\s*"""Signup attempted with an email already on file\."""/m,
    );
    expect(body).toMatch(
      /^class InvalidCredentialsError\(AuthError\):\s*\n\s*"""Login failed — email or password incorrect\."""/m,
    );
    expect(body).toMatch(
      /^class InvalidAuthTokenError\(DriftstackError\):\s*\n\s*"""Token \(verification, magic link, password reset\) is invalid, expired, or already used\."""/m,
    );
    expect(body).toMatch(
      /^class EmailNotVerifiedError\(ForbiddenError\):\s*\n\s*"""Login attempted before email verification step completed\."""/m,
    );
  });

  it('V-439/V-353e operations leaf classes: FeatureUnavailableError (503 — config-gate, e.g. avatar uploads when R2 isn\'t wired) + MfaStepUpRequiredError (V-353e 15-min step-up + POST /v1/auth/mfa/step-up retry hint) + InternalError (unhandled server-side; detail may be sanitized). MfaStepUpRequiredError docstring carries the customer-facing remediation step verbatim — drift to dropping the POST path would lose the "what do I do now" framing.', () => {
    expect(body).toMatch(/^class FeatureUnavailableError\(DriftstackError\):$/m);
    expect(body).toMatch(/Endpoint requires infrastructure not configured in this deployment/);
    expect(body).toMatch(/\(e\.g\. avatar uploads when R2 isn't wired\)\. HTTP 503\./);
    expect(body).toMatch(/^class MfaStepUpRequiredError\(DriftstackError\):$/m);
    expect(body).toMatch(/V-353e — operation requires a fresh MFA proof \(15-minute step-up/);
    expect(body).toMatch(/freshness window\)\. Customer should call POST \/v1\/auth\/mfa\/step-up/);
    expect(body).toMatch(/with a TOTP code and retry the original request\./);
    expect(body).toMatch(/^class InternalError\(DriftstackError\):$/m);
    expect(body).toMatch(/Unhandled server-side error\. Detail message may be sanitized;/);
    expect(body).toMatch(/check Driftstack status \/ contact support if this persists\./);
  });

  it('PROBLEM_TYPE_TO_ERROR mapping — 24 problem-type URI → subclass entries. Maps the server constants in apps/server/src/lib/problem-types.ts onto the right Python exception. Every URI is `https://errors.driftstack.dev/<slug>`. The HTTP layer consults this mapping so customers get typed exceptions instead of bare DriftstackError + .problem_type string compare.', () => {
    expect(body).toMatch(/^PROBLEM_TYPE_TO_ERROR: dict\[str, type\[DriftstackError\]\] = \{$/m);
    // RFC-7807 standard problem types.
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/bad-request": BadRequestError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/unauthorized": AuthError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/forbidden": ForbiddenError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/not-found": NotFoundError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/conflict": ConflictError,/);
    // Rate / quota.
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/rate-limited": RateLimitError,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/concurrency-limit": ConcurrencyLimitError,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/tier-limit": QuotaExceededError,/);
    // Auth keys.
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/revoked-key": RevokedKeyError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/expired-key": ExpiredKeyError,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/invalid-key": InvalidKeyError,/);
    // Session.
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/session-destroyed": SessionDestroyedError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/session-timeout": SessionTimeoutError,/,
    );
    // Domain.
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
    // V-115 auth-flow.
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
    // V-439 ops.
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/feature-unavailable": FeatureUnavailableError,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/mfa-step-up-required": MfaStepUpRequiredError,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/internal": InternalError,/);
  });

  it('PROBLEM_TYPE_TO_ERROR audit-comment + driver-error duplicate entry. Both /driver-error AND /driver-not-integrated map to the same DriverError class — drift to splitting them into separate classes would force customers to catch two specific errors for what is conceptually one "upstream driver issue". The comment "Keep the mapping in one place for ease of audit + extension" is load-bearing for the future-extension expectation.', () => {
    expect(body).toMatch(
      /# Keep the mapping in one place for ease of audit \+ extension\. The HTTP\s*\n# layer in `driftstack\.http` consults this; the keys match the server\s*\n# constants in apps\/server\/src\/lib\/problem-types\.ts\./,
    );
    // driver-error AND driver-not-integrated both → DriverError.
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/driver-error": DriverError,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/driver-not-integrated": DriverError,/,
    );
  });

  it('V-490 is_retryable predicate + V-489 TS mirror reference. Function-level docstring + _RETRYABLE_TYPES tuple. CRITICAL retry-allowlist invariant: only 3 retryable classes (TransportError network-failure + InternalError 5xx + RateLimitError 429-with-Retry-After). Everything else is NOT retryable. Drift to widening the tuple would let SDK retry validation errors / auth failures / state-driven errors, none of which would change on retry.', () => {
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
  });

  it('is_retryable() function signature + docstring + isinstance-based implementation. Takes `object` (not DriftstackError) so customers can pass `None` or arbitrary exceptions safely — non-DriftstackError values return False. The "SDK wraps known errors in DriftstackError, so a non-DS error is something the caller threw and the caller should decide how to handle" framing is the load-bearing escape-hatch contract.', () => {
    expect(body).toMatch(/^def is_retryable\(err: object\) -> bool:$/m);
    expect(body).toMatch(
      /"""Return True iff ``err`` is a DriftstackError whose kind is retryable\./,
    );
    expect(body).toMatch(/Use this from your own retry\/backoff loop when the built-in retry in/);
    expect(body).toMatch(
      /``driftstack\.retry`` doesn't fit\. Honour ``RateLimitError\.retry_after_seconds``/,
    );
    expect(body).toMatch(/for the wait between attempts when it's set\./);
    expect(body).toMatch(
      /Non-DriftstackError values \(regular Exceptions, None, primitives\) return/,
    );
    expect(body).toMatch(
      /False — the SDK wraps known errors in DriftstackError, so a non-DS error/,
    );
    expect(body).toMatch(
      /is something the caller threw and the caller should decide how to handle\./,
    );
    expect(body).toMatch(/return isinstance\(err, _RETRYABLE_TYPES\)/);
  });
});
