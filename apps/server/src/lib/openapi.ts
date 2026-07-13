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
  ConsequentialActionCategorySchema,
  AdminAccountResponseSchema,
  CreateProfileRequestSchema,
  ListProfilesResponseSchema,
  ProfileExportEnvelopeSchema,
  ProfileImportRequestSchema,
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
  ResendVerificationRequestSchema,
  ResendVerificationResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
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
  ExtractRequestSchema,
  ExtractResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SessionLoginRequestSchema,
  SessionLoginResponseSchema,
  ChangeTierRequestSchema,
  CreateApiKeyRequestSchema,
  CreateApiKeyResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  DeleteAccountRequestSchema,
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
  AgentModelSchema,
  AgentSessionSchema,
  ResumeSessionRequestSchema,
  ResumeSessionResponseSchema,
  AgentIntentSchema,
  IntentResultSchema,
  RecipeSchema,
  RecipeDetailSchema,
} from '@driftstack/api-types';
// S33 2026-07-07 (fable-truth-audit) — the cookie shape the agent-session
// cookie read/import routes emit + validate. Imported from the harness
// control protocol (the routes' own single source of truth) rather than
// re-declared here, so a wire-shape change flows into the spec.
import { CookieSchema } from '../schemas/harness-control-protocol.js';

