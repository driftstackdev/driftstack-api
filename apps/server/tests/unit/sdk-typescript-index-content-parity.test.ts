// W424.A — drift guard for packages/sdk-typescript/src/index.ts.
// The public barrel — every SDK export consumers depend on flows
// through this file. Drift here either drops an export (consumer
// `import { X } from '@driftstack/sdk'` breaks at build time) or
// silently widens the public surface (adds something to the API
// contract no one intended to ship).
//
//   • Framing pinned: public surface; add-here-as-package-grows.
//   • Driftstack + DriftstackOptions exported from ./client.js.
//   • RetryConfig, HttpClientConfig, RequestOptions type exports.
//   • iteratePaginated runtime + CursorPage type export.
//   • Per-resource list-page type re-exports (sessions / apiKeys /
//     webhooks / profiles / profile-snapshots / account / mfa /
//     audit-log / legal).
//   • Errors: DriftstackError + DriftstackErrorKind type + every
//     typed-error class + isRetryable.
//   • Webhook helper: verifyWebhookSignature + VerifySignatureInput.
//   • Re-exports of @driftstack/api-types so SDK consumers don't
//     need a second dependency.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W424.A packages/sdk-typescript/src/index.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: public surface; add new exports here as the package grows', () => {
    expect(body).toMatch(
      /\/\/ @driftstack\/sdk public surface\. Add new exports here as the package grows\./,
    );
  });

  it('Driftstack runtime + DriftstackOptions type re-export from ./client.js', () => {
    expect(body).toMatch(/export \{ Driftstack, type DriftstackOptions \} from '\.\/client\.js';/);
  });

  it('Type-only re-exports: RetryConfig / HttpClientConfig + RequestOptions', () => {
    expect(body).toMatch(/export type \{ RetryConfig \} from '\.\/retry\.js';/);
    expect(body).toMatch(/export type \{ HttpClientConfig, RequestOptions \} from '\.\/http\.js';/);
  });

  it('Pagination: iteratePaginated runtime + CursorPage type', () => {
    expect(body).toMatch(
      /export \{ iteratePaginated, type CursorPage \} from '\.\/pagination\.js';/,
    );
  });

  it('Per-resource list-page type re-exports (sessions / api-keys / webhooks / profiles / profile-snapshots)', () => {
    expect(body).toMatch(/export type \{ SessionsListPage \} from '\.\/resources\/sessions\.js';/);
    expect(body).toMatch(
      /export type \{\s*\n?\s*ApiKeyList,\s*\n?\s*RotateApiKeyOptions,\s*\n?\s*RotateApiKeyResponse,\s*\n?\s*\} from '\.\/resources\/api-keys\.js';/,
    );
    expect(body).toMatch(
      /export type \{ WebhookEndpointList, WebhookDeliveryListPage \} from '\.\/resources\/webhooks\.js';/,
    );
    expect(body).toMatch(
      /export type \{ ProfilesListPage, TrimProfileResponse \} from '\.\/resources\/profiles\.js';/,
    );
    expect(body).toMatch(
      /export type \{ ProfileSnapshotsListPage \} from '\.\/resources\/profile-snapshots\.js';/,
    );
  });

  it('Account types re-export (AccountSelfProfile / WebSessionEntry / ListWebSessionsResponse / UploadAvatarResponse / RateLimitBucket / GetAccountRateLimitsResponse / BundledLlmSettings / BundledLlmStatus / UpdateBundledLlmSettingsRequest / ByokAnthropicKeyMetadata / SetByokAnthropicKeyResponse / TestByokAnthropicKeyResult)', () => {
    expect(body).toMatch(
      /export type \{\s*\n?\s*AccountSelfProfile,\s*\n?\s*WebSessionEntry,\s*\n?\s*ListWebSessionsResponse,\s*\n?\s*UploadAvatarResponse,\s*\n?\s*RateLimitBucket,\s*\n?\s*GetAccountRateLimitsResponse,\s*\n?\s*BundledLlmSettings,\s*\n?\s*BundledLlmStatus,\s*\n?\s*UpdateBundledLlmSettingsRequest,\s*\n?\s*ByokAnthropicKeyMetadata,\s*\n?\s*SetByokAnthropicKeyResponse,\s*\n?\s*TestByokAnthropicKeyResult,\s*\n?\s*\} from '\.\/resources\/account\.js';/,
    );
  });

  it('MFA + audit-log + legal type re-exports', () => {
    expect(body).toMatch(
      /export type \{\s*\n?\s*MfaStatusResponse,\s*\n?\s*MfaEnrollResponse,\s*\n?\s*MfaVerifyRequest,\s*\n?\s*MfaVerifyResponse,\s*\n?\s*MfaDisableRequest,\s*\n?\s*\} from '\.\/resources\/mfa\.js';/,
    );
    expect(body).toMatch(
      /export type \{\s*\n?\s*AuditLogEntry,\s*\n?\s*AuditLogListPage,\s*\n?\s*AuditLogQuery,\s*\n?\s*AuditLogExportResponse,\s*\n?\s*\} from '\.\/resources\/audit-log\.js';/,
    );
    expect(body).toMatch(
      /export type \{\s*\n?\s*LegalDocumentEntry,\s*\n?\s*LegalRequiredEntry,\s*\n?\s*AcceptLegalDocumentRequest,\s*\n?\s*AcceptLegalDocumentResponse,\s*\n?\s*\} from '\.\/resources\/legal\.js';/,
    );
    // Team types re-export (added in the slice that closed the
    // TS SDK type-surface gap for client.team.* method params + return types).
    expect(body).toMatch(
      /export type \{\s*\n?\s*TeamRole,\s*\n?\s*TeamMember,\s*\n?\s*TeamInvite,\s*\n?\s*TeamOwner,\s*\n?\s*TeamMembersList,\s*\n?\s*TeamInvitesList,\s*\n?\s*TeamOwnersList,\s*\n?\s*AcceptInviteResponse,\s*\n?\s*InviteOptions,\s*\n?\s*\} from '\.\/resources\/team\.js';/,
    );
    // Crypto-orders parameter-type re-exports.
    expect(body).toMatch(
      /export type \{\s*\n?\s*CreateCryptoCheckoutOptions,\s*\n?\s*ListCryptoOrdersOptions,\s*\n?\s*\} from '\.\/resources\/crypto-orders\.js';/,
    );
  });

  it("Errors block: DriftstackError + DriftstackErrorKind type + isRetryable + every typed-error class from './errors.js'", () => {
    expect(body).toMatch(/\/\/ Errors/);
    for (const sym of [
      'DriftstackError',
      'AuthError',
      'BadRequestError',
      'ConcurrencyLimitError',
      'ConflictError',
      'DriverError',
      'DriverNotIntegratedError',
      'EmailAlreadyRegisteredError',
      'EmailNotVerifiedError',
      'ExpiredKeyError',
      'FeatureUnavailableError',
      'ForbiddenError',
      'InternalError',
      'InvalidAuthTokenError',
      'InvalidCredentialsError',
      'InvalidKeyError',
      'MfaStepUpRequiredError',
      'NotFoundError',
      'RateLimitError',
      'RevokedKeyError',
      'SessionDestroyedError',
      'TierLimitError',
      'TransportError',
      'ValidationError',
    ] as const) {
      expect(body).toMatch(new RegExp(`\\b${sym}\\b,`));
    }
    expect(body).toMatch(/type DriftstackErrorKind,/);
    expect(body).toMatch(/isRetryable,/);
    expect(body).toMatch(/\} from '\.\/errors\.js';/);
  });

  it("Webhook helper: verifyWebhookSignature + VerifySignatureInput type from './webhook-signature.js' (with Priority-2 framing)", () => {
    expect(body).toMatch(/\/\/ Webhook helper \(full webhook system in Priority 2\)/);
    expect(body).toMatch(
      /export \{ verifyWebhookSignature, type VerifySignatureInput \} from '\.\/webhook-signature\.js';/,
    );
  });

  it('api-types re-export framing pinned (so consumers do not need a second @driftstack/api-types dependency)', () => {
    expect(body).toMatch(
      /\/\/ Re-export the public Zod schemas \+ types so SDK consumers don't need a\s*\n?\s*\/\/ second @driftstack\/api-types dependency\./,
    );
    expect(body).toMatch(/\} from '@driftstack\/api-types';/);
  });

  it('api-types re-export roster: V-460/V-266 CLI activation + V-079 auth + V-353d login MFA + V-353d/e MFA challenge/step-up + V-081 profiles + V-313 clone + V-312 snapshots + V-204 email preferences + V-352/V-352b account self-edit + V-082 billing', () => {
    expect(body).toMatch(/\/\/ V-460 \/ V-266 CLI\/GUI activation flow/);
    expect(body).toMatch(/\/\/ V-079 auth flow/);
    expect(body).toMatch(/\/\/ V-353d login MFA challenge — discriminated-union response shape/);
    expect(body).toMatch(/\/\/ V-353d\/e MFA challenge \+ step-up/);
    expect(body).toMatch(/\/\/ V-081 profiles/);
    expect(body).toMatch(/\/\/ V-313 profile clone/);
    expect(body).toMatch(/\/\/ V-312 profile snapshots/);
    expect(body).toMatch(/\/\/ V-204 email preferences/);
    expect(body).toMatch(/\/\/ V-352 \/ V-352b account self-edit \+ avatar upload/);
    expect(body).toMatch(/\/\/ V-082 billing/);
  });

  it('Core api-types re-exports present (Account/ApiKey/Session/Webhook/Profile/Billing trios)', () => {
    for (const t of [
      'Account',
      'AccountId',
      'AccountTier',
      'ApiKey',
      'ApiKeyId',
      'ApiKeyScope',
      'CaptureRequest',
      'CaptureResponse',
      'CreateApiKeyRequest',
      'CreateApiKeyResponse',
      'CreateSessionRequest',
      'CreateSessionResponse',
      'CreateWebhookRequest',
      'CreateWebhookResponse',
      'UpdateWebhookRequest',
      'RotateWebhookSecretResponse',
      'PaginationQuery',
      'Problem',
      'ProblemType',
      'Session',
      'SessionEvent',
      'SessionId',
      'SessionStatus',
      'WebhookEndpoint',
      'WebhookDelivery',
      'WebhookEventType',
      'LoginRequest',
      'LoginResponse',
      'LoginResponseUnion',
      'LogoutRequest',
      'LogoutResponse',
      'MfaChallengeRequest',
      'MfaChallengeResponse',
      'MfaStepUpRequest',
      'MfaStepUpResponse',
      'MagicLinkRequest',
      'MagicLinkConsumeRequest',
      'PasswordResetRequest',
      'PasswordResetConfirmRequest',
      'RefreshSessionRequest',
      'SignupRequest',
      'SignupResponse',
      'VerifyEmailRequest',
      'VerifyEmailResponse',
      'WebSession',
      'Profile',
      'ProfileId',
      'CreateProfileRequest',
      'UpdateProfileRequest',
      'CloneProfileRequest',
      'ProfileSnapshot',
      'CaptureSnapshotRequest',
      'RestoreSnapshotRequest',
      'EmailPreference',
      'ListEmailPreferencesResponse',
      'OptOutableEmailEvent',
      'SetEmailPreferenceRequest',
      'UpdateAccountMeRequest',
      'UploadAvatarRequest',
      'BillingPeriod',
      'CreateCheckoutSessionRequest',
      'CreateCheckoutSessionResponse',
      'CreatePortalSessionResponse',
      'GetBillingStateResponse',
      'Subscription',
      'SubscriptionStatus',
    ] as const) {
      expect(body).toMatch(new RegExp(`\\b${t}\\b,`));
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
