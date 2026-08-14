// W389.A — drift guard for apps/server/src/lib/errors.ts.
// RFC 7807 problem+json error taxonomy. ApiError subclasses are the
// only thing the error-middleware converts to typed problem responses;
// anything else becomes a 500 Internal. The status codes + problem
// types pinned here are referenced by SDK error-mapping logic and by
// the /docs/errors-reference public page.
//
//   • RFC 7807 framing + "never leak raw error messages" posture.
//   • ApiError base class: toProblem() emits canonical problem-shape.
//   • Status-code ladder: 400 BadRequest/Validation/InvalidAuthToken,
//     401 Unauthorized/InvalidKey/Revoked/Expired/InvalidCredentials,
//     403 Forbidden/EmailNotVerified/MfaStepUp, 404 NotFound,
//     409 Conflict/EmailAlreadyRegistered/LegalAcceptanceRequired,
//     410 SessionDestroyed, 429 RateLimited/Concurrency/TierLimit,
//     500 Internal, 502 DriverError, 503 DriverNotIntegrated/
//     FeatureUnavailable, 504 SessionTimeout.
//   • V-352b FeatureUnavailable framing.
//   • V-353e MfaStepUp 403 + requires_mfa_step_up extension.
//   • V-079 auth-flow error cluster.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W389.A apps/server/src/lib/errors.ts content parity', () => {
  const body = read(LIB);

  it('RFC 7807 problem+json framing pinned in module comment', () => {
    expect(body).toMatch(
      /The error middleware \(apps\/server\/src\/middleware\/\s*\n?\s*\/\/\s*error-handler\.ts\) converts them to RFC 7807 problem\+json responses/,
    );
  });

  it('"never leak raw error messages to clients" posture pinned', () => {
    expect(body).toMatch(
      /a TypeError, a Drizzle error, a pino crash —\s*\n?\s*\/\/\s*is logged at error level and replied as Internal \(500\) with a stable\s*\n?\s*\/\/\s*problem-type\. We never leak raw error messages to clients/,
    );
  });

  it('ApiError base class: toProblem() emits {type,title,status,detail?,instance?,...extensions}', () => {
    expect(body).toMatch(/export class ApiError extends Error \{/);
    expect(body).toMatch(/readonly type: ProblemType;/);
    expect(body).toMatch(/readonly title: string;/);
    expect(body).toMatch(/readonly status: number;/);
    expect(body).toMatch(/readonly detail: string \| undefined;/);
    expect(body).toMatch(/readonly extensions: Record<string, unknown>;/);
    expect(body).toMatch(/toProblem\(instance\?: string\): Problem \{/);
    expect(body).toMatch(
      /\.\.\.\(this\.detail !== undefined \? \{ detail: this\.detail \} : \{\}\),/,
    );
    expect(body).toMatch(/\.\.\.\(instance !== undefined \? \{ instance \} : \{\}\),/);
    // CORRECTED 2026-08-14. This pinned `...this.extensions,` as the LAST
    // member of the returned object. That order let an extension named
    // type/title/status/detail/instance silently replace the real member — and
    // the error handler reads problem.status to set the response code, so an
    // extension could set the HTTP status. Extensions are now stripped of
    // reserved names and spread FIRST; the pin follows the corrected source.
    expect(body).toMatch(/\.\.\.safeExtensions,/);
    expect(body).toMatch(
      /Object\.entries\(this\.extensions\)\.filter\(\(\[key\]\) => !RESERVED_PROBLEM_MEMBERS\.has\(key\)\)/,
    );
  });

  it('BadRequestError = 400 BadRequest', () => {
    expect(body).toMatch(
      /export class BadRequestError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.BadRequest,\s*\n?\s*title: 'Bad Request',\s*\n?\s*status: 400,/,
    );
  });

  it('ValidationError = 400 ValidationFailed (carries issues extension)', () => {
    expect(body).toMatch(
      /export class ValidationError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.ValidationFailed,\s*\n?\s*title: 'Validation Failed',\s*\n?\s*status: 400,[\s\S]+?extensions: \{ issues \},/,
    );
  });

  it('UnauthorizedError = 401 Unauthorized (default "API key missing or invalid.")', () => {
    expect(body).toMatch(
      // V-737 — an optional `extensions` param (mirroring BadRequestError) so the
      // OAuth token route can carry its RFC 6749 §5.2 `error` code on a 401. The
      // default detail is unchanged and every existing caller is unaffected.
      /export class UnauthorizedError extends ApiError \{[\s\S]+?constructor\(detail = 'API key missing or invalid\.', extensions\?: Record<string, unknown>\)[\s\S]+?type: PROBLEM_TYPES\.Unauthorized,\s*\n?\s*title: 'Unauthorized',\s*\n?\s*status: 401,/,
    );
  });

  it('InvalidKeyError + RevokedKeyError + ExpiredKeyError = 401 trio', () => {
    expect(body).toMatch(
      /export class InvalidKeyError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.InvalidKey,\s*\n?\s*title: 'Invalid API key',\s*\n?\s*status: 401,/,
    );
    expect(body).toMatch(
      /export class RevokedKeyError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.RevokedKey,\s*\n?\s*title: 'API key revoked',\s*\n?\s*status: 401,/,
    );
    expect(body).toMatch(
      /export class ExpiredKeyError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.ExpiredKey,\s*\n?\s*title: 'API key expired',\s*\n?\s*status: 401,/,
    );
  });

  it('ForbiddenError = 403 Forbidden', () => {
    expect(body).toMatch(
      /export class ForbiddenError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.Forbidden,\s*\n?\s*title: 'Forbidden',\s*\n?\s*status: 403,/,
    );
  });

  it('NotFoundError = 404 NotFound', () => {
    expect(body).toMatch(
      /export class NotFoundError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.NotFound,\s*\n?\s*title: 'Not Found',\s*\n?\s*status: 404,/,
    );
  });

  it('ConflictError = 409 Conflict', () => {
    expect(body).toMatch(
      /export class ConflictError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.Conflict,\s*\n?\s*title: 'Conflict',\s*\n?\s*status: 409,/,
    );
  });

  it('RateLimitedError = 429 + retry_after_seconds extension', () => {
    expect(body).toMatch(
      /export class RateLimitedError extends ApiError \{[\s\S]+?constructor\(retryAfterSeconds: number, detail = 'Rate limit exceeded\.'\)[\s\S]+?type: PROBLEM_TYPES\.RateLimited,\s*\n?\s*title: 'Too Many Requests',\s*\n?\s*status: 429,[\s\S]+?extensions: \{ retry_after_seconds: retryAfterSeconds \},/,
    );
  });

  it('ConcurrencyLimitError = 429 + current_sessions + limit extensions', () => {
    expect(body).toMatch(
      /export class ConcurrencyLimitError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.ConcurrencyLimit,\s*\n?\s*title: 'Concurrent session limit reached',\s*\n?\s*status: 429,[\s\S]+?extensions: \{ current_sessions: currentSessions, limit \},/,
    );
  });

  it('TierLimitError = 429 TierLimit', () => {
    expect(body).toMatch(
      /export class TierLimitError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.TierLimit,\s*\n?\s*title: 'Tier limit reached',\s*\n?\s*status: 429,/,
    );
  });

  it('SessionDestroyedError = 410 Gone-equivalent (SessionDestroyed)', () => {
    expect(body).toMatch(
      /export class SessionDestroyedError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.SessionDestroyed,\s*\n?\s*title: 'Session destroyed',\s*\n?\s*status: 410,/,
    );
  });

  it('SessionTimeoutError = 504 + timeout_ms extension (distinguished from DriverError)', () => {
    expect(body).toMatch(
      /SessionTimeoutError — distinguished from DriverError so customers\s*\n?\s*\/\/\s*can react specifically to "the operation didn't finish within the\s*\n?\s*\/\/\s*per-call timeout I supplied"/,
    );
    expect(body).toMatch(
      /export class SessionTimeoutError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.SessionTimeout,\s*\n?\s*title: 'Session timeout',\s*\n?\s*status: 504,[\s\S]+?extensions: \{ timeout_ms: timeoutMs \},/,
    );
  });

  it('DriverError = 502 DriverError', () => {
    expect(body).toMatch(
      /export class DriverError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.DriverError,\s*\n?\s*title: 'Driver error',\s*\n?\s*status: 502,/,
    );
  });

  it('DriverNotIntegratedError = 503 DriverNotIntegrated', () => {
    expect(body).toMatch(
      /export class DriverNotIntegratedError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.DriverNotIntegrated,\s*\n?\s*title: 'Driver not integrated',\s*\n?\s*status: 503,[\s\S]+?detail:\s*\n?\s*'The selected browser driver does not implement this operation in this deployment\.',/,
    );
    expect(body).not.toMatch(/DriverNotIntegratedError[\s\S]{0,500}?real WebKit/);
    expect(body).not.toMatch(/DriverNotIntegratedError[\s\S]{0,500}?credential login/i);
  });

  it('V-352b FeatureUnavailableError = 503 (deploy-time-disabled features, e.g. avatar upload)', () => {
    expect(body).toMatch(
      /V-352b — 503 when an optional feature is disabled at deploy-time\s*\n?\s*\/\/\s*\(e\.g\. avatar upload when the public R2 bucket isn't configured\)/,
    );
    expect(body).toMatch(
      /export class FeatureUnavailableError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.FeatureUnavailable,\s*\n?\s*title: 'Feature unavailable',\s*\n?\s*status: 503,/,
    );
  });

  it('V-353e MfaStepUpRequiredError = 403 + requires_mfa_step_up extension + 2-reason union', () => {
    expect(body).toMatch(
      /V-353e — step-up MFA challenge required to run the requested op\.\s*\n?\s*\/\/\s*Status is 403 \(the caller is authenticated; they just need to prove\s*\n?\s*\/\/\s*MFA again within the 15-min freshness window\)/,
    );
    expect(body).toMatch(/reason: 'never_satisfied' \| 'expired'/);
    expect(body).toMatch(
      /export class MfaStepUpRequiredError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.MfaStepUpRequired,\s*\n?\s*title: 'MFA step-up required',\s*\n?\s*status: 403,[\s\S]+?extensions: \{ requires_mfa_step_up: true, reason \},/,
    );
  });

  it('LegalAcceptanceRequiredError = 409 + pending_acceptances extension (avoids extra GET round-trip)', () => {
    expect(body).toMatch(
      /LegalAcceptanceRequiredError — 409 when an operation is gated on\s*\n?\s*\/\/\s*the customer accepting one or more legal documents \(ToS, Privacy,\s*\n?\s*\/\/\s*DPA, AUP\)/,
    );
    expect(body).toMatch(
      /export class LegalAcceptanceRequiredError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.LegalAcceptanceRequired,\s*\n?\s*title: 'Legal acceptance required',\s*\n?\s*status: 409,[\s\S]+?extensions: \{ pending_acceptances: pendingAcceptances \},/,
    );
    expect(body).toMatch(
      /pendingAcceptances: Array<\{ document_key: string; current_version: string \}>,/,
    );
  });

  it('V-079 auth-flow error cluster: EmailAlreadyRegistered / InvalidCredentials / InvalidAuthToken / EmailNotVerified', () => {
    expect(body).toMatch(/\/\/ Auth-flow errors \(V-079\)\./);
    expect(body).toMatch(
      /export class EmailAlreadyRegisteredError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.EmailAlreadyRegistered,\s*\n?\s*title: 'Email already registered',\s*\n?\s*status: 409,/,
    );
    expect(body).toMatch(
      /export class InvalidCredentialsError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.InvalidCredentials,\s*\n?\s*title: 'Invalid credentials',\s*\n?\s*status: 401,/,
    );
    expect(body).toMatch(
      /export class InvalidAuthTokenError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.InvalidAuthToken,\s*\n?\s*title: 'Invalid auth token',\s*\n?\s*status: 400,/,
    );
    expect(body).toMatch(
      /export class EmailNotVerifiedError extends ApiError \{[\s\S]+?type: PROBLEM_TYPES\.EmailNotVerified,\s*\n?\s*title: 'Email not verified',\s*\n?\s*status: 403,/,
    );
  });

  it('InternalError = 500 Internal (last-resort catch-all)', () => {
    expect(body).toMatch(
      /export class InternalError extends ApiError \{[\s\S]+?constructor\(detail = 'An unexpected error occurred\.', cause\?: unknown\)[\s\S]+?type: PROBLEM_TYPES\.Internal,\s*\n?\s*title: 'Internal Server Error',\s*\n?\s*status: 500,/,
    );
  });

  it('imports: PROBLEM_TYPES + Problem + ProblemType from @driftstack/api-types (single source of truth)', () => {
    expect(body).toMatch(
      // ProblemSchema is now a VALUE import too: `toProblem` derives the
      // reserved RFC 7807 member names from `ProblemSchema.shape` rather than
      // restating them, so a member added to the schema is protected with no
      // second list to keep in step.
      /import \{\s*\n?\s*PROBLEM_TYPES,\s*\n?\s*ProblemSchema,\s*\n?\s*type Problem,\s*\n?\s*type ProblemType,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
