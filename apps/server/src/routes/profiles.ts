// Profile routes — five endpoints under /v1/profiles (V-081).
//
//   POST   /v1/profiles       — create (tier-limit enforced)
//   GET    /v1/profiles       — list (cursor pagination)
//   GET    /v1/profiles/:id   — get one
//   PATCH  /v1/profiles/:id   — partial update (name, description)
//   DELETE /v1/profiles/:id   — delete
//
// Auth-gated via app.requireAuth + app.rateLimit('global'). Public id
// format: `prof_<uuid>` — same prefix-conversion convention as
// sessions.ts.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateProfileRequestSchema,
  PaginationQuerySchema,
  UpdateProfileRequestSchema,
} from '@driftstack/api-types';
import type { ProfileRecord, ProfilesService } from '../services/profiles.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import { resolveEffectiveAccount } from '../services/auth.js';

const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';

function readEffectiveAccountHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[EFFECTIVE_ACCOUNT_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

const PROFILE_ID_RE = /^prof_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromProfileId(value: string): string {
  const match = PROFILE_ID_RE.exec(value);
  if (!match || !match[1]) {
    throw new BadRequestError('Invalid id format. Expected "prof_<uuid>".');
  }
  return match[1];
}

function publicProfile(p: ProfileRecord): Record<string, unknown> {
  return {
    id: `prof_${p.id}`,
    name: p.name,
    archetype: p.archetype,
    description: p.description,
    last_used_at: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export interface ProfileRoutesDeps {
  service: ProfilesService;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRoutesDeps): void {
  const { service } = deps;

  // ── POST /v1/profiles ────────────────────────────────────────────────
  app.post(
    '/v1/profiles',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = CreateProfileRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const profile = await service.create({
        accountId: ctx.account.id,
        tier: ctx.account.tier,
        name: parsed.data.name,
        ...(parsed.data.archetype !== undefined ? { archetype: parsed.data.archetype } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
      return publicProfile(profile);
    },
  );

  // ── GET /v1/profiles ─────────────────────────────────────────────────
  // V-330 — honors X-Driftstack-Account: a team member with a valid
  // membership lists the owner's profiles. Read-only routes treat all
  // roles equivalently — both 'member' and 'admin' can read.
  app.get(
    '/v1/profiles',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = PaginationQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const cursorUuid =
        parsed.data.cursor !== undefined ? uuidFromProfileId(parsed.data.cursor) : undefined;

      const page = await service.list({
        accountId: effective.accountId,
        limit: parsed.data.limit,
        ...(cursorUuid !== undefined ? { cursor: cursorUuid } : {}),
      });
      return {
        data: page.data.map(publicProfile),
        has_more: page.hasMore,
        next_cursor: page.nextCursor !== null ? `prof_${page.nextCursor}` : null,
      };
    },
  );

  // ── GET /v1/profiles/:id ─────────────────────────────────────────────
  // V-330 — same effective-account scoping as the list endpoint above.
  app.get<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const id = uuidFromProfileId(req.params.id);
      const row = await service.get({ id, accountId: effective.accountId });
      return publicProfile(row);
    },
  );

  // ── PATCH /v1/profiles/:id ───────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const parsed = UpdateProfileRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const updates: { name?: string; description?: string | null } = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.description !== undefined) updates.description = parsed.data.description;

      const row = await service.update({ id, accountId: ctx.account.id, updates });
      return publicProfile(row);
    },
  );

  // ── DELETE /v1/profiles/:id ──────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      await service.delete({ id, accountId: ctx.account.id });
      return reply.code(204).send();
    },
  );
}
