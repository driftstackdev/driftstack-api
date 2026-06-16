// Profile routes — five endpoints under /v1/profiles (V-081).
//
//   POST   /v1/profiles       — create (tier-limit enforced)
//   GET    /v1/profiles       — list (cursor pagination)
//   GET    /v1/profiles/:id   — get one
//   PATCH  /v1/profiles/:id   — partial update (name, description, folder, tags)
//   DELETE /v1/profiles/:id   — delete
//
// Auth-gated via app.requireAuth + app.rateLimit('global'). Public id
// format: `prof_<uuid>` — same prefix-conversion convention as
// sessions.ts.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CloneProfileRequestSchema,
  CreateProfileRequestSchema,
  PaginationQuerySchema,
  PROFILE_EXPORT_ENVELOPE_VERSION,
  ProfileImportRequestSchema,
  UpdateProfileRequestSchema,
} from '@driftstack/api-types';
import type { ProfileRecord, ProfilesService } from '../services/profiles.js';
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import type { AccountAuthRepo } from '../services/auth.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';

/**
 * V-326e4 — admin-only gate for profile write operations on team
 * owners. Returns the effective accountId (string) when the team
 * write should proceed, or undefined when the request is self-scoped.
 * Throws ForbiddenError on member-role team requests.
 */
function effectiveAccountIdForWrite(
  request: FastifyRequest,
  ctx: NonNullable<FastifyRequest['account']>,
): string | undefined {
  const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
  if (effective.kind !== 'team') return undefined;
  if (effective.role !== 'admin') {
    throw new ForbiddenError('Profile writes on a team owner require admin role on that team.');
  }
  return effective.accountId;
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
    folder: p.folder,
    tags: p.tags,
    last_used_at: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
    // L4b recycle bin — null for a live profile; the trash timestamp for a
    // trashed one (only the GET /v1/profiles/trash path returns trashed rows).
    deleted_at: p.deletedAt ? p.deletedAt.toISOString() : null,
  };
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export interface ProfileRoutesDeps {
  service: ProfilesService;
  /**
   * V-326e4 — needed to look up the OWNER's tier for the profile-cap
   * check on POST /v1/profiles when team-scoped.
   */
  authRepo: AccountAuthRepo;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRoutesDeps): void {
  const { service, authRepo } = deps;

  // ── POST /v1/profiles ────────────────────────────────────────────────
  // V-326e4 — admin-only when targeting a team owner; profile cap +
  // accountId derive from the OWNER. Member role gets 403.
  app.post(
    '/v1/profiles',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = CreateProfileRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const eff = effectiveAccountIdForWrite(req, ctx);
      let accountId = ctx.account.id;
      let tier = ctx.account.tier;
      if (eff !== undefined) {
        const owner = await authRepo.getAccount(eff);
        if (!owner) throw new ForbiddenError('Owner account no longer exists.');
        accountId = owner.id;
        tier = owner.tier;
      }

      const profile = await service.create({
        accountId,
        tier,
        name: parsed.data.name,
        ...(parsed.data.archetype !== undefined ? { archetype: parsed.data.archetype } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.folder !== undefined ? { folder: parsed.data.folder } : {}),
        ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
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
  // V-326e4 — admin-only on team scope.
  app.patch<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const parsed = UpdateProfileRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const updates: {
        name?: string;
        description?: string | null;
        folder?: string | null;
        tags?: string[];
      } = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.description !== undefined) updates.description = parsed.data.description;
      if (parsed.data.folder !== undefined) updates.folder = parsed.data.folder;
      if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;

      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;
      const row = await service.update({ id, accountId, updates });
      return publicProfile(row);
    },
  );

  // ── DELETE /v1/profiles/:id ──────────────────────────────────────────
  // V-326e4 — admin-only on team scope.
  app.delete<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;
      await service.delete({ id, accountId });
      return reply.code(204).send();
    },
  );

  // ── GET /v1/profiles/trash (L4b recycle bin) ─────────────────────────
  // Lists the account's TRASHED profiles (deleted_at set), newest first.
  // Read-only → both team roles, same effective-account scoping as the list
  // endpoint. Static path → Fastify matches it ahead of /v1/profiles/:id.
  app.get(
    '/v1/profiles/trash',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const rows = await service.listTrash({ accountId: effective.accountId });
      return { data: rows.map(publicProfile) };
    },
  );

  // ── POST /v1/profiles/:id/restore (L4b recycle bin) ──────────────────
  // Un-trashes a soft-deleted profile. Same write-scope + admin-only-on-team
  // gate as delete. 404 if no trashed row; 409 if a live profile took the name
  // (the service maps the repo's name_conflict outcome).
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/restore',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;
      const row = await service.restore({ id, accountId });
      return publicProfile(row);
    },
  );

  // ── POST /v1/profiles/:id/clone (V-313) ──────────────────────────────
  // Same admin-only-on-team gate as create. Tier cap is checked
  // server-side (matches the create path); 402 / TierLimit on
  // exceeded. Body `name` optional — server auto-derives a non-
  // conflicting `${source} (copy)` if omitted.
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/clone',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const parsed = CloneProfileRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const eff = effectiveAccountIdForWrite(req, ctx);
      let accountId = ctx.account.id;
      let tier = ctx.account.tier;
      if (eff !== undefined) {
        const owner = await authRepo.getAccount(eff);
        if (!owner) throw new ForbiddenError('Owner account no longer exists.');
        accountId = owner.id;
        tier = owner.tier;
      }

      const cloned = await service.clone({
        id,
        accountId,
        tier,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      });
      return publicProfile(cloned);
    },
  );

  // ── GET /v1/profiles/:id/export (V-480) ──────────────────────────────
  // Metadata-only JSON export. Per-profile browser state lives driver-
  // side and is out of scope for v1; the envelope is versioned so a v2
  // that extends to driver state stays back-compat. Read-side audit
  // emit lets customers reconstruct file-flow lineage post-hoc.
  app.get<{ Params: { id: string } }>(
    '/v1/profiles/:id/export',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const id = uuidFromProfileId(req.params.id);
      const row = await service.exportProfile({ id, accountId: effective.accountId });
      return {
        version: PROFILE_EXPORT_ENVELOPE_VERSION,
        exported_at: new Date().toISOString(),
        source_profile_id: `prof_${row.id}`,
        source_account_id: row.accountId,
        profile: {
          name: row.name,
          archetype: row.archetype,
          description: row.description,
        },
      };
    },
  );

  // ── POST /v1/profiles/import (V-480) ────────────────────────────────
  // Accepts a v1 envelope, mints a fresh profile in the caller's
  // account. Tier-cap + name-conflict semantics match POST /v1/profiles.
  // Importing into a different account than the source is permitted
  // (transfer between teammate accounts via the file).
  app.post(
    '/v1/profiles/import',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = ProfileImportRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const eff = effectiveAccountIdForWrite(req, ctx);
      let accountId = ctx.account.id;
      let tier = ctx.account.tier;
      if (eff !== undefined) {
        const owner = await authRepo.getAccount(eff);
        if (!owner) throw new ForbiddenError('Owner account no longer exists.');
        accountId = owner.id;
        tier = owner.tier;
      }

      const env = parsed.data.envelope;
      const row = await service.importProfile({
        accountId,
        tier,
        sourceProfileId: env.source_profile_id,
        sourceAccountId: env.source_account_id,
        payload: env.profile,
        ...(parsed.data.name_override !== undefined
          ? { nameOverride: parsed.data.name_override }
          : {}),
      });
      return publicProfile(row);
    },
  );

  // 2026-05-22 — V-666 transfer ownership of a profile to another
  // Driftstack account. Body shape: { recipient_account_id: "acc_<uuid>" }.
  // The recipient's account_id is visible to them on /settings; they
  // share it out-of-band (chat / email) + sender pastes it here.
  // No email-leak path; the lookup is by id, not address.
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/transfer',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const body = req.body as { recipient_account_id?: unknown };
      const raw = typeof body.recipient_account_id === 'string' ? body.recipient_account_id : '';
      if (!/^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
        throw new ValidationError({
          fieldErrors: { recipient_account_id: ['Expected "acc_<uuid>".'] },
          formErrors: [],
        });
      }
      const recipientId = raw.slice(4);
      if (recipientId === ctx.account.id) {
        throw new ValidationError({
          fieldErrors: { recipient_account_id: ['Cannot transfer to your own account.'] },
          formErrors: [],
        });
      }
      const recipient = await authRepo.getAccount(recipientId);
      if (!recipient) {
        throw new NotFoundError(`Recipient account ${raw} not found.`);
      }
      const sourceId = uuidFromProfileId(req.params.id);
      const { newProfile } = await service.transferProfile({
        sourceProfileId: sourceId,
        sourceAccountId: ctx.account.id,
        recipientAccountId: recipient.id,
        recipientTier: recipient.tier,
      });
      return {
        new_profile: publicProfile(newProfile),
        recipient_account_id: `acc_${recipient.id}`,
      };
    },
  );
}
