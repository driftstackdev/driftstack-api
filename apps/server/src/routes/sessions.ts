// Session routes — eight endpoints under /v1/sessions.
//
// Every route:
//   - is auth-gated via app.requireAuth
//   - is rate-limited via app.rateLimit('global'), session-create gets a
//     dedicated bucket (sessions:create) for tighter throttling
//   - parses request body/params/query through Zod schemas in @driftstack/api-types
//   - returns the public session shape (account/key ids prefixed, internal
//     fields like driver_session_id stripped)
//   - delegates to SessionsService for business logic
//
// Public id format: `acc_<uuid>`, `key_<uuid>`, `ses_<uuid>`. The route
// layer is the prefix-conversion boundary; service + DB use raw uuids.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CaptureRequestSchema,
  CreateSessionRequestSchema,
  InteractRequestSchema,
  NavigateRequestSchema,
  PaginationQuerySchema,
  WaitRequestSchema,
} from '@driftstack/api-types';
import type { SessionRecord, SessionsService } from '../services/sessions.js';
import { BadRequestError } from '../lib/errors.js';

// ───────────────────────────────────────────────────────────────────────────
// ID helpers
// ───────────────────────────────────────────────────────────────────────────

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function prefixId(prefix: string, uuid: string): string {
  return `${prefix}_${uuid}`;
}

function publicSession(s: SessionRecord): Record<string, unknown> {
  return {
    id: prefixId('ses', s.id),
    account_id: prefixId('acc', s.accountId),
    api_key_id: prefixId('key', s.apiKeyId),
    status: s.status,
    archetype: s.archetype,
    label: s.label,
    metadata: s.metadata,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    last_state_at: s.lastStateAt ? s.lastStateAt.toISOString() : null,
    destroyed_at: s.destroyedAt ? s.destroyedAt.toISOString() : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Plugin
// ───────────────────────────────────────────────────────────────────────────

export interface SessionRoutesOptions {
  service: SessionsService;
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) {
    // Should be unreachable — preHandler ensures auth ran.
    throw new Error('account context missing after requireAuth');
  }
  return request.account;
}

export function registerSessionRoutes(app: FastifyInstance, opts: SessionRoutesOptions): void {
  const { service } = opts;

  // ── POST /v1/sessions ──────────────────────────────────────────────────
  app.post(
    '/v1/sessions',
    {
      preHandler: [app.requireAuth, app.rateLimit('sessions:create')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(request);
      const body = CreateSessionRequestSchema.parse(request.body ?? {});
      const session = await service.create(ctx, body);
      return reply.code(201).send(publicSession(session));
    },
  );

  // ── GET /v1/sessions ───────────────────────────────────────────────────
  app.get(
    '/v1/sessions',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request: FastifyRequest) => {
      const ctx = requireCtx(request);
      const query = PaginationQuerySchema.parse(request.query ?? {});
      const page = await service.list(ctx, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return {
        data: page.items.map(publicSession),
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      };
    },
  );

  // ── POST /v1/sessions/:id/navigate ─────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/navigate',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = NavigateRequestSchema.parse(request.body ?? {});
      const result = await service.navigate(ctx, id, body);
      return {
        url: result.url,
        final_url: result.finalUrl,
        status: result.status,
        duration_ms: result.durationMs,
      };
    },
  );

  // ── POST /v1/sessions/:id/interact ─────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/interact',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = InteractRequestSchema.parse(request.body ?? {});
      const result = await service.interact(ctx, id, body);
      return { ok: true as const, duration_ms: result.durationMs };
    },
  );

  // ── POST /v1/sessions/:id/wait ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/wait',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = WaitRequestSchema.parse(request.body ?? {});
      const result = await service.wait(ctx, id, body);
      return { satisfied: result.satisfied, duration_ms: result.durationMs };
    },
  );

  // ── GET /v1/sessions/:id/state ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/state',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const state = await service.getState(ctx, id);
      return {
        url: state.url,
        title: state.title,
        cookies: state.cookies,
        local_storage: state.localStorage,
        captured_at: state.capturedAt.toISOString(),
      };
    },
  );

  // ── POST /v1/sessions/:id/capture ──────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/capture',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = CaptureRequestSchema.parse(request.body ?? {});
      const result = await service.capture(ctx, id, body);
      return {
        kind: result.kind,
        data: result.data,
        encoding: result.encoding,
        byte_size: result.byteSize,
        duration_ms: result.durationMs,
      };
    },
  );

  // ── DELETE /v1/sessions/:id ────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/v1/sessions/:id',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      await service.destroy(ctx, id);
      return reply.code(204).send();
    },
  );
}
