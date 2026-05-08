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
import { GUIInputRequestSchema } from '../schemas/gui-input.js';
import { BadRequestError, ForbiddenError } from '../lib/errors.js';
import type { AccountAuthRepo } from '../services/auth.js';
import { resolveEffectiveAccount } from '../services/auth.js';

const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';

function readEffectiveAccountHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[EFFECTIVE_ACCOUNT_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

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
    purpose: s.purpose,
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
  /**
   * V-326e1 — needed to look up the OWNER's account row (for tier
   * resolution) when a team member creates a session via
   * X-Driftstack-Account.
   */
  authRepo: AccountAuthRepo;
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) {
    // Should be unreachable — preHandler ensures auth ran.
    throw new Error('account context missing after requireAuth');
  }
  return request.account;
}

export function registerSessionRoutes(app: FastifyInstance, opts: SessionRoutesOptions): void {
  const { service, authRepo } = opts;

  // ── POST /v1/sessions ──────────────────────────────────────────────────
  // V-326e1 — when X-Driftstack-Account is set, the new session is
  // created on the OWNER's account. Caller's role MUST be 'admin' on
  // that team (Q1 verdict — member is read-only on writes); 'member'
  // role gets 403. Tier-derived concurrent cap uses the OWNER's tier.
  app.post(
    '/v1/sessions',
    {
      preHandler: [app.requireAuth, app.rateLimit('sessions:create')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(request);
      const body = CreateSessionRequestSchema.parse(request.body ?? {});
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      if (effective.kind === 'team') {
        if (effective.role !== 'admin') {
          throw new ForbiddenError(
            'Creating a session on a team owner requires admin role on that team.',
          );
        }
        const owner = await authRepo.getAccount(effective.accountId);
        if (!owner) {
          throw new ForbiddenError('Owner account no longer exists.');
        }
        const session = await service.create(ctx, body, {
          effectiveAccountId: owner.id,
          effectiveTier: owner.tier,
        });
        return reply.code(201).send(publicSession(session));
      }
      const session = await service.create(ctx, body);
      return reply.code(201).send(publicSession(session));
    },
  );

  // ── GET /v1/sessions ───────────────────────────────────────────────────
  // V-326d — honors X-Driftstack-Account: a team member with a valid
  // membership on the requested owner sees the owner's sessions.
  // Without the header (or with the caller's own account id), behaves
  // identically to pre-V-326d.
  app.get(
    '/v1/sessions',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request: FastifyRequest) => {
      const ctx = requireCtx(request);
      const query = PaginationQuerySchema.parse(request.query ?? {});
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const page = await service.list(ctx, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {}),
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

  // ── POST /v1/sessions/:id/gui-input ────────────────────────────────────
  // GUI-control plane (L-001). Coordinate-level primitives that bypass
  // the behavioral simulation layer. Gated behind `gui_control` scope —
  // customer keys never carry this; only enterprise self-hosted GUI
  // keys do. See docs/locked-decisions.md.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/gui-input',
    {
      preHandler: [app.requireAuth, app.requireScope('gui_control'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = GUIInputRequestSchema.parse(request.body ?? {});
      const result = await service.guiInput(ctx, id, body);
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
  // V-326e2 — admin-only when targeting an owner via X-Driftstack-
  // Account; member role gets 403. Self-account behavior unchanged.
  app.delete<{ Params: { id: string } }>(
    '/v1/sessions/:id',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(
          'Destroying a session on a team owner requires admin role on that team.',
        );
      }
      await service.destroy(
        ctx,
        id,
        effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {},
      );
      return reply.code(204).send();
    },
  );
}
