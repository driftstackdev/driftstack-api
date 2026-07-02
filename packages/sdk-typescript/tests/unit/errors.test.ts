import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  AuthError,
  BadRequestError,
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  ConcurrencyLimitError,
  DriftstackError,
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  errorFromProblem,
  FeatureUnavailableError,
  InternalError,
  InvalidAuthTokenError,
  InvalidCredentialsError,
  InvalidKeyError,
  isRetryable,
  MfaStepUpRequiredError,
  NotFoundError,
  PairModeConflictError,
  PairModeStateInvalidTransitionError,
  ProfileInUseError,
  RateLimitError,
  TierLimitError,
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

  it('maps bad-request → BadRequestError (generic 400, NOT ValidationError)', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.BadRequest, title: 'Bad Request', status: 400 },
      null,
    );
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e).toBeInstanceOf(DriftstackError);
    // BadRequestError is a sibling of ValidationError, NOT a parent —
    // the generic bad-request problem-type must not surface as a
    // validation failure (which would imply a field-level issues list).
    expect(e).not.toBeInstanceOf(ValidationError);
    expect(e.kind).toBe('bad_request');
    expect(e.status).toBe(400);
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
    expect(e).not.toBeInstanceOf(BadRequestError);
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

  // Arc 4 Wave 2.B sub-slice 8.20.k.4 (v2-#8) — TS TierLimitError
  // parity with Python+Go QuotaExceededError typed-extension fields.
  // Customers reading the error in TS now get err.current /
  // err.limit / err.recordType without re-parsing the raw problem.
  it('maps tier-limit → TierLimitError, captures current/limit/recordType', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.TierLimit,
        title: 'Tier quota exhausted',
        status: 429,
        current: 1000,
        limit: 1000,
        record_type: 'navigate',
      },
      null,
    );
    expect(e).toBeInstanceOf(TierLimitError);
    expect((e as TierLimitError).current).toBe(1000);
    expect((e as TierLimitError).limit).toBe(1000);
    expect((e as TierLimitError).recordType).toBe('navigate');
  });

  it('tier-limit without extension fields → fields default to undefined (matches Python None / Go zero-value semantics)', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.TierLimit, title: 'Tier quota exhausted', status: 429 },
      null,
    );
    expect(e).toBeInstanceOf(TierLimitError);
    expect((e as TierLimitError).current).toBeUndefined();
    expect((e as TierLimitError).limit).toBeUndefined();
    expect((e as TierLimitError).recordType).toBeUndefined();
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

  it('unknown problem type → DriftstackError with raw fields + preserved extensions', () => {
    const e = errorFromProblem(
      {
        type: 'https://errors.example.dev/custom',
        title: 'Custom',
        status: 418,
        // Extension members MUST survive the unknown-type fallback (they were
        // dropped before the Fable SDK re-audit fix — the fallback bypassed
        // toOpts/extensionMembers).
        request_id: 'req_abc123',
        code: 'teapot',
      },
      null,
    );
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e).not.toBeInstanceOf(BadRequestError);
    expect(e.type).toBe('https://errors.example.dev/custom');
    expect(e.status).toBe(418);
    expect(e.extensions.request_id).toBe('req_abc123');
    expect(e.extensions.code).toBe('teapot');
    // <500 unknown → bad_request (non-retryable).
    expect(e.kind).toBe('bad_request');
  });

  it('unknown 5xx problem type → retryable internal kind, extensions preserved', () => {
    const e = errorFromProblem(
      {
        type: 'https://errors.driftstack.dev/upstream-overloaded',
        title: 'Overloaded',
        status: 503,
        retry_after_seconds: 30,
      },
      null,
    );
    expect(e).toBeInstanceOf(DriftstackError);
    expect(e.status).toBe(503);
    // Documented policy: a generic (non-terminal) 5xx is retryable.
    expect(e.kind).toBe('internal');
    expect(isRetryable(e)).toBe(true);
    expect(e.extensions.retry_after_seconds).toBe(30);
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

// Bundled-LLM 402 + pair-mode 409 typed errors — the `kind`
// discriminator must match the HTTP status class: 402 → 'payment_required'
// (a dedicated union member), 409 → the existing 'conflict' kind. They
// were previously built with the wrong 'bad_request' kind. isRetryable()
// keys off transport/internal/rate_limited, so all four stay NON-retryable.
describe('errorFromProblem — bundled-LLM 402 + pair-mode 409 kind correctness', () => {
  it('maps bundled-llm-budget-exhausted → BundledLlmBudgetExhaustedError (kind payment_required, status 402)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.BundledLlmBudgetExhausted,
        title: 'Bundled-LLM budget exhausted',
        status: 402,
        spent_cents: 1500,
        cap_cents: 1000,
      },
      null,
    );
    expect(e).toBeInstanceOf(BundledLlmBudgetExhaustedError);
    expect(e.kind).toBe('payment_required');
    expect(e.status).toBe(402);
    expect((e as BundledLlmBudgetExhaustedError).spentCents).toBe(1500);
    expect((e as BundledLlmBudgetExhaustedError).capCents).toBe(1000);
    expect(isRetryable(e)).toBe(false);
  });

  it('maps bundled-llm-consent-required → BundledLlmConsentRequiredError (kind payment_required, status 402)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.BundledLlmConsentRequired,
        title: 'Bundled-LLM consent required',
        status: 402,
      },
      null,
    );
    expect(e).toBeInstanceOf(BundledLlmConsentRequiredError);
    expect(e.kind).toBe('payment_required');
    expect(e.status).toBe(402);
    expect(isRetryable(e)).toBe(false);
  });

  it('maps pair-mode-conflict → PairModeConflictError (kind conflict, status 409)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.PairModeConflict,
        title: 'Pair-mode takeover conflict',
        status: 409,
        winner_client_id: 'client-abc',
      },
      null,
    );
    expect(e).toBeInstanceOf(PairModeConflictError);
    expect(e.kind).toBe('conflict');
    expect(e.status).toBe(409);
    expect((e as PairModeConflictError).winnerClientId).toBe('client-abc');
    expect(isRetryable(e)).toBe(false);
  });

  it('maps pair-mode-invalid-transition → PairModeStateInvalidTransitionError (kind conflict, status 409)', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.PairModeStateInvalidTransition,
        title: 'Invalid pair-mode transition',
        status: 409,
        from: 'ai-driving',
        transition: 'handback',
      },
      null,
    );
    expect(e).toBeInstanceOf(PairModeStateInvalidTransitionError);
    expect(e.kind).toBe('conflict');
    expect(e.status).toBe(409);
    expect((e as PairModeStateInvalidTransitionError).from).toBe('ai-driving');
    expect((e as PairModeStateInvalidTransitionError).transition).toBe('handback');
    expect(isRetryable(e)).toBe(false);
  });

  it('maps profile-in-use → ProfileInUseError (kind conflict, status 409, active_session_id surfaced)', () => {
    // A3 finding #7 — single-active-session-per-profile guard 409.
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.ProfileInUse,
        title: 'Profile already in use',
        status: 409,
        active_session_id: 'ses_abc123',
      },
      null,
    );
    expect(e).toBeInstanceOf(ProfileInUseError);
    expect(e.kind).toBe('conflict');
    expect(e.status).toBe(409);
    expect((e as ProfileInUseError).activeSessionId).toBe('ses_abc123');
    expect(isRetryable(e)).toBe(false);
  });
});

