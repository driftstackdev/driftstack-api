// W423.A — drift guard for packages/sdk-typescript/src/errors.ts.
// One typed class per Driftstack RFC 7807 problem-type URI. Drift
// here either drops a problem-type mapping (consumers can't catch
// the specific class) or breaks the base-class chain (instanceof
// DriftstackError stops catching everything).
//
//   • Framing pinned: one class per problem-type URI; all extend
//     DriftstackError; transport fallback for non-Problem failures.
//   • Mapping table pinned: every problem-type ↔ SDK class row.
//   • DriftstackError shape pinned: readonly kind/status/type/title
//     + optional detail/instance + extensions Record.
//   • TYPE_TO_CTOR mapping table pinned for every problem-type that
//     has a typed class.
//   • errorFromProblem: rate-limited body+header priority + unknown-
//     type DriftstackError fallback (5xx -> internal, else
//     bad_request).
//   • isRetryable predicate (V-489) pinned: transport + internal +
//     rate_limited retryable; everything else not.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W423.A packages/sdk-typescript/src/errors.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: one class per Driftstack RFC 7807 problem-type URI; all extend DriftstackError; transport fallback for non-Problem failures', () => {
    expect(body).toMatch(/\/\/ SDK error classes — one per Driftstack RFC 7807 problem-type URI\./);
    expect(body).toMatch(
      /\/\/ All errors extend `DriftstackError` \(the base\) so consumers can catch the\s*\n?\s*\/\/ whole class with a single `instanceof DriftstackError`/,
    );
    expect(body).toMatch(
      /\/\/ Anything else \(network failure, parse error, etc\.\) surfaces as a\s*\n?\s*\/\/ `DriftstackError` with `kind: 'transport'` set on the instance\./,
    );
  });

  it('Mapping table comment pinned: every problem-type URI ↔ SDK class row (bad-request through mfa-step-up-required)', () => {
    for (const [uri, cls] of [
      ['bad-request', 'BadRequestError'],
      ['validation-failed', 'ValidationError'],
      ['unauthorized', 'AuthError'],
      ['invalid-key', 'InvalidKeyError'],
      ['revoked-key', 'RevokedKeyError'],
      ['expired-key', 'ExpiredKeyError'],
      ['forbidden', 'ForbiddenError'],
      ['not-found', 'NotFoundError'],
      ['conflict', 'ConflictError'],
      ['rate-limited', 'RateLimitError'],
      ['concurrency-limit', 'ConcurrencyLimitError'],
      ['tier-limit', 'TierLimitError'],
      ['session-destroyed', 'SessionDestroyedError'],
      ['driver-error', 'DriverError'],
      ['driver-not-integrated', 'DriverNotIntegratedError'],
      ['internal', 'InternalError'],
      ['email-already-registered', 'EmailAlreadyRegisteredError'],
      ['invalid-credentials', 'InvalidCredentialsError'],
      ['invalid-auth-token', 'InvalidAuthTokenError'],
      ['email-not-verified', 'EmailNotVerifiedError'],
      ['feature-unavailable', 'FeatureUnavailableError'],
      ['mfa-step-up-required', 'MfaStepUpRequiredError'],
    ] as const) {
      expect(body).toMatch(new RegExp(`https://errors\\.driftstack\\.dev/${uri}\\s+→\\s+${cls}`));
    }
  });

  it('DriftstackErrorKind union pinned: exhaustive list including V-441 feature_unavailable + mfa_step_up_required + transport', () => {
    expect(body).toMatch(
      /export type DriftstackErrorKind =\s*\n?\s*\|\s*'bad_request'\s*\n?\s*\|\s*'validation'\s*\n?\s*\|\s*'unauthorized'\s*\n?\s*\|\s*'invalid_key'\s*\n?\s*\|\s*'revoked_key'\s*\n?\s*\|\s*'expired_key'\s*\n?\s*\|\s*'forbidden'\s*\n?\s*\|\s*'not_found'\s*\n?\s*\|\s*'conflict'\s*\n?\s*\|\s*'rate_limited'\s*\n?\s*\|\s*'concurrency_limit'\s*\n?\s*\|\s*'tier_limit'\s*\n?\s*\|\s*'session_destroyed'\s*\n?\s*\|\s*'session_timeout'\s*\n?\s*\|\s*'legal_acceptance_required'\s*\n?\s*\|\s*'driver_error'\s*\n?\s*\|\s*'driver_not_integrated'\s*\n?\s*\|\s*'internal'\s*\n?\s*\|\s*'email_already_registered'\s*\n?\s*\|\s*'invalid_credentials'\s*\n?\s*\|\s*'invalid_auth_token'\s*\n?\s*\|\s*'email_not_verified'/,
    );
    expect(body).toMatch(/\/\/ V-441 — closing problem-type parity with Go \+ Python\./);
    expect(body).toMatch(
      /\|\s*'feature_unavailable'\s*\n?\s*\|\s*'mfa_step_up_required'\s*\n?\s*\|\s*'transport';/,
    );
  });

  it('DriftstackError base class: readonly kind/status/type/title + optional detail/instance + extensions Record + name="DriftstackError"', () => {
    expect(body).toMatch(
      /export class DriftstackError extends Error \{\s*\n?\s*readonly kind: DriftstackErrorKind;\s*\n?\s*readonly status: number;\s*\n?\s*readonly type: string;\s*\n?\s*readonly title: string;\s*\n?\s*readonly detail: string \| undefined;\s*\n?\s*readonly instance: string \| undefined;\s*\n?\s*readonly extensions: Record<string, unknown>;/,
    );
    expect(body).toMatch(
      /super\(opts\.detail \?\? opts\.title, opts\.cause !== undefined \? \{ cause: opts\.cause \} : undefined\);\s*\n?\s*this\.name = 'DriftstackError';/,
    );
    expect(body).toMatch(/this\.extensions = opts\.extensions \?\? \{\};/);
  });

  it('RateLimitError carries retryAfterSeconds (sourced from retry_after_seconds extension or Retry-After header)', () => {
    expect(body).toMatch(
      /\/\*\* Suggested wait before retrying\. Sourced from `retry_after_seconds` extension or `Retry-After` header\. \*\/\s*\n?\s*readonly retryAfterSeconds: number;\s*\n?\s*constructor\(p: Problem, retryAfterSeconds: number\) \{\s*\n?\s*super\(toOpts\('rate_limited', p\)\);\s*\n?\s*this\.name = 'RateLimitError';\s*\n?\s*this\.retryAfterSeconds = retryAfterSeconds;\s*\n?\s*\}/,
    );
  });

  it('ConcurrencyLimitError carries currentSessions/limit + ValidationError carries issues + SessionTimeoutError carries timeoutMs', () => {
    expect(body).toMatch(
      /export class ConcurrencyLimitError extends DriftstackError \{\s*\n?\s*readonly currentSessions: number \| undefined;\s*\n?\s*readonly limit: number \| undefined;/,
    );
    expect(body).toMatch(
      /\/\*\* Server-supplied issues array; shape varies \(often a Zod flatten\(\)\)\. \*\/\s*\n?\s*readonly issues: unknown;/,
    );
    expect(body).toMatch(
      /export class SessionTimeoutError extends DriftstackError \{\s*\n?\s*readonly timeoutMs: number \| undefined;/,
    );
  });

  it('LegalAcceptanceRequiredError carries pendingAcceptances[]: PendingAcceptance {document_key, current_version} with type-narrowed filter', () => {
    expect(body).toMatch(
      /export interface PendingAcceptance \{\s*\n?\s*document_key: string;\s*\n?\s*current_version: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export class LegalAcceptanceRequiredError extends DriftstackError \{\s*\n?\s*readonly pendingAcceptances: PendingAcceptance\[\];/,
    );
    expect(body).toMatch(
      /this\.pendingAcceptances = Array\.isArray\(ext\)\s*\n?\s*\? \(ext\.filter\(\s*\n?\s*\(e\) =>\s*\n?\s*typeof e === 'object' &&\s*\n?\s*e !== null &&\s*\n?\s*typeof \(e as \{ document_key\?: unknown \}\)\.document_key === 'string' &&\s*\n?\s*typeof \(e as \{ current_version\?: unknown \}\)\.current_version === 'string',\s*\n?\s*\) as PendingAcceptance\[\]\)\s*\n?\s*: \[\];/,
    );
  });

  it('TransportError: kind=transport, type="about:blank", default status=0; auth-flow + V-441 typed errors enumerated', () => {
    expect(body).toMatch(
      /\/\*\* Network \/ parse \/ non-Problem failure — server didn't return a structured error\. \*\/\s*\n?\s*export class TransportError extends DriftstackError \{\s*\n?\s*constructor\(message: string, status = 0, cause\?: unknown\) \{\s*\n?\s*super\(\{\s*\n?\s*kind: 'transport',\s*\n?\s*status,\s*\n?\s*type: 'about:blank',\s*\n?\s*title: 'Transport error',\s*\n?\s*detail: message,/,
    );
    expect(body).toMatch(/\/\/ Auth-flow errors \(V-079; SDK normalization V-114\)/);
    expect(body).toMatch(
      /\/\/ V-441 — typed errors closing TS SDK problem-type parity with Go \+ Python\./,
    );
    expect(body).toMatch(
      /\/\*\* V-353e — operation requires fresh MFA proof \(15-minute step-up window\)\.\s*\n?\s*\*\s*Customer should call `client\.auth\.mfaStepUp\(\{ code \}\)` and retry\. \*\//,
    );
    expect(body).toMatch(
      /\/\*\* Endpoint requires infrastructure not configured in this deployment\s*\n?\s*\*\s*\(e\.g\. avatar uploads when R2 isn't wired\)\. HTTP 503\. \*\//,
    );
  });

  it('TYPE_TO_CTOR mapping table pinned: every problem-type URI has a typed-class ctor entry', () => {
    for (const uri of [
      'bad-request',
      'validation-failed',
      'unauthorized',
      'invalid-key',
      'revoked-key',
      'expired-key',
      'forbidden',
      'not-found',
      'conflict',
      'concurrency-limit',
      'tier-limit',
      'session-destroyed',
      'session-timeout',
      'legal-acceptance-required',
      'driver-error',
      'driver-not-integrated',
      'internal',
      'email-already-registered',
      'invalid-credentials',
      'invalid-auth-token',
      'email-not-verified',
      'feature-unavailable',
      'mfa-step-up-required',
    ] as const) {
      expect(body).toMatch(new RegExp(`'https://errors\\.driftstack\\.dev/${uri}':`));
    }
  });

  it('errorFromProblem: rate-limited body-then-header priority (default 1) + unknown-type fallback to DriftstackError (5xx -> internal, else bad_request)', () => {
    expect(body).toMatch(
      /export function errorFromProblem\(p: Problem, retryAfterHeader: string \| null\): DriftstackError \{/,
    );
    expect(body).toMatch(
      /if \(p\.type === 'https:\/\/errors\.driftstack\.dev\/rate-limited'\) \{\s*\n?\s*const fromBody = \(p as \{ retry_after_seconds\?: number \}\)\.retry_after_seconds;\s*\n?\s*const fromHeader = retryAfterHeader !== null \? Number\(retryAfterHeader\) : NaN;\s*\n?\s*const retryAfter = fromBody \?\? \(Number\.isFinite\(fromHeader\) \? fromHeader : 1\);\s*\n?\s*return new RateLimitError\(p, retryAfter\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Unknown problem type — surface as DriftstackError with the raw fields\./,
    );
    expect(body).toMatch(/kind: p\.status >= 500 \? 'internal' : 'bad_request',/);
  });

  it('toOpts helper: maps Problem → DriftstackError constructor opts; extensions = members minus the 5 RFC 7807 standard keys (type/title/status/detail/instance)', () => {
    expect(body).toMatch(
      /function toOpts\(\s*\n?\s*kind: DriftstackErrorKind,\s*\n?\s*p: Problem,\s*\n?\s*\):/,
    );
    expect(body).toMatch(/extensions: extensionMembers\(p\),/);
    expect(body).toMatch(
      /function extensionMembers\(p: Problem\): Record<string, unknown> \{\s*\n?\s*const known = new Set\(\['type', 'title', 'status', 'detail', 'instance'\]\);\s*\n?\s*const out: Record<string, unknown> = \{\};\s*\n?\s*for \(const \[k, v\] of Object\.entries\(p\)\) \{\s*\n?\s*if \(!known\.has\(k\)\) out\[k\] = v;\s*\n?\s*\}\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it('V-489 isRetryable predicate: transport + internal + rate_limited retryable; everything else not; non-DriftstackError → false', () => {
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*V-489 — `isRetryable\(err\)` predicate exposed for SDK consumers\s*\n?\s*\*\s*who run their own retry\/backoff loop instead of the built-in one\s*\n?\s*\*\s*in `retry\.ts`\./,
    );
    expect(body).toMatch(
      /export function isRetryable\(err: unknown\): boolean \{\s*\n?\s*if \(!\(err instanceof DriftstackError\)\) return false;\s*\n?\s*switch \(err\.kind\) \{\s*\n?\s*case 'transport':\s*\n?\s*case 'internal':\s*\n?\s*case 'rate_limited':\s*\n?\s*return true;\s*\n?\s*default:\s*\n?\s*return false;\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
