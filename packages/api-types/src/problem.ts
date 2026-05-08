// RFC 7807 problem details. Every error response from the API is one of these.
// `type` is a stable URI; clients switch on it. `detail` is human-readable.

import { z } from 'zod';

export const ProblemSchema = z
  .object({
    type: z
      .string()
      .url()
      .describe('Stable URI identifying the problem class. Clients switch on this.'),
    title: z.string(),
    status: z.number().int().min(100).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
  })
  .catchall(z.unknown())
  .describe('RFC 7807 problem details');

export type Problem = z.infer<typeof ProblemSchema>;

// Stable problem types — keep these URIs forever. Adding new ones is fine;
// renaming or removing breaks consumers.
export const PROBLEM_TYPES = {
  BadRequest: 'https://errors.driftstack.dev/bad-request',
  Unauthorized: 'https://errors.driftstack.dev/unauthorized',
  Forbidden: 'https://errors.driftstack.dev/forbidden',
  NotFound: 'https://errors.driftstack.dev/not-found',
  Conflict: 'https://errors.driftstack.dev/conflict',
  RateLimited: 'https://errors.driftstack.dev/rate-limited',
  ConcurrencyLimit: 'https://errors.driftstack.dev/concurrency-limit',
  TierLimit: 'https://errors.driftstack.dev/tier-limit',
  RevokedKey: 'https://errors.driftstack.dev/revoked-key',
  ExpiredKey: 'https://errors.driftstack.dev/expired-key',
  InvalidKey: 'https://errors.driftstack.dev/invalid-key',
  SessionDestroyed: 'https://errors.driftstack.dev/session-destroyed',
  SessionTimeout: 'https://errors.driftstack.dev/session-timeout',
  LegalAcceptanceRequired: 'https://errors.driftstack.dev/legal-acceptance-required',
  DriverError: 'https://errors.driftstack.dev/driver-error',
  DriverNotIntegrated: 'https://errors.driftstack.dev/driver-not-integrated',
  ValidationFailed: 'https://errors.driftstack.dev/validation-failed',
  Internal: 'https://errors.driftstack.dev/internal',
  // Auth-flow problem types (V-079).
  EmailAlreadyRegistered: 'https://errors.driftstack.dev/email-already-registered',
  InvalidCredentials: 'https://errors.driftstack.dev/invalid-credentials',
  InvalidAuthToken: 'https://errors.driftstack.dev/invalid-auth-token',
  EmailNotVerified: 'https://errors.driftstack.dev/email-not-verified',
  // V-352b — feature explicitly disabled at deploy-time (e.g. avatar
  // upload requires the public R2 bucket; in environments where it
  // isn't configured the endpoint returns 503 instead of a misleading
  // 404 / 500).
  FeatureUnavailable: 'https://errors.driftstack.dev/feature-unavailable',
} as const;

export type ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];