describe('V-492 — PROBLEM_TYPES coverage parity', () => {
  // Every PROBLEM_TYPES URI exposed by api-types must dispatch to a
  // typed DriftstackError subclass (not the bare DriftstackError
  // fallback). Catches: "we added a new problem-type to the server
  // but forgot to wire it into the SDK." The test loops the
  // PROBLEM_TYPES enum and asserts errorFromProblem returns a
  // SUBCLASS of DriftstackError for each.
  it('every PROBLEM_TYPES URI is mapped to a typed subclass', () => {
    const uris = Object.values(PROBLEM_TYPES);
    expect(uris.length).toBeGreaterThan(0);

    for (const uri of uris) {
      const e = errorFromProblem({ type: uri, title: 'test', status: 400 }, null);
      // The bare DriftstackError fallback is what unknown URIs
      // produce. Every known URI should produce a strict subclass.
      // `e.constructor === DriftstackError` would be true only
      // for the fallback path.
      expect(e.constructor.name).not.toBe('DriftstackError');
      expect(e).toBeInstanceOf(DriftstackError);
    }
  });
});

describe('V-489 — isRetryable predicate', () => {
  it('returns true for transport errors', () => {
    const e = new TransportError('network down');
    expect(isRetryable(e)).toBe(true);
  });

  it('returns true for internal errors (5xx)', () => {
    const e = new InternalError({
      type: PROBLEM_TYPES.Internal,
      title: 'Internal',
      status: 500,
    });
    expect(isRetryable(e)).toBe(true);
  });

  it('returns true for rate-limited errors', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.RateLimited, title: 'Rate limited', status: 429 },
      '5',
    );
    expect(isRetryable(e)).toBe(true);
  });

  it('returns false for validation errors', () => {
    const e = new ValidationError({
      type: PROBLEM_TYPES.ValidationFailed,
      title: 'Validation',
      status: 400,
    });
    expect(isRetryable(e)).toBe(false);
  });

  it('returns false for auth errors', () => {
    const e = new AuthError({
      type: PROBLEM_TYPES.Unauthorized,
      title: 'Unauthorized',
      status: 401,
    });
    expect(isRetryable(e)).toBe(false);
  });

  it('returns false for not-found errors', () => {
    const e = new NotFoundError({
      type: PROBLEM_TYPES.NotFound,
      title: 'Not found',
      status: 404,
    });
    expect(isRetryable(e)).toBe(false);
  });

  it('returns false for non-DriftstackError thrown values', () => {
    expect(isRetryable(new Error('regular'))).toBe(false);
    expect(isRetryable('string')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable({ status: 500 })).toBe(false);
  });
});
