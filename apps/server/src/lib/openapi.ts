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
  UpdateAccountMeRequestSchema,
  UploadAvatarRequestSchema,
  AdminAuditLogEntrySchema,
  ApiKeySchema,
  CaptureRequestSchema,
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
  SessionStateSchema,
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
