// V-312 — profile snapshot routes.
//
//   POST   /v1/profiles/:id/snapshots          — capture a snapshot
//   GET    /v1/profiles/:id/snapshots          — list per-profile (cursor-paginated)
//   GET    /v1/profile-snapshots               — list per-account (across all profiles)
//   GET    /v1/profile-snapshots/:id           — get one
//   POST   /v1/profile-snapshots/:id/restore   — create a fresh profile from snapshot
//   DELETE /v1/profile-snapshots/:id           — hard-delete the snapshot
//
// The snapshot is an immutable point-in-time copy of the parent
// profile's metadata (per founder Tier-2 verdict 2026-05-09); the
// parent keeps evolving independently. Restore creates a NEW profile
// row carrying the snapshot's archetype + a customer-supplied name.
//
// Scope model: the 3 read routes need only requireAuth; the 3 WRITE
// routes (capture / restore / delete) additionally require the
// `write:profiles` scope, matching the sibling /v1/profiles write
// routes. Snapshots are profile mutations — restore in particular
// creates a profile — so a read-scope key must not reach them.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CaptureSnapshotRequestSchema,
  PaginationQuerySchema,
  RestoreSnapshotRequestSchema,
} from '@driftstack/api-types';
import { BadRequestError, ForbiddenError, ValidationError } from '../lib/errors.js';
import type { ProfilesService, ProfileRecord } from '../services/profiles.js';
import type {
  ProfileSnapshotRecord,
  ProfileSnapshotsService,
} from '../services/profile-snapshots.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import type { AccountAuthRepo } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';

function effectiveAccountIdForWrite(
  request: FastifyRequest,
  ctx: NonNullable<FastifyRequest['account']>,
): string | undefined {
  const eff = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
  if (eff.kind !== 'team') return undefined;
  if (eff.role !== 'admin') {
    throw new ForbiddenError('Snapshot writes on a team owner require admin role.');
  }
  return eff.accountId;
}

const PUBLIC_ID_RE = /^[a-z]+_([0-9a-fA-F-]{36})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const m = PUBLIC_ID_RE.exec(value);
  if (!m || !m[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return m[1];
}

function publicSnapshot(s: ProfileSnapshotRecord): Record<string, unknown> {
  return {
    id: `psnap_${s.id}`,
    parent_profile_id: s.parentProfileId ? `prof_${s.parentProfileId}` : null,
    label: s.label,
    description: s.description,
    parent_archetype: s.parentArchetype,
    parent_name: s.parentName,
    captured_at: s.capturedAt.toISOString(),
    created_at: s.createdAt.toISOString(),
  };
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

export interface ProfileSnapshotsRoutesDeps {
  service: ProfileSnapshotsService;
  profilesService: ProfilesService;
  authRepo: AccountAuthRepo;
}

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['account']> {
  const ctx = req.account;
  if (!ctx) throw new Error('account context missing after requireAuth');
  return ctx;
}

export function registerProfileSnapshotsRoutes(
  app: FastifyInstance,
  deps: ProfileSnapshotsRoutesDeps,
): void {
  const { service, profilesService, authRepo } = deps;

  // ── POST /v1/profiles/:id/snapshots — capture ──────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/snapshots',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const profileId = uuidFromPrefixedId(req.params.id, 'prof');
      const parsed = CaptureSnapshotRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;

      const snapshot = await service.capture({
        accountId,
        profileId,
        label: parsed.data.label,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
      // S46 2026-07-07 (founder-approved) — 201 Created, matching every sibling
      // create-POST (profiles, sessions, agent-sessions, webhooks) and the
      // docs/openapi contract. Was an implicit 200.
      return reply.code(201).send(publicSnapshot(snapshot));
    },
  );

  // ── GET /v1/profiles/:id/snapshots — list per profile ──────────────────
  // V-553.B-21 / Fable last-hours audit 2026-07-07 (C9) — read:profiles gate.
  // Snapshots ARE profile data (the reference already documents `read` or
  // `read:profiles` as required here, and write:profiles is scoped to cover
  // "profiles and their snapshots"); the sibling GET /v1/profiles routes gate
  // on read:profiles but these snapshot reads were missed, so a narrow granular
  // key lacking read:profiles could read snapshot metadata. Ownership is already
  // account-scoped in the handler; this adds the missing least-privilege floor.
  // A broad `read` / account_owner key satisfies it via the V-481 hierarchy.
  app.get<{ Params: { id: string } }>(
    '/v1/profiles/:id/snapshots',
    { preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const profileId = uuidFromPrefixedId(req.params.id, 'prof');
      const eff = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const accountId = eff.kind === 'team' ? eff.accountId : ctx.account.id;
      const query = PaginationQuerySchema.parse(req.query ?? {});
      const page = await service.list({
        accountId,
        parentProfileId: profileId,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      return {
        data: page.data.map(publicSnapshot),
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
      };
    },
  );

  // ── GET /v1/profile-snapshots — list per account ───────────────────────
  // read:profiles gate — see the C9 rationale on GET /v1/profiles/:id/snapshots.
  app.get(
    '/v1/profile-snapshots',
    { preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const eff = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const accountId = eff.kind === 'team' ? eff.accountId : ctx.account.id;
      const query = PaginationQuerySchema.parse(req.query ?? {});
      const page = await service.list({
        accountId,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      return {
        data: page.data.map(publicSnapshot),
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
      };
    },
  );

  // ── GET /v1/profile-snapshots/:id ──────────────────────────────────────
  // read:profiles gate — see the C9 rationale on GET /v1/profiles/:id/snapshots.
  app.get<{ Params: { id: string } }>(
    '/v1/profile-snapshots/:id',
    { preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromPrefixedId(req.params.id, 'psnap');
      const eff = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const accountId = eff.kind === 'team' ? eff.accountId : ctx.account.id;
      const snapshot = await service.get({ id, accountId });
      return publicSnapshot(snapshot);
    },
  );

  // ── POST /v1/profile-snapshots/:id/restore ─────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/profile-snapshots/:id/restore',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromPrefixedId(req.params.id, 'psnap');
      const parsed = RestoreSnapshotRequestSchema.safeParse(req.body);
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

      const restored = await service.restore({
        accountId,
        snapshotId: id,
        tier,
        name: parsed.data.name,
      });
      return publicProfile(restored);
    },
  );

  // ── DELETE /v1/profile-snapshots/:id ───────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/v1/profile-snapshots/:id',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const id = uuidFromPrefixedId(req.params.id, 'psnap');
      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;
      await service.delete({ id, accountId });
      return reply.code(204).send();
    },
  );

  // Reference profilesService to satisfy the unused-warn in deploys
  // where the param is wired but the route doesn't use it directly.
  void profilesService;
}
