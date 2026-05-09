import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  AuthError,
  BadRequestError,
  ConcurrencyLimitError,
  DriftstackError,
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  errorFromProblem,
  FeatureUnavailableError,
  InvalidAuthTokenError,
  InvalidCredentialsError,
  InvalidKeyError,
  MfaStepUpRequiredError,
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

// V-114: SDK normalization for V-079 auth-flow problem types. Before V-114
// these mapped to a generic DriftstackError; after V-114 each has a
// dedicated class so consumers can catch on the specific failure mode
// (e.g. distinguishing "wrong password" from "email not verified" without
// reading the problem URI).
describe('errorFromProblem — auth-flow problem types (V-114)', () => {
  it('maps email-already-registered → EmailAlreadyRegisteredError (status 409)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.EmailAlreadyRegistered,
        title: 'Email already registered',
        status: 409,
      },
      null,
    );
    expect(e).toBeInstanceOf(EmailAlreadyRegisteredError);
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e.kind).toBe('email_already_registered');
    expect(e.status).toBe(409);
  });

  it('maps invalid-credentials → InvalidCredentialsError (status 401)', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.InvalidCredentials, title: 'Invalid credentials', status: 401 },
      null,
    );
    expect(e).toBeInstanceOf(InvalidCredentialsError);
    expect(e.kind).toBe('invalid_credentials');
    expect(e.status).toBe(401);
  });

  it('maps invalid-auth-token → InvalidAuthTokenError (status 400)', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.InvalidAuthToken, title: 'Invalid auth token', status: 400 },
      null,
    );
    expect(e).toBeInstanceOf(InvalidAuthTokenError);
    expect(e.kind).toBe('invalid_auth_token');
    expect(e.status).toBe(400);
  });

  it('maps email-not-verified → EmailNotVerifiedError (status 403)', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.EmailNotVerified, title: 'Email not verified', status: 403 },
      null,
    );
    expect(e).toBeInstanceOf(EmailNotVerifiedError);
    expect(e.kind).toBe('email_not_verified');
    expect(e.status).toBe(403);
  });

  it('preserves the verbatim problem URI on the typed error', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.EmailNotVerified, title: 'Email not verified', status: 403 },
      null,
    );
    expect(e.type).toBe('https://errors.driftstack.dev/email-not-verified');
  });
});

// V-441 — additional typed errors closing three-SDK problem-type parity.
describe('errorFromProblem — V-441 ops-flow problem types', () => {
  it('maps feature-unavailable → FeatureUnavailableError (status 503)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.FeatureUnavailable,
        title: 'Feature unavailable',
        status: 503,
      },
      null,
    );
    expect(e).toBeInstanceOf(FeatureUnavailableError);
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e.kind).toBe('feature_unavailable');
    expect(e.status).toBe(503);
  });

  it('maps mfa-step-up-required → MfaStepUpRequiredError (status 403)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.MfaStepUpRequired,
        title: 'MFA step-up required',
        status: 403,
      },
      null,
    );
    expect(e).toBeInstanceOf(MfaStepUpRequiredError);
    expect(e.kind).toBe('mfa_step_up_required');
    expect(e.status).toBe(403);
  });
});
