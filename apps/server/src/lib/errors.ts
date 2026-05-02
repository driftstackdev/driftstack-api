// Error taxonomy for the API.
//
// Every thrown error that surfaces to the response layer is one of these
// `ApiError` subclasses. The error middleware (apps/server/src/middleware/
// error-handler.ts) converts them to RFC 7807 problem+json responses.
//
// Anything *else* that escapes — a TypeError, a Drizzle error, a pino crash —
// is logged at error level and replied as Internal (500) with a stable
// problem-type. We never leak raw error messages to clients.

import { PROBLEM_TYPES, type Problem, type ProblemType } from '@driftstack/api-types';

export interface ApiErrorOptions {
  type: ProblemType;
  title: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly type: ProblemType;
  readonly title: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(opts: ApiErrorOptions) {
    super(opts.detail ?? opts.title, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ApiError';
    this.type = opts.type;
    this.title = opts.title;
    this.status = opts.status;
    this.detail = opts.detail;
    this.extensions = opts.extensions ?? {};
  }

  toProblem(instance?: string): Problem {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(instance !== undefined ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export class BadRequestError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.BadRequest,
      title: 'Bad Request',
      status: 400,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'BadRequestError';
  }
}

export class ValidationError extends ApiError {
  constructor(issues: unknown) {
    super({
      type: PROBLEM_TYPES.ValidationFailed,
      title: 'Validation Failed',
      status: 400,
      detail: 'One or more fields failed validation.',
      extensions: { issues },
    });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(detail = 'API key missing or invalid.') {
    super({
      type: PROBLEM_TYPES.Unauthorized,
      title: 'Unauthorized',
      status: 401,
      detail,
    });
    this.name = 'UnauthorizedError';
  }
}

export class InvalidKeyError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.InvalidKey,
      title: 'Invalid API key',
      status: 401,
      detail: 'The supplied API key is not recognised.',
    });
    this.name = 'InvalidKeyError';
  }
}

export class RevokedKeyError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.RevokedKey,
      title: 'API key revoked',
      status: 401,
      detail: 'This API key has been revoked.',
    });
    this.name = 'RevokedKeyError';
  }
}

export class ExpiredKeyError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.ExpiredKey,
      title: 'API key expired',
      status: 401,
      detail: 'This API key has expired.',
    });
    this.name = 'ExpiredKeyError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(detail = 'Caller is not permitted to perform this action.') {
    super({
      type: PROBLEM_TYPES.Forbidden,
      title: 'Forbidden',
      status: 403,
      detail,
    });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(detail = 'Resource not found.') {
    super({
      type: PROBLEM_TYPES.NotFound,
      title: 'Not Found',
      status: 404,
      detail,
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(detail: string) {
    super({
      type: PROBLEM_TYPES.Conflict,
      title: 'Conflict',
      status: 409,
      detail,
    });
    this.name = 'ConflictError';
  }
}

export class RateLimitedError extends ApiError {
  constructor(retryAfterSeconds: number, detail = 'Rate limit exceeded.') {
    super({
      type: PROBLEM_TYPES.RateLimited,
      title: 'Too Many Requests',
      status: 429,
      detail,
      extensions: { retry_after_seconds: retryAfterSeconds },
    });
    this.name = 'RateLimitedError';
  }
}

export class ConcurrencyLimitError extends ApiError {
  constructor(currentSessions: number, limit: number) {
    super({
      type: PROBLEM_TYPES.ConcurrencyLimit,
      title: 'Concurrent session limit reached',
      status: 429,
      detail: `Account already has ${currentSessions.toString()} active sessions; tier permits ${limit.toString()}.`,
      extensions: { current_sessions: currentSessions, limit },
    });
    this.name = 'ConcurrencyLimitError';
  }
}

export class TierLimitError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.TierLimit,
      title: 'Tier limit reached',
      status: 429,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'TierLimitError';
  }
}

export class SessionDestroyedError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.SessionDestroyed,
      title: 'Session destroyed',
      status: 410,
      detail: 'This session has been destroyed and cannot be used.',
    });
    this.name = 'SessionDestroyedError';
  }
}

export class DriverError extends ApiError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super({
      type: PROBLEM_TYPES.DriverError,
      title: 'Driver error',
      status: 502,
      detail,
      ...(extensions !== undefined ? { extensions } : {}),
    });
    this.name = 'DriverError';
  }
}

export class DriverNotIntegratedError extends ApiError {
  constructor() {
    super({
      type: PROBLEM_TYPES.DriverNotIntegrated,
      title: 'Driver not integrated',
      status: 503,
      detail: 'The real WebKit driver is not yet integrated; this server is configured to use it.',
    });
    this.name = 'DriverNotIntegratedError';
  }
}

export class InternalError extends ApiError {
  constructor(detail = 'An unexpected error occurred.', cause?: unknown) {
    super({
      type: PROBLEM_TYPES.Internal,
      title: 'Internal Server Error',
      status: 500,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = 'InternalError';
  }
}
