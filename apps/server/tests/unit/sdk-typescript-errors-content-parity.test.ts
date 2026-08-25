// W423.A (W672-deepened) — drift guard for packages/sdk-typescript/
// src/errors.ts. One typed class per Driftstack RFC 7807 problem-type
// URI.
//
// W672 splits the original 13 it() blocks into 22 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • 23 typed error classes pinned PER CLASS, with extension data
//     carried by 4 of them (ValidationError.issues + RateLimitError
//     .retryAfterSeconds + ConcurrencyLimitError.{currentSessions,
//     limit} + LegalAcceptanceRequiredError.pendingAcceptances +
//     SessionTimeoutError.timeoutMs).
//   • DriftstackError base — 7 readonly fields + constructor super-
//     pattern (uses opts.detail ?? opts.title as the message + only
//     spreads cause when defined). Drift to dropping `extensions`
//     would lose the raw RFC 7807 extension members.
//   • DriftstackErrorKind union — 28 string-literal values
//     (including V-441 feature_unavailable + mfa_step_up_required +
//     transport).
//   • TYPE_TO_CTOR mapping — 22 entries (NO rate-limited entry;
//     rate-limited routes through errorFromProblem\'s explicit
//     branch so it can pass retryAfterSeconds).
//   • errorFromProblem — rate-limited body-then-header priority +
//     default-1 fallback when neither source is finite; unknown-
//     type fallback to DriftstackError (5xx → internal, else
//     bad_request).
//   • V-489 isRetryable — 3 retryable kinds (transport + internal +
//     rate_limited); default false (including non-DriftstackError
//     throws).
//   • TransportError — kind='transport', type='about:blank', default
//     status=0 (no HTTP status when network never reached server).

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

  it('file exists at canonical path + module framing pinned (one class per RFC 7807 problem-type URI + extends DriftstackError + transport fallback for non-Problem failures)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ SDK error classes — one per Driftstack RFC 7807 problem-type URI\./);
    expect(body).toMatch(
      /\/\/ All errors extend `DriftstackError` \(the base\) so consumers can catch the\s*\/\/ whole class with a single `instanceof DriftstackError`/,
    );
    expect(body).toMatch(
      /\/\/ Anything else \(network failure, parse error, etc\.\) surfaces as a\s*\/\/ `DriftstackError` with `kind: 'transport'` set on the instance\./,
    );
  });

  it('Mapping table comment — 22-row problem-type URI ↔ SDK class roster pinned. Every URI MUST stay attached to its class because customers read this comment to know which class to catch.', () => {
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

  it('CRITICAL DriftstackErrorKind union — 26 string-literal values + 3 V-441 closing-parity values + Q.1.d byok_anthropic_required (2026-05-17). Includes `payment_required` (402, bundled-LLM rail). Drift to widening the union without coordinated server+client update would break exhaustive switch statements in isRetryable.', () => {
    expect(body).toMatch(
      /export type DriftstackErrorKind =\s*\|\s*'bad_request'\s*\|\s*'validation'\s*\|\s*'unauthorized'\s*\|\s*'invalid_key'\s*\|\s*'revoked_key'\s*\|\s*'expired_key'\s*\|\s*'forbidden'\s*\|\s*'not_found'\s*\|\s*'conflict'\s*\|\s*'payment_required'\s*\|\s*'rate_limited'\s*\|\s*'concurrency_limit'\s*\|\s*'tier_limit'\s*\|\s*'session_destroyed'\s*\|\s*'session_timeout'\s*\|\s*'legal_acceptance_required'\s*\|\s*'driver_error'\s*\|\s*'driver_not_integrated'\s*\|\s*'internal'\s*\|\s*'email_already_registered'\s*\|\s*'invalid_credentials'\s*\|\s*'invalid_auth_token'\s*\|\s*'email_not_verified'/,
    );
    expect(body).toMatch(/\/\/ V-441 — closing problem-type parity with Go \+ Python\./);
    expect(body).toMatch(
      /\|\s*'feature_unavailable'\s*\|\s*'mfa_step_up_required'\s*\|\s*'byok_anthropic_required'\s*\|\s*'proxy_validation_failed'\s*\|\s*'transport';/,
    );
  });

  it('DriftstackError base class — 7 readonly fields (kind/status/type/title/detail/instance/extensions). CRITICAL: detail + instance are explicitly typed `string | undefined` (NOT `string?`) so callers must handle the undefined case in strict type-checking. extensions is `Record<string, unknown>` (default {} in constructor).', () => {
    expect(body).toMatch(
      /export class DriftstackError extends Error \{\s*readonly kind: DriftstackErrorKind;\s*readonly status: number;\s*readonly type: string;\s*readonly title: string;\s*readonly detail: string \| undefined;\s*readonly instance: string \| undefined;\s*readonly extensions: Record<string, unknown>;/,
    );
  });

  it('DriftstackError constructor super-pattern — `super(opts.detail ?? opts.title, opts.cause !== undefined ? { cause: opts.cause } : undefined)`. CRITICAL: detail-or-title fallback (NOT `||` — empty detail string would be hidden) + conditional cause option (drift to always spreading cause: undefined would set cause to undefined on the error instance, breaking Error.cause null-check). this.name = "DriftstackError" pinned. extensions ?? {} default pinned.', () => {
    expect(body).toMatch(
      /super\(opts\.detail \?\? opts\.title, opts\.cause !== undefined \? \{ cause: opts\.cause \} : undefined\);\s*this\.name = 'DriftstackError';/,
    );
    expect(body).toMatch(/this\.extensions = opts\.extensions \?\? \{\};/);
  });

  it('Standard 4xx classes — BadRequestError + AuthError + ForbiddenError + NotFoundError + ConflictError. Each is a thin DriftstackError subclass that sets the kind via toOpts() + overrides this.name with its own class name. Drift to dropping any would force errorFromProblem to fall back to a generic DriftstackError.', () => {
    expect(body).toMatch(
      /export class BadRequestError extends DriftstackError \{\s*constructor\(p: Problem\) \{\s*super\(toOpts\('bad_request', p\)\);\s*this\.name = 'BadRequestError';\s*\}\s*\}/,
    );
    expect(body).toMatch(
      /export class AuthError extends DriftstackError \{[\s\S]*?super\(toOpts\('unauthorized', p\)\);\s*this\.name = 'AuthError';/,
    );
    expect(body).toMatch(/this\.name = 'ForbiddenError';/);
    expect(body).toMatch(/this\.name = 'NotFoundError';/);
    expect(body).toMatch(/this\.name = 'ConflictError';/);
  });

  it('API-key lifecycle 3-class trio — InvalidKeyError + RevokedKeyError + ExpiredKeyError. The 3 separate classes let callers distinguish 401-because-typo from 401-because-revoked from 401-because-expired (each requires different remediation). Drift to collapsing into AuthError would lose this remediation distinction.', () => {
    expect(body).toMatch(
      /export class InvalidKeyError extends DriftstackError \{[\s\S]*?super\(toOpts\('invalid_key', p\)\);\s*this\.name = 'InvalidKeyError';/,
    );
    expect(body).toMatch(
      /export class RevokedKeyError extends DriftstackError \{[\s\S]*?super\(toOpts\('revoked_key', p\)\);\s*this\.name = 'RevokedKeyError';/,
    );
    expect(body).toMatch(
      /export class ExpiredKeyError extends DriftstackError \{[\s\S]*?super\(toOpts\('expired_key', p\)\);\s*this\.name = 'ExpiredKeyError';/,
    );
  });

  it('CRITICAL ValidationError — carries `issues: unknown` extension data. JSDoc rationale: "Server-supplied issues array; shape varies (often a Zod flatten())." Drift to typing issues as a specific shape would lock the SDK to one server-side validation library version.', () => {
    expect(body).toMatch(
      /\/\*\* Server-supplied issues array; shape varies \(often a Zod flatten\(\)\)\. \*\/\s*readonly issues: unknown;/,
    );
  });

  it('CRITICAL RateLimitError — carries `retryAfterSeconds: number` + 2-param constructor (Problem + retryAfterSeconds). Sourced from "retry_after_seconds extension or Retry-After header". Drift to making retryAfterSeconds optional would force every customer\'s catch to handle undefined.', () => {
    expect(body).toMatch(
      /\/\*\* Suggested wait before retrying\. Sourced from `retry_after_seconds` extension or `Retry-After` header\. \*\/\s*readonly retryAfterSeconds: number;\s*constructor\(p: Problem, retryAfterSeconds: number\) \{\s*super\(toOpts\('rate_limited', p\)\);\s*this\.name = 'RateLimitError';\s*this\.retryAfterSeconds = retryAfterSeconds;\s*\}/,
    );
  });

  it('CRITICAL ConcurrencyLimitError — carries `currentSessions: number | undefined` + `limit: number | undefined`. Extracted from problem extensions (current_sessions / limit). Lets dashboards render "X/Y sessions in use" badges. Drift to dropping the typed fields would force callers to manually parse the extensions Record.', () => {
    expect(body).toMatch(
      /export class ConcurrencyLimitError extends DriftstackError \{\s*readonly currentSessions: number \| undefined;\s*readonly limit: number \| undefined;/,
    );
    expect(body).toMatch(
      /const ext = p as \{ current_sessions\?: number; limit\?: number \};\s*this\.currentSessions = ext\.current_sessions;\s*this\.limit = ext\.limit;/,
    );
  });

  it('TierLimitError + SessionDestroyedError — 2 simple subclasses with no extension data. TierLimitError surfaces from create/clone/restore on profiles + restore on profile-snapshots (the 3 "mint a new profile" paths). SessionDestroyedError surfaces when a session is acted on after destroy.', () => {
    expect(body).toMatch(
      /export class TierLimitError extends DriftstackError \{[\s\S]*?this\.name = 'TierLimitError';/,
    );
    expect(body).toMatch(
      /export class SessionDestroyedError extends DriftstackError \{[\s\S]*?this\.name = 'SessionDestroyedError';/,
    );
  });

  it('CRITICAL LegalAcceptanceRequiredError — carries `pendingAcceptances: PendingAcceptance[]` with TYPE-NARROWED filter. The Array.isArray + element-wise typeof check guards against malformed server responses. Each pending acceptance carries (document_key + current_version). 2-field rationale pinned: "drive the user through the acceptance flow without a follow-up GET" — drift to dropping pendingAcceptances would force a doubled round-trip.', () => {
    expect(body).toMatch(
      /export interface PendingAcceptance \{\s*document_key: string;\s*current_version: string;\s*\}/,
    );
    expect(body).toMatch(
      /export class LegalAcceptanceRequiredError extends DriftstackError \{\s*readonly pendingAcceptances: PendingAcceptance\[\];/,
    );
    expect(body).toMatch(
      /this\.pendingAcceptances = Array\.isArray\(ext\)\s*\? \(ext\.filter\(\s*\(e\) =>\s*typeof e === 'object' &&\s*e !== null &&\s*typeof \(e as \{ document_key\?: unknown \}\)\.document_key === 'string' &&\s*typeof \(e as \{ current_version\?: unknown \}\)\.current_version === 'string',\s*\) as PendingAcceptance\[\]\)\s*: \[\];/,
    );
  });

  it('CRITICAL SessionTimeoutError — carries `timeoutMs: number | undefined`. JSDoc rationale: distinguished from DriverError so customers can react SPECIFICALLY to "the operation didn\'t finish within the per-call timeout" without conflating with downstream driver failures. The "server actually applied" wording acknowledges the server may CLAMP the customer\'s requested timeout.', () => {
    expect(body).toMatch(
      /\/\/ SessionTimeoutError — distinguished from DriverError so customers can\s*\/\/ react specifically to "the operation didn't finish within the per-call\s*\/\/ timeout I supplied" without conflating with downstream driver failures\./,
    );
    expect(body).toMatch(
      /export class SessionTimeoutError extends DriftstackError \{\s*readonly timeoutMs: number \| undefined;/,
    );
    expect(body).toMatch(/this\.timeoutMs = typeof ext === 'number' \? ext : undefined;/);
  });

  it('Driver/server 3-class trio — DriverError + DriverNotIntegratedError + InternalError. Driver classes surface downstream automation-driver failures (DriverNotIntegratedError = e.g. trying to use a browser driver not configured in this deployment). InternalError surfaces unhandled 5xx — the only retryable one of the 3 (per V-489 isRetryable below).', () => {
    expect(body).toMatch(/this\.name = 'DriverError';/);
    expect(body).toMatch(/this\.name = 'DriverNotIntegratedError';/);
    expect(body).toMatch(/this\.name = 'InternalError';/);
  });

  it('Auth-flow 4-class section (V-079; SDK normalization V-114) — EmailAlreadyRegisteredError + InvalidCredentialsError + InvalidAuthTokenError + EmailNotVerifiedError. Section comment pinned. The 4 classes let signup/login/verify-email/magic-link consumers distinguish failure modes for the customer-facing copy.', () => {
    expect(body).toMatch(/\/\/ Auth-flow errors \(V-079; SDK normalization V-114\)/);
    expect(body).toMatch(/this\.name = 'EmailAlreadyRegisteredError';/);
    expect(body).toMatch(/this\.name = 'InvalidCredentialsError';/);
    expect(body).toMatch(/this\.name = 'InvalidAuthTokenError';/);
    expect(body).toMatch(/this\.name = 'EmailNotVerifiedError';/);
  });

  it('CRITICAL V-441 closing-parity 2 classes — MfaStepUpRequiredError + FeatureUnavailableError. Section comment "V-441 — typed errors closing TS SDK problem-type parity with Go + Python" pinned. MfaStepUpRequiredError JSDoc carries the V-353e 15-minute step-up window remediation hint: "Customer should call `client.auth.mfaStepUp({ code })` and retry." FeatureUnavailableError JSDoc carries the HTTP 503 framing + "e.g. avatar uploads when R2 isn\'t wired" example.', () => {
    expect(body).toMatch(
      /\/\/ V-441 — typed errors closing TS SDK problem-type parity with Go \+ Python\./,
    );
    expect(body).toMatch(
      /\/\*\* V-353e — operation requires fresh MFA proof \(15-minute step-up window\)\.\s*\*\s*Customer should call `client\.auth\.mfaStepUp\(\{ code \}\)` and retry\. \*\//,
    );
    expect(body).toMatch(
      /\/\*\* Endpoint requires infrastructure not configured in this deployment\s*\*\s*\(e\.g\. avatar uploads when R2 isn't wired\)\. HTTP 503\. \*\//,
    );
  });

  it('CRITICAL TransportError — kind="transport" + status=0 default + type="about:blank" + title="Transport error". RFC 7807 says type="about:blank" indicates "no further metadata"; using it here tells customers this came from the SDK transport layer, NOT the server. status=0 default means "no HTTP status" — the request never reached the server.', () => {
    expect(body).toMatch(
      /\/\*\* Network \/ parse \/ non-Problem failure — server didn't return a structured error\. \*\/\s*export class TransportError extends DriftstackError \{\s*constructor\(message: string, status = 0, cause\?: unknown\) \{\s*super\(\{\s*kind: 'transport',\s*status,\s*type: 'about:blank',\s*title: 'Transport error',\s*detail: message,/,
    );
  });

  it("CRITICAL TYPE_TO_CTOR mapping table — 22 entries (NO rate-limited entry; that's handled by errorFromProblem's explicit branch so it can pass retryAfterSeconds). Every URI MUST be in the table for the correct typed class to be constructed.", () => {
    const uris = [
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
    ];
    for (const uri of uris) {
      expect(body).toMatch(new RegExp(`'https://errors\\.driftstack\\.dev/${uri}':`));
    }
    // NO rate-limited entry in TYPE_TO_CTOR.
    expect(body).not.toMatch(/'https:\/\/errors\.driftstack\.dev\/rate-limited':\s*\(p\)/);
  });

  it('CRITICAL errorFromProblem rate-limited branch — body-then-header priority + default-1 fallback. (1) `fromBody = p.retry_after_seconds`; (2) `fromHeader = Number(retryAfterHeader)`; (3) `retryAfter = fromBody ?? (Number.isFinite(fromHeader) ? fromHeader : 1)`. CRITICAL ordering: body wins over header; default-1 ensures we never pass NaN to RateLimitError (drift to default-0 would let retry loops spam the server with zero delay).', () => {
    expect(body).toMatch(
      /export function errorFromProblem\(p: Problem, retryAfterHeader: string \| null\): DriftstackError \{/,
    );
    expect(body).toMatch(
      /if \(p\.type === 'https:\/\/errors\.driftstack\.dev\/rate-limited'\) \{\s*const fromBody = \(p as \{ retry_after_seconds\?: number \}\)\.retry_after_seconds;\s*const fromHeader = retryAfterHeader !== null \? Number\(retryAfterHeader\) : NaN;\s*const retryAfter = fromBody \?\? \(Number\.isFinite\(fromHeader\) \? fromHeader : 1\);\s*return new RateLimitError\(p, retryAfter\);\s*\}/,
    );
  });

  it("errorFromProblem unknown-type fallback — routes through toOpts(p.status >= 500 ? 'internal' : 'bad_request', p). CRITICAL: (a) the status-based kind keeps the retryability split (internal IS retryable per isRetryable; bad_request is NOT); (b) routing through toOpts preserves the problem's EXTENSION members on .extensions (Fable SDK re-audit 2026-07-02 — the old direct-construct fallback dropped them). The unknown-type path uses DriftstackError directly (not a typed subclass) so consumers fall back to `instanceof DriftstackError`.", () => {
    expect(body).toMatch(
      /\/\/ Unknown problem type — surface as DriftstackError with the raw fields\./,
    );
    expect(body).toMatch(
      /return new DriftstackError\(toOpts\(p\.status >= 500 \? 'internal' : 'bad_request', p\)\);/,
    );
  });

  it('toOpts helper — maps Problem → DriftstackError constructor opts. Conditional spread on detail + instance (NOT always-include) keeps undefined-vs-missing-key distinction so extensions={} stays clean of fake "detail: undefined" entries. extensions: extensionMembers(p) call pinned.', () => {
    expect(body).toMatch(/function toOpts\(\s*kind: DriftstackErrorKind,\s*p: Problem,\s*\):/);
    expect(body).toMatch(/extensions: extensionMembers\(p\),/);
  });

  it('CRITICAL extensionMembers helper — extracts non-RFC-7807-standard keys from Problem. 5-key known-set (type/title/status/detail/instance) ALL filtered out; everything else copied to the extensions Record. Drift to dropping any of the 5 standard keys would let them leak into extensions (e.g. customer code accessing extensions.title would shadow the standard field).', () => {
    expect(body).toMatch(
      /function extensionMembers\(p: Problem\): Record<string, unknown> \{\s*const known = new Set\(\['type', 'title', 'status', 'detail', 'instance'\]\);\s*const out: Record<string, unknown> = \{\};\s*for \(const \[k, v\] of Object\.entries\(p\)\) \{\s*if \(!known\.has\(k\)\) out\[k\] = v;\s*\}\s*return out;\s*\}/,
    );
  });

  it('CRITICAL V-489 isRetryable JSDoc — 4-line framing pinned: predicate exposed for "SDK consumers who run their own retry/backoff loop instead of the built-in one in retry.ts." 3 retryable-kinds documented (transport / internal / rate_limited) + non-retryable rationale: 4xx + non-DriftstackError throws. The "any DriftstackError where ... not in the retryable set" framing tells customers this is closed-set.', () => {
    expect(body).toMatch(
      /\/\*\*\s*\*\s*V-489 — `isRetryable\(err\)` predicate exposed for SDK consumers\s*\*\s*who run their own retry\/backoff loop instead of the built-in one\s*\*\s*in `retry\.ts`\./,
    );
    expect(body).toMatch(/Retryable kinds:/);
    expect(body).toMatch(/NOT retryable:/);
  });

  it('CRITICAL V-489 isRetryable implementation — `if (!(err instanceof DriftstackError)) return false;` + `switch (err.kind) { case "transport": case "internal": case "rate_limited": return true; default: return false; }`. Drift to fall-through cases would silently make new kinds retryable; drift to dropping the instanceof check would let non-DS errors retry.', () => {
    expect(body).toMatch(
      /export function isRetryable\(err: unknown\): boolean \{\s*if \(!\(err instanceof DriftstackError\)\) return false;\s*switch \(err\.kind\) \{\s*case 'transport':\s*case 'internal':\s*case 'rate_limited':\s*return true;\s*default:\s*return false;\s*\}\s*\}/,
    );
  });

  it("Error-class export inventory — every typed error class MUST be exported. 23 classes + 1 base + PendingAcceptance interface + 2 functions (errorFromProblem + isRetryable) + 1 type (DriftstackErrorKind) = 27+ exports. Drift to dropping any export would break customer code that imports from '@driftstack/sdk'.", () => {
    const exportedClasses = [
      'DriftstackError',
      'BadRequestError',
      'ValidationError',
      'AuthError',
      'InvalidKeyError',
      'RevokedKeyError',
      'ExpiredKeyError',
      'ForbiddenError',
      'NotFoundError',
      'ConflictError',
      'RateLimitError',
      'ConcurrencyLimitError',
      'TierLimitError',
      'SessionDestroyedError',
      'LegalAcceptanceRequiredError',
      'SessionTimeoutError',
      'DriverError',
      'DriverNotIntegratedError',
      'InternalError',
      'EmailAlreadyRegisteredError',
      'InvalidCredentialsError',
      'InvalidAuthTokenError',
      'EmailNotVerifiedError',
      'MfaStepUpRequiredError',
      'FeatureUnavailableError',
      'TransportError',
    ];
    for (const cls of exportedClasses) {
      expect(body).toMatch(new RegExp(`export class ${cls} extends`));
    }
    expect(body).toMatch(/export function errorFromProblem/);
    expect(body).toMatch(/export function isRetryable/);
    expect(body).toMatch(/export type DriftstackErrorKind/);
    expect(body).toMatch(/export interface PendingAcceptance/);
  });
});
