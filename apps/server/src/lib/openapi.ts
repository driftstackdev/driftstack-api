// OpenAPI 3.1 spec generator.
//
// Builds the API document by registering Zod schemas with @asteasolutions/
// zod-to-openapi and pairing them with route metadata (path, method, auth,
// rate-limit bucket, status codes). The output is a static JSON document
// served at /openapi.json and rendered by Scalar UI at /docs.
//
// Adding a new endpoint requires:
//   1. Define request + response schemas in @driftstack/api-types
//   2. Add a `registerRoute(...)` call in this file
//   3. Add the route handler in apps/server/src/routes/
//
// The route handler still does its own Zod parse — this generator only
// publishes the contract.

import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from 'zod';

// Augment z with .openapi() — must run before any registry.register call.
extendZodWithOpenApi(z);
import {
  AccountRegionSchema,
  AccountSchema,
  AccountStatusSchema,
  AccountTierSchema,
  AdminAccountResponseSchema,
  CreateProfileRequestSchema,
  ListProfilesResponseSchema,
  ProfileSchema,
  UpdateProfileRequestSchema,
  AdminApplyIpnRequestSchema,
  AdminCryptoDailyBreakdownResponseSchema,
  AdminCryptoOrderEnvelopeSchema,
  AdminCryptoOrderEventsResponseSchema,
  AdminCryptoPendingAgeResponseSchema,
  AdminCryptoStatsResponseSchema,
  AdminIdempotencyMetricsResponseSchema,
  AdminListCryptoOrdersResponseSchema,
  AdminSweepExpiredRequestSchema,
  AdminSweepExpiredResponseSchema,
  AdminUpdateInternalNoteRequestSchema,
  CryptoQuoteRequestSchema,
  CryptoQuoteResponseSchema,
  CancelCryptoOrderResponseSchema,
  CryptoOrderReceiptSchema,
  CreateCheckoutSessionRequestSchema,
  CreateCheckoutSessionResponseSchema,
  CreateCryptoCheckoutRequestSchema,
  CreateCryptoCheckoutResponseSchema,
  CreatePortalSessionResponseSchema,
  CryptoOrderEnvelopeSchema,
  GetBillingStateResponseSchema,
  ListCryptoOrdersResponseSchema,
  UpdateCryptoOrderNoteRequestSchema,
  LoginRequestSchema,
  LoginResponseUnionSchema,
  LogoutRequestSchema,
  MagicLinkConsumeRequestSchema,
  MagicLinkConsumeResponseSchema,
  MagicLinkRequestSchema,
  MagicLinkRequestResponseSchema,
  PasswordResetConfirmRequestSchema,
  PasswordResetConfirmResponseSchema,
  PasswordResetRequestSchema,
  PasswordResetRequestResponseSchema,
  RefreshSessionRequestSchema,
  RefreshSessionResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  StartTrialPackRequestSchema,
  StartTrialPackResponseSchema,
  UpdateAccountMeRequestSchema,
  UploadAvatarRequestSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
  AdminAuditLogEntrySchema,
  ApiKeySchema,
  CaptureRequestSchema,
  CliAuthorizeBindRequestSchema,
  CliAuthorizeBindResponseSchema,
  CliAuthorizeExchangeRequestSchema,
  CliAuthorizeExchangeResponseSchema,
  CliAuthorizeInitiateRequestSchema,
  CliAuthorizeInitiateResponseSchema,
  CaptureResponseSchema,
  ChangeTierRequestSchema,
  CreateApiKeyRequestSchema,
  CreateApiKeyResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  InteractRequestSchema,
  InteractResponseSchema,
  ListAuditLogQuerySchema,
  ListDeliveriesQuerySchema,
  ListDlqQuerySchema,
  NavigateRequestSchema,
  NavigateResponseSchema,
  PaginationQuerySchema,
  ProblemSchema,
  QuotaOverrideResponseSchema,
  SessionSchema,
  SetQuotaOverrideRequestSchema,
  SuspendAccountRequestSchema,
  UnsuspendAccountRequestSchema,
  UsagePeriodSummarySchema,
  WaitRequestSchema,
  WaitResponseSchema,
  WebhookDeliverySchema,
  WebhookEndpointSchema,
  UpdateWebhookRequestSchema,
  SessionStateSchema,
  SessionEgressConfigSchema,
  SavedProxyConfigSchema,
} from '@driftstack/api-types';

