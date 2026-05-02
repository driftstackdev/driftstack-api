import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  AuthError,
  BadRequestError,
  ConcurrencyLimitError,
  DriftstackError,
  errorFromProblem,
  InvalidKeyError,
  NotFoundError,
  RateLimitError,
  TransportError,
  ValidationError,
} from '../../src/errors.js';

describe('errorFromProblem', () => {
  it('maps unauthorized → AuthError', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.Unauthorized, title: 'Unauthorized', status: 401 },
      null,
    );
    expect(e).toBeInstanceOf(AuthError);
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e.kind).toBe('unauthorized');
    expect(e.status).toBe(401);
  });

  it('maps invalid-key → InvalidKeyError', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.InvalidKey, title: 'Invalid', status: 401 },
      null,
    );
    expect(e).toBeInstanceOf(InvalidKeyError);
  });

  it('maps validation-failed → ValidationError, captures issues', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.ValidationFailed,
        title: 'Validation Failed',
        status: 400,
        issues: { fieldErrors: { url: ['Required'] } },
      },
      null,
    );
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).issues).toEqual({ fieldErrors: { url: ['Required'] } });
  });

  it('maps rate-limited → RateLimitError, prefers body retry_after_seconds', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.RateLimited,
        title: 'Rate limited',
        status: 429,
        retry_after_seconds: 12,
      },
      '99',
    );
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retryAfterSeconds).toBe(12);
  });

  it('maps rate-limited without body hint → uses Retry-After header', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.RateLimited, title: 'Rate limited', status: 429 },
      '7',
    );
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retryAfterSeconds).toBe(7);
  });

  it('maps rate-limited with neither hint → defaults to 1s', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.RateLimited, title: 'Rate limited', status: 429 },
      null,
    );
    expect((e as RateLimitError).retryAfterSeconds).toBe(1);
  });

  it('maps concurrency-limit → ConcurrencyLimitError, captures current/limit', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.ConcurrencyLimit,
        title: 'Concurrent session limit reached',
        status: 429,
        current_sessions: 1,
        limit: 1,
      },
      null,
    );
    expect(e).toBeInstanceOf(ConcurrencyLimitError);
    expect((e as ConcurrencyLimitError).currentSessions).toBe(1);
    expect((e as ConcurrencyLimitError).limit).toBe(1);
  });

  it('maps not-found → NotFoundError', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.NotFound, title: 'Not Found', status: 404 },
      null,
    );
    expect(e).toBeInstanceOf(NotFoundError);
  });

  it('unknown problem type → DriftstackError with raw fields', () => {
    const e = errorFromProblem(
      { type: 'https://errors.example.dev/custom', title: 'Custom', status: 418 },
      null,
    );
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e).not.toBeInstanceOf(BadRequestError);
    expect(e.type).toBe('https://errors.example.dev/custom');
    expect(e.status).toBe(418);
  });

  it('preserves extension members on the parent class via .extensions', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.NotFound,
        title: 'Not Found',
        status: 404,
        resource: 'session',
      },
      null,
    );
    expect(e.extensions.resource).toBe('session');
  });
});

describe('TransportError', () => {
  it('encapsulates non-Problem failures', () => {
    const inner = new Error('connection refused');
    const e = new TransportError('network blip', 0, inner);
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e.kind).toBe('transport');
    expect(e.status).toBe(0);
  });
});