const PaginatedSessionsSchema = z.object({
  data: z.array(SessionSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const PaginatedRecipesSchema = z.object({
  data: z.array(RecipeSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const PaginatedApiKeysSchema = z.object({
  data: z.array(ApiKeySchema),
});

// V-386 — full /v1/account/me response shape. Defined here rather than
// in api-types because it is richer than the lean shared AccountSchema.
// This named OpenAPI component is also mirrored by the public SDK
// AccountSelfProfile models and consumed directly by the dashboard.
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
  avatar_source: z.enum(['user', 'idp', 'none']),
  mfa_enrolled: z.boolean(),
  concurrent_session_cap: z.number().int().nonnegative(),
  concurrent_session_active: z.number().int().nonnegative(),
  profile_cap: z.number().int().nonnegative().nullable(),
  profile_count: z.number().int().nonnegative(),
  teams: z.array(
    z.object({
      owner_account_id: z.string(),
      // Owner identity so the dashboard can label a team by who owns it
      // (instead of a bare acc_<uuid>). email is always present; name is
      // null when the owner never set a display name.
      owner_email: z.string(),
      owner_name: z.string().nullable(),
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
  r.register('AgentSession', AgentSessionSchema);
  r.register('AgentIntent', AgentIntentSchema);
  r.register('IntentResult', IntentResultSchema);
  r.register('Recipe', RecipeSchema);
  r.register('RecipeDetail', RecipeDetailSchema);
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
  r.register('ExtractRequest', ExtractRequestSchema);
  r.register('ExtractResponse', ExtractResponseSchema);
  r.register('SearchRequest', SearchRequestSchema);
  r.register('SearchResponse', SearchResponseSchema);
  r.register('SessionLoginRequest', SessionLoginRequestSchema);
  r.register('SessionLoginResponse', SessionLoginResponseSchema);
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
  // Billing resource — GET /v1/billing returns the subscription
  // mirror. Schema lives in @driftstack/api-types/billing
  // already; registering it here lifts it from anonymous-inline to a
  // named #/components/schemas/GetBillingStateResponse ref so pydantic
  // regen produces a typed class (matches TS+Go SDK shapes).
  r.register('GetBillingStateResponse', GetBillingStateResponseSchema);

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
    operationId: 'createSession',
    summary: 'Create a session',
    tags: ['sessions'],
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
    operationId: 'listSessions',
    summary: 'List sessions for the calling account',
    tags: ['sessions'],
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
    operationId: 'navigateSession',
    summary: 'Navigate to a URL within a session',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string().describe('Prefixed session id (ses_<uuid>)') }),
      body: {
        content: {
          'application/json': {
            schema: NavigateRequestSchema,
            example: { url: 'https://example.com/pricing' },
          },
        },
      },
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
    operationId: 'interactSession',
    summary: 'Send an interaction (tap / type / scroll / press) to the session',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: InteractRequestSchema,
            example: { action: { kind: 'tap', selector: '#add-to-cart' } },
          },
        },
      },
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
    operationId: 'waitSession',
    summary: 'Wait for a session-side condition (selector, url, time)',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: WaitRequestSchema,
            example: { condition: { kind: 'selector', selector: '#order-confirmation' } },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Wait resolved (satisfied or timed out).',
        content: {
          'application/json': {
            schema: WaitResponseSchema,
            example: { satisfied: true, duration_ms: 1240 },
          },
        },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/sessions/{id}',
    operationId: 'getSession',
    summary: 'Get a session by id (includes harness-reported egress_capabilities)',
    tags: ['sessions'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Session record.',
        content: { 'application/json': { schema: SessionSchema } },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/sessions/{id}/state',
    operationId: 'getSessionState',
    summary: 'Snapshot current session state (URL, title, cookies, localStorage)',
    tags: ['sessions'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Session state.',
        content: {
          'application/json': {
            schema: SessionStateSchema,
            example: {
              url: 'https://example.com/pricing',
              title: 'Pricing — Example',
              cookies: [{ name: 'session', value: 'abc123', domain: 'example.com', path: '/' }],
              local_storage: { theme: 'dark' },
              captured_at: '2026-05-31T12:00:05Z',
            },
          },
        },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/capture',
    operationId: 'captureSession',
    summary: 'Capture a screenshot, DOM snapshot, or PDF of the session',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: CaptureRequestSchema,
            example: { kind: 'screenshot', full_page: true },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Capture produced.',
        content: {
          'application/json': {
            schema: CaptureResponseSchema,
            example: {
              kind: 'screenshot',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              encoding: 'base64',
              byte_size: 68,
              duration_ms: 320,
            },
          },
        },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/extract',
    operationId: 'extractSession',
    summary: 'Read structured data from the page (a batch of named extractions)',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: ExtractRequestSchema,
            example: {
              extractions: [
                { name: 'title', selector: 'h1', type: 'text' },
                { name: 'price', selector: '.price', type: 'text', transform: 'number' },
                { name: 'links', selector: 'a.product', type: 'list' },
              ],
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Extraction produced.',
        content: {
          'application/json': {
            schema: ExtractResponseSchema,
            example: { value: { title: 'Example', price: 19.99, links: ['/a', '/b'] } },
          },
        },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/search',
    operationId: 'searchSession',
    summary: 'Find the search field, type the query, and submit',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: SearchRequestSchema,
            example: { query: 'wireless headphones', wait_for_results_selector: '.results' },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Query typed and (optionally) submitted.',
        content: {
          'application/json': {
            schema: SearchResponseSchema,
            example: { submitted: true, results_visible: true },
          },
        },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/sessions/{id}/login',
    operationId: 'loginSession',
    summary: 'Heuristic credential login (type username + password, submit)',
    tags: ['sessions'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: SessionLoginRequestSchema,
            example: {
              username: 'user@example.com',
              password: '••••••••',
              success_selector: '.dashboard',
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Credentials typed and submitted; logged_in is the post-submit assessment.',
        content: {
          'application/json': {
            schema: SessionLoginResponseSchema,
            example: { logged_in: true, post_login_url: 'https://example.com/account' },
          },
        },
      },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'delete',
    path: '/v1/sessions/{id}',
    operationId: 'destroySession',
    summary: 'Destroy a session',
    tags: ['sessions'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Session destroyed.' },
      404: {
        description: 'Session not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── Admin / API keys ───────────────────────────────────────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/api-keys',
    operationId: 'createApiKey',
    summary: 'Create an API key (returns plaintext once, never retrievable later)',
    tags: ['api-keys'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: CreateApiKeyRequestSchema,
            example: { name: 'ci-pipeline', scopes: ['read', 'write'] },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Key created. The plaintext is in the response — store it now.',
        content: {
          'application/json': {
            schema: CreateApiKeyResponseSchema,
            example: {
              id: 'key_3f8a1b2c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
              name: 'ci-pipeline',
              key_prefix: 'ds_live_3f8a',
              scopes: ['read', 'write'],
              last_used_at: null,
              revoked_at: null,
              expires_at: null,
              created_at: '2026-05-31T12:00:00Z',
              plaintext: 'ds_live_exampleexampleexampleexampleexample',
            },
          },
        },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'get',
    path: '/v1/api-keys',
    operationId: 'listApiKeys',
    summary: 'List API keys for the calling account',
    tags: ['api-keys'],
    security: auth,
    responses: {
      200: {
        description: 'List of keys (plaintext never included).',
        content: {
          'application/json': {
            schema: PaginatedApiKeysSchema,
            example: {
              data: [
                {
                  id: 'key_3f8a1b2c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
                  name: 'ci-pipeline',
                  key_prefix: 'ds_live_3f8a',
                  scopes: ['read', 'write'],
                  last_used_at: '2026-05-31T09:30:00Z',
                  revoked_at: null,
                  expires_at: null,
                  created_at: '2026-05-20T08:00:00Z',
                },
              ],
            },
          },
        },
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'delete',
    path: '/v1/api-keys/{id}',
    operationId: 'revokeApiKey',
    summary: 'Revoke an API key',
    tags: ['api-keys'],
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
    operationId: 'rotateApiKey',
    summary: 'Rotate an API key (V-296). 24h grace; new plaintext shown once',
    tags: ['api-keys'],
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
            example: {
              id: 'key_5f6a7b8c-9d0e-1f20-3a4b-5c6d7e8f9a0b',
              name: 'ci-pipeline',
              key_prefix: 'ds_live_5f6a',
              scopes: ['read', 'write'],
              last_used_at: null,
              revoked_at: null,
              expires_at: null,
              created_at: '2026-05-31T12:00:00Z',
              plaintext: 'ds_live_exampleexampleexampleexamplerotate',
              rotated_from: 'key_3f8a1b2c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
              grace_period_ends_at: '2026-06-01T12:00:00Z',
            },
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
    tags: ['usage'],
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
    tags: ['usage'],
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
  // member-facing GET /v1/team/owners endpoint. Carries the owner's
  // email/name so the dashboard labels a team by who owns it.
  const TeamOwnerSchema = z
    .object({
      owner_account_id: z.string(),
      owner_email: z.string(),
      owner_name: z.string().nullable(),
      role: z.enum(['member', 'admin']),
      membership_id: z.string(),
    })
    .openapi('TeamOwner');

  registerRoute(r, {
    method: 'post',
    path: '/v1/team/invites',
    summary: 'Invite an email to join the calling owner’s team',
    tags: ['team'],
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
    tags: ['team'],
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
    tags: ['team'],
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
    tags: ['team'],
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
    tags: ['team'],
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
    tags: ['team'],
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
    tags: ['meta'],
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
    method: 'post',
    path: '/v1/admin/accounts/{id}/delete',
    summary: 'Delete an account (admin, GDPR Article 17)',
    tags: ['admin'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: DeleteAccountRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Account deleted.',
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
        bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']),
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
    operationId: 'replayWebhookDelivery',
    summary: 'Replay a webhook delivery (V-307; customer self-service)',
    tags: ['webhooks'],
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
      404: {
        description: 'No validation schedule exists for that archetype.',
        content: problemContent,
      },
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
  const UploadAvatarResponseOpenApi = z
    .object({
      avatar_url: z.string().nullable(),
      content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      bytes: z.number().int().nonnegative(),
    })
    .openapi('UploadAvatarResponse');
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

  // Arc 7 docs.openapi — BYOK Anthropic + Bundled LLM endpoints.
  // The full reference for both surfaces lives at
  // docs.driftstack.dev/api/byok-anthropic + /api/bundled-llm. These
  // OpenAPI route registrations expose the surface to SDK
  // generators + the Scalar UI rendered at /docs/.
  const ByokAnthropicMetadataOpenApi = z
    .object({
      has_key: z.boolean(),
      set_at: z.string().nullable(),
      last_used_at: z.string().nullable(),
    })
    .openapi('ByokAnthropicMetadata');
  const PutByokAnthropicRequestOpenApi = z
    .object({
      api_key: z.string().min(1).describe('Plaintext Anthropic API key. Never echoed back.'),
    })
    .openapi('PutByokAnthropicRequest');
  const PutByokAnthropicResponseOpenApi = z
    .object({
      set_at: z.string(),
    })
    .openapi('PutByokAnthropicResponse');
  // Union types don't accept .openapi() in zod-to-openapi for some
  // versions; leave TestByokAnthropicResponseOpenApi inline. The
  // success/failure shapes are simple enough that the synthesised
  // type is fine.
  const TestByokAnthropicResponseOpenApi = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ]);
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/byok-anthropic-key',
    summary: 'BYOK Anthropic key metadata (no plaintext)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Metadata — has_key + set_at + last_used_at. Plaintext is never exposed.',
        content: { 'application/json': { schema: ByokAnthropicMetadataOpenApi } },
      },
      ...errors4xx,
      503: {
        description: 'BYOK Anthropic key storage not yet enabled on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'put',
    path: '/v1/account/me/byok-anthropic-key',
    summary: 'Set or rotate the BYOK Anthropic key',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: PutByokAnthropicRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Key stored. Returns set_at timestamp.',
        content: { 'application/json': { schema: PutByokAnthropicResponseOpenApi } },
      },
      ...errors4xx,
      503: { description: 'BYOK storage not enabled.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/account/me/byok-anthropic-key',
    summary: 'Clear the stored BYOK Anthropic key',
    tags: ['account'],
    security: auth,
    responses: {
      204: { description: 'Key cleared.' },
      ...errors4xx,
      503: { description: 'BYOK storage not enabled.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/me/byok-anthropic-key/test',
    summary: 'Test the stored BYOK Anthropic key against the Anthropic API',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Connection test result. ok=true on success; ok=false with reason on failure.',
        content: { 'application/json': { schema: TestByokAnthropicResponseOpenApi } },
      },
      ...errors4xx,
      503: { description: 'BYOK storage not enabled.', content: problemContent },
    },
  });

  // Bundled LLM (v2-#6).
  const BundledLlmSettingsOpenApi = z
    .object({
      consent: z.boolean(),
      monthly_cap_usd_cents: z.number().int().min(0).max(1_000_000),
    })
    .openapi('BundledLlmSettings');
  const PatchBundledLlmRequestOpenApi = z
    .object({
      consent: z.boolean().optional(),
      monthly_cap_usd_cents: z.number().int().min(0).max(1_000_000).optional(),
    })
    .describe('At least one of consent / monthly_cap_usd_cents must be present.')
    .openapi('PatchBundledLlmRequest');
  const BundledLlmStatusOpenApi = z
    .object({
      consent: z.boolean(),
      cap_cents: z.number().int().min(0),
      used_this_month_cents: z.number().int().min(0),
      remaining_cents: z.number().int().min(0),
      refused_count_this_month: z.number().int().min(0),
      month_started_at: z.string(),
    })
    .openapi('BundledLlmStatus');
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/bundled-llm-settings',
    summary: 'Bundled-LLM consent + monthly cap (v2-#6)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Current bundled-LLM settings. Defaults to consent=false, cap=$20.',
        content: { 'application/json': { schema: BundledLlmSettingsOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/account/me/bundled-llm-settings',
    summary: 'Update bundled-LLM consent and/or monthly cap',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: PatchBundledLlmRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Updated settings.',
        content: { 'application/json': { schema: BundledLlmSettingsOpenApi } },
      },
      ...errors4xx,
      // S42 2026-07-07 (founder-approved) — bundled-LLM consent tier gate:
      // consent:true only on tiers with bundled billing (API Builder+).
      // consent:false + cap-only updates stay open on every tier.
      403: {
        description:
          'Key lacks the account_owner scope, or consent:true was requested on a tier without bundled-LLM billing (below API Builder).',
        content: problemContent,
      },
    },
  });
  // Per-account organization taxonomy (2026-06-16) — empty folders (+icons) +
  // tags defined in the GUI rail, synced per-account.
  const AccountOrganizationOpenApi = z
    .object({
      folders: z.array(z.object({ name: z.string(), icon: z.string().optional() })),
      tags: z.array(z.string()),
    })
    .openapi('AccountOrganization');
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/organization',
    summary: 'Account organization taxonomy (empty folders + tags)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: "The caller's folder/tag taxonomy. Empty arrays by default.",
        content: { 'application/json': { schema: AccountOrganizationOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'put',
    path: '/v1/account/me/organization',
    summary: 'Replace the account organization taxonomy (account_owner)',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AccountOrganizationOpenApi } } },
    },
    responses: {
      200: {
        description: 'The stored taxonomy.',
        content: { 'application/json': { schema: AccountOrganizationOpenApi } },
      },
      ...errors4xx,
    },
  });
  // ARC A — per-account customer proxies. The password is write-only (accepted
  // on create/update, never returned); responses expose has_password.
  const OpenVpnConfigOpenApi = z.object({
    config_blob: z.string(),
    username: z.string().optional(),
    password: z.string().optional(),
  });
  const WireGuardConfigOpenApi = z.object({
    private_key: z.string(),
    peer_public_key: z.string(),
    endpoint: z.string(),
    allowed_ips: z.string().optional(),
    address: z.string().optional(),
    dns: z.string().optional(),
  });
  const AccountProxyInputOpenApi = z
    .object({
      label: z.string(),
      scheme: z.enum(['socks5', 'http', 'openvpn', 'wireguard']).optional(),
      host: z.string(),
      port: z.number().int(),
      username: z.string().nullable().optional(),
      password: z.string().nullable().optional(),
      openvpn: OpenVpnConfigOpenApi.optional(),
      wireguard: WireGuardConfigOpenApi.optional(),
    })
    .openapi('AccountProxyInput');
  const AccountProxyMetadataOpenApi = z
    .object({
      id: z.string(),
      label: z.string(),
      scheme: z.enum(['socks5', 'http', 'openvpn', 'wireguard']),
      host: z.string(),
      port: z.number().int(),
      username: z.string().nullable(),
      has_password: z.boolean(),
      has_secret: z.boolean(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi('AccountProxyMetadata');
  const AccountProxyListOpenApi = z
    .object({ data: z.array(AccountProxyMetadataOpenApi) })
    .openapi('AccountProxyList');
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/proxies',
    summary: 'List the account’s customer proxies (account_owner; no secrets)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'The account’s proxies (metadata only — has_password, never the password).',
        content: { 'application/json': { schema: AccountProxyListOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/me/proxies',
    summary: 'Create a customer proxy (account_owner)',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AccountProxyInputOpenApi } } },
    },
    responses: {
      201: {
        description: 'The created proxy (metadata only).',
        content: { 'application/json': { schema: AccountProxyMetadataOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'put',
    path: '/v1/account/me/proxies/{id}',
    summary: 'Update a customer proxy (account_owner; omit password to keep it)',
    tags: ['account'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: AccountProxyInputOpenApi } } },
    },
    responses: {
      200: {
        description: 'The updated proxy (metadata only).',
        content: { 'application/json': { schema: AccountProxyMetadataOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/account/me/proxies/{id}',
    summary: 'Delete a customer proxy (account_owner)',
    tags: ['account'],
    security: auth,
    responses: {
      204: { description: 'Deleted.' },
      ...errors4xx,
    },
  });
  const AccountProxyTestResultOpenApi = z
    .union([
      z.object({ ok: z.literal(true), latency_ms: z.number().int() }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ])
    .openapi('AccountProxyTestResult');
  registerRoute(r, {
    method: 'post',
    path: '/v1/account/me/proxies/{id}/test',
    summary: 'Test reachability of a customer proxy (account_owner)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Reachability result (ok=true + latency_ms, or ok=false + reason).',
        content: { 'application/json': { schema: AccountProxyTestResultOpenApi } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/bundled-llm-status',
    summary: 'Bundled-LLM month-to-date spend + remaining headroom',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description: 'Used / remaining / cap in cents, plus calendar-month-start.',
        content: { 'application/json': { schema: BundledLlmStatusOpenApi } },
      },
      ...errors4xx,
    },
  });

  // Arc 7 docs.openapi — OAuth-client IDP signin (V-667.C). The
  // /v1/auth/oauth-client/* surface lets customers sign in to the
  // dashboard with Google or GitHub. The callback endpoint is the
  // IDP-redirect target; /start returns the authorize URL the
  // dashboard sends the customer's browser to; /confirm-merge is
  // the verdict-1 same-email-collision resolution path.
  const OauthClientStartRequestOpenApi = z.object({
    provider: z.enum(['google', 'github']),
    redirect_to: z.string().url(),
  });
  const OauthClientStartResponseOpenApi = z.object({ authorize_url: z.string().url() });
  const OauthClientConfirmMergeRequestOpenApi = z.object({
    token: z.string().min(32).max(128),
  });
  const OauthClientConfirmMergeResponseOpenApi = z.object({
    outcome: z.literal('merged'),
    account_id: z.string(),
    link_id: z.string(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/oauth-client/start',
    summary: 'Stage an IDP signin flow — returns the authorize URL for Google or GitHub',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: OauthClientStartRequestOpenApi } } },
    },
    responses: {
      200: {
        description:
          "Authorize URL — the client redirects the user's browser here to start the IDP consent flow.",
        content: { 'application/json': { schema: OauthClientStartResponseOpenApi } },
      },
      400: { description: 'Unknown provider OR provider not configured.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/oauth-client/confirm-merge',
    summary:
      'Confirm a same-email-collision merge — links a new IDP identity to an existing account',
    tags: ['auth'],
    request: {
      body: {
        content: { 'application/json': { schema: OauthClientConfirmMergeRequestOpenApi } },
      },
    },
    responses: {
      200: {
        description: 'Merge confirmed; IDP identity now linked to the existing account.',
        content: { 'application/json': { schema: OauthClientConfirmMergeResponseOpenApi } },
      },
      400: {
        description: 'Token is invalid, expired, or already used.',
        content: problemContent,
      },
    },
  });

  // Arc 7 docs.openapi — OAuth 2.0 public dance (V-667). The 4
  // standard-spec endpoints third-party clients use to obtain access
  // tokens on a customer's behalf. Full prose at
  // docs.driftstack.dev/api/oauth. Admin endpoints (/v1/admin/oauth/*)
  // are NOT registered — they're internal-only.
  // Caps below MUST mirror apps/server/src/routes/oauth.ts so the
  // openapi spec the SDKs consume matches the actual route validator
  // (slice 117 added the route-side caps; this slice aligns the spec).
  const OAuthAuthorizeQueryOpenApi = z.object({
    client_id: z.string().min(1).max(128),
    redirect_uri: z.string().url(),
    state: z.string().min(8).max(256),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    scope: z.string().max(1024).optional(),
  });
  const OAuthAuthorizeResponseOpenApi = z.object({ authorization_id: z.string() });
  const OAuthTokenRequestOpenApi = z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(256),
    code_verifier: z.string().min(43).max(128),
    client_id: z.string().min(1).max(128),
    client_secret: z.string().min(1).max(256),
    redirect_uri: z.string().url(),
  });
  const OAuthTokenResponseOpenApi = z.object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: z.array(z.string()),
  });
  const OAuthIntrospectRequestOpenApi = z.object({ token: z.string().min(1).max(2048) });
  const OAuthIntrospectResponseOpenApi = z.union([
    z.object({ active: z.literal(false) }),
    z.object({
      active: z.literal(true),
      client_id: z.string(),
      account_id: z.string().nullable(),
      scope: z.array(z.string()),
      exp: z.number().int().positive(),
    }),
  ]);
  const OAuthRevokeRequestOpenApi = z.object({
    token: z.string().min(1).max(2048),
    token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/oauth/authorize',
    summary: 'OAuth 2.0 authorize — stage a PKCE authorization (RFC 6749 + RFC 7636)',
    tags: ['oauth'],
    request: {
      query: OAuthAuthorizeQueryOpenApi,
    },
    responses: {
      200: {
        description: 'Authorization staged. authorization_id is consumed by /authorize/complete.',
        content: { 'application/json': { schema: OAuthAuthorizeResponseOpenApi } },
      },
      400: { description: 'Invalid request / scope / client.', content: problemContent },
      401: { description: 'Unknown / revoked client.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/oauth/token',
    summary: 'OAuth 2.0 token — exchange authorization code for an access token',
    tags: ['oauth'],
    request: {
      body: { content: { 'application/json': { schema: OAuthTokenRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'Access token (1-hour TTL; no refresh tokens issued).',
        content: { 'application/json': { schema: OAuthTokenResponseOpenApi } },
      },
      400: {
        description: 'invalid_grant / invalid_request / invalid_scope / access_denied.',
        content: problemContent,
      },
      401: { description: 'invalid_client / unauthorized_client.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/oauth/introspect',
    summary: 'OAuth 2.0 introspect — RFC 7662 token introspection',
    tags: ['oauth'],
    request: {
      body: { content: { 'application/json': { schema: OAuthIntrospectRequestOpenApi } } },
    },
    responses: {
      200: {
        description: 'active=true with token metadata, OR active=false when not recognized.',
        content: { 'application/json': { schema: OAuthIntrospectResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/oauth/revoke',
    summary: 'OAuth 2.0 revoke — RFC 7009 token revocation',
    tags: ['oauth'],
    request: {
      body: { content: { 'application/json': { schema: OAuthRevokeRequestOpenApi } } },
    },
    responses: {
      200: {
        description:
          'Always 200, regardless of whether the token existed. Spec requirement: prevents probe-style enumeration.',
        content: { 'application/json': { schema: z.object({}) } },
      },
    },
  });

  const RateLimitBucketOpenApi = z.object({
    bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']),
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
  const AccountAuditEntryOpenApi = z
    .object({
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
    })
    .openapi('AccountAuditEntry');
  const ListAccountAuditResponseOpenApi = z
    .object({
      data: z.array(AccountAuditEntryOpenApi),
      next_cursor: z.string().nullable(),
    })
    .openapi('ListAccountAuditResponse');
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
  const ExportAccountAuditResponseOpenApi = z
    .object({
      generated_at: z.string(),
      account_id: z.string(),
      row_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
      data: z.array(AccountAuditEntryOpenApi),
    })
    .openapi('ExportAccountAuditResponse');
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

  // V-541.D — customer-facing per-cycle cost surface. Scoped to the
  // calling account (account id pinned to ctx, not a URL param). The
  // customer surface omits operator-tuned threshold caps; it returns
  // only the account's actual spend + where it sits vs its thresholds.
  const CostThresholdStateOpenApi = z
    .enum(['under-soft', 'between-soft-and-hard', 'over-hard'])
    .openapi('CostThresholdState');
  const CostBreakdownOpenApi = z
    .object({
      computeCents: z.number().int().nonnegative(),
      storageCents: z.number().int().nonnegative(),
      egressCents: z.number().int().nonnegative(),
      emailCents: z.number().int().nonnegative(),
      llmCents: z.number().int().nonnegative(),
      totalCents: z.number().int().nonnegative(),
      thresholdState: CostThresholdStateOpenApi,
    })
    .openapi('CostBreakdown');
  const AccountCostResponseOpenApi = z
    .object({
      account_id: z.string(),
      billing_cycle: z.string().regex(/^\d{4}-\d{2}$/),
      tier: AccountTierSchema,
      breakdown: CostBreakdownOpenApi,
    })
    .openapi('AccountCostResponse');
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/cost',
    summary: 'Read the calling account cost breakdown for a billing cycle',
    tags: ['account'],
    security: auth,
    request: {
      query: z.object({
        billing_cycle: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
    },
    responses: {
      200: {
        description:
          'Per-cycle cost breakdown. A fresh account with no usage gets a zero breakdown (not 404).',
        content: { 'application/json': { schema: AccountCostResponseOpenApi } },
      },
      ...errors4xx,
    },
  });

  // GUI notification panel SSE stream. One per-account stream surfaces
  // every NotificationEvent the server publishes (cost.threshold_alert
  // today). No JSON body — text/event-stream frames. No Last-Event-ID
  // resume in v0.1 (the bus is in-memory only).
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/notifications',
    summary: 'Subscribe to the calling account notification event stream (SSE)',
    tags: ['account'],
    security: auth,
    responses: {
      200: {
        description:
          'SSE stream of per-account notification events (text/event-stream). Each frame carries an `event:` discriminator (e.g. cost.threshold_alert) and a JSON `data:` payload; heartbeat comments keep the connection alive.',
        content: {
          'text/event-stream': {
            schema: z.string().openapi('AccountNotificationsStream', {
              description:
                'Server-sent event stream of NotificationEvent frames for the calling account.',
            }),
          },
        },
      },
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
  const AdminSessionStatsResponseSchema = z.object({
    // Count per session status (every status key present, zero-filled).
    by_status: z.record(z.string(), z.number().int().nonnegative()),
    active: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/sessions/stats',
    summary: 'Cross-account session counts by status (admin)',
    tags: ['admin'],
    security: auth,
    responses: {
      200: {
        description: 'Session counts grouped by status, plus active + total.',
        content: { 'application/json': { schema: AdminSessionStatsResponseSchema } },
      },
      ...errors4xx,
    },
  });

  // Overview — aggregate counts the admin-panel index renders.
  const AdminOverviewResponseSchema = z.object({
    accounts: z.object({
      active: z.number().int().nonnegative(),
      suspended: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      // Account count per tier (every AccountTier key present, zero-filled).
      by_tier: z.record(z.string(), z.number().int().nonnegative()),
      // New-signup counts over rolling UTC windows.
      signups: z.object({
        today: z.number().int().nonnegative(),
        last_7d: z.number().int().nonnegative(),
        last_30d: z.number().int().nonnegative(),
      }),
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
        limit: z.number().int().min(1).max(100).optional(),
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
      201: {
        description: 'Note recorded.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      404: {
        description: 'Account not found.',
        content: problemContent,
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
      201: {
        description:
          'Refund recorded for audit. Money movement happens via Stripe dashboard manually per V-280 launch-day runbook.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      404: {
        description: 'Account not found.',
        content: problemContent,
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
    severity: z.enum(['minor', 'major', 'outage']),
    status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
    started_at: z.string(),
    resolved_at: z.string().nullable(),
    components_affected: z.array(z.string()),
    public: z.boolean(),
  });
  const AdminIncidentCreateRequestOpenApi = z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
    severity: z.enum(['minor', 'major', 'outage']),
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
    method: 'get',
    path: '/v1/admin/incidents',
    summary: 'List incidents (admin; V-295)',
    tags: ['admin'],
    security: auth,
    request: {
      query: z.object({
        scope: z
          .enum(['public', 'all'])
          .optional()
          .describe("'public' returns only public incidents; 'all' (default) returns everything."),
        since: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp; filter to incidents started since this time.'),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Incidents (newest first), filtered by scope/since/limit.',
        content: {
          'application/json': {
            schema: z.object({ data: z.array(AdminIncidentResponseOpenApi) }),
          },
        },
      },
      ...errors4xx,
    },
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
      201: {
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
      201: {
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
      body: {
        content: {
          'application/json': {
            schema: SignupRequestSchema,
            example: {
              email: 'you@example.com',
              password: 'use-a-long-unique-passphrase',
              name: 'Acme Inc',
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Verification email sent; account is unverified until /v1/auth/verify-email.',
        content: {
          'application/json': {
            schema: SignupResponseSchema,
            example: { verification_email_expires_at: '2026-06-01T12:00:00Z' },
          },
        },
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
      body: {
        content: {
          'application/json': {
            schema: VerifyEmailRequestSchema,
            example: { token: '7c3f1a9e0b2d4c6f8a1b3d5e7f9c0a2b4d6e8f1a3c5e7d9f' },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Email verified; web session issued.',
        content: {
          'application/json': {
            schema: VerifyEmailResponseSchema,
            example: {
              session: {
                token: 'example-web-session-token-shown-once',
                expires_at: '2026-06-30T12:00:00Z',
                account_id: 'acc_9c8b7a6d-5e4f-3210-abcd-ef0123456789',
              },
            },
          },
        },
      },
      ...errors4xx,
    },
  });
  // S33 2026-07-07 (fable-truth-audit) — #187 self-service verification
  // re-send: live route that was previously absent from the spec.
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/resend-verification',
    summary: 'Re-send the signup verification email; response never confirms account existence',
    tags: ['auth'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: ResendVerificationRequestSchema,
            example: { email: 'you@example.com' },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Accepted. The response shape is identical whether the email matched an unverified account, an already-verified account, or no account at all (the server silently no-ops in the latter two cases — no account-enumeration signal). expires_at is the verification-token expiry.',
        content: {
          'application/json': {
            schema: ResendVerificationResponseSchema,
            example: { sent: true, expires_at: '2026-06-01T12:00:00Z' },
          },
        },
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
      body: {
        content: {
          'application/json': {
            schema: LoginRequestSchema,
            example: { email: 'you@example.com', password: 'use-a-long-unique-passphrase' },
          },
        },
      },
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
      200: {
        description: 'Session revoked.',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
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
  // v2-#26 — dashboard-friendly 302 redirect to the Stripe Customer
  // Portal. The POST /v1/billing/portal-session endpoint above
  // returns the URL as JSON; this GET variant is for direct browser
  // navigation (e.g. a dashboard "Manage subscription" link).
  registerRoute(r, {
    method: 'get',
    path: '/v1/account/me/billing-portal',
    summary: 'Redirect to a one-time Stripe Customer Portal URL (302)',
    tags: ['billing'],
    security: auth,
    responses: {
      302: {
        description: 'Redirects to the Stripe Customer Portal URL via the Location header.',
        headers: {
          Location: {
            description: 'Stripe Customer Portal URL.',
            schema: { type: 'string', format: 'uri' },
          },
        },
      },
      ...errors4xx,
      503: { description: 'Billing not enabled on this deployment.', content: problemContent },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/billing',
    summary: 'Read the calling account billing state (subscription)',
    tags: ['billing'],
    security: auth,
    responses: {
      200: {
        description: 'Subscription row (null when the account has never subscribed).',
        content: { 'application/json': { schema: GetBillingStateResponseSchema } },
      },
      ...errors4xx,
      // S46 2026-07-07 (founder-approved) — read:billing scope floor (the
      // route had no scope gate before; V-481 #122 residual closed).
      403: {
        description:
          'Key lacks the read:billing scope (a broad read or account_owner key satisfies it).',
        content: problemContent,
      },
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
  // NOTE: the legacy /v1/proxies saved-proxies surface is intentionally NOT
  // documented — it's a never-backed 503 stub, superseded by the live
  // account-proxies API (/v1/account/me/proxies, documented above). The
  // routes stay mounted but undocumented until a follow-up retires them.

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
              mode: z.enum(['manual', 'ai', 'pair']).optional(),
              model: AgentModelSchema.optional(),
              // file 57 — attach a saved profile (persistent browser identity).
              // Pass the profile id from the profiles API (prof_<uuid>); a bare
              // uuid is also accepted. Must be owned (unknown/not-owned → 404);
              // omit for a stateless session.
              profile_id: z.string().optional(),
              // ARC A — route the session through an owned account proxy
              // (unknown/not-owned → 404); omit for the default egress.
              proxy_id: z.string().uuid().optional(),
              // Skip the pre-launch live proxy probe for THIS launch (the
              // dispatch-side SSRF re-guard still applies).
              skip_proxy_probe: z.boolean().optional(),
              // Start URL the remote browser opens on launch; absolute http(s)
              // only. Omit → operator default.
              initial_url: z.string().min(1).max(2048).optional(),
              // Explicit geolocation override. Default (omitted) derives the
              // device's location from the proxy exit IP — coherent with the
              // session's apparent network location. Only set this when you
              // know the proxy's true location better than IP geolocation;
              // divergence from the exit country is a fingerprint-consistency
              // risk. accuracy is meters (omit → device default).
              geolocation: z
                .object({
                  latitude: z.number().min(-90).max(90),
                  longitude: z.number().min(-180).max(180),
                  accuracy: z.number().positive().optional(),
                })
                .optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Agent session created; transcript empty + full budget remaining.',
        content: { 'application/json': { schema: AgentSessionSchema } },
      },
      ...errors4xx,
      // S42 2026-07-07 (founder-approved) — V-485 aiAgent tier gate: mode
      // ai (the default) / pair requires the AI-agent feature on the owner
      // tier; mode manual is available on every tier.
      403: {
        description:
          'Caller not permitted — key lacks the write scope, or mode ai/pair was requested on a tier without the AI-agent feature (Free / Personal).',
        content: problemContent,
      },
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/agent-sessions',
    summary: "List the account's agent chat sessions (newest first, capped at 100)",
    tags: ['agent-chat'],
    security: auth,
    responses: {
      200: {
        description: 'Agent sessions for the authenticated account.',
        content: {
          'application/json': { schema: z.object({ data: z.array(AgentSessionSchema) }) },
        },
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
        description: 'Agent session resource.',
        content: { 'application/json': { schema: AgentSessionSchema } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      ...errors4xx,
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });

  // Arc 2 sub-slice 8.3 — SSE transcript stream. text/event-stream, no
  // JSON body. Last-Event-ID resume: the client sends the last entry
  // `index` it saw; the server replays every later entry, then live-
  // streams new appends. Registers only when the transcript event bus
  // is wired deploy-side.
  registerRoute(r, {
    method: 'get',
    path: '/v1/agent-sessions/{id}/transcript',
    summary: 'Stream the agent-session transcript as Server-Sent Events (SSE)',
    tags: ['agent-chat'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description:
          'SSE stream of agent-session transcript events (text/event-stream). Supports Last-Event-ID resume: send the last entry index seen and the server replays subsequent entries before live-streaming new appends.',
        content: {
          'text/event-stream': {
            schema: z.string().openapi('AgentSessionTranscriptStream', {
              description:
                'Server-sent event stream of transcript.entry frames; each frame carries an `id:` (the entry index) and a JSON `data:` payload of { index, entry }.',
            }),
          },
        },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      ...errors4xx,
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
            schema: z.object({
              user_message: z.string().min(1).max(8000),
              // W443/W445 — approve consequential actions flagged on a prior turn.
              approve_consequential_actions: z
                .array(
                  z.object({
                    category: ConsequentialActionCategorySchema,
                    matched_text: z.string().min(1).max(200),
                  }),
                )
                .max(20)
                .optional(),
            }),
            example: { user_message: 'Go to the pricing page and take a screenshot.' },
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
                session: AgentSessionSchema,
                intents: z.array(AgentIntentSchema),
                results: z.array(IntentResultSchema),
                ok: z.boolean(),
              }),
              z.object({
                kind: z.literal('clarify'),
                session: AgentSessionSchema,
                clarifying_question: z.string(),
              }),
              z.object({
                kind: z.literal('refuse'),
                session: AgentSessionSchema,
                refuse_reason: z.string(),
              }),
            ]),
          },
        },
      },
      ...errors4xx,
      404: {
        description: 'Agent session not found (or owned by another account).',
        content: problemContent,
      },
      409: {
        description:
          'Agent session is closed/paused, its transcript capacity is exhausted, or another turn is already running for this session.',
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

  // ── Arc 2 sub-slice 8.9 (v2-#8) — pair-mode takeover + handback ──
  //
  // For mode='pair' agent sessions only — these endpoints return 409 on
  // non-pair sessions. State machine carries through 'takeover-queued' /
  // 'handback-queued' intermediate states when the runtime is mid-
  // decompose (Wave 2.A 8.11 / 8.12); the wire response reflects the
  // post-transition state so callers branch on `pair_mode_state.kind`.
  const pairModeStateResponseSchema = z.object({
    pair_mode_state: z
      .object({
        kind: z.enum([
          'ai-driving',
          'takeover-pending',
          'takeover-queued',
          'human-driving',
          'handback-pending',
          'handback-queued',
        ]),
      })
      .passthrough(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/takeover',
    summary: 'Request a human takeover on a pair-mode agent session',
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ client_id: z.string().min(1).max(120) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Transition succeeded; returns the post-transition pair-mode state.',
        content: { 'application/json': { schema: pairModeStateResponseSchema } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      409: {
        description:
          'Session not mode=pair, or pair-mode state machine refused the transition (typed problem URI pair-mode-invalid-transition with from + transition extensions).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  // W474 — POST /:id/resume. Resume a session the harness auto-paused on a
  // detected bot-challenge, once the customer has resolved it. Peer to
  // takeover/handback; previously absent from the spec (route + docs existed).
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/resume',
    summary: 'Resume an agent session the harness auto-paused on a detected bot-challenge',
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        required: false,
        content: {
          'application/json': { schema: ResumeSessionRequestSchema },
        },
      },
    },
    responses: {
      202: {
        description:
          'Resume requested. Best-effort dispatch to the node running the session (inert unless the fleet control plane is wired).',
        content: { 'application/json': { schema: ResumeSessionResponseSchema } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      409: {
        description: 'Session is not active; resume requires an active (paused) session.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  // Wave 29-NNN ARC 3 Slice 3 (2026-05-19) — top-level mode setter.
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/mode',
    summary: 'Set the operational mode (manual / ai / pair) on an active agent session',
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ mode: z.enum(['manual', 'ai', 'pair']) }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Returns the post-transition AgentSession (with mode + pair_mode_state updated atomically). Idempotent on same-mode targets.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      409: {
        description: 'Session is not active (cannot change mode on closed/paused).',
        content: problemContent,
      },
      ...errors4xx,
      // S42 follow-up 2026-07-07 — the /mode flip carries the same aiAgent
      // tier gate as create (a manual session must not become LLM-driven
      // on a tier without the feature).
      403: {
        description:
          "Flipping INTO 'ai'/'pair' requires the AI-agent feature on the session owner's tier — same gate as create. Flips to 'manual' are never tier-refused.",
        content: problemContent,
      },
    },
  });

  // Wave 29-NNN ARC 3 Slice 4+5 (2026-05-19/20) — LK.6 InputEvent
  // forward-to-harness + pair-mode takeover-trigger. Slice 6
  // (2026-05-20) — modifier vocabulary documented in description.
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/input-event',
    summary: 'Forward an LK.6 InputEvent to the harness (manual/pair mode only)',
    description:
      "Body shape: { event: <discriminated-union>, client_id?: string }. The `event` object must be one of 12 variants discriminated by `type`: the mouse/key set mouseMove / mouseDown / mouseUp / keyDown / keyUp / wheel / ping, plus the touch set tap / touchStart / touchMove / touchEnd / swipe (device-CSS coordinates; the harness injects via W3C `pointerType:touch` and owns the touch dynamics). See packages/api-types/src/agent-input-event.ts:InputEventSchema for the canonical Zod definition. Modifier vocabulary (keyDown / keyUp `modifiers` array): use the canonical 4-name set 'cmd' | 'ctrl' | 'shift' | 'option' — these map 1:1 onto Quartz CGEventFlags on the macOS harness side. DOM-standard names (Shift / Control / Alt / Meta) round-trip through the schema unchanged but the harness decoder drops them.",
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              event: z.object({}).passthrough(),
              client_id: z.string().min(1).max(128).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Discriminated by 'kind'. 'pair-mode-takeover-fired' (Slice 5 — first input-event in pair-mode ai-driving fires the takeover-request transition) carries pair_mode_state. 'forwarded' (post-harness; today 503s) carries duration_ms.",
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      409: {
        description:
          'Session is in mode=ai (input-event requires manual/pair), OR pair_mode_state is mid-transition (takeover-pending / handback-pending / etc.), OR session is closed. Pair-mode takeover-trigger missing client_id surfaces as 400 via errors4xx.',
        content: problemContent,
      },
      503: {
        description:
          'Pre-harness: forward-to-harness path returns 503 until Mac fleet Swift work lands. Pair-mode takeover-trigger path returns 200.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/handback',
    summary: 'Hand control back from human to AI on a pair-mode agent session',
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        required: false,
        content: { 'application/json': { schema: z.object({}) } },
      },
    },
    responses: {
      200: {
        description: 'Transition succeeded; returns the post-transition pair-mode state.',
        content: { 'application/json': { schema: pairModeStateResponseSchema } },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      409: {
        description:
          'Session not mode=pair, or pair-mode state machine refused the transition (typed problem URI pair-mode-invalid-transition with from + transition extensions).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── S33 2026-07-07 (fable-truth-audit) — live-session control surface ──
  //
  // Seven live-but-previously-unregistered agent-session endpoints: the
  // page-state poll, the cookie-jar read + import pair, the history step,
  // the file upload, and the download list + fetch pair. Each accepts the
  // account bearer (read scope on GETs, broad write on POSTs — same floor
  // the handlers enforce); they additionally accept the per-session
  // gui_control_key the GUI/Simulator holds, which is a GUI-internal
  // channel and not part of the published bearer contract. Apart from
  // page-state, every route returns a DISCRIMINATED 200 body in each
  // relay case (ok / unavailable / timeout / error) so expected-inert
  // states — control plane not wired, session not live on a node, node
  // offline — render as data, not HTTP errors.
  const agentRelayStatus = z.enum(['ok', 'unavailable', 'timeout', 'error']);
  registerRoute(r, {
    method: 'get',
    path: '/v1/agent-sessions/{id}/page-state',
    summary:
      "Poll the agent session's last-reported page state (loading / loaded / errored / stalled)",
    tags: ['agent-chat'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          'The latest page state the session harness reported (the GUI loading bar / error overlay polls this). `page_state` is null when nothing has been reported yet, the cached entry is older than the freshness bound, the session is closed, or the fleet control plane is not wired.',
        content: {
          'application/json': {
            schema: z.object({
              page_state: z
                .object({
                  state: z.enum(['loading', 'loaded', 'errored', 'stalled']),
                  url: z.string().nullable(),
                  title: z.string().nullable(),
                  tabId: z.string().nullable(),
                  error: z.object({ kind: z.string(), message: z.string() }).nullable(),
                })
                .nullable(),
            }),
          },
        },
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
    method: 'get',
    path: '/v1/agent-sessions/{id}/cookies',
    summary: "Read the running session's live cookie jar (includes httpOnly cookies)",
    tags: ['agent-chat'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → `cookies` is the live jar pulled from the running session; 'unavailable' (not live on a node / control plane not wired / node offline), 'timeout' (node did not reply), or 'error' → `cookies` is null and `reason`, when set, says why. The jar shape round-trips 1:1 into POST /v1/agent-sessions/{id}/cookies/set.",
        content: {
          'application/json': {
            schema: z.object({
              cookies: z.array(CookieSchema).nullable(),
              status: agentRelayStatus,
              reason: z.string().optional(),
            }),
          },
        },
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
    path: '/v1/agent-sessions/{id}/cookies/set',
    summary: "Import a cookie jar into the running session's cookie store",
    tags: ['agent-chat'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              // Same Cookie shape the read emits — an exported cookies.json
              // round-trips 1:1. Bounded count per request.
              cookies: z.array(CookieSchema).min(1).max(2000),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → the write was applied to the live session's cookie store; 'unavailable' / 'timeout' / 'error' → nothing was written and `reason`, when set, says why.",
        content: {
          'application/json': {
            schema: z.object({ status: agentRelayStatus, reason: z.string().optional() }),
          },
        },
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
    path: '/v1/agent-sessions/{id}/history',
    summary: "Step the running session's browser history one entry back or forward",
    tags: ['agent-chat'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              direction: z.enum(['back', 'forward']),
              // Optional (multi-tab): which tab's back-forward list to step.
              // Omitted → the session's current tab.
              tabId: z.string().optional(),
            }),
            example: { direction: 'back' },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → the history step was applied; 'unavailable' / 'timeout' / 'error' → the step did not run and `reason`, when set, says why.",
        content: {
          'application/json': {
            schema: z.object({ status: agentRelayStatus, reason: z.string().optional() }),
          },
        },
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
    path: '/v1/agent-sessions/{id}/files',
    summary:
      "Upload a file into the running session's isolated upload area (for driving file inputs)",
    tags: ['agent-chat'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).max(255),
              mime: z.string().min(1).max(255),
              // Base64-encoded file bytes; decoded size capped at 64 MiB
              // (larger → 400). Per-account concurrent and per-session
              // lifetime volume caps apply (over-cap → status 'error').
              dataB64: z.string().min(1),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → `handle` is the opaque { id, name, mime, size } reference used to drive a page's <input type=file> (no worker filesystem path is ever exposed); 'unavailable' / 'timeout' / 'error' → `handle` is null and `reason`, when set, says why (including the per-account concurrent and per-session lifetime upload caps).",
        content: {
          'application/json': {
            schema: z.object({
              handle: z
                .object({
                  id: z.string(),
                  name: z.string(),
                  mime: z.string(),
                  size: z.number(),
                })
                .nullable(),
              status: agentRelayStatus,
              reason: z.string().optional(),
            }),
          },
        },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      ...errors4xx,
      // Override the generic errors4xx 400 with the upload-specific causes
      // (declared after the spread so this description wins).
      400: {
        description: 'Validation failed (malformed body, empty file, or decoded size over 64 MiB).',
        content: problemContent,
      },
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/agent-sessions/{id}/downloads',
    summary: 'List the files pages have downloaded inside the running session',
    tags: ['agent-chat'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → `files` lists the session's downloads (empty array = no downloads yet; `name` is always a bare basename, never a path); 'unavailable' / 'timeout' / 'error' → `files` is null and `reason`, when set, says why.",
        content: {
          'application/json': {
            schema: z.object({
              files: z
                .array(
                  z.object({
                    name: z.string(),
                    size: z.number(),
                    mime: z.string().optional(),
                  }),
                )
                .nullable(),
              status: agentRelayStatus,
              reason: z.string().optional(),
            }),
          },
        },
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
    method: 'get',
    path: '/v1/agent-sessions/{id}/downloads/content',
    summary: "Fetch one downloaded file's bytes (base64) by basename",
    tags: ['agent-chat'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        // A basename from a prior downloads list; re-sanitized + confined
        // to the session's download area server-side (defense in depth).
        name: z.string().min(1).max(255),
      }),
    },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → `file` carries { name, mime, dataB64 } (base64 bytes, 64 MiB cap; mime falls back to application/octet-stream); 'unavailable' / 'timeout' / 'error' (including file not found or too large) → `file` is null and `reason`, when set, says why.",
        content: {
          'application/json': {
            schema: z.object({
              file: z
                .object({
                  name: z.string(),
                  mime: z.string(),
                  dataB64: z.string(),
                })
                .nullable(),
              status: agentRelayStatus,
              reason: z.string().optional(),
            }),
          },
        },
      },
      404: { description: 'Agent session not found.', content: problemContent },
      ...errors4xx,
      503: {
        description: 'AI chat agent not enabled on this deployment.',
        content: problemContent,
      },
    },
  });

  // ── LK arc — per-Mac LiveKit ──
  //
  // LK.3 POST /v1/agent-sessions/:id/livekit-token mints a per-Mac
  // JWT for the gui-client (or any LiveKit subscriber) to connect to
  // the room hosting the agent session's video stream. LK.2 POST
  // /v1/mac-nodes/register persists the per-Mac LiveKit api_key +
  // encrypted secret used by the mint path.
  const LivekitInfoOpenApi = z
    .object({
      ws_url: z.string().url(),
      room: z.string(),
      token: z.string(),
      participant_identity: z.string(),
      expires_at: z.string(),
    })
    .openapi('LiveKitInfo');
  const RegisterMacNodeBodyOpenApi = z
    .object({
      mac_node_id: z.string().uuid(),
      livekit: z.object({
        api_key: z.string().min(1).max(256),
        api_secret: z.string().min(1).max(1024),
        ws_url: z.string().url(),
      }),
    })
    .openapi('RegisterMacNodeRequest');
  const RegisterMacNodeResponseOpenApi = z
    .object({
      mac_node_id: z.string(),
      livekit_registered_at: z.string(),
      ws_url: z.string(),
    })
    .openapi('RegisterMacNodeResponse');
  registerRoute(r, {
    method: 'post',
    path: '/v1/agent-sessions/{id}/livekit-token',
    summary: 'Mint a per-Mac LiveKit JWT for the agent session room (LK.3)',
    tags: ['agent-chat'],
    security: auth,
    responses: {
      200: {
        description:
          'LiveKit join info: ws_url + room + token (24h TTL) + participant_identity + expires_at.',
        content: { 'application/json': { schema: LivekitInfoOpenApi } },
      },
      403: {
        description: 'Cannot mint a token for a non-active agent session.',
        content: problemContent,
      },
      404: { description: 'Agent session not found.', content: problemContent },
      503: {
        description:
          'No Mac in the fleet has registered LiveKit credentials yet, OR the stored secret is unreadable (re-run /v1/mac-nodes/register).',
        content: problemContent,
      },
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/mac-nodes/register',
    summary: 'Register per-Mac LiveKit credentials on the fleet_nodes row (LK.2)',
    tags: ['admin'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: RegisterMacNodeBodyOpenApi } } },
    },
    responses: {
      200: {
        description:
          'Credentials stored. Response never echoes api_key or api_secret (operator-secret).',
        content: { 'application/json': { schema: RegisterMacNodeResponseOpenApi } },
      },
      ...errors4xx,
    },
  });

  // Doc-132 §5.2 (recipe auto-generation) v1.0 slice — GET
  // /v1/agent-sessions/{id}/recipe-suggestion derives a label +
  // description from the session's OWN intent_log so the customer's
  // "Save recipe" dialog can prefill something useful. Deliberately
  // NOT a cross-customer ML/training pipeline (Tier-3 customer-data-
  // handling call, founder-gated) — read-only, single-account, same
  // gate as the rest of the recipe library.
  registerRoute(r, {
    method: 'get',
    path: '/v1/agent-sessions/{id}/recipe-suggestion',
    summary: "Suggest a recipe label/description for an agent session's intent_log",
    tags: ['agent-chat'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          'Deterministic suggestion derived from the flattened intent_log (same assembly POST /v1/recipes uses). Safe to call speculatively before deciding to save.',
        content: {
          'application/json': {
            schema: z.object({
              suggested_label: z.string(),
              suggested_description: z.string(),
              intent_count: z.number().int().nonnegative(),
            }),
          },
        },
      },
      404: {
        description:
          'Agent session not found (also returned for cross-account access — existence is not leaked).',
        content: problemContent,
      },
      ...errors4xx,
      503: {
        description:
          'Recipe library not enabled on this deployment. Requires both recipesRepo + agentSessionsRepo wired in bootstrap.',
        content: problemContent,
      },
    },
  });

  // ── AI-B4 recipe library (write-only at v1.0) ──
  //
  // POST /v1/recipes snapshots a finished agent_session's intent_log
  // + transcript so customers can replay the same flow later without
  // re-paying the LLM decomposition cost. Read / list / execute /
  // delete surfaces are v1.1 D2/D3 scope; only the POST is documented
  // here. Server registers as 503 FeatureUnavailable when either
  // recipesRepo or agentSessionsRepo is missing from AppDeps.
  registerRoute(r, {
    method: 'post',
    path: '/v1/recipes',
    summary: 'Snapshot an agent session as a replayable recipe',
    tags: ['agent-chat'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              // Matches CreateRecipeRequestSchema in routes/recipes.ts;
              // 100-char cap prevents problem+json body bloat on the
              // NotFoundError path.
              agent_session_id: z.string().min(1).max(100),
              label: z.string().min(1).max(120),
              description: z.string().max(2000).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description:
          'Recipe created. The `intent_count` field is the length of the assembled intent_log (flatMap of plan-executed transcript turns).',
        content: { 'application/json': { schema: RecipeSchema } },
      },
      404: {
        description:
          'Agent session not found (also returned for cross-account access — existence is not leaked).',
        content: problemContent,
      },
      ...errors4xx,
      503: {
        description:
          'Recipe library not enabled on this deployment. Requires both recipesRepo + agentSessionsRepo wired in bootstrap.',
        content: problemContent,
      },
    },
  });

  // GET /v1/recipes — list the caller's saved recipes, newest first
  // (V-530.I / D2 read-path). Keyset-paginated (limit + opaque cursor).
  // Recipe EXECUTION stays gated on the harness executor; this is
  // read-only. 503 when the recipe library isn't wired.
  registerRoute(r, {
    method: 'get',
    path: '/v1/recipes',
    summary: 'List saved recipes (newest first, keyset-paginated)',
    tags: ['agent-chat'],
    security: auth,
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description:
          'Page of recipes. Each item is the metadata shape (id, label, description, agent_session_id, intent_count, timestamps) — not the full intent_log. `next_cursor` is null on the last page.',
        content: { 'application/json': { schema: PaginatedRecipesSchema } },
      },
      ...errors4xx,
      503: {
        description:
          'Recipe library not enabled on this deployment. Requires both recipesRepo + agentSessionsRepo wired in bootstrap.',
        content: problemContent,
      },
    },
  });

  // GET /v1/recipes/:id — fetch one recipe with its public intent_log.
  // Sensitive type values stay encrypted server-side and are omitted from the
  // response. V-530.J / D2. 404 on missing/cross-account (existence not leaked).
  registerRoute(r, {
    method: 'get',
    path: '/v1/recipes/{id}',
    summary: 'Fetch a saved recipe with its public intent_log',
    tags: ['agent-chat'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          'The recipe plus its ordered `intent_log`. Sensitive type steps retain `sensitive: true`, selector, and order but omit the optional `value`; exact replay values stay encrypted server-side.',
        content: { 'application/json': { schema: RecipeDetailSchema } },
      },
      404: {
        description: 'Recipe not found (also returned cross-account — existence is not leaked).',
        content: problemContent,
      },
      ...errors4xx,
      503: {
        description:
          'Recipe library not enabled on this deployment. Requires both recipesRepo + agentSessionsRepo wired in bootstrap.',
        content: problemContent,
      },
    },
  });

  // DELETE /v1/recipes/:id — delete one recipe. V-530.J / D3. `write`
  // scope (mutation). 204 on success; 404 on missing/cross-account.
  registerRoute(r, {
    method: 'delete',
    path: '/v1/recipes/{id}',
    summary: 'Delete a saved recipe',
    tags: ['agent-chat'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Recipe deleted. No content.' },
      404: {
        description: 'Recipe not found (also returned cross-account — existence is not leaked).',
        content: problemContent,
      },
      ...errors4xx,
      503: {
        description:
          'Recipe library not enabled on this deployment. Requires both recipesRepo + agentSessionsRepo wired in bootstrap.',
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
      'Fleet-node WebSocket event stream (operator-only; mTLS + signed Ed25519 JWT at handshake; customer API keys have no role here)',
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
          'Fleet events stream not yet implemented. Both the AppDeps-wired path and the activation-gate-off path return 503 — the WebSocket handler + Cloudflare AOP + fleet_nodes SQL migration are pending. This endpoint is operator-only (fleet nodes auth via mTLS); customer API keys have no role here.',
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
  // Caps below MUST mirror apps/server/src/routes/billing-crypto-orders.ts
  // ListQuery + GetParams (slice 117 defensive caps). Drift between
  // the openapi.ts shadow and the route schema is what slice 120
  // closed for the OAuth surface; this fixes the same drift for the
  // customer billing-crypto-orders surface.
  const BillingCryptoOrderIdOpenApi = z
    .string()
    .min(1)
    .max(100)
    .describe('Order id (ord_<12-hex-chars>, e.g. ord_a1b2c3d4e5f6; capped at 100 chars).');
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
        // prior page's next_cursor. 512 cap matches the route's
        // ListQuery.cursor cap.
        cursor: z
          .string()
          .min(1)
          .max(512)
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
      params: z.object({ order_id: BillingCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: BillingCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: BillingCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: BillingCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: BillingCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: BillingCryptoOrderIdOpenApi }),
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
  //
  // Caps below MUST mirror apps/server/src/routes/admin-crypto-orders.ts
  // ListQuery + GetParams (slice 117 defensive caps). Same shadow-vs-
  // route drift fix as slice 123 for the customer billing surface.
  const AdminCryptoOrderIdOpenApi = z
    .string()
    .min(1)
    .max(100)
    .describe('Order id (ord_<12-hex-chars>, e.g. ord_a1b2c3d4e5f6; capped at 100 chars).');
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/crypto-orders',
    summary: 'List crypto orders across all accounts (admin)',
    tags: ['admin', 'crypto'],
    security: auth,
    request: {
      query: z.object({
        account_id: z.string().min(1).max(100).optional(),
        status: z
          .enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'])
          .optional(),
        search: z.string().min(1).max(200).optional(),
        payment_id: z.string().min(1).max(128).optional().describe('Exact-match reverse lookup.'),
        limit: z.string().optional(),
        cursor: z.string().min(1).max(512).optional().describe('Opaque cursor from a prior page.'),
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
      params: z.object({ order_id: AdminCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: AdminCryptoOrderIdOpenApi }),
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
      params: z.object({ order_id: AdminCryptoOrderIdOpenApi }),
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
    path: '/v1/admin/billing/subscriptions/stats',
    summary: 'Active-subscription distribution by tier (paying-customer mix)',
    tags: ['admin', 'billing'],
    security: auth,
    responses: {
      200: {
        description:
          'Active-subscription count by tier + total active (status in active/trialing).',
        content: {
          'application/json': {
            schema: z
              .object({
                by_tier: z.record(z.string(), z.number().int().nonnegative()),
                total_active: z.number().int().nonnegative(),
              })
              .openapi('AdminSubscriptionStatsResponse'),
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/owner/platform-status',
    summary: 'Owner-only: which activation-gated features are wired in this deployment',
    tags: ['admin', 'owner'],
    security: auth,
    responses: {
      200: {
        description:
          'Boolean activation flags (no secrets) — billing/livekit/crypto/oauth/sentry/CORS.',
        content: {
          'application/json': {
            schema: z
              .object({
                features: z.object({
                  billing: z.boolean(),
                  livekit: z.boolean(),
                  crypto: z.boolean(),
                  oauth_client: z.boolean(),
                  sentry: z.boolean(),
                  permissive_cors: z.boolean(),
                }),
              })
              .openapi('OwnerPlatformStatusResponse'),
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/admin/owner/pricing',
    summary:
      'Owner-only: current per-tier monthly pricing (read-only foundation for editable pricing)',
    tags: ['admin', 'owner'],
    security: auth,
    responses: {
      200: {
        description:
          'Per-tier monthly price in cents (the source crypto-checkout/cost-caps/display derive from).',
        content: {
          'application/json': {
            schema: z
              .object({
                tiers: z.array(
                  z.object({
                    tier: z.string(),
                    monthly_cents: z.number().int().nonnegative(),
                  }),
                ),
              })
              .openapi('OwnerPricingResponse'),
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/admin/owner/pricing/{tier}',
    summary: "Owner-only: edit a tier's monthly price (pricing-as-data; audited)",
    tags: ['admin', 'owner'],
    security: auth,
    request: {
      params: z.object({
        tier: z
          .string()
          .describe('Paid tier slug (e.g. api_scale). Free/unpriced tiers are rejected.'),
      }),
      body: {
        content: {
          'application/json': {
            schema: z
              .object({ monthly_cents: z.number().int().positive().max(1_000_000) })
              .openapi('OwnerPricingEditRequest'),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Updated tier price. Reflected by the owner pricing view AND the crypto-checkout charge.',
        content: {
          'application/json': {
            schema: z
              .object({ tier: z.string(), monthly_cents: z.number().int().nonnegative() })
              .openapi('OwnerPricingEditResponse'),
          },
        },
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
        days: z.string().optional().describe('Defaults to 7; max 90.'),
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
        account_id: z.string().min(1).max(100).optional(),
        status: z
          .enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'])
          .optional(),
        search: z.string().min(1).max(200).optional(),
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
      params: z.object({ order_id: AdminCryptoOrderIdOpenApi }),
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
      body: {
        content: {
          'application/json': {
            schema: MagicLinkRequestSchema,
            example: { email: 'you@example.com' },
          },
        },
      },
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
    summary: 'Exchange a magic-link token for a session or MFA challenge',
    tags: ['auth'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: MagicLinkConsumeRequestSchema,
            example: { token: '7c3f1a9e0b2d4c6f8a1b3d5e7f9c0a2b4d6e8f1a3c5e7d9f' },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Session issued, or an MFA challenge returned when the account has MFA.',
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
      body: {
        content: {
          'application/json': {
            schema: PasswordResetRequestSchema,
            example: { email: 'you@example.com' },
          },
        },
      },
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
    summary: 'Consume a password-reset token and set a new password',
    tags: ['auth'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: PasswordResetConfirmRequestSchema,
            example: {
              token: '7c3f1a9e0b2d4c6f8a1b3d5e7f9c0a2b4d6e8f1a3c5e7d9f',
              new_password: 'use-a-long-unique-passphrase',
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Password updated; a session is issued unless the account must complete MFA first.',
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
    summary: 'Start CLI/GUI activation; returns a device user code + browser URL',
    tags: ['auth'],
    request: {
      body: { content: { 'application/json': { schema: CliAuthorizeInitiateRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'Opaque activation code, separate device-displayed user code, and browser URL. Codes expire after ~5min.',
        content: { 'application/json': { schema: CliAuthorizeInitiateResponseSchema } },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/auth/cli-authorize/bind-device-code',
    summary: 'Verify the device user code and bind activation to the calling web session',
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
      404: {
        description: 'Sign-in session not found (or owned by another account).',
        content: problemContent,
      },
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
  // All three routes reply with a human-readable `message` (the route impls
  // return `{ message }`, never `{ ok }`).
  const StatusSubscribeResponseOpenApi = z.object({
    message: z.string(),
  });
  // confirm + unsubscribe carry the opaque token as a query param on a GET
  // (the link in the email is a plain click), not a JSON request body.
  const StatusTokenQueryOpenApi = z.object({
    token: z.string().describe('Opaque token from the confirm/unsubscribe email link.'),
  });
  // Exit-IP echo for device-side proxy probes (proxy-probe design step 1).
  // Unauthenticated by design; IP-rate-limited.
  registerRoute(r, {
    method: 'get',
    path: '/v1/egress/echo',
    summary: 'Echo the caller exit IP (+ best-effort CF-edge geo) — proxy-probe support',
    tags: ['egress'],
    responses: {
      200: {
        description:
          'The IP + best-effort geo (CF-edge country/region/city/timezone, each null when unknown) this request arrived from.',
        content: {
          'application/json': {
            schema: z.object({
              ip: z.string(),
              country: z.string().nullable(),
              region: z.string().nullable(),
              city: z.string().nullable(),
              timezone: z.string().nullable(),
            }),
          },
        },
      },
    },
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
      202: {
        description: 'Confirmation email sent (always 202 — no enumeration signal).',
        content: { 'application/json': { schema: StatusSubscribeResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/status/subscribe/confirm',
    summary: 'Confirm a status-subscription email via token',
    tags: ['status'],
    request: {
      query: StatusTokenQueryOpenApi,
    },
    responses: {
      200: {
        description: 'Subscription confirmed.',
        content: { 'application/json': { schema: StatusSubscribeResponseOpenApi } },
      },
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/status/subscribe/unsubscribe',
    summary: 'Unsubscribe an email from status notifications via token',
    tags: ['status'],
    request: {
      query: StatusTokenQueryOpenApi,
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
    operationId: 'createWebhook',
    summary: 'Create a webhook endpoint',
    tags: ['webhooks'],
    security: auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: CreateWebhookRequestSchema,
            example: {
              url: 'https://example.com/driftstack/webhooks',
              events: ['session.completed', 'session.failed'],
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Created endpoint; plaintext signing secret returned ONCE.',
        content: {
          'application/json': {
            schema: CreateWebhookResponseSchema,
            example: {
              id: 'whk_2b1c3d4e-5f60-7a8b-9c0d-1e2f3a4b5c6d',
              url: 'https://example.com/driftstack/webhooks',
              secret_prefix: 'whsec_v1_2b1c',
              prev_secret_prefix: null,
              rotation_grace_expires_at: null,
              events: ['session.completed', 'session.failed'],
              description: 'Production webhook endpoint',
              active: true,
              consecutive_failures: 0,
              last_success_at: null,
              last_failure_at: null,
              disabled_at: null,
              delivery_counts: { delivered: 0, failed: 0, dlq: 0 },
              created_at: '2026-05-31T12:00:00Z',
              secret: 'whsec_v1_exampleexampleexampleexampleexample',
            },
          },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/webhooks',
    operationId: 'listWebhooks',
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
    operationId: 'getWebhook',
    summary: 'Get a single webhook endpoint',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Endpoint.',
        content: {
          'application/json': {
            schema: WebhookEndpointSchema,
            example: {
              id: 'whk_2b1c3d4e-5f60-7a8b-9c0d-1e2f3a4b5c6d',
              url: 'https://example.com/driftstack/webhooks',
              secret_prefix: 'whsec_v1_2b1c',
              prev_secret_prefix: null,
              rotation_grace_expires_at: null,
              events: ['session.completed', 'session.failed'],
              description: 'Production webhook endpoint',
              active: true,
              consecutive_failures: 0,
              last_success_at: '2026-05-31T09:30:00Z',
              last_failure_at: null,
              disabled_at: null,
              delivery_counts: { delivered: 1284, failed: 3, dlq: 0 },
              created_at: '2026-05-20T08:00:00Z',
            },
          },
        },
      },
      404: {
        description: 'Webhook endpoint not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/webhooks/{id}',
    operationId: 'updateWebhook',
    summary: 'Partial update of a webhook endpoint (url / events / description / active)',
    tags: ['webhooks'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: UpdateWebhookRequestSchema,
            example: { url: 'https://example.com/driftstack/webhooks/v2' },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Updated endpoint.',
        content: { 'application/json': { schema: WebhookEndpointSchema } },
      },
      404: {
        description: 'Webhook endpoint not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/webhooks/{id}',
    operationId: 'deleteWebhook',
    summary: 'Disable (soft-delete) a webhook endpoint. Idempotent.',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Endpoint disabled.' },
      404: {
        description: 'Webhook endpoint not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/webhooks/{id}/deliveries',
    operationId: 'listWebhookDeliveries',
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
      404: {
        description: 'Webhook endpoint not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── V-356 webhook test-delivery + V-359 secret rotation ────────────────
  registerRoute(r, {
    method: 'post',
    path: '/v1/webhooks/{id}/test',
    operationId: 'testWebhook',
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
      404: {
        description: 'Webhook endpoint not found (or owned by another account).',
        content: problemContent,
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
    operationId: 'rotateWebhookSecret',
    summary: 'Rotate the signing secret with a 24h grace (worker dual-signs during grace)',
    tags: ['webhooks'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Fresh plaintext shown ONCE; prev secret stays valid for 24h.',
        content: {
          'application/json': {
            schema: RotateSecretResponseOpenApi,
            example: {
              id: 'whk_2b1c3d4e-5f60-7a8b-9c0d-1e2f3a4b5c6d',
              secret: 'whsec_v1_exampleexampleexampleexamplerotate',
              secret_prefix: 'whsec_v1_9f8e',
              prev_secret_prefix: 'whsec_v1_2b1c',
              grace_expires_at: '2026-06-01T12:00:00Z',
            },
          },
        },
      },
      404: {
        description: 'Webhook endpoint not found (or owned by another account).',
        content: problemContent,
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
    operationId: 'createProfile',
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
      409: {
        description: 'A profile with this name already exists in the account.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles',
    operationId: 'listProfiles',
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
    operationId: 'getProfile',
    summary: 'Get a single profile',
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Profile.',
        content: { 'application/json': { schema: ProfileSchema } },
      },
      404: {
        description: 'Profile not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  // 2026-05-20 — one-shot "launch this profile" verb. Equivalent to
  // POST /v1/sessions with { profile_id, archetype: <profile.archetype> }
  // but saves a round-trip + name-lookup. Optional body override (label);
  // everything else comes from the profile. Returns the created session
  // (201). Requires write:sessions. The handler lives in routes/sessions.ts.
  // 2026-07-01 — dropped `proxy`: it was never wired through (the SDKs'
  // launch() had the identical dead field, removed the same day) - per-
  // session customer-configurable egress isn't available on this resource.
  const LaunchProfileRequestOpenApi = z
    .object({
      label: z.string().optional(),
    })
    .openapi('LaunchProfileRequest');
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/launch',
    operationId: 'launchProfile',
    summary: 'Launch a session from a saved profile (one-shot profile verb)',
    tags: ['profiles'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: LaunchProfileRequestOpenApi } } },
    },
    responses: {
      201: {
        description: 'Session created from the profile.',
        content: { 'application/json': { schema: CreateSessionResponseSchema } },
      },
      404: {
        description: 'Profile not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'patch',
    path: '/v1/profiles/{id}',
    operationId: 'updateProfile',
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
      404: {
        description: 'Profile not found (or owned by another account).',
        content: problemContent,
      },
      409: {
        description: 'The requested name is already taken by another profile in the account.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/profiles/{id}',
    operationId: 'deleteProfile',
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
    // doc-150 item 5 — per-profile sealed-store size + last save-back time.
    size_bytes: z.number().int().nonnegative().nullable(),
    last_saved_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/clone',
    operationId: 'cloneProfile',
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
      404: {
        description: 'Source profile not found (or owned by another account).',
        content: problemContent,
      },
      409: {
        description: 'The explicit clone name is already taken in the account.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── L4b recycle bin (soft delete → trash → restore / purge) ────────────
  const TrashedProfileOpenApi = ProfileResponseOpenApi.extend({
    // Set for a trashed profile (the moment it was soft-deleted); null on a
    // live profile. The trash list only ever returns non-null values.
    deleted_at: z.string().nullable(),
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles/trash',
    operationId: 'listTrashedProfiles',
    summary: 'List trashed (soft-deleted) profiles, newest-deleted first',
    tags: ['profiles'],
    security: auth,
    responses: {
      200: {
        description: 'Trashed profiles. Each carries a non-null deleted_at.',
        content: {
          'application/json': { schema: z.object({ data: z.array(TrashedProfileOpenApi) }) },
        },
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/restore',
    operationId: 'restoreProfile',
    summary: 'Restore a trashed profile (clears deleted_at; returns it to the live list)',
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'The restored profile.',
        content: { 'application/json': { schema: ProfileResponseOpenApi } },
      },
      404: {
        description: 'No trashed profile with that id (or owned by another account).',
        content: problemContent,
      },
      409: {
        description: 'A live profile already holds the name — rename it, then retry.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/profiles/{id}/purge',
    operationId: 'purgeProfile',
    summary: 'Permanently delete a trashed profile, freeing its tier-cap slot (irreversible)',
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Trashed profile permanently deleted.' },
      404: {
        description: 'No trashed profile with that id (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── V-480 profile export / import (data portability) ───────────────────
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles/{id}/export',
    operationId: 'exportProfile',
    summary: 'Export a profile as a versioned JSON envelope (metadata-only)',
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Versioned export envelope (re-import via POST /v1/profiles/import).',
        content: { 'application/json': { schema: ProfileExportEnvelopeSchema } },
      },
      404: {
        description: 'Profile not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/import',
    operationId: 'importProfile',
    summary: 'Import a profile from a v1 export envelope (mints a fresh profile)',
    tags: ['profiles'],
    security: auth,
    request: {
      body: { content: { 'application/json': { schema: ProfileImportRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Imported profile (a fresh id is minted in the caller account).',
        content: { 'application/json': { schema: ProfileResponseOpenApi } },
      },
      409: {
        description:
          'A profile with the imported name already exists; pass name_override to rename.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  // 2026-05-22 — V-666 transfer ownership of a profile to another account
  // by id (the recipient shares their acc_<uuid> out-of-band).
  const TransferProfileRequestOpenApi = z.object({
    recipient_account_id: z.string().describe('Recipient account id (acc_<uuid>).'),
  });
  const TransferProfileResponseOpenApi = z.object({
    new_profile: ProfileResponseOpenApi,
    recipient_account_id: z.string(),
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/transfer',
    operationId: 'transferProfile',
    summary: 'Transfer profile ownership to another Driftstack account by id',
    tags: ['profiles'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: TransferProfileRequestOpenApi,
            example: { recipient_account_id: 'acc_9c8b7a6d-5e4f-3210-abcd-ef0123456789' },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Profile transferred; a fresh profile is minted in the recipient account.',
        content: { 'application/json': { schema: TransferProfileResponseOpenApi } },
      },
      404: {
        description: 'Profile not found, or recipient account does not exist.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });

  // ── S33 2026-07-07 (fable-truth-audit) — profile storage trim ──────────
  // doc-150 §8 storage cleanup: live route (write:profiles) that was
  // previously absent from the spec. Discriminated 200 body in every
  // case, mirroring the agent-session relay routes.
  registerRoute(r, {
    method: 'post',
    path: '/v1/profiles/{id}/trim',
    operationId: 'trimProfile',
    summary:
      "Trim a profile's re-fetchable caches to reclaim storage (cookies / localStorage / IndexedDB / tabs are kept)",
    tags: ['profiles'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          "Discriminated body: status 'ok' → the trim ran and the smaller size was persisted ({ size_bytes, bytes_reclaimed }); 'unavailable' → nothing ran (profile in use by a running session, no saved state to trim yet, storage/fleet not enabled, or no node connected — `reason` says which); 'timeout' → the node did not reply; 'error' → the node reported a failure (`reason` set) and the stored state is untouched.",
        content: {
          'application/json': {
            schema: z.union([
              z.object({
                status: z.literal('ok'),
                size_bytes: z.number().int().nonnegative(),
                bytes_reclaimed: z.number().int().nonnegative(),
              }),
              z.object({
                status: z.enum(['unavailable', 'timeout', 'error']),
                reason: z.string().optional(),
              }),
            ]),
          },
        },
      },
      404: {
        description: 'Profile not found (or owned by another account).',
        content: problemContent,
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
    operationId: 'captureSnapshot',
    summary: 'Capture an immutable point-in-time snapshot of the profile',
    tags: ['profiles', 'snapshots'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: CaptureSnapshotRequestOpenApi,
            example: {
              label: 'before-viewport-tweak',
              description: 'Snapshot taken before changing the device profile.',
            },
          },
        },
      },
    },
    responses: {
      // S46 2026-07-07 (founder-approved) — 201 Created, matching the route
      // (reply.code(201)) and every sibling create-POST. The spec said 200
      // while the route also returned 200; both moved together.
      201: {
        description: 'Snapshot captured.',
        content: { 'application/json': { schema: SnapshotResponseOpenApi } },
      },
      404: {
        description: 'Profile not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'get',
    path: '/v1/profiles/{id}/snapshots',
    operationId: 'listProfileSnapshots',
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
    operationId: 'listSnapshots',
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
    operationId: 'getSnapshot',
    summary: 'Single snapshot by id',
    tags: ['snapshots'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Snapshot.',
        content: { 'application/json': { schema: SnapshotResponseOpenApi } },
      },
      404: {
        description: 'Snapshot not found (or owned by another account).',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'post',
    path: '/v1/profile-snapshots/{id}/restore',
    operationId: 'restoreSnapshot',
    summary: 'Create a new profile from a snapshot (tier-cap + name-conflict checked)',
    tags: ['snapshots', 'profiles'],
    security: auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: RestoreSnapshotRequestOpenApi,
            example: { name: 'mobile-shopper-restored' },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'New profile created from snapshot.',
        content: { 'application/json': { schema: ProfileResponseOpenApi } },
      },
      404: {
        description: 'Snapshot not found (or owned by another account).',
        content: problemContent,
      },
      409: {
        description: 'A profile with the requested name already exists in the account.',
        content: problemContent,
      },
      ...errors4xx,
    },
  });
  registerRoute(r, {
    method: 'delete',
    path: '/v1/profile-snapshots/{id}',
    operationId: 'deleteSnapshot',
    summary: 'Hard-delete a snapshot',
    tags: ['snapshots'],
    security: auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Snapshot deleted.' },
      404: {
        description: 'Snapshot not found (or owned by another account).',
        content: problemContent,
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
    servers: [{ url: 'https://api.driftstack.dev', description: 'Production' }],
  });
  return cached;
}

/** Test-only: clear the memoised spec so a re-call regenerates. */
export function _clearSpecCache(): void {
  cached = null;
}