const PaginatedSessionsSchema = z.object({
  data: z.array(SessionSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const PaginatedApiKeysSchema = z.object({
  data: z.array(ApiKeySchema),
});

// V-386 — full /v1/account/me response shape. Defined here rather than
// in api-types because the SDKs read AccountSchema (the lean shared
// type) and the rich /me response is only ever consumed by the
// dashboard via the route directly.
const AccountMeResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  tier: AccountTierSchema,
  status: AccountStatusSchema,
  timezone: z.string().nullable(),
  slug: z.string().nullable(),
  region: AccountRegionSchema.nullable(),
  avatar_url: z.string().nullable(),
  mfa_enrolled: z.boolean(),
  concurrent_session_cap: z.number().int().nonnegative(),
  concurrent_session_active: z.number().int().nonnegative(),
  profile_cap: z.number().int().nonnegative().nullable(),
  profile_count: z.number().int().nonnegative(),
  teams: z.array(
    z.object({
      owner_account_id: z.string(),
      role: z.enum(['admin', 'member']),
      membership_id: z.string(),
    }),
  ),
});

// ───────────────────────────────────────────────────────────────────────────
// Build the registry
// ───────────────────────────────────────────────────────────────────────────

function buildRegistry(): OpenAPIRegistry {
  const r = new OpenAPIRegistry();

  // Bearer auth scheme
  r.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key',
  });

  // Reusable schemas — promote to components.schemas so codegen
  // produces named types (Pydantic, Go structs, etc.) instead of
  // inline anonymous shapes. Anything referenced from a route's
  // request/response is registered here.
  r.register('Account', AccountSchema);
  r.register('AccountMeResponse', AccountMeResponseSchema);
  r.register('UpdateAccountMeRequest', UpdateAccountMeRequestSchema);
  r.register('ApiKey', ApiKeySchema);
  r.register('Session', SessionSchema);
  r.register('SessionState', SessionStateSchema);
  r.register('Problem', ProblemSchema);
  r.register('UsagePeriodSummary', UsagePeriodSummarySchema);
  r.register('PaginationQuery', PaginationQuerySchema);
  // Sessions resource
  r.register('CreateSessionRequest', CreateSessionRequestSchema);
  r.register('CreateSessionResponse', CreateSessionResponseSchema);
  r.register('NavigateRequest', NavigateRequestSchema);
  r.register('NavigateResponse', NavigateResponseSchema);
  r.register('InteractRequest', InteractRequestSchema);
  r.register('InteractResponse', InteractResponseSchema);
  r.register('WaitRequest', WaitRequestSchema);
  r.register('WaitResponse', WaitResponseSchema);
  r.register('CaptureRequest', CaptureRequestSchema);
  r.register('CaptureResponse', CaptureResponseSchema);
  // API keys resource
  r.register('CreateApiKeyRequest', CreateApiKeyRequestSchema);
  r.register('CreateApiKeyResponse', CreateApiKeyResponseSchema);
  // Webhooks resource
  r.register('WebhookEndpoint', WebhookEndpointSchema);
  r.register('CreateWebhookRequest', CreateWebhookRequestSchema);
  r.register('CreateWebhookResponse', CreateWebhookResponseSchema);
  r.register('WebhookDelivery', WebhookDeliverySchema);
  r.register('ListDeliveriesQuery', ListDeliveriesQuerySchema);
  // Admin (already registered below for the admin section, but having
  // them once at the top keeps the codegen output deterministic).
  r.register('AdminAccount', AdminAccountResponseSchema);
  r.register('AdminAuditLogEntry', AdminAuditLogEntrySchema);

  const auth = [{ BearerAuth: [] }];

  const problemContent = {
    'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
  };

  const errors4xx = {
    400: { description: 'Validation failed.', content: problemContent },
    401: { description: 'Authentication failed.', content: problemContent },
    403: { description: 'Caller not permitted.', content: problemContent },
    429: { description: 'Rate limit or concurrency limit hit.', content: problemContent },
  };

  // ── Sessions ───────────────────────────────────────────────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions',
    summary: 'Create a session',
    tags: ['Sessions'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': { schema: CreateSessionRequestSchema },
        },
      },
    },
    responses: {
      201: {
        description: 'Session created.',
        content: { 'application/json': { schema: CreateSessionResponseSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/sessions',
    summary: 'List sessions for the calling account',
    tags: ['Sessions'],
    security: auth,
    request: { query: PaginationQuerySchema },
    responses: {
      200: {
        description: 'Paginated list of sessions.',
        content: { 'application/json': { schema: PaginatedSessionsSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/navigate',
    summary: 'Navigate to a URL within a session',
    tags: ['Sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string().describe('Prefixed session id (ses_<uuid>)') }),
      body: { content: { 'application/json': { schema: NavigateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Navigation completed.',
        content: { 'application/json': { schema: NavigateResponseSchema } },
      },
      404: { description: 'Session not found.', content: problemContent },
      410: { description: 'Session destroyed.', content: problemContent },
      502: { description: 'Driver-level error during navigation.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/interact',
    summary: 'Send an interaction (tap / type / scroll / press) to the session',
    tags: ['Sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: InteractRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Interaction completed.',
        content: { 'application/json': { schema: InteractResponseSchema } },
      },
      404: { description: 'Session not found.', content: problemContent },
      410: { description: 'Session destroyed.', content: problemContent },
      502: { description: 'Driver-level error.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/wait',
    summary: 'Wait for a session-side condition (selector, url, time)',
    tags: ['Sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: WaitRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Wait resolved (satisfied or timed out).',
        content: { 'application/json': { schema: WaitResponseSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/sessions/{id}/state',
    summary: 'Snapshot current session state (URL, title, cookies, localStorage)',
    tags: ['Sessions'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Session state.',
        content: { 'application/json': { schema: SessionStateSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/capture',
    summary: 'Capture a screenshot, DOM snapshot, or PDF of the session',
    tags: ['Sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: CaptureRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Capture produced.',
        content: { 'application/json': { schema: CaptureResponseSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'delete',
    path: '/v1/sessions/{id}',
    summary: 'Destroy a session',
    tags: ['Sessions'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Session destroyed.' },
      ...errors4xx,
    },
  });

  // ── Admin / API keys ───────────────────────────────────────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/api-keys',
    summary: 'Create an API key (returns plaintext once, never retrievable later)',
    tags: ['API keys'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: CreateApiKeyRequestSchema } } },
    },
    responses: {
      201: {
        description: 'Key created. The plaintext is in the response — store it now.',
        content: { 'application/json': { schema: CreateApiKeyResponseSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/api-keys',
    summary: 'List API keys for the calling account',
    tags: ['API keys'],
    security: auth,
    responses: {
      200: {
        description: 'List of keys (plaintext never included).',
        content: { 'application/json': { schema: PaginatedApiKeysSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'delete',
    path: '/v1/api-keys/{id}',
    summary: 'Revoke an API key',
    tags: ['API keys'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Key revoked.' },
      404: { description: 'Key not found.', content: problemContent },
      ...errors4xx,
    },
  });

  // V-296 — API key rotation. Mints a fresh plaintext + sets the OLD
  // key's expires_at to now + 24h grace via the existing
  // expires_at-driven auth gate.
  registerRoute(r, {
    method: 'post',
    path: '/v1/api-keys/{id}/rotate',
    summary: 'Rotate an API key (V-296). 24h grace; new plaintext shown once',
    tags: ['API keys'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ name: z.string().optional() }).openapi('RotateApiKeyRequest'),
          },
        },
      },
    },
    responses: {
      201: {
        description:
          'New key created with the same scopes; old key auto-revokes at grace_period_ends_at.',
        content: {
          'application/json': {
            schema: CreateApiKeyResponseSchema.extend({
              rotated_from: z.string(),
              grace_period_ends_at: z.string(),
            }).openapi('RotateApiKeyResponse'),
          },
        },
      },
      404: { description: 'Key not found.', content: problemContent },
      ...errors4xx,
    },
  });

  // ── Usage ──────────────────────────────────────────────────────────────
  registerRoute(r, {
    method: 'get',
    path: '/v1/usage',
    summary: 'Current-period usage totals + tier quotas',
    tags: ['Usage'],
    security: auth,
    responses: {
      200: {
        description: 'Period summary.',
        content: { 'application/json': { schema: UsagePeriodSummarySchema } },
      },
      ...errors4xx,
    },
  });

  // V-452 — daily-bucketed time series. Honors X-Driftstack-Account
  // team-RBAC header.
  const UsageDailyBucketOpenApi = z.object({
    date: z.string(),
    totals: z.record(z.number().int().nonnegative()),
  });
  const UsageSeriesResponseOpenApi = z.object({
    from_date: z.string(),
    to_date: z.string(),
    buckets: z.array(UsageDailyBucketOpenApi),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/usage/series',
    summary: 'Daily-bucketed usage time series for the calling account',
    tags: ['Usage'],
    security: auth,
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day totals over the trailing window (default 30 days, max 90).',
        content: { 'application/json': { schema: UsageSeriesResponseOpenApi } },
      },
      ...errors4xx,
    },
  });

  // ── Team RBAC (V-298) ──────────────────────────────────────────────────
  // Auth path integration is V-298d — until then, accepted members can
  // sign in but the membership grants no implicit permissions on the
  // owner's resources. Routes work; permissions are next-slice.

  const TeamMemberSchema = z
    .object({
      id: z.string().describe('Prefixed membership id (mem_<uuid>)'),
      owner_account_id: z.string(),
      member_account_id: z.string(),
      member_email: z.string(),
      role: z.enum(['member', 'admin']),
      invited_at: z.string(),
      accepted_at: z.string(),
      invited_by_account_id: z.string().nullable(),
    })
    .openapi('TeamMember');

  const TeamInviteSchema = z
    .object({
      id: z.string().describe('Prefixed invite id (inv_<uuid>)'),
      owner_account_id: z.string(),
      invitee_email: z.string(),
      role: z.enum(['member', 'admin']),
      expires_at: z.string(),
      invited_by_account_id: z.string().nullable(),
      accepted_at: z.string().nullable(),
      created_at: z.string(),
    })
    .openapi('TeamInvite');

  // V-326c — minimal "owner" view of a membership for the
  // member-facing GET /v1/team/owners endpoint.
  const TeamOwnerSchema = z
    .object({
      owner_account_id: z.string(),
      role: z.enum(['member', 'admin']),
      membership_id: z.string(),
    })
    .openapi('TeamOwner');

  registerRoute(r, {
    method: 'post',
    path: '/v1/team/invites',
    summary: 'Invite an email to join the calling owner’s team',
    tags: ['Team'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                email: z.string().email(),
                role: z.enum(['member', 'admin']).optional(),
              })
              .openapi('TeamInviteRequest'),
          },
        },
      },
    },
    responses: {
      202: {
        description: 'Invite sent. The invitee can accept via the email link.',
        content: { 'application/json': { schema: z.object({ message: z.string() }) } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/team/invites',
    summary: 'List pending invites for the calling owner',
    tags: ['Team'],
    security: auth,
    responses: {
      200: {
        description: 'Pending invites.',
        content: { 'application/json': { schema: z.object({ data: z.array(TeamInviteSchema) }) } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/team/invites/accept',
    summary: 'Accept a pending team invite',
    tags: ['Team'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ token: z.string().min(20) }).openapi('TeamAcceptRequest'),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Membership recorded. (Auth-path integration is V-298d; member acts as owner only after that ships.)',
        content: {
          'application/json': { schema: z.object({ membership: TeamMemberSchema }) },
        },
      },
      404: { description: 'Invite not found or already used.', content: problemContent },
      409: {
        description: 'Accepting account email does not match invite.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/team/members',
    summary: 'List confirmed team members for the calling owner',
    tags: ['Team'],
    security: auth,
    responses: {
      200: {
        description: 'Team members.',
        content: { 'application/json': { schema: z.object({ data: z.array(TeamMemberSchema) }) } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/team/owners',
    summary: 'List owner accounts the caller is a member of (V-326c)',
    tags: ['Team'],
    security: auth,
    responses: {
      200: {
        description: 'Owner accounts the caller is a team member of.',
        content: { 'application/json': { schema: z.object({ data: z.array(TeamOwnerSchema) }) } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'delete',
    path: '/v1/team/members/{id}',
    summary: 'Remove a team member',
    tags: ['Team'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Membership removed.' },
      404: {
        description: 'Membership not found or owned by a different account.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── Health ─────────────────────────────────────────────────────────────
  registerRoute(r, {
    method: 'get',
    path: '/health',
    summary: 'Liveness probe',
    tags: ['Meta'],
    responses: {
      200: {
        description: 'Server is up.',
        content: {
          'application/json': { schema: z.object({ ok: z.boolean() }) },
        },
      },
    },
  });

  // ── Admin (operational tooling) ────────────────────────────────────────
  // All routes under this section require the 'admin' scope (D-012, D-025).
  // Tagged 'admin' so customer-facing docs can filter them out at
  // generation time. See V-022.

  r.register('AdminAccount', AdminAccountResponseSchema);
  r.register('AdminAuditLogEntry', AdminAuditLogEntrySchema);
  r.register('WebhookDelivery', WebhookDeliverySchema);

  const PaginatedDlqSchema = z.object({
    data: z.array(WebhookDeliverySchema),
    next_cursor: z.string().nullable(),
  });

  const PaginatedAuditLogSchema = z.object({
    data: z.array(AdminAuditLogEntrySchema),
    next_cursor: z.string().nullable(),
  });

  // Account state
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/accounts/{id}/tier',
    summary: 'Change account tier (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      params: z.object({ id: z.string().describe('Prefixed account id (acc_<uuid>)') }),
      body: { content: { 'application/json': { schema: ChangeTierRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Updated account row.',
        content: { 'application/json': { schema: AdminAccountResponseSchema } },
      },
      404: { description: 'Account not found.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/accounts/{id}/suspend',
    summary: 'Suspend an account (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: SuspendAccountRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Account suspended.',
        content: { 'application/json': { schema: AdminAccountResponseSchema } },
      },
      404: { description: 'Account not found.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/accounts/{id}/unsuspend',
    summary: 'Restore a suspended account (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UnsuspendAccountRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Account active.',
        content: { 'application/json': { schema: AdminAccountResponseSchema } },
      },
      404: { description: 'Account not found.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/accounts/{id}/usage',
    summary: 'Usage period summary for any account (admin)',
    tags: ['admin'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Period summary for the target account.',
        content: { 'application/json': { schema: UsagePeriodSummarySchema } },
      },
      404: { description: 'Account not found.', content: problemContent },
      ...errors4xx,
    },
  });

  // Rate-limit override
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/accounts/{id}/quota-override',
    summary: 'Set a temporary rate-limit override on a bucket (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: SetQuotaOverrideRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Override stored. Effective on the next auth-cache miss for the target.',
        content: { 'application/json': { schema: QuotaOverrideResponseSchema } },
      },
      404: { description: 'Account not found.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'delete',
    path: '/v1/admin/accounts/{id}/quota-override',
    summary: 'Clear a rate-limit override (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        bucket_key: z.enum(['global', 'sessions:create']),
      }),
    },
    responses: {
      204: { description: 'Override cleared.' },
      404: {
        description: 'No active override for that bucket.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // Webhook ops
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/webhook-deliveries/{id}',
    summary: 'Fetch one webhook delivery (admin)',
    tags: ['admin'],
    security: auth,
    request: { params: z.object({ id: z.string().describe('Prefixed delivery id (wdl_<uuid>)') }) },
    responses: {
      200: {
        description: 'Delivery row.',
        content: { 'application/json': { schema: WebhookDeliverySchema } },
      },
      404: { description: 'Delivery not found.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/webhook-deliveries/{id}/replay',
    summary: 'Replay a webhook delivery (admin)',
    tags: ['admin'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Delivery reset to pending; worker will retry.',
        content: { 'application/json': { schema: WebhookDeliverySchema } },
      },
      404: { description: 'Delivery not found.', content: problemContent },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/webhook-dlq',
    summary: 'List dead-lettered webhook deliveries across accounts (admin)',
    tags: ['admin'],
    security: auth,
    request: { query: ListDlqQuerySchema },
    responses: {
      200: {
        description: 'Paginated DLQ list.',
        content: { 'application/json': { schema: PaginatedDlqSchema } },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/webhook-dlq/{id}/requeue',
    summary: 'Requeue a DLQ webhook delivery (admin)',
    tags: ['admin'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'DLQ entry reset to pending.',
        content: { 'application/json': { schema: WebhookDeliverySchema } },
      },
      404: { description: 'Delivery not found.', content: problemContent },
      409: {
        description: 'Delivery is not in DLQ — use /webhook-deliveries/:id/replay instead.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // V-307 — customer self-service replay. Account-scoped: 404 (not 403)
  // for non-owned deliveries to avoid leaking the existence of other
  // accounts' deliveries.
  registerRoute(r, {
    method: 'post',
    path: '/v1/webhook-deliveries/{deliveryId}/replay',
    summary: 'Replay a webhook delivery (V-307; customer self-service)',
    tags: ['Webhooks'],
    security: auth,
    request: {
      params: z.object({ deliveryId: z.string().describe('Prefixed delivery id (wdl_<uuid>)') }),
    },
    responses: {
      200: {
        description: 'Delivery reset to pending; the worker re-fires within ~30s.',
        content: { 'application/json': { schema: WebhookDeliverySchema } },
      },
      404: {
        description: 'Delivery not found or not owned by the calling account.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // Audit log
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/audit-log',
    summary: 'Query the admin audit log (admin)',
    tags: ['admin'],
    security: auth,
    request: { query: ListAuditLogQuerySchema },
    responses: {
      200: {
        description: 'Paginated audit log entries.',
        content: { 'application/json': { schema: PaginatedAuditLogSchema } },
      },
      ...errors4xx,
    },
  });

  // V-195 — public version endpoint. No auth.
  const VersionResponseSchema = z.object({
    version: z.string(),
    git_sha: z.string(),
    started_at: z.string(),
    node_version: z.string(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/version',
    summary: 'Build + runtime metadata (public)',
    tags: ['public'],
    responses: {
      200: {
        description: 'Server version, git sha, start time, node version.',
        content: { 'application/json': { schema: VersionResponseSchema } },
      },
    },
  });

  // V-218 — continuous validation harness (admin-only).
  const ValidationScheduleOpenApi = z.object({
    id: z.string().uuid(),
    archetype_id: z.string(),
    cadence_seconds: z.number().int().positive(),
    enabled: z.boolean(),
    last_run_at: z.string().nullable(),
    next_run_at: z.string(),
    last_run_id: z.string().nullable(),
    reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  const ListValidationSchedulesResponseOpenApi = z.object({
    data: z.array(ValidationScheduleOpenApi),
  });
  const UpsertValidationScheduleRequestOpenApi = z.object({
    archetype_id: z.string(),
    cadence_seconds: z.number().int().min(60),
    enabled: z.boolean().optional(),
    reason: z.string().optional(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/validation-schedules',
    summary: 'List continuous-validation schedules (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'All registered validation schedules.',
        content: {
          'application/json': { schema: ListValidationSchedulesResponseOpenApi },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'put',
    path: '/v1/admin/validation-schedules',
    summary: 'Upsert a validation schedule (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': { schema: UpsertValidationScheduleRequestOpenApi },
        },
      },
    },
    responses: {
      200: {
        description: 'The upserted schedule.',
        content: { 'application/json': { schema: ValidationScheduleOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/admin/validation-schedules/{archetype}',
    summary: 'Remove a validation schedule (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      204: { description: 'Schedule removed.' },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/validation-schedules/{archetype}/trigger',
    summary: 'Trigger an immediate validation run (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Run id of the dispatched recapture.',
        content: {
          'application/json': {
            schema: z.object({ run_id: z.string() }),
          },
        },
      },
      ...errors4xx,
    },
  });

  // V-219 — customer-facing rate-limit view.
  // ── V-386 — /v1/account/me ────────────────────────────────────────────
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me',
    summary: 'Read the calling account (full self-visible state)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: "Calling account's full state including tier caps + team memberships.",
        content: { 'application/json': { schema: AccountMeResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/account/me',
    summary: 'Partial update of name / timezone / slug / region',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: UpdateAccountMeRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Updated account state.',
        content: { 'application/json': { schema: AccountMeResponseSchema } },
      },
      ...errors4xx,
      409: {
        description: 'Slug already in use by another account.',
        content: problemContent,
      },
    },
  });

  // V-387 — avatar upload + clear.
  const UploadAvatarResponseOpenApi = z.object({
    avatar_url: z.string().nullable(),
    content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    bytes: z.number().int().nonnegative(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/me/avatar',
    summary: 'Upload (or replace) the calling account avatar (V-352b)',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: UploadAvatarRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Avatar stored; presigned read URL returned.',
        content: { 'application/json': { schema: UploadAvatarResponseOpenApi } },
      },
      ...errors4xx,
      413: {
        description: 'Avatar payload exceeds the per-route body limit.',
        content: problemContent,
      },
      503: {
        description: 'Avatar storage unavailable in this deploy.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/account/me/avatar',
    summary: 'Clear the calling account avatar pointer (V-352b)',
    tags: ['account'],
    security: auth,
    responses: {
      204: { description: 'Avatar cleared.' },
      ...errors4xx,
    },
  });

  // V-667.C-followup — customer-facing list of OAuth identities linked
  // to the calling account. Internal fields (provider_sub,
  // provider_avatar_url, provider_name) are intentionally omitted.
  const AccountOauthLinkOpenApi = z.object({
    id: z.string(),
    provider: z.string(),
    provider_email: z.string().nullable(),
    linked_at: z.string(),
    last_login_at: z.string().nullable(),
    last_revoked_at: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/oauth-links',
    summary: 'List OAuth-client identity links for the calling account (V-667.C)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Links for the calling account (empty when none linked).',
        content: {
          'application/json': {
            schema: z.object({ data: z.array(AccountOauthLinkOpenApi) }),
          },
        },
      },
      ...errors4xx,
    },
  });

  const RateLimitBucketOpenApi = z.object({
    bucket_key: z.enum(['global', 'sessions:create']),
    capacity: z.number().int().positive(),
    refill_per_second: z.number().positive(),
    source: z.enum(['tier_default', 'override']),
    override_expires_at: z.string().nullable(),
  });
  const GetAccountRateLimitsResponseOpenApi = z.object({
    tier: z.string(),
    buckets: z.array(RateLimitBucketOpenApi),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/rate-limits',
    summary: 'Effective rate-limit config for the calling account',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Per-bucket capacity + refill, with override-vs-default source.',
        content: {
          'application/json': { schema: GetAccountRateLimitsResponseOpenApi },
        },
      },
      ...errors4xx,
    },
  });

  // V-216 — customer-facing audit log.
  const ListAccountAuditQueryOpenApi = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    action: z.string().optional(),
  });
  const AccountAuditEntryOpenApi = z.object({
    id: z.string().uuid(),
    account_id: z.string(),
    actor_type: z.enum(['customer', 'system', 'staff']),
    actor_account_id: z.string().nullable(),
    actor_key_id: z.string().nullable(),
    action: z.string(),
    target_resource_id: z.string().nullable(),
    payload: z.record(z.unknown()).nullable(),
    ip_address: z.string().nullable(),
    user_agent: z.string().nullable(),
    timestamp: z.string(),
  });
  const ListAccountAuditResponseOpenApi = z.object({
    data: z.array(AccountAuditEntryOpenApi),
    next_cursor: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/audit-log',
    summary: "List the calling account's own audit-log entries",
    tags: ['account'],
    security: auth,
    request: { query: ListAccountAuditQueryOpenApi },
    responses: {
      200: {
        description: 'Paginated audit-log entries (newest first).',
        content: { 'application/json': { schema: ListAccountAuditResponseOpenApi } },
      },
      ...errors4xx,
    },
  });

  // V-462 — V-297 bulk export (GDPR Article 20 portability). The
  // `format=csv` branch returns text/csv with content-disposition;
  // the `format=json` branch (default) returns the JSON envelope
  // below. SDK methods cover the JSON branch only — CSV download is
  // browser-driven and not useful through a typed SDK call.
  const ExportAccountAuditQueryOpenApi = z.object({
    format: z.enum(['csv', 'json']).optional(),
  });
  const ExportAccountAuditResponseOpenApi = z.object({
    generated_at: z.string(),
    account_id: z.string(),
    row_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    data: z.array(AccountAuditEntryOpenApi),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/audit-log/export',
    summary: "Bulk-export the calling account's audit log (GDPR Article 20)",
    tags: ['account'],
    security: auth,
    request: { query: ExportAccountAuditQueryOpenApi },
    responses: {
      200: {
        description:
          'JSON envelope when format=json (or omitted); text/csv attachment when format=csv. The `x-driftstack-export-truncated` response header signals when the 10,000-row ceiling was hit.',
        content: {
          'application/json': { schema: ExportAccountAuditResponseOpenApi },
          'text/csv': { schema: { type: 'string' } },
        },
      },
      ...errors4xx,
    },
  });

  // V-204 — customer email notification preferences.
  const ListEmailPrefsResponseSchema = z.object({
    data: z.array(
      z.object({
        event_type: z.enum([
          'signup-welcome',
          'session-failed-first',
          'tier-changed',
          'trial-pack-purchased',
          'trial-pack-expired',
          'billing-receipt',
        ]),
        opted_in: z.boolean(),
      }),
    ),
  });
  const SetEmailPrefRequestOpenApi = z.object({
    event_type: z.enum([
      'signup-welcome',
      'session-failed-first',
      'tier-changed',
      'trial-pack-purchased',
      'trial-pack-expired',
      'billing-receipt',
    ]),
    opted_in: z.boolean(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/email-preferences',
    summary: 'List email notification preferences',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Per-event opt-in state. Defaults to opted-in.',
        content: { 'application/json': { schema: ListEmailPrefsResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'put',
    path: '/v1/account/email-preferences',
    summary: 'Set a single email notification preference',
    tags: ['account'],
    security: auth,
    request: {
      body: {
        content: { 'application/json': { schema: SetEmailPrefRequestOpenApi } },
      },
    },
    responses: {
      204: { description: 'Preference updated.' },
      ...errors4xx,
    },
  });

  // Cross-account rate-limit overrides list (admin)
  const ListAdminOverridesQueryOpenApi = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    account_id: z.string().optional(),
    include_expired: z.enum(['true', 'false']).optional(),
  });
  const PaginatedAdminOverridesSchema = z.object({
    data: z.array(QuotaOverrideResponseSchema),
    next_cursor: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/rate-limit-overrides',
    summary: 'Cross-account rate-limit override list (admin)',
    tags: ['admin'],
    security: auth,
    request: { query: ListAdminOverridesQueryOpenApi },
    responses: {
      200: {
        description: 'Paginated cross-account rate-limit overrides.',
        content: { 'application/json': { schema: PaginatedAdminOverridesSchema } },
      },
      ...errors4xx,
    },
  });

  // Cross-account API keys list (admin)
  const ListAdminApiKeysQueryOpenApi = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    account_id: z.string().optional(),
    revoked: z.enum(['true', 'false']).optional(),
  });
  const PaginatedAdminApiKeysSchema = z.object({
    data: z.array(ApiKeySchema),
    next_cursor: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/api-keys',
    summary: 'Cross-account API key list (admin)',
    tags: ['admin'],
    security: auth,
    request: { query: ListAdminApiKeysQueryOpenApi },
    responses: {
      200: {
        description: 'Paginated cross-account API keys.',
        content: { 'application/json': { schema: PaginatedAdminApiKeysSchema } },
      },
      ...errors4xx,
    },
  });

  // Cross-account sessions list (admin)
  const ListAdminSessionsQueryOpenApi = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.enum(['creating', 'ready', 'busy', 'destroyed', 'errored']).optional(),
    account_id: z.string().optional(),
  });
  const PaginatedAdminSessionsSchema = z.object({
    data: z.array(SessionSchema),
    next_cursor: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/sessions',
    summary: 'Cross-account session list (admin)',
    tags: ['admin'],
    security: auth,
    request: { query: ListAdminSessionsQueryOpenApi },
    responses: {
      200: {
        description: 'Paginated cross-account sessions.',
        content: { 'application/json': { schema: PaginatedAdminSessionsSchema } },
      },
      ...errors4xx,
    },
  });

  // Overview — aggregate counts the admin-panel index renders.
  const AdminOverviewResponseSchema = z.object({
    accounts: z.object({
      active: z.number().int().nonnegative(),
      suspended: z.number().int().nonnegative(),
    }),
    webhooks: z.object({
      dlq_depth: z.number().int().nonnegative(),
    }),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/overview',
    summary: 'Aggregate counts for the admin panel index page (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Aggregate active/suspended account counts and DLQ depth.',
        content: { 'application/json': { schema: AdminOverviewResponseSchema } },
      },
      ...errors4xx,
    },
  });

  // ── V-465 — admin OpenAPI gap closure ──────────────────────────────────
  // 12 admin routes that exist server-side but were never registered in
  // the OpenAPI spec. All require the `driftstack_internal_admin` scope
  // (gated by `app.requireScope` in the route handler). Schemas are
  // deliberately permissive (admin-internal; the staff panel binds to
  // them directly rather than against generated types).
  const AdminListAccountsResponseOpenApi = z.object({
    data: z.array(AdminAccountResponseSchema),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/accounts',
    summary: 'List accounts with optional filters (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      query: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
        status: z.enum(['active', 'suspended', 'deleted']).optional(),
        tier: z.string().optional(),
        email_contains: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Cursor-paginated account rows.',
        content: { 'application/json': { schema: AdminListAccountsResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/accounts/{id}',
    summary: 'Get a single account (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Account row.',
        content: { 'application/json': { schema: AdminAccountResponseSchema } },
      },
      ...errors4xx,
      404: { description: 'Account not found.', content: problemContent },
    },
  });
  const AdminAuditNoteRequestOpenApi = z.object({
    note: z.string().min(1).max(2000),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/accounts/{id}/audit-note',
    summary: 'Record a free-form support note on an account (admin; V-281)',
    tags: ['admin'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AdminAuditNoteRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Note recorded.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      ...errors4xx,
    },
  });
  const AdminRefundRecordRequestOpenApi = z.object({
    amount_cents: z.number().int().positive(),
    currency: z.string().length(3),
    reason: z.string().min(1).max(2000),
    stripe_refund_id: z.string().optional(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/accounts/{id}/refund-record',
    summary: 'Record a refund issued out-of-band against the account (admin; V-281)',
    tags: ['admin'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AdminRefundRecordRequestOpenApi } } },
    },
    responses: {
      200: {
        description:
          'Refund recorded for audit. Money movement happens via Stripe dashboard manually per V-280 launch-day runbook.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/api-keys/{id}/revoke',
    summary: 'Force-revoke an API key (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Key revoked. Idempotent.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      ...errors4xx,
      404: { description: 'API key not found.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/sessions/{id}/destroy',
    summary: 'Force-destroy an in-flight session (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Session destroyed. Idempotent against already-destroyed sessions.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      ...errors4xx,
      404: { description: 'Session not found.', content: problemContent },
    },
  });
  // ── Incidents (V-295) ───────────────────────────────────────────────────
  const AdminIncidentResponseOpenApi = z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    severity: z.enum(['minor', 'major', 'critical']),
    status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
    started_at: z.string(),
    resolved_at: z.string().nullable(),
    components_affected: z.array(z.string()),
    public: z.boolean(),
  });
  const AdminIncidentCreateRequestOpenApi = z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
    severity: z.enum(['minor', 'major', 'critical']),
    status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
    started_at: z.string().optional(),
    components_affected: z.array(z.string()).optional(),
    public: z.boolean().optional(),
  });
  const AdminIncidentUpdateRequestOpenApi = z.object({
    body: z.string().min(1).max(10_000),
    status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/incidents',
    summary: 'Create an incident (admin; V-295)',
    tags: ['admin'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AdminIncidentCreateRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Incident created.',
        content: { 'application/json': { schema: AdminIncidentResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/incidents/{id}',
    summary: 'Get a single incident with its update timeline (admin; V-295)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Incident detail (incl. updates timeline).',
        content: { 'application/json': { schema: AdminIncidentResponseOpenApi } },
      },
      ...errors4xx,
      404: { description: 'Incident not found.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/incidents/{id}/updates',
    summary: 'Append an update to an incident (admin; V-295)',
    tags: ['admin'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AdminIncidentUpdateRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Update appended; incident timeline reflects the new entry.',
        content: { 'application/json': { schema: AdminIncidentResponseOpenApi } },
      },
      ...errors4xx,
      404: { description: 'Incident not found.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/incidents/{id}/resolve',
    summary: 'Mark an incident resolved (admin; V-295)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Incident transitioned to status=resolved + resolved_at set.',
        content: { 'application/json': { schema: AdminIncidentResponseOpenApi } },
      },
      ...errors4xx,
      404: { description: 'Incident not found.', content: problemContent },
    },
  });
  // ── Status subscribers (V-176) ──────────────────────────────────────────
  const AdminStatusSubscriberOpenApi = z.object({
    id: z.string(),
    email: z.string(),
    confirmed: z.boolean(),
    created_at: z.string(),
    confirmed_at: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/status-subscribers',
    summary: 'List status-page subscribers (admin)',
    tags: ['admin'],
    security: auth,
    request: {
      query: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
        confirmed: z.boolean().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Paginated subscribers.',
        content: {
          'application/json': {
            schema: z.object({
              data: z.array(AdminStatusSubscriberOpenApi),
              has_more: z.boolean(),
              next_cursor: z.string().nullable(),
            }),
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/status-subscribers/{id}/force-unsubscribe',
    summary: 'Force-unsubscribe a status subscriber (admin; abuse / GDPR)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Subscriber removed. Idempotent against already-removed entries.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      ...errors4xx,
      404: { description: 'Subscriber not found.', content: problemContent },
    },
  });

  // ── V-353 MFA (TOTP) ───────────────────────────────────────────────────
  const MfaStatusResponseOpenApi = z.object({
    enrolled: z.boolean(),
    enrolled_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    unused_recovery_codes: z.number().int().nonnegative(),
  });
  const MfaEnrollResponseOpenApi = z.object({
    otpauth_uri: z.string(),
    secret_base32: z.string(),
    algorithm: z.literal('SHA1'),
    digits: z.literal(6),
    period_seconds: z.literal(30),
  });
  const MfaVerifyRequestOpenApi = z.object({
    code: z.string().regex(/^\d{6}$/),
  });
  const MfaVerifyResponseOpenApi = z.object({
    recovery_codes: z.array(z.string()).length(10),
  });
  const MfaDisableRequestOpenApi = z.object({
    confirm: z.literal('disable-mfa'),
  });
  const MfaChallengeRequestOpenApi = z.object({
    challenge_token: z.string(),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recovery_code: z.string().optional(),
  });
  const MfaChallengeResponseOpenApi = z.object({
    session: z.object({
      token: z.string(),
      expires_at: z.string(),
      account_id: z.string(),
    }),
    via: z.enum(['totp', 'recovery']),
  });
  const MfaStepUpRequestOpenApi = z.object({
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recovery_code: z.string().optional(),
  });
  const MfaStepUpResponseOpenApi = z.object({
    via: z.enum(['totp', 'recovery']),
    mfa_satisfied_at: z.string(),
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/account/mfa',
    summary: 'MFA enrollment status for the calling account',
    tags: ['account', 'mfa'],
    security: auth,
    responses: {
      200: {
        description: 'enrolled flag + timestamps + remaining recovery-code count.',
        content: { 'application/json': { schema: MfaStatusResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/mfa/enroll',
    summary: 'Start MFA TOTP enrollment (returns otpauth URI + base32 secret)',
    tags: ['account', 'mfa'],
    security: auth,
    responses: {
      200: {
        description: 'Pending enrollment row created; secret shown once for QR / manual entry.',
        content: { 'application/json': { schema: MfaEnrollResponseOpenApi } },
      },
      409: { description: 'Already enrolled — disable first.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/mfa/verify',
    summary: 'Confirm enrollment with first 6-digit code; returns 10 single-use recovery codes',
    tags: ['account', 'mfa'],
    security: auth,
    request: { body: { content: { 'application/json': { schema: MfaVerifyRequestOpenApi } } } },
    responses: {
      200: {
        description: 'Enrollment activated; recovery codes shown ONCE.',
        content: { 'application/json': { schema: MfaVerifyResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/account/mfa',
    summary: 'Disable MFA. Step-up gated (requires fresh MFA proof).',
    tags: ['account', 'mfa'],
    security: auth,
    request: { body: { content: { 'application/json': { schema: MfaDisableRequestOpenApi } } } },
    responses: {
      204: { description: 'MFA disabled; recovery codes invalidated.' },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/mfa/disable',
    summary: 'POST alias for DELETE /v1/account/mfa. Same step-up gate.',
    tags: ['account', 'mfa'],
    security: auth,
    request: { body: { content: { 'application/json': { schema: MfaDisableRequestOpenApi } } } },
    responses: {
      204: { description: 'MFA disabled.' },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/mfa/recovery-codes/regenerate',
    summary: 'Mint 10 fresh recovery codes; old codes invalidated',
    tags: ['account', 'mfa'],
    security: auth,
    responses: {
      200: {
        description: 'Fresh recovery codes shown ONCE.',
        content: { 'application/json': { schema: MfaVerifyResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/mfa/challenge',
    summary: 'Exchange a login challenge_token for a real session via TOTP / recovery code',
    tags: ['auth', 'mfa'],
    request: {
      body: { content: { 'application/json': { schema: MfaChallengeRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Session issued; via discriminator says totp or recovery.',
        content: { 'application/json': { schema: MfaChallengeResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/mfa/step-up',
    summary: 'Refresh mfa_satisfied_at on the calling web session (no new session issued)',
    tags: ['auth', 'mfa'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: MfaStepUpRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'mfa_satisfied_at advanced to now.',
        content: { 'application/json': { schema: MfaStepUpResponseOpenApi } },
      },
      ...errors4xx,
    },
  });

  // ── V-401 — core auth surface (signup / verify-email / login / refresh / logout) ──
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/signup',
    summary: 'Sign up a new account; emits a verification email',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: SignupRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Verification email sent; account is unverified until /v1/auth/verify-email.',
        content: { 'application/json': { schema: SignupResponseSchema } },
      },
      ...errors4xx,
      409: {
        description: 'Email is already registered.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/verify-email',
    summary: 'Consume the email-verification token; issues a web session',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: VerifyEmailRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Email verified; web session issued.',
        content: { 'application/json': { schema: VerifyEmailResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/login',
    summary:
      'Authenticate with email + password; issues a session OR returns an MFA challenge token',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: LoginRequestSchema } } },
    },
    responses: {
      200: {
        description:
          "Discriminated-union: session row when MFA isn't enrolled OR { mfa_required: true, challenge_token, challenge_expires_at } when MFA is. Clients branch on the `mfa_required` literal.",
        content: { 'application/json': { schema: LoginResponseUnionSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/refresh',
    summary: 'Exchange a refresh token for a fresh web-session token',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: RefreshSessionRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Fresh session issued.',
        content: { 'application/json': { schema: RefreshSessionResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/logout',
    summary: 'Revoke a web-session token',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: LogoutRequestSchema } } },
    },
    responses: {
      204: { description: 'Session revoked.' },
      ...errors4xx,
    },
  });

  // ── V-420 — billing surface ────────────────────────────────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/billing/checkout-session',
    summary: 'Start a Stripe Checkout session for a tier subscription',
    tags: ['billing'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: CreateCheckoutSessionRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Checkout URL + session id; redirect the customer to checkout_url.',
        content: { 'application/json': { schema: CreateCheckoutSessionResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/billing/trial-pack',
    summary: 'Start a Stripe Checkout session for the one-time $2.99 trial pack',
    tags: ['billing'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: StartTrialPackRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Checkout URL + session id.',
        content: { 'application/json': { schema: StartTrialPackResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/billing/portal-session',
    summary: 'Mint a Stripe Customer Portal one-time URL for subscription self-service',
    tags: ['billing'],
    security: auth,
    responses: {
      200: {
        description: 'Portal URL; short-lived; redirect immediately.',
        content: { 'application/json': { schema: CreatePortalSessionResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing',
    summary: 'Read the calling account billing state (subscription + trial pack)',
    tags: ['billing'],
    security: auth,
    responses: {
      200: {
        description: 'Subscription row + trial-pack credit/expiry/redemption state.',
        content: { 'application/json': { schema: GetBillingStateResponseSchema } },
      },
      ...errors4xx,
    },
  });

  // ── EG-API-1.2 + 1.3 — customer-configurable egress (planning 133) ──────
  // All four routes register as 503 FeatureUnavailable stubs until the
  // EG-API-1.6 propagation slice lands a concrete SOCKS5 backend; the
  // OpenAPI spec describes the wired-backend behavior so SDK consumers
  // can generate the right client surface ahead of time.
  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/proxy',
    summary: 'Set customer-configurable proxy for a session (planning 133 Phase 1+)',
    tags: ['egress'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: SessionEgressConfigSchema } } },
    },
    responses: {
      200: {
        description: 'Proxy configured; safeguards applied.',
        content: {
          'application/json': {
            schema: z.object({
              type: z.enum(['socks5', 'openvpn', 'wireguard']),
              safeguards: z.object({
                block_direct_internet: z.boolean(),
                block_unproxied_dns: z.boolean(),
                block_webrtc_stun_leakage: z.boolean(),
              }),
            }),
          },
        },
      },
      ...errors4xx,
      503: {
        description: 'Egress backend not yet wired on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/sessions/{id}/proxy',
    summary: "Read a session's current proxy config (type + safeguards only — no secret material)",
    tags: ['egress'],
    security: auth,
    responses: {
      200: {
        description: 'Proxy summary (NO raw secret material).',
        content: {
          'application/json': {
            schema: z.object({
              type: z.enum(['socks5', 'openvpn', 'wireguard']),
              safeguards: z.object({
                block_direct_internet: z.boolean(),
                block_unproxied_dns: z.boolean(),
                block_webrtc_stun_leakage: z.boolean(),
              }),
            }),
          },
        },
      },
      404: {
        description: 'No proxy attached to this session yet.',
        content: problemContent,
      },
      ...errors4xx,
      503: {
        description: 'Egress backend not yet wired on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/proxies',
    summary: 'Save a reusable customer proxy config (SOCKS5/OpenVPN/WireGuard)',
    tags: ['egress'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: SavedProxyConfigSchema } } },
    },
    responses: {
      201: {
        description: 'Proxy config saved; raw secrets are NEVER echoed back.',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string(),
              label: z.string(),
              type: z.enum(['socks5', 'openvpn', 'wireguard']),
            }),
          },
        },
      },
      ...errors4xx,
      503: {
        description: 'Egress backend not yet wired on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/proxies',
    summary: 'List the calling account saved proxy configs (no secret material)',
    tags: ['egress'],
    security: auth,
    responses: {
      200: {
        description: 'List of saved proxy summaries.',
        content: {
          'application/json': {
            schema: z.object({
              data: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  type: z.enum(['socks5', 'openvpn', 'wireguard']),
                }),
              ),
            }),
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/proxies/{id}',
    summary: 'Remove a saved proxy config',
    tags: ['egress'],
    security: auth,
    responses: {
      204: { description: 'Deleted.' },
      404: { description: 'Proxy not found.', content: problemContent },
      ...errors4xx,
      503: {
        description: 'Egress backend not yet wired on this deployment.',
        content: problemContent,
      },
    },
  });

  // ── AI-D — agent chat sessions ──────────────────────────────────
  // All four routes register as 503 FeatureUnavailable stubs until the
  // LLM key path is enabled on the deployment; the OpenAPI spec
  // describes the wired-runtime behavior so SDK consumers compile
  // ahead of time.
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions',
    summary: 'Create a new agent chat session',
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              driftstack_session_id: z.string().min(1).optional(),
              token_budget: z.number().int().positive().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Agent session created; transcript empty + full budget remaining.',
        content: { 'application/json': { schema: z.object({}) } },
      },
      ...errors4xx,
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/agent-sessions/{id}',
    summary: 'Read agent session state (transcript_length + budget + status)',
    tags: ['agent-chat'],
    security: auth,
    responses: {
      200: {
        description: 'Agent session envelope.',
        content: { 'application/json': { schema: z.object({}) } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      ...errors4xx,
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/message',
    summary: 'Run one decompose→execute turn against the agent session',
    tags: ['agent-chat'],
    security: auth,
    request: {
      headers: z.object({
        // BYOK Anthropic key (Tier-3 LOCKED 2026-05-16). Optional;
        // when set, forwards to the decomposer's Anthropic API call.
        // Customer-stored keys (per-account) override the deployment
        // fallback. NEVER logged server-side.
        'x-byok-anthropic-api-key': z.string().min(1).optional(),
      }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ user_message: z.string().min(1).max(8000) }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Turn result — discriminated by `kind`: plan-executed (intents + results + ok) / clarify (clarifying_question) / refuse (refuse_reason). The `session` envelope is always present and carries the updated transcript_length + token_budget_remaining counters.',
        content: {
          'application/json': {
            schema: z.union([
              z.object({
                kind: z.literal('plan-executed'),
                session: z.object({}),
                intents: z.array(z.object({})),
                results: z.array(z.object({})),
                ok: z.boolean(),
              }),
              z.object({
                kind: z.literal('clarify'),
                session: z.object({}),
                clarifying_question: z.string(),
              }),
              z.object({
                kind: z.literal('refuse'),
                session: z.object({}),
                refuse_reason: z.string(),
              }),
            ]),
          },
        },
      },
      ...errors4xx,
      409: {
        description: 'Agent session is closed or paused; start a new session.',
        content: problemContent,
      },
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/agent-sessions/{id}',
    summary: 'Close the agent session (idempotent)',
    tags: ['agent-chat'],
    security: auth,
    responses: {
      204: { description: 'Closed.' },
      404: { description: 'Agent session not found.', content: problemContent },
      ...errors4xx,
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });

  // ── V-820 — fleet events stream (operator-only; not customer-facing) ──
  // Currently registers as a 503 FeatureUnavailable stub regardless of
  // AppDeps wiring — the WebSocket handler + fastify-websocket plugin +
  // Cloudflare AOP layer are pending. SDK code generators reading this
  // surface should NOT generate a customer-facing fleet client; the
  // intended consumer is the Mac fleet itself (Agent 1 / harness).
  registerRoute(r, {
    method: 'get',
    path: '/v1/fleet/events',
    summary:
      'Fleet-node WebSocket event stream (operator-only; mTLS + signed JWT auth per docs/network-architecture.md)',
    tags: ['fleet'],
    // No `security: auth` — fleet auth runs via signed JWT in a custom
    // header at WebSocket handshake, gated by mTLS at the edge. The
    // customer-API Bearer token has no role here.
    responses: {
      101: {
        description:
          'WebSocket protocol upgrade — handshake authenticated via mTLS + signed Ed25519 JWT in the `x-fleet-jwt` header. Currently NOT IMPLEMENTED; see 503 below.',
      },
      503: {
        description:
          'Fleet events stream not yet implemented. Both the AppDeps-wired path and the activation-gate-off path return 503 in this slice — the WebSocket handler + Cloudflare AOP + fleet_nodes SQL migration are pending (see docs/internal/fleet-nodes-sql-migration-design.md + docs/internal/cross-agent-control-plane-contract.md).',
        content: problemContent,
      },
    },
  });

  // ── V-666 — crypto-orders surface. Crypto payments are non-refundable.
  registerRoute(r, {
    method: 'post',
    path: '/v1/billing/crypto-checkout/quote',
    summary: 'Preview a crypto-checkout price without minting an order',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: CryptoQuoteRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Fiat-cents price + crypto pay-range (stub until NowPayments lands).',
        content: { 'application/json': { schema: CryptoQuoteResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/billing/crypto-checkout',
    summary: 'Mint a new crypto-payment order',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      headers: z.object({
        'idempotency-key': z
          .string()
          .max(255)
          .optional()
          .describe(
            'Optional client-supplied idempotency key. Duplicate POSTs with the same key within 24h replay the original order. See /docs/idempotency-keys.',
          ),
      }),
      body: { content: { 'application/json': { schema: CreateCryptoCheckoutRequestSchema } } },
    },
    responses: {
      201: {
        description:
          'Order minted; response carries payment context for the customer. On a replayed key, the response also sets `Idempotent-Replayed: 1`.',
        content: { 'application/json': { schema: CreateCryptoCheckoutResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing/crypto-orders',
    summary: "List the caller account's crypto orders (newest first)",
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      query: z.object({
        limit: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe('Page size (1-100). Defaults to server-side 50.'),
        // V-666.BR — single-value status filter; mirrors admin list.
        status: z
          .enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'])
          .optional()
          .describe('If set, only orders matching this status are returned.'),
        // V-666.BU — forward cursor; opaque base64url token from a
        // prior page's next_cursor.
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe('Opaque cursor from a prior page. Iterate until null.'),
        // V-666.BX — half-open date-range filter on created_at.
        created_after: z
          .string()
          .datetime()
          .optional()
          .describe('Lower bound (inclusive). ISO 8601 timestamp.'),
        created_before: z
          .string()
          .datetime()
          .optional()
          .describe('Upper bound (exclusive). ISO 8601 timestamp.'),
      }),
    },
    responses: {
      200: {
        description: 'Order list scoped to the calling account.',
        content: { 'application/json': { schema: ListCryptoOrdersResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing/crypto-orders/{order_id}',
    summary: 'Read a single crypto order owned by the calling account',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string().describe('Order id (ord_<hex>).') }),
    },
    responses: {
      200: {
        description: 'Order envelope.',
        content: { 'application/json': { schema: CryptoOrderEnvelopeSchema } },
      },
      404: { description: 'No such order owned by this account.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/billing/crypto-orders/{order_id}',
    summary: 'Update the customer-facing free-text note on an order',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateCryptoOrderNoteRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Updated order envelope.',
        content: { 'application/json': { schema: CryptoOrderEnvelopeSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing/crypto-orders/{order_id}/receipt',
    summary: 'Read the JSON receipt for an order owned by the calling account',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
    },
    responses: {
      200: {
        description: 'Normalised receipt payload (status, paid_at, amounts).',
        content: { 'application/json': { schema: CryptoOrderReceiptSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing/crypto-orders/{order_id}/receipt.txt',
    summary: 'Same receipt rendered as text/plain for curl/wget pipelines',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
    },
    responses: {
      200: {
        description: 'Text receipt; same fields as the JSON variant.',
        content: {
          'text/plain': {
            schema: z.string().describe('Plain-text receipt, one field per line.'),
          },
        },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing/crypto-orders/{order_id}/receipt.pdf',
    summary: 'PDF rendering of the receipt with Content-Disposition: attachment',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
    },
    responses: {
      200: {
        description: 'PDF bytes; the route also sets a meaningful filename.',
        content: {
          'application/pdf': {
            schema: z.string().describe('Binary PDF body. base64 only on display.'),
          },
        },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/billing/crypto-orders/{order_id}/cancel',
    summary: 'Cancel a pending crypto order (self-service abandonment)',
    tags: ['billing', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
    },
    responses: {
      200: {
        description: 'Order cancelled; envelope returned with status: cancelled.',
        content: { 'application/json': { schema: CancelCryptoOrderResponseSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      409: {
        description: 'Order has moved past pending and cannot be cancelled self-service.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── V-666.AY — admin crypto-orders surface. Requires the
  // `driftstack_internal_admin` scope; otherwise the route returns 403.
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders',
    summary: 'List crypto orders across all accounts (admin)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      query: z.object({
        account_id: z.string().optional(),
        status: z
          .enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'])
          .optional(),
        search: z.string().optional(),
        payment_id: z.string().optional().describe('Exact-match reverse lookup.'),
        limit: z.string().optional(),
        cursor: z.string().optional().describe('Opaque cursor from a prior page.'),
        created_after: z
          .string()
          .datetime()
          .optional()
          .describe('Lower bound (inclusive). ISO 8601 timestamp.'),
        created_before: z
          .string()
          .datetime()
          .optional()
          .describe('Upper bound (exclusive). ISO 8601 timestamp.'),
      }),
    },
    responses: {
      200: {
        description: 'Paginated order list with next_cursor.',
        content: { 'application/json': { schema: AdminListCryptoOrdersResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders/{order_id}',
    summary: 'Read a single crypto order (admin envelope includes internal_note)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
    },
    responses: {
      200: {
        description: 'Admin order envelope.',
        content: { 'application/json': { schema: AdminCryptoOrderEnvelopeSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders/{order_id}/events',
    summary: "Read an order's append-only state-transition timeline",
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
    },
    responses: {
      200: {
        description: 'Order events oldest-first.',
        content: { 'application/json': { schema: AdminCryptoOrderEventsResponseSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/admin/crypto-orders/{order_id}/internal-note',
    summary: 'Set or clear the admin-only internal note on an order',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
      body: {
        content: { 'application/json': { schema: AdminUpdateInternalNoteRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'Order envelope with the updated internal_note.',
        content: { 'application/json': { schema: AdminCryptoOrderEnvelopeSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/crypto-orders/sweep-expired',
    summary: 'Sweep stale pending orders to failed (idempotent)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AdminSweepExpiredRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Count of orders swept this tick + a capped flag.',
        content: { 'application/json': { schema: AdminSweepExpiredResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders/stats',
    summary: 'At-a-glance KPI snapshot for the ops dashboard',
    tags: ['admin', 'crypto'],
    security: auth,
    responses: {
      200: {
        description: 'Counts per status + paid revenue + time-to-paid metrics.',
        content: { 'application/json': { schema: AdminCryptoStatsResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders/daily',
    summary: 'Per-(date, status) counts for the last N days (max 90)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      query: z.object({
        days: z.string().optional().describe('Defaults to 30; max 90.'),
      }),
    },
    responses: {
      200: {
        description: 'Sparse rows; zero-fill is the caller responsibility.',
        content: {
          'application/json': { schema: AdminCryptoDailyBreakdownResponseSchema },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders/pending-age',
    summary: 'Histogram of pending-order ages (1h / 1-6h / 6-24h / >24h)',
    tags: ['admin', 'crypto'],
    security: auth,
    responses: {
      200: {
        description: 'Bucketed counts + total currently pending.',
        content: {
          'application/json': { schema: AdminCryptoPendingAgeResponseSchema },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders/idempotency-metrics',
    summary: 'Idempotency-key counters (replays / first_writes / body mismatches)',
    tags: ['admin', 'crypto'],
    security: auth,
    responses: {
      200: {
        description: 'Process-lifetime counters; cheap to scrape.',
        content: {
          'application/json': { schema: AdminIdempotencyMetricsResponseSchema },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders.csv',
    summary: 'CSV export of crypto orders matching the supplied filters (max 1000 rows)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      query: z.object({
        account_id: z.string().optional(),
        status: z
          .enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'])
          .optional(),
        search: z.string().optional(),
        limit: z.string().optional(),
        created_after: z.string().datetime().optional(),
        created_before: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body. First row is the header.',
        content: {
          'text/csv': {
            schema: z.string().describe('RFC 4180 CSV; UTF-8 no BOM.'),
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/admin/crypto-orders/{order_id}/apply-ipn',
    summary: 'Manually apply a NowPayments IPN to an order (ops escape hatch)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      params: z.object({ order_id: z.string() }),
      body: { content: { 'application/json': { schema: AdminApplyIpnRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Order envelope with the transitioned status.',
        content: { 'application/json': { schema: AdminCryptoOrderEnvelopeSchema } },
      },
      404: { description: 'No such order.', content: problemContent },
      ...errors4xx,
    },
  });

  // ── V-402 — magic-link + password-reset auth surface ──────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/magic-link/request',
    summary: 'Request a magic-link email; always 200 to avoid account enumeration',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: MagicLinkRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'Email accepted; if the address matches an account, a magic-link email is delivered. Response shape never confirms account existence.',
        content: { 'application/json': { schema: MagicLinkRequestResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/magic-link/consume',
    summary: 'Exchange a magic-link token for a fresh web session',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: MagicLinkConsumeRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Session issued.',
        content: { 'application/json': { schema: MagicLinkConsumeResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/password-reset/request',
    summary: 'Request a password-reset email; always 200 to avoid account enumeration',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: PasswordResetRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'Email accepted; if the address matches an account, a reset email is delivered.',
        content: { 'application/json': { schema: PasswordResetRequestResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/password-reset/confirm',
    summary: 'Consume a password-reset token + set a new password; issues a fresh session',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: PasswordResetConfirmRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Password updated; web session issued.',
        content: { 'application/json': { schema: PasswordResetConfirmResponseSchema } },
      },
      ...errors4xx,
    },
  });

  // ── V-460 — V-266 browser-OAuth-style CLI/GUI activation flow ──────────
  // Three routes: initiate (public) / bind (web-session auth required) /
  // exchange (public). The CLI/GUI never sees a user password — the
  // dashboard mints a scoped API key and hands the plaintext to the
  // CLI/GUI through `exchange`.
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/cli-authorize/initiate',
    summary: 'Start the CLI/GUI activation flow; returns a code + browser URL',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: CliAuthorizeInitiateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Activation code + browser URL the CLI/GUI opens. Code expires after ~5min.',
        content: { 'application/json': { schema: CliAuthorizeInitiateResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/cli-authorize/bind',
    summary: "Web-session-authed: bind the CLI/GUI's code to the calling account; mints an API key",
    tags: ['auth'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: CliAuthorizeBindRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Code bound; CLI/GUI can now poll exchange for the plaintext key.',
        content: { 'application/json': { schema: CliAuthorizeBindResponseSchema } },
      },
      ...errors4xx,
      404: {
        description: 'Code not found or expired.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/cli-authorize/exchange',
    summary: 'Poll for the bound API key plaintext (one-shot delivery)',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: CliAuthorizeExchangeRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'Discriminated-union: { status: pending } / { status: bound, api_key, account_id } / { status: expired }. The bound branch is one-shot — subsequent calls 404.',
        content: { 'application/json': { schema: CliAuthorizeExchangeResponseSchema } },
      },
      ...errors4xx,
      404: {
        description: 'Code not found or already consumed.',
        content: problemContent,
      },
    },
  });

  // ── V-355 web-session list / revoke ────────────────────────────────────
  const WebSessionEntryOpenApi = z.object({
    id: z.string(),
    os: z.string(),
    browser: z.string(),
    last_used_at: z.string(),
    expires_at: z.string(),
    current: z.boolean(),
  });
  const ListWebSessionsResponseOpenApi = z.object({
    data: z.array(WebSessionEntryOpenApi),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/web-sessions',
    summary: 'Active dashboard sign-ins for the calling account',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Active web sessions; current session marked.',
        content: { 'application/json': { schema: ListWebSessionsResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/account/web-sessions/{id}',
    summary: 'Revoke a specific dashboard sign-in by id',
    tags: ['account'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      204: { description: 'Session revoked.' },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/account/web-sessions',
    summary: 'Bulk-revoke every dashboard sign-in except the calling one (?keep=current)',
    tags: ['account'],
    security: auth,
    request: {
      query: z.object({ keep: z.literal('current') }),
    },
    responses: {
      200: {
        description: 'Other sessions revoked.',
        content: {
          'application/json': {
            schema: z.object({ revoked: z.number().int().nonnegative() }),
          },
        },
      },
      ...errors4xx,
    },
  });

  // ── V-459 — /v1/status/* — public status page surface ─────────────────
  // No-auth public endpoints; the marketing-site status indicator
  // and external uptime monitors consume them. Not exposed in
  // customer SDKs (intentional — customers monitor via status page).
  const StatusComponentResultOpenApi = z.object({
    name: z.string(),
    status: z.enum(['operational', 'degraded', 'major_outage']),
    last_checked_at: z.string(),
  });
  // V-545.A — recent_incidents item shape (latest ≤5 public
  // incidents from the last 30d). Mirror of PublicIncidentSummary in
  // routes/status.ts; drift caught by W412.C parity test.
  const StatusRecentIncidentOpenApi = z.object({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
    status: z.string(),
    started_at: z.string(),
    resolved_at: z.string().nullable(),
  });
  const StatusResponseOpenApi = z.object({
    overall_status: z.enum(['operational', 'degraded', 'major_outage']),
    components: z.array(StatusComponentResultOpenApi),
    recent_incidents: z.array(StatusRecentIncidentOpenApi),
  });
  const StatusIncidentsResponseOpenApi = z.object({
    data: z.array(z.unknown()),
  });
  const StatusIncidentDetailResponseOpenApi = z.object({
    incident: z.unknown(),
    updates: z.array(z.unknown()),
  });
  const StatusSlaResponseOpenApi = z.object({
    window_days: z.number().int().nonnegative(),
    uptime_percent: z.number(),
    target_percent: z.number(),
  });
  const StatusSubscribeRequestOpenApi = z.object({
    email: z.string().email(),
  });
  const StatusSubscribeResponseOpenApi = z.object({
    ok: z.boolean(),
  });
  const StatusUnsubscribeRequestOpenApi = z.object({
    token: z.string(),
  });
  const StatusConfirmRequestOpenApi = z.object({
    token: z.string(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/status',
    summary: 'Public service status (overall + per-component); 30s cache',
    tags: ['status'],
    responses: {
      200: {
        description: 'Status snapshot with components + recent incidents.',
        content: { 'application/json': { schema: StatusResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/status/incidents',
    summary: 'Public incidents log',
    tags: ['status'],
    responses: {
      200: {
        description: 'Incidents (most recent first).',
        content: { 'application/json': { schema: StatusIncidentsResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/status/incidents/{id}',
    summary: 'Public incident detail with update timeline (V-545.A)',
    tags: ['status'],
    request: {
      params: z.object({ id: z.string().describe('Prefixed id: inc_<uuid>.') }),
    },
    responses: {
      200: {
        description: 'Incident detail + update timeline (oldest first).',
        content: { 'application/json': { schema: StatusIncidentDetailResponseOpenApi } },
      },
      400: { description: 'Invalid id format. Expected inc_<uuid>.', content: problemContent },
      404: { description: 'Incident is private or does not exist.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/status/sla',
    summary: 'Rolling-window uptime percentage vs SLA target',
    tags: ['status'],
    responses: {
      200: {
        description: 'Rolling window + uptime + target.',
        content: { 'application/json': { schema: StatusSlaResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/status/subscribe',
    summary: 'Subscribe an email to status notifications (double-opt-in)',
    tags: ['status'],
    request: {
      body: { content: { 'application/json': { schema: StatusSubscribeRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Confirmation email sent (always 200 — no enumeration signal).',
        content: { 'application/json': { schema: StatusSubscribeResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/status/subscribe/confirm',
    summary: 'Confirm a status-subscription email via token',
    tags: ['status'],
    request: {
      body: { content: { 'application/json': { schema: StatusConfirmRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Subscription confirmed.',
        content: { 'application/json': { schema: StatusSubscribeResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/status/subscribe/unsubscribe',
    summary: 'Unsubscribe an email from status notifications via token',
    tags: ['status'],
    request: {
      body: { content: { 'application/json': { schema: StatusUnsubscribeRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Unsubscribed.',
        content: { 'application/json': { schema: StatusSubscribeResponseOpenApi } },
      },
    },
  });

  // ── V-458 — /v1/legal/* — acceptance machinery ─────────────────────────
  const LegalDocumentEntryOpenApi = z.object({
    document_key: z.string(),
    title: z.string(),
    version: z.string(),
    effective_date: z.string(),
    content_hash: z.string(),
    source_path: z.string(),
    byte_size: z.number().int().nonnegative(),
  });
  const ListLegalDocumentsResponseOpenApi = z.object({
    data: z.array(LegalDocumentEntryOpenApi),
  });
  const LegalRequiredEntryOpenApi = z.object({
    document_key: z.string(),
    current_version: z.string(),
    content_hash: z.string(),
    reason: z.string(),
    last_accepted_version: z.string().nullable(),
  });
  const ListLegalRequiredResponseOpenApi = z.object({
    data: z.array(LegalRequiredEntryOpenApi),
  });
  const AcceptLegalDocumentRequestOpenApi = z.object({
    document_key: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  });
  const AcceptLegalDocumentResponseOpenApi = z.object({
    id: z.string(),
    account_id: z.string(),
    document_key: z.string(),
    version: z.string(),
    content_hash: z.string(),
    accepted_at: z.string(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/legal/documents',
    summary: 'List the legal-document catalog (versions + content_hash)',
    tags: ['legal'],
    security: auth,
    responses: {
      200: {
        description: 'Catalog entries (no document body — body served on the marketing site).',
        content: { 'application/json': { schema: ListLegalDocumentsResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/legal/required',
    summary: 'List documents the calling account must accept (or re-accept)',
    tags: ['legal'],
    security: auth,
    responses: {
      200: {
        description: 'Required acceptances; each entry includes reason + last accepted version.',
        content: { 'application/json': { schema: ListLegalRequiredResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/legal/accept',
    summary: 'Record acceptance of a (document, version, content_hash) tuple',
    tags: ['legal'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AcceptLegalDocumentRequestOpenApi } } },
    },
    responses: {
      201: {
        description: 'Acceptance recorded.',
        content: { 'application/json': { schema: AcceptLegalDocumentResponseOpenApi } },
      },
      409: {
        description: 'Document version changed since fetch — re-fetch + retry.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── V-457 — /v1/webhooks base CRUD + deliveries + PATCH ────────────────
  // Customer-facing webhook CRUD; was previously SDK-exposed but
  // missing from spec (only test + rotate-secret were registered).
  const ListWebhookEndpointsResponseOpenApi = z.object({
    data: z.array(WebhookEndpointSchema),
  });
  const ListDeliveriesQueryOpenApi = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.enum(['pending', 'in_flight', 'delivered', 'failed', 'dlq']).optional(),
  });
  const PaginatedDeliveriesOpenApi = z.object({
    data: z.array(WebhookDeliverySchema),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/webhooks',
    summary: 'Create a webhook endpoint',
    tags: ['webhooks'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: CreateWebhookRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Created endpoint; plaintext signing secret returned ONCE.',
        content: { 'application/json': { schema: CreateWebhookResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/webhooks',
    summary: 'List webhook endpoints for the calling account',
    tags: ['webhooks'],
    security: auth,
    responses: {
      200: {
        description: 'Endpoint list (no plaintext).',
        content: { 'application/json': { schema: ListWebhookEndpointsResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/webhooks/{id}',
    summary: 'Get a single webhook endpoint',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Endpoint.',
        content: { 'application/json': { schema: WebhookEndpointSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/webhooks/{id}',
    summary: 'Partial update of a webhook endpoint (url / events / description / active)',
    tags: ['webhooks'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateWebhookRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Updated endpoint.',
        content: { 'application/json': { schema: WebhookEndpointSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/webhooks/{id}',
    summary: 'Disable (soft-delete) a webhook endpoint. Idempotent.',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Endpoint disabled.' },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/webhooks/{id}/deliveries',
    summary: 'List delivery attempts for a webhook endpoint',
    tags: ['webhooks'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      query: ListDeliveriesQueryOpenApi,
    },
    responses: {
      200: {
        description: 'Paginated delivery list with optional ?status= filter.',
        content: { 'application/json': { schema: PaginatedDeliveriesOpenApi } },
      },
      ...errors4xx,
    },
  });

  // ── V-356 webhook test-delivery + V-359 secret rotation ────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/webhooks/{id}/test',
    summary: 'Enqueue a synthetic test.ping delivery (bypass subscription)',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      202: {
        description: 'Test delivery enqueued.',
        content: {
          'application/json': {
            schema: z.object({
              delivery_id: z.string(),
              event_id: z.string(),
              event_type: z.literal('test.ping'),
            }),
          },
        },
      },
      ...errors4xx,
    },
  });
  const RotateSecretResponseOpenApi = z.object({
    id: z.string(),
    secret: z.string(),
    secret_prefix: z.string(),
    prev_secret_prefix: z.string(),
    grace_expires_at: z.string(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/webhooks/{id}/rotate-secret',
    summary: 'Rotate the signing secret with a 24h grace (worker dual-signs during grace)',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Fresh plaintext shown ONCE; prev secret stays valid for 24h.',
        content: { 'application/json': { schema: RotateSecretResponseOpenApi } },
      },
      409: {
        description: 'Endpoint is disabled; cannot rotate.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── V-456 — /v1/profiles base CRUD (V-081) ─────────────────────────────
  // Customer-facing profile CRUD; was previously SDK-exposed but
  // missing from spec. Now registered so Scalar UI + downstream SDK
  // regenerators see the canonical shapes.
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles',
    summary: 'Create a profile',
    tags: ['profiles'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: CreateProfileRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Created profile.',
        content: { 'application/json': { schema: ProfileSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles',
    summary: 'List profiles for the calling account',
    tags: ['profiles'],
    security: auth,
    request: { query: PaginationQuerySchema },
    responses: {
      200: {
        description: 'Paginated profile list.',
        content: { 'application/json': { schema: ListProfilesResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles/{id}',
    summary: 'Get a single profile',
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Profile.',
        content: { 'application/json': { schema: ProfileSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/profiles/{id}',
    summary: 'Partial update of a profile (name / description)',
    tags: ['profiles'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateProfileRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Updated profile.',
        content: { 'application/json': { schema: ProfileSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/profiles/{id}',
    summary: 'Delete a profile (storage state wiped; idempotent)',
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Profile deleted.' },
      ...errors4xx,
    },
  });

  // ── V-313 profile cloning ──────────────────────────────────────────────
  const CloneProfileRequestOpenApi = z.object({
    name: z.string().optional(),
  });
  const ProfileResponseOpenApi = z.object({
    id: z.string(),
    name: z.string(),
    archetype: z.string(),
    description: z.string().nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/clone',
    summary: 'Duplicate an existing profile metadata row with an auto-derived "(copy)" name',
    tags: ['profiles'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: CloneProfileRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Cloned profile.',
        content: { 'application/json': { schema: ProfileResponseOpenApi } },
      },
      ...errors4xx,
    },
  });

  // ── V-312 profile snapshots ────────────────────────────────────────────
  const SnapshotResponseOpenApi = z.object({
    id: z.string(),
    parent_profile_id: z.string().nullable(),
    label: z.string(),
    description: z.string().nullable(),
    parent_archetype: z.string(),
    parent_name: z.string(),
    captured_at: z.string(),
    created_at: z.string(),
  });
  const ListSnapshotsResponseOpenApi = z.object({
    data: z.array(SnapshotResponseOpenApi),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });
  const CaptureSnapshotRequestOpenApi = z.object({
    label: z.string().min(1).max(120),
    description: z.string().max(2048).optional(),
  });
  const RestoreSnapshotRequestOpenApi = z.object({
    name: z.string(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/snapshots',
    summary: 'Capture an immutable point-in-time snapshot of the profile',
    tags: ['profiles', 'snapshots'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: CaptureSnapshotRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Snapshot captured.',
        content: { 'application/json': { schema: SnapshotResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles/{id}/snapshots',
    summary: "List a profile's snapshots, newest-first",
    tags: ['profiles', 'snapshots'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: {
        description: 'Snapshots for this profile.',
        content: { 'application/json': { schema: ListSnapshotsResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profile-snapshots',
    summary: 'List every snapshot owned by the calling account (cross-profile)',
    tags: ['snapshots'],
    security: auth,
    request: { query: PaginationQuerySchema },
    responses: {
      200: {
        description: 'Snapshots across all profiles.',
        content: { 'application/json': { schema: ListSnapshotsResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profile-snapshots/{id}',
    summary: 'Single snapshot by id',
    tags: ['snapshots'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Snapshot.',
        content: { 'application/json': { schema: SnapshotResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profile-snapshots/{id}/restore',
    summary: 'Create a new profile from a snapshot (tier-cap + name-conflict checked)',
    tags: ['snapshots', 'profiles'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: RestoreSnapshotRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'New profile created from snapshot.',
        content: { 'application/json': { schema: ProfileResponseOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/profile-snapshots/{id}',
    summary: 'Hard-delete a snapshot',
    tags: ['snapshots'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Snapshot deleted.' },
      ...errors4xx,
    },
  });

  return r;
}

function registerRoute(r: OpenAPIRegistry, config: RouteConfig): void {
  r.registerPath(config);
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────

let cached: OpenAPIObject | null = null;

export function generateOpenApiSpec(): OpenAPIObject {
  if (cached) return cached;

  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Driftstack API',
      version: '0.0.1',
      description: [
        'Driftstack API — stealth iPhone Safari automation. Pre-launch contract; subject to change.',
        '',
        '## Team RBAC: X-Driftstack-Account header (V-326e)',
        '',
        "Members of a team can scope any /v1/* request to the OWNER's resources by passing",
        'the `X-Driftstack-Account: acc_<owner-uuid>` request header. The server validates that',
        'the calling account is on the team referenced by the header.',
        '',
        '- Read endpoints (GET): both `member` and `admin` roles allowed.',
        '- Write endpoints (POST / PATCH / DELETE / api-keys rotate): `admin` role only;',
        '  `member` role gets 403.',
        '',
        'Endpoints honoring the header: /v1/sessions (+ all session sub-paths), /v1/profiles,',
        '/v1/api-keys (+ /:id/rotate), /v1/webhooks (+ /:id/deliveries + replay),',
        '/v1/account/audit-log (+ export), /v1/account/email-preferences, /v1/usage,',
        '/v1/usage/series.',
        '',
        'Endpoints that do NOT honor the header: /v1/team/*, /v1/account/me (always',
        "returns the caller's own profile + their team list), /v1/auth/*.",
        '',
        'See `docs.driftstack.dev/api/team` for full details.',
      ].join('\n'),
      license: { name: 'MIT' },
      contact: { name: 'Driftstack', url: 'https://github.com/driftstackdev/driftstack-api' },
    },
    servers: [{ url: 'https://api.driftstack.dev', description: 'Production (placeholder)' }],
  });
  return cached;
}

/** Test-only: clear the memoised spec so a re-call regenerates. */
export function _clearSpecCache(): void {
  cached = null;
}
