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
  AccountSchema,
  AdminAccountResponseSchema,
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
      description:
        'Driftstack API — stealth iPhone Safari automation. Pre-launch contract; subject to change.',
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
