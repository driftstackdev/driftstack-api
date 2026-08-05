// W965 — errors lib RFC 7807 cross-source invariant. Two-hundred-
// ninety-first in the drift-guard series. Pins the API error
// taxonomy:
//
//   Service intro framing — 'Error taxonomy for the API. Every
//   thrown error that surfaces to the response layer is one of
//   these ApiError subclasses. The error middleware (apps/server/
//   src/middleware/error-handler.ts) converts them to RFC 7807
//   problem+json responses'.
//
//   500-never-leak framing — 'Anything *else* that escapes — a
//   TypeError, a Drizzle error, a pino crash — is logged at error
//   level and replied as Internal (500) with a stable problem-type.
//   We never leak raw error messages to clients'.
//
//   ApiError base class:
//     - 5 readonly fields: type + title + status + detail +
//       extensions.
//     - constructor takes ApiErrorOptions (6 fields incl. cause).
//     - toProblem(instance?) builds RFC 7807 problem+json shape.
//
//   25 ApiError subclasses across the codebase:
//     - BadRequestError (400).
//     - ValidationError (400).
//     - UnauthorizedError + InvalidKeyError + RevokedKeyError +
//       ExpiredKeyError (401).
//     - ForbiddenError (403).
//     - NotFoundError (404).
//     - ConflictError (409).
//     - RateLimitedError (429).
//     - ConcurrencyLimitError (429).
//     - TierLimitError (429).
//     - SessionDestroyedError + SessionTimeoutError +
//       DriverError + DriverNotIntegratedError +
//       FeatureUnavailableError + MfaStepUpRequiredError +
//       LegalAcceptanceRequiredError + EmailAlreadyRegisteredError
//       + InvalidCredentialsError + InvalidAuthTokenError +
//       EmailNotVerifiedError + InternalError.
//
//   Problem-types from @driftstack/api-types PROBLEM_TYPES.
//
// stays in lockstep across apps/server/src/lib/errors.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  TierLimitError,
  UnauthorizedError,
  ValidationError,
} from '../../src/lib/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W965 errors lib RFC 7807 cross-source invariant', () => {
  // ─── Service intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/lib/errors.ts header pins surface — 'Error taxonomy for the API. Every thrown error that surfaces to the response layer is one of these ApiError subclasses. The error middleware (apps/server/src/middleware/error-handler.ts) converts them to RFC 7807 problem+json responses'. The error-middleware-converts framing is the central architecture.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/Error taxonomy for the API\./);
    expect(p).toMatch(/Every thrown error that surfaces to the response layer is one of these/);
    expect(p).toMatch(
      /`ApiError` subclasses\. The error middleware \(apps\/server\/src\/middleware\//,
    );
    expect(p).toMatch(/error-handler\.ts\) converts them to RFC 7807 problem\+json responses\./);
  });

  // ─── 500-never-leak framing ──────────────────────────────────

  it("CRITICAL 500-never-leak framing — 'Anything *else* that escapes — a TypeError, a Drizzle error, a pino crash — is logged at error level and replied as Internal (500) with a stable problem-type. We never leak raw error messages to clients'. The never-leak posture is the customer-facing safety invariant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(
      /Anything \*else\* that escapes — a TypeError, a Drizzle error, a pino crash —/,
    );
    expect(p).toMatch(/is logged at error level and replied as Internal \(500\) with a stable/);
    expect(p).toMatch(/problem-type\. We never leak raw error messages to clients\./);
  });

  // ─── ApiError base class shape ───────────────────────────────

  it('CRITICAL ApiError has 5 readonly fields — type + title + status + detail (string | undefined) + extensions (Record). The 5-field shape is the RFC 7807 problem+json content.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/export class ApiError extends Error \{/);
    expect(p).toMatch(/readonly type: ProblemType;/);
    expect(p).toMatch(/readonly title: string;/);
    expect(p).toMatch(/readonly status: number;/);
    expect(p).toMatch(/readonly detail: string \| undefined;/);
    expect(p).toMatch(/readonly extensions: Record<string, unknown>;/);
  });

  it('CRITICAL ApiErrorOptions 6 fields — type + title + status + detail? + extensions? + cause?. The 6-field opts is the constructor input contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/export interface ApiErrorOptions \{/);
    expect(p).toMatch(/type: ProblemType;/);
    expect(p).toMatch(/title: string;/);
    expect(p).toMatch(/status: number;/);
    expect(p).toMatch(/detail\?: string;/);
    expect(p).toMatch(/extensions\?: Record<string, unknown>;/);
    expect(p).toMatch(/cause\?: unknown;/);
  });

  // ─── toProblem() shape ───────────────────────────────────────

  it('CRITICAL toProblem(instance?) builds RFC 7807 problem+json shape — type + title + status + detail (only if defined) + instance (only if provided) + ...extensions spread. The RFC 7807 conformance is the wire-format contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/toProblem\(instance\?: string\): Problem \{/);
    expect(p).toMatch(/type: this\.type,/);
    expect(p).toMatch(/title: this\.title,/);
    expect(p).toMatch(/status: this\.status,/);
    expect(p).toMatch(/\.\.\.\(this\.detail !== undefined \? \{ detail: this\.detail \} : \{\}\),/);
    expect(p).toMatch(/\.\.\.\(instance !== undefined \? \{ instance \} : \{\}\),/);
    expect(p).toMatch(/\.\.\.this\.extensions,/);
  });

  // ─── BadRequestError 400 + 'Bad Request' ─────────────────────

  it("CRITICAL BadRequestError sets type=PROBLEM_TYPES.BadRequest + title='Bad Request' + status=400. The 400-status + 'Bad Request' title matches HTTP semantics.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/export class BadRequestError extends ApiError \{/);
    expect(p).toMatch(/type: PROBLEM_TYPES\.BadRequest,/);
    expect(p).toMatch(/title: 'Bad Request',/);
    expect(p).toMatch(/status: 400,/);
  });

  // ─── ValidationError 400 + issues extension ──────────────────

  it("CRITICAL ValidationError sets title='Validation Failed' + status=400 + detail='One or more fields failed validation.' + extensions={ issues }. The structured-issues extension surfaces Zod schema-level errors to clients.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/export class ValidationError extends ApiError \{/);
    expect(p).toMatch(/type: PROBLEM_TYPES\.ValidationFailed,/);
    expect(p).toMatch(/title: 'Validation Failed',/);
    expect(p).toMatch(/status: 400,/);
    expect(p).toMatch(/detail: 'One or more fields failed validation\.',/);
    expect(p).toMatch(/extensions: \{ issues \},/);
  });

  // ─── UnauthorizedError default detail ────────────────────────

  it("CRITICAL UnauthorizedError defaults detail to 'API key missing or invalid.'. The default-message lets routes throw new UnauthorizedError() with no args.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    // V-737 — the DEFAULT is what this pins, and it is unchanged; the optional
    // extensions param added for the OAuth `error` code does not disturb
    // `new UnauthorizedError()` with no args.
    expect(p).toMatch(
      /constructor\(detail = 'API key missing or invalid\.', extensions\?: Record<string, unknown>\)/,
    );
  });

  // ─── 25 ApiError subclasses cardinality ──────────────────────

  it('CRITICAL errors.ts declares EXACTLY 32 ApiError subclasses — covers BadRequest + Validation + auth (5x 401) + Forbidden + NotFound + Conflict + 2x rate-limit + Tier + domain-specific errors + Internal. Q.1.d added ByokAnthropicRequiredError (2026-05-17); subsequent additions through 2026-05-20 (egress + agent + activation-gate family) grew the taxonomy; doc-150 item 6 added StorageQuotaExceededError (2026-06-25); founder directive #63 added ProxyValidationFailedError (2026-06-25); A3 finding #7 added ProfileInUseError (2026-06-27) → 32 subclasses + 1 base.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    const classes = p.match(/export class \w+Error extends ApiError/g) ?? [];
    expect(classes.length).toBe(32); // 32 subclasses, plus ApiError base = 33 total
  });

  // ─── Each subclass sets name field ───────────────────────────

  it("CRITICAL each ApiError subclass sets this.name = 'XxxError' in the constructor. The named-class instance lets logs distinguish 'NotFoundError' from 'ConflictError' at glance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/this\.name = 'BadRequestError';/);
    expect(p).toMatch(/this\.name = 'ValidationError';/);
    expect(p).toMatch(/this\.name = 'UnauthorizedError';/);
    expect(p).toMatch(/this\.name = 'NotFoundError';/);
    expect(p).toMatch(/this\.name = 'ConflictError';/);
    expect(p).toMatch(/this\.name = 'TierLimitError';/);
  });

  // ─── PROBLEM_TYPES + Problem + ProblemType imports ───────────

  it('CRITICAL imports PROBLEM_TYPES (value) + Problem (type) + ProblemType (type) from @driftstack/api-types — single-source-of-truth for the problem-type vocabulary.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(
      /import \{ PROBLEM_TYPES, type Problem, type ProblemType \} from '@driftstack\/api-types';/,
    );
  });

  // ─── Runtime parity: ApiError construction + toProblem ───────

  it('CRITICAL ApiError.toProblem produces 4-field RFC 7807 shape without instance. Mechanically verified.', () => {
    const err = new ApiError({
      type: 'about:blank' as never,
      title: 'Test',
      status: 418,
    });
    const problem = err.toProblem();
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Test',
      status: 418,
    });
  });

  it('CRITICAL ApiError.toProblem includes instance when supplied + spreads extensions. The instance field is the per-request identifier (route layer fills it).', () => {
    const err = new ApiError({
      type: 'about:blank' as never,
      title: 'Test',
      status: 418,
      detail: 'optional',
      extensions: { custom: 'value' },
    });
    const problem = err.toProblem('/v1/test/123');
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Test',
      status: 418,
      detail: 'optional',
      instance: '/v1/test/123',
      custom: 'value',
    });
  });

  it('CRITICAL ApiError.toProblem omits detail field when not supplied. The conditional-spread keeps the wire shape clean for detail-less errors.', () => {
    const err = new ApiError({
      type: 'about:blank' as never,
      title: 'Test',
      status: 500,
    });
    const problem = err.toProblem();
    expect(problem).not.toHaveProperty('detail');
  });

  // ─── Runtime: subclass instances ─────────────────────────────

  it("CRITICAL BadRequestError runtime — status=400 + name='BadRequestError'. Verified mechanically.", () => {
    const err = new BadRequestError('test detail');
    expect(err.status).toBe(400);
    expect(err.name).toBe('BadRequestError');
    expect(err.title).toBe('Bad Request');
    expect(err.detail).toBe('test detail');
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
  });

  it('CRITICAL ValidationError runtime — status=400 + extensions={ issues } payload. The extensions.issues field carries the Zod schema-level errors.', () => {
    const issues = [{ path: ['email'], message: 'invalid' }];
    const err = new ValidationError(issues);
    expect(err.status).toBe(400);
    expect(err.name).toBe('ValidationError');
    expect(err.extensions).toEqual({ issues });
  });

  it("CRITICAL UnauthorizedError runtime — default detail = 'API key missing or invalid.' when no args. The 0-arg constructor is the common case in middleware.", () => {
    const err = new UnauthorizedError();
    expect(err.status).toBe(401);
    expect(err.detail).toBe('API key missing or invalid.');
    expect(err.name).toBe('UnauthorizedError');
  });

  it('CRITICAL NotFoundError runtime — status=404 + custom detail. Verified mechanically.', () => {
    const err = new NotFoundError('Resource X not found.');
    expect(err.status).toBe(404);
    expect(err.name).toBe('NotFoundError');
    expect(err.detail).toBe('Resource X not found.');
  });

  it('CRITICAL ConflictError runtime — status=409 + custom extensions Record. Used for name-collision + state-conflict errors across services.', () => {
    const err = new ConflictError('name taken', { resource: 'profile', field: 'name' });
    expect(err.status).toBe(409);
    expect(err.name).toBe('ConflictError');
    expect(err.extensions).toEqual({ resource: 'profile', field: 'name' });
  });

  it('CRITICAL TierLimitError runtime — status=429 + 4-field extensions { limit, current, resource, tier }. Matches W923 profile-snapshots + W948 profiles TierLimitError shape exactly.', () => {
    const err = new TierLimitError('Tier "X" permits at most N profiles; you have M.', {
      limit: 10,
      current: 10,
      resource: 'profile',
      tier: 'team_manual',
    });
    expect(err.status).toBe(429);
    expect(err.name).toBe('TierLimitError');
    expect(err.extensions).toEqual({
      limit: 10,
      current: 10,
      resource: 'profile',
      tier: 'team_manual',
    });
  });

  // ─── ApiError preserves cause ────────────────────────────────

  it('CRITICAL ApiError constructor passes opts.cause through to Error super constructor. The cause-chain lets logs surface the original error (e.g. Drizzle pg-error).', () => {
    const originalError = new Error('original');
    const err = new ApiError({
      type: 'about:blank' as never,
      title: 'Wrapper',
      status: 500,
      cause: originalError,
    });
    expect(err.cause).toBe(originalError);
  });

  // ─── 500 cause never leaks into the problem body (CWE-209) ───

  it("CRITICAL InternalError preserves the cause on the Error object (for logs) but toProblem() does NOT spread it into the response body. The error-handler wraps every unknown 5xx as `new InternalError('...', err)` passing `err` as the CAUSE (not extensions) — this runtime guard ensures a Postgres/Drizzle error's table/column/constraint/SQL detail stays log-only and never reaches the customer (the never-leak-raw-messages invariant; CWE-209 info-disclosure).", () => {
    // node-postgres errors carry enumerable own props that WOULD leak
    // if the cause were ever spread into the body (e.g. via a refactor
    // that routed cause into `extensions`). The handler-source parity
    // test can't catch that — only this behavioural assertion can.
    const pgLikeCause = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      table: 'accounts',
      column: 'email',
      constraint: 'accounts_email_key',
      detail: 'Key (email)=(victim@example.com) already exists.',
      schema: 'public',
    });
    const err = new InternalError('An unexpected error occurred.', pgLikeCause);
    // Cause IS preserved on the Error object so server-side logs surface it.
    expect(err.cause).toBe(pgLikeCause);
    // Body is EXACTLY the 5 safe RFC 7807 fields — toEqual fails if ANY
    // cause prop (code/table/column/constraint/detail/schema) leaks in.
    const problem = err.toProblem('/v1/sessions/abc');
    expect(problem).toEqual({
      type: err.type,
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/v1/sessions/abc',
    });
    for (const leakyKey of ['code', 'table', 'column', 'constraint', 'schema', 'cause']) {
      expect(problem, `problem body must NOT leak '${leakyKey}'`).not.toHaveProperty(leakyKey);
    }
    // `detail` IS present but MUST be the generic message, not the pg detail.
    expect(problem.detail).toBe('An unexpected error occurred.');
  });

  // ─── ApiError default message = detail OR title ──────────────

  it('CRITICAL ApiError super message = detail ?? title — instance.message returns detail when supplied, falls back to title. The 2-level fallback ensures the JS Error.message is always populated.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(
      /super\(opts\.detail \?\? opts\.title, opts\.cause !== undefined \? \{ cause: opts\.cause \} : undefined\);/,
    );
    // Runtime: detail = title fallback.
    const errWithDetail = new BadRequestError('explicit detail');
    expect(errWithDetail.message).toBe('explicit detail');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/errors-lib-rfc7807-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
