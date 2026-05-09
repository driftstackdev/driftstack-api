// @driftstack/sdk public surface. Add new exports here as the package grows.

export { Driftstack, type DriftstackOptions } from './client.js';
export type { RetryConfig } from './retry.js';
export type { HttpClientConfig, RequestOptions } from './http.js';
export { iteratePaginated, type CursorPage } from './pagination.js';
export type { SessionsListPage } from './resources/sessions.js';
export type { ApiKeyList } from './resources/api-keys.js';
export type { WebhookEndpointList, WebhookDeliveryListPage } from './resources/webhooks.js';
export type { ProfilesListPage } from './resources/profiles.js';
export type { ProfileSnapshotsListPage } from './resources/profile-snapshots.js';
export type {
  AccountSelfProfile,
  WebSessionEntry,
  ListWebSessionsResponse,
  UploadAvatarResponse,
  RateLimitBucket,
  GetAccountRateLimitsResponse,
} from './resources/account.js';
export type {
  MfaStatusResponse,
  MfaEnrollResponse,
  MfaVerifyRequest,
  MfaVerifyResponse,
  MfaDisableRequest,
} from './resources/mfa.js';
export type { AuditLogEntry, AuditLogListPage, AuditLogQuery } from './resources/audit-log.js';
export type {
  LegalDocumentEntry,
  LegalRequiredEntry,
  AcceptLegalDocumentRequest,
  AcceptLegalDocumentResponse,
} from './resources/legal.js';

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
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  ExpiredKeyError,
  FeatureUnavailableError,
  ForbiddenError,
  InternalError,
  InvalidAuthTokenError,
  InvalidCredentialsError,
  InvalidKeyError,
  MfaStepUpRequiredError,
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
  CaptureRequestInput,
  CaptureResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWebhookRequest,
  CreateWebhookResponse,
  InteractAction,
  InteractRequest,
  InteractResponse,
  ListDeliveriesQuery,
  ListDeliveriesQueryInput,
  NavigateRequest,
  NavigateRequestInput,
  NavigateResponse,
  PaginationQuery,
  PaginationQueryInput,
  Problem,
  ProblemType,
  Session,
  SessionEvent,
  SessionId,
  SessionState,
  SessionStatus,
  UsagePeriodSummary,
  UsageDailyBucket,
  UsageSeriesResponse,
  WaitCondition,
  WaitRequest,
  WaitResponse,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointId,
  WebhookEventType,
  RotateWebhookSecretResponse,
  // V-079 auth flow
  LoginRequest,
  LoginResponse,
  // V-353d login MFA challenge — discriminated-union response shape
  LoginMfaRequiredResponse,
  LoginResponseUnion,
  LogoutRequest,
  LogoutResponse,
  // V-353d/e MFA challenge + step-up
  MfaChallengeRequest,
  MfaChallengeResponse,
  MfaStepUpRequest,
  MfaStepUpResponse,
  MagicLinkRequest,
  MagicLinkRequestResponse,
  MagicLinkConsumeRequest,
  MagicLinkConsumeResponse,
  PasswordResetRequest,
  PasswordResetRequestResponse,
  PasswordResetConfirmRequest,
  PasswordResetConfirmResponse,
  RefreshSessionRequest,
  RefreshSessionResponse,
  SignupRequest,
  SignupResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  WebSession,
  // V-081 profiles
  Profile,
  ProfileId,
  CreateProfileRequest,
  UpdateProfileRequest,
  // V-313 profile clone
  CloneProfileRequest,
  // V-312 profile snapshots
  ProfileSnapshot,
  CaptureSnapshotRequest,
  RestoreSnapshotRequest,
  // V-204 email preferences
  EmailPreference,
  ListEmailPreferencesResponse,
  OptOutableEmailEvent,
  SetEmailPreferenceRequest,
  // V-352 / V-352b account self-edit + avatar upload
  UpdateAccountMeRequest,
  UploadAvatarRequest,
  // V-082 billing
  BillingPeriod,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CreatePortalSessionResponse,
  GetBillingStateResponse,
  StartTrialPackRequest,
  StartTrialPackResponse,
  Subscription,
  SubscriptionStatus,
  TrialPackState,
} from '@driftstack/api-types';
