// @driftstack/sdk public surface. Add new exports here as the package grows.

export { Driftstack, type DriftstackOptions } from './client.js';
export type { RetryConfig } from './retry.js';
export type { HttpClientConfig, RequestOptions } from './http.js';
export { iteratePaginated, type CursorPage } from './pagination.js';
export type { SessionsListPage } from './resources/sessions.js';
export { ArchetypesResource } from './resources/archetypes.js';
export type {
  ApiKeyList,
  RotateApiKeyOptions,
  RotateApiKeyResponse,
} from './resources/api-keys.js';
export type { WebhookEndpointList, WebhookDeliveryListPage } from './resources/webhooks.js';
export type {
  ProfilesListPage,
  TrimProfileResponse,
  TrimProfileScope,
} from './resources/profiles.js';
export type { ProfileSnapshotsListPage } from './resources/profile-snapshots.js';
export type {
  AccountSelfProfile,
  WebSessionEntry,
  ListWebSessionsResponse,
  UploadAvatarResponse,
  RateLimitBucket,
  GetAccountRateLimitsResponse,
  BundledLlmSettings,
  BundledLlmStatus,
  UpdateBundledLlmSettingsRequest,
  ByokAnthropicKeyMetadata,
  SetByokAnthropicKeyResponse,
  TestByokAnthropicKeyResult,
} from './resources/account.js';
export type {
  MfaStatusResponse,
  MfaEnrollResponse,
  MfaVerifyRequest,
  MfaVerifyResponse,
  MfaDisableRequest,
} from './resources/mfa.js';
export type {
  AuditLogEntry,
  AuditLogListPage,
  AuditLogQuery,
  AuditLogExportResponse,
} from './resources/audit-log.js';
export type { SessionProxyAttachResponse } from './resources/egress.js';
export type {
  AgentSession,
  AgentSessionsListPage,
  CreateAgentSessionRequest,
  AgentIntent,
  AgentIntentResult,
  AgentFailureDiagnosis,
  ConsequentialActionCategory,
  AgentUsage,
  AgentMessageResponse,
  LiveKitInfo,
} from './resources/agent-sessions.js';
// Slice 6 cross-SDK lock 2026-05-20 — re-export the canonical
// LK.6 modifier vocabulary so TS customers can import it without
// reaching into @driftstack/api-types directly.
export { CANONICAL_MODIFIER_NAMES, type CanonicalModifier } from '@driftstack/api-types';
// W637 — re-export the archetype catalog so SDK + GUI consumers can render
// the selectable archetype list (filtered by `status`) without deep-importing
// @driftstack/api-types. ARCHETYPE_REGISTRY is the single source of truth; a
// new device lights up everywhere once its `status` flips to launch/available.
export {
  ARCHETYPE_REGISTRY,
  LOCKED_ARCHETYPE_ID,
  LOCKED_ARCHETYPE_DISPLAY_LABEL,
  archetypeDisplayLabel,
  type ArchetypeConfig,
  type ArchetypeStatus,
  type ArchetypeCanvasFamily,
} from '@driftstack/api-types';
// doc-150 items 5/6 — re-export the per-account storage quota constants so
// SDK + GUI consumers can render the per-profile size meter + account-wide
// quota bar against the SAME caps the server enforces, without deep-importing
// @driftstack/api-types. TIER_STORAGE_BYTES_CAP is keyed by AccountTier (bytes);
// STORAGE_SOFT_WARN_FRACTION is the soft (80%) warn threshold.
export { TIER_STORAGE_BYTES_CAP, STORAGE_SOFT_WARN_FRACTION } from '@driftstack/api-types';
export type { Recipe, CreateRecipeRequest, RecipeSuggestion } from './resources/recipes.js';
export type {
  TeamRole,
  TeamMember,
  TeamInvite,
  TeamOwner,
  TeamMembersList,
  TeamInvitesList,
  TeamOwnersList,
  AcceptInviteResponse,
  InviteOptions,
} from './resources/team.js';
export type {
  CreateCryptoCheckoutOptions,
  ListCryptoOrdersOptions,
} from './resources/crypto-orders.js';
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
  isRetryable,
  AuthError,
  BadRequestError,
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  ByokAnthropicRequiredError,
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
  LegalAcceptanceRequiredError,
  MfaStepUpRequiredError,
  NotFoundError,
  PairModeConflictError,
  PairModeStateInvalidTransitionError,
  ProfileInUseError,
  ProxyValidationFailedError,
  RateLimitError,
  RevokedKeyError,
  SessionDestroyedError,
  SessionTimeoutError,
  StorageQuotaExceededError,
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
  UpdateWebhookRequest,
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
  // V-460 / V-266 CLI/GUI activation flow
  CliAuthorizeBindRequest,
  CliAuthorizeBindResponse,
  CliAuthorizeExchangeRequest,
  CliAuthorizeExchangeResponse,
  CliAuthorizeExchangeStatus,
  CliAuthorizeInitiateRequest,
  CliAuthorizeInitiateResponse,
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
  Subscription,
  SubscriptionStatus,
  // EG-API-1.1 — customer-configurable egress (planning 133)
  EgressSafeguard,
  OpenVpnProxyConfig,
  ProxyConfig,
  ProxyType,
  SavedProxyConfig,
  SessionEgressConfig,
  SocksProxyConfig,
  WireGuardProxyConfig,
  // Live account-proxies API (the egress resource's saved-proxy surface)
  AccountProxyInput,
  AccountProxyCreate,
  AccountProxyUpdate,
  AccountProxyMetadata,
  AccountProxyList,
  AccountProxyTestResult,
  PublicArchetypeStatus,
  PublicArchetype,
  ListArchetypesResponse,
} from '@driftstack/api-types';
