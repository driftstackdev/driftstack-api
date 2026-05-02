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
  ApiKeySchema,
  CaptureRequestSchema,
  CaptureResponseSchema,
  CreateApiKeyRequestSchema,
  CreateApiKeyResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  InteractRequestSchema,
  InteractResponseSchema,
  NavigateRequestSchema,
  NavigateResponseSchema,
  PaginationQuerySchema,
  ProblemSchema,
  SessionSchema,
  UsagePeriodSummarySchema,
  WaitRequestSchema,
  WaitResponseSchema,
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

  // Reusable schemas
  r.register('Account', AccountSchema);
  r.register('ApiKey', ApiKeySchema);
  r.register('Session', SessionSchema);
  r.register('Problem', ProblemSchema);
  r.register('UsagePeriodSummary', UsagePeriodSummarySchema);

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
