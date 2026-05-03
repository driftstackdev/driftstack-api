// SDK error classes — one per Driftstack RFC 7807 problem-type URI.
//
// All errors extend `DriftstackError` (the base) so consumers can catch the
// whole class with a single `instanceof DriftstackError`. The fine-grained
// classes carry typed extension data (e.g. `RateLimitError.retryAfterSeconds`,
// `ConcurrencyLimitError.currentSessions`).
//
// Mapping table (server → SDK class):
//   https://errors.driftstack.dev/bad-request          → BadRequestError
//   https://errors.driftstack.dev/validation-failed    → ValidationError
//   https://errors.driftstack.dev/unauthorized         → AuthError
//   https://errors.driftstack.dev/invalid-key          → InvalidKeyError
//   https://errors.driftstack.dev/revoked-key          → RevokedKeyError
//   https://errors.driftstack.dev/expired-key          → ExpiredKeyError
//   https://errors.driftstack.dev/forbidden            → ForbiddenError
//   https://errors.driftstack.dev/not-found            → NotFoundError
//   https://errors.driftstack.dev/conflict             → ConflictError
//   https://errors.driftstack.dev/rate-limited         → RateLimitError
//   https://errors.driftstack.dev/concurrency-limit    → ConcurrencyLimitError
//   https://errors.driftstack.dev/tier-limit           → TierLimitError
//   https://errors.driftstack.dev/session-destroyed    → SessionDestroyedError
//   https://errors.driftstack.dev/driver-error         → DriverError
//   https://errors.driftstack.dev/driver-not-integrated → DriverNotIntegratedError
//   https://errors.driftstack.dev/internal             → InternalError
//
// Anything else (network failure, parse error, etc.) surfaces as a
// `DriftstackError` with `kind: 'transport'` set on the instance.

import type { Problem } from '@driftstack/api-types';

export type DriftstackErrorKind =
  | 'bad_request'
  | 'validation'
  | 'unauthorized'
  | 'invalid_key'
  | 'revoked_key'
  | 'expired_key'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'concurrency_limit'
  | 'tier_limit'
  | 'session_destroyed'
  | 'session_timeout'
  | 'driver_error'
  | 'driver_not_integrated'
  | 'internal'
  | 'transport';

export class DriftstackError extends Error {
  readonly kind: DriftstackErrorKind;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(opts: {
    kind: DriftstackErrorKind;
    status: number;
    type: string;
    title: string;
    detail?: string;
    instance?: string;
    extensions?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.detail ?? opts.title, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'DriftstackError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.type = opts.type;
    this.title = opts.title;
    this.detail = opts.detail;
    this.instance = opts.instance;
    this.extensions = opts.extensions ?? {};
  }
}

export class BadRequestError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('bad_request', p));
    this.name = 'BadRequestError';
  }
}

export class ValidationError extends DriftstackError {
  /** Server-supplied issues array; shape varies (often a Zod flatten()). */
  readonly issues: unknown;
  constructor(p: Problem) {
    super(toOpts('validation', p));
    this.name = 'ValidationError';
    this.issues = (p as { issues?: unknown }).issues;
  }
}

export class AuthError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('unauthorized', p));
    this.name = 'AuthError';
  }
}

export class InvalidKeyError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('invalid_key', p));
    this.name = 'InvalidKeyError';
  }
}

export class RevokedKeyError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('revoked_key', p));
    this.name = 'RevokedKeyError';
  }
}

export class ExpiredKeyError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('expired_key', p));
    this.name = 'ExpiredKeyError';
  }
}

export class ForbiddenError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('forbidden', p));
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('not_found', p));
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('conflict', p));
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends DriftstackError {
  /** Suggested wait before retrying. Sourced from `retry_after_seconds` extension or `Retry-After` header. */
  readonly retryAfterSeconds: number;
  constructor(p: Problem, retryAfterSeconds: number) {
    super(toOpts('rate_limited', p));
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ConcurrencyLimitError extends DriftstackError {
  readonly currentSessions: number | undefined;
  readonly limit: number | undefined;
  constructor(p: Problem) {
    super(toOpts('concurrency_limit', p));
    this.name = 'ConcurrencyLimitError';
    const ext = p as { current_sessions?: number; limit?: number };
    this.currentSessions = ext.current_sessions;
    this.limit = ext.limit;
  }
}

export class TierLimitError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('tier_limit', p));
    this.name = 'TierLimitError';
  }
}

export class SessionDestroyedError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('session_destroyed', p));
    this.name = 'SessionDestroyedError';
  }
}

