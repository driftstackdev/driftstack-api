// @driftstack/sdk public surface. Add new exports here as the package grows.

export { Driftstack, type DriftstackOptions } from './client.js';
export type { RetryConfig } from './retry.js';
export type { HttpClientConfig, RequestOptions } from './http.js';
export type { SessionsListPage } from './resources/sessions.js';
export type { ApiKeyList } from './resources/api-keys.js';

// Errors
export {
  DriftstackError,
  type DriftstackErrorKind,
  AuthError,
  BadRequestError,
  ConcurrencyLimitError,
  ConflictError,
  DriverError,
  DriverNotIntegratedError,
  ExpiredKeyError,
  ForbiddenError,
  InternalError,
  InvalidKeyError,
  NotFoundError,
  RateLimitError,
  RevokedKeyError,
  SessionDestroyedError,
  TierLimitError,
  TransportError,
  ValidationError,
} from './errors.js';

// Webhook helper (full webhook system in Priority 2)
export { verifyWebhookSignature, type VerifySignatureInput } from './webhook-signature.js';

// Re-export the public Zod schemas + types so SDK consumers don't need a
// second @driftstack/api-types dependency.
export type {
  Account,
  AccountId,
  AccountTier,
  ApiKey,
  ApiKeyId,
  ApiKeyScope,
  CaptureKind,
  CaptureRequest,
  CaptureResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  InteractAction,
  InteractRequest,
  InteractResponse,
  NavigateRequest,
  NavigateResponse,
  PaginationQuery,
  Problem,
  ProblemType,
  Session,
  SessionEvent,
  SessionId,
  SessionState,
  SessionStatus,
  UsagePeriodSummary,
  WaitCondition,
  WaitRequest,
  WaitResponse,
} from '@driftstack/api-types';