// SessionTimeoutError — distinguished from DriverError so customers can
// react specifically to "the operation didn't finish within the per-call
// timeout I supplied" without conflating with downstream driver failures.
// The `timeout_ms` field on the problem extension surfaces the bound the
// server actually applied (may differ from the customer's request if the
// server clamped it).
export class SessionTimeoutError extends DriftstackError {
  readonly timeoutMs: number | undefined;
  constructor(p: Problem) {
    super(toOpts('session_timeout', p));
    this.name = 'SessionTimeoutError';
    const ext = (p as { timeout_ms?: unknown }).timeout_ms;
    this.timeoutMs = typeof ext === 'number' ? ext : undefined;
  }
}

export class DriverError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('driver_error', p));
    this.name = 'DriverError';
  }
}

export class DriverNotIntegratedError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('driver_not_integrated', p));
    this.name = 'DriverNotIntegratedError';
  }
}

export class InternalError extends DriftstackError {
  constructor(p: Problem) {
    super(toOpts('internal', p));
    this.name = 'InternalError';
  }
}

/** Network / parse / non-Problem failure — server didn't return a structured error. */
export class TransportError extends DriftstackError {
  constructor(message: string, status = 0, cause?: unknown) {
    super({
      kind: 'transport',
      status,
      type: 'about:blank',
      title: 'Transport error',
      detail: message,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = 'TransportError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Mapping
// ───────────────────────────────────────────────────────────────────────────

const TYPE_TO_CTOR: Record<string, (p: Problem) => DriftstackError> = {
  'https://errors.driftstack.dev/bad-request': (p) => new BadRequestError(p),
  'https://errors.driftstack.dev/validation-failed': (p) => new ValidationError(p),
  'https://errors.driftstack.dev/unauthorized': (p) => new AuthError(p),
  'https://errors.driftstack.dev/invalid-key': (p) => new InvalidKeyError(p),
  'https://errors.driftstack.dev/revoked-key': (p) => new RevokedKeyError(p),
  'https://errors.driftstack.dev/expired-key': (p) => new ExpiredKeyError(p),
  'https://errors.driftstack.dev/forbidden': (p) => new ForbiddenError(p),
  'https://errors.driftstack.dev/not-found': (p) => new NotFoundError(p),
  'https://errors.driftstack.dev/conflict': (p) => new ConflictError(p),
  'https://errors.driftstack.dev/concurrency-limit': (p) => new ConcurrencyLimitError(p),
  'https://errors.driftstack.dev/tier-limit': (p) => new TierLimitError(p),
  'https://errors.driftstack.dev/session-destroyed': (p) => new SessionDestroyedError(p),
  'https://errors.driftstack.dev/session-timeout': (p) => new SessionTimeoutError(p),
  'https://errors.driftstack.dev/driver-error': (p) => new DriverError(p),
  'https://errors.driftstack.dev/driver-not-integrated': (p) => new DriverNotIntegratedError(p),
  'https://errors.driftstack.dev/internal': (p) => new InternalError(p),
};

/**
 * Build the typed error class from a server `Problem` plus a possibly-set
 * Retry-After header (used by RateLimitError when the body's
 * `retry_after_seconds` is missing).
 */
export function errorFromProblem(p: Problem, retryAfterHeader: string | null): DriftstackError {
  if (p.type === 'https://errors.driftstack.dev/rate-limited') {
    const fromBody = (p as { retry_after_seconds?: number }).retry_after_seconds;
    const fromHeader = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
    const retryAfter = fromBody ?? (Number.isFinite(fromHeader) ? fromHeader : 1);
    return new RateLimitError(p, retryAfter);
  }
  const ctor = TYPE_TO_CTOR[p.type];
  if (ctor) return ctor(p);
  // Unknown problem type — surface as DriftstackError with the raw fields.
  return new DriftstackError({
    kind: p.status >= 500 ? 'internal' : 'bad_request',
    status: p.status,
    type: p.type,
    title: p.title,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
    ...(p.instance !== undefined ? { instance: p.instance } : {}),
  });
}

function toOpts(
  kind: DriftstackErrorKind,
  p: Problem,
): {
  kind: DriftstackErrorKind;
  status: number;
  type: string;
  title: string;
  detail?: string;
  instance?: string;
  extensions: Record<string, unknown>;
} {
  return {
    kind,
    status: p.status,
    type: p.type,
    title: p.title,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
    ...(p.instance !== undefined ? { instance: p.instance } : {}),
    extensions: extensionMembers(p),
  };
}

function extensionMembers(p: Problem): Record<string, unknown> {
  const known = new Set(['type', 'title', 'status', 'detail', 'instance']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!known.has(k)) out[k] = v;
  }
  return out;
}
