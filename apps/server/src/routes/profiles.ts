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

import {
  parseRequestBodyReportingUnknown,
  reportUnknownRequestFields,
} from '../lib/unknown-request-fields.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CloneProfileRequestSchema,
  CreateProfileRequestSchema,
  PaginationQuerySchema,
  PROFILE_EXPORT_ENVELOPE_VERSION,
  ProfileImportRequestSchema,
  UpdateProfileRequestSchema,
} from '@driftstack/api-types';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRIM_PROFILE_SCOPES } from '../schemas/harness-control-protocol.js';

/**
 * The optional body of POST /v1/profiles/:id/trim.
 *
 * `.strict()` so a typo'd key is a 400 rather than silently clearing the default
 * scope — on an op that DELETES a customer's cookies, "I sent scopes and it
 * cleared the cache instead" must not be a quiet outcome.
 */
export const TrimScopeBodySchema = z
  .object({ scope: z.enum(TRIM_PROFILE_SCOPES).optional() })
  .strict();
import type { ProfileRecord, ProfilesService } from '../services/profiles.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import {
  BadRequestError,
  FeatureUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import {
  PROFILE_ACTIVITY_ENTRY_LIMIT,
  PROFILE_ACTIVITY_SESSION_LIMIT,
} from '../services/profile-activity.js';
import { requireArchetypeForTier } from '../lib/errors-helpers.js';
import type { AccountAuthRepo } from '../services/auth.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import { buildAssignProfileBlock } from '../services/profile-store.js';
import type { R2 } from '../lib/r2.js';
import { customerSafeNodeDiagnostic } from '../services/scrub-node-diagnostics.js';

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
    icon: p.icon,
    note: p.note,
    last_used_at: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
    // doc-150 item 5 — per-profile sealed-store size + last save-back time.
    // Customer-safe metadata only (a byte count + a timestamp) — never the
    // opaque sealed blob itself, which lives in R2 and never rides this record.
    size_bytes: p.sizeBytes,
    last_saved_at: p.lastSavedAt ? p.lastSavedAt.toISOString() : null,
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
  /**
   * doc-150 §8 — fleet control-plane registry for the out-of-session trim
   * eviction (POST /:id/trim picks any healthy node + relays a `trimProfile`).
   * Absent (stateless deploy / FLEET_CONTROL_PLANE_ENABLED off) → trim returns a
   * graceful `unavailable`, exactly like the cookies route.
   */
  fleetControlRegistry?: FleetControlRegistry;
  /**
   * doc-150 §8 — R2 client to mint the presigned GET/PUT the trim op carries (the
   * sealed blob flows R2 ↔ node directly; the CP never holds it). Absent → trim
   * returns `unavailable` (no blob to fetch/write back).
   */
  r2?: R2;
  /**
   * #14 — agent-sessions repo for the trim's "is this profile bound to a live
   * session?" guard (countActiveForProfile). Absent → the guard is skipped (the
   * trim behaves exactly as before; no false positives). Present → a trim against
   * a profile with a still-active session returns `unavailable` instead of racing
   * the session's save-back over the same R2 blob (a lost update).
   */
  agentSessions?: AgentSessionsRepo;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRoutesDeps): void {
  const { service, authRepo, fleetControlRegistry, r2, agentSessions } = deps;

  // A profile trim is a large out-of-session transform on a shared Mac: the
  // node may GET, decrypt/decompress, filter, re-seal, and PUT up to the 256 MiB
  // per-blob backstop while the API waits for as long as 60 seconds. The generic
  // request-rate bucket permits bursts, so bound expensive concurrent work per
  // effective owner account independently of request frequency.
  const profileTrimAccountsInFlight = new Set<string>();
  function reserveProfileTrim(accountId: string): (() => void) | null {
    if (profileTrimAccountsInFlight.has(accountId)) return null;
    profileTrimAccountsInFlight.add(accountId);
    return () => profileTrimAccountsInFlight.delete(accountId);
  }

  // ── POST /v1/profiles ────────────────────────────────────────────────
  // V-326e4 — admin-only when targeting a team owner; profile cap +
  // accountId derive from the OWNER. Member role gets 403.
  app.post(
    '/v1/profiles',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = CreateProfileRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Item 6 — a mistyped field used to be dropped in silence and answered
      // 201. The request still succeeds exactly as before; the ignored keys are
      // now reported in a header and a server log instead of vanishing.
      reportUnknownRequestFields({
        body: req.body,
        knownKeys: Object.keys(CreateProfileRequestSchema.shape),
        reply,
        logger: req.log,
        route: 'POST /v1/profiles',
      });

      const eff = effectiveAccountIdForWrite(req, ctx);
      let accountId = ctx.account.id;
      let tier = ctx.account.tier;
      if (eff !== undefined) {
        const owner = await authRepo.getAccount(eff);
        if (!owner) throw new ForbiddenError('Owner account no longer exists.');
        accountId = owner.id;
        tier = owner.tier;
      }

      // V-1611 #15 — device entitlement. Checked AFTER the effective-owner
      // resolution above, so an act-as create is judged on the OWNER's tier and
      // not the caller's: a free member acting on a paid owner gets the owner's
      // devices, and a paid member acting on a free owner does not smuggle one in.
      if (parsed.data.archetype !== undefined) {
        requireArchetypeForTier(tier, parsed.data.archetype);
      }

      const profile = await service.create({
        accountId,
        tier,
        name: parsed.data.name,
        ...(parsed.data.archetype !== undefined ? { archetype: parsed.data.archetype } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.folder !== undefined ? { folder: parsed.data.folder } : {}),
        ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      });
      return publicProfile(profile);
    },
  );

  // ── GET /v1/profiles ─────────────────────────────────────────────────
  // V-330 — honors X-Driftstack-Account: a team member with a valid
  // membership lists the owner's profiles. Read-only routes treat all
  // roles equivalently — both 'member' and 'admin' can read.
  // V-553.B-21 — read:profiles gate. ProfilesService's list/get/listTrash
  // don't take an AccountContext (they're also called internally by
  // sessions.ts/agent-sessions.ts to resolve a session's bound profile,
  // which must NOT require read:profiles — a write:sessions-only CI key
  // creating a profile-bound session shouldn't need profile read access).
  // So the gate lives here, at the route layer, mirroring exactly how
  // the write routes below gate on write:profiles via app.requireScope.
  app.get(
    '/v1/profiles',
    {
      preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')],
    },
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
  // V-553.B-21 — read:profiles gate; see the GET /v1/profiles comment above.
  app.get<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    {
      preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')],
    },
    async (req) => {
      const ctx = requireCtx(req);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const id = uuidFromProfileId(req.params.id);
      const row = await service.get({ id, accountId: effective.accountId });
      return publicProfile(row);
    },
  );

  // ── PATCH /v1/profiles/:id ───────────────────────────────────────────
  // ── GET /v1/profiles/:id/activity ────────────────────────────────────
  // P-23 — the profile's recent navigation, projected from the account's agent
  // session transcripts. ⛔ ACCOUNT ACTIVITY, not "browsing history": D-1 keeps
  // the transcript out of the profile's Clear-history action, so this view
  // still shows rows after a clear, and the name is part of the contract.
  // Read scope mirrors GET /:id. Ownership: `service.get` 404s a foreign or
  // unknown profile BEFORE the sessions store is touched, so the projection
  // can never read across accounts even though it is keyed by profile id —
  // and the store query is ALSO account-scoped, so the two guards agree.
  // No query parameters by design (fixed server bounds; see profile-activity).
  app.get<{ Params: { id: string } }>(
    '/v1/profiles/:id/activity',
    {
      preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')],
    },
    async (req) => {
      const ctx = requireCtx(req);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      const id = uuidFromProfileId(req.params.id);
      await service.get({ id, accountId: effective.accountId }); // 404 on unknown/foreign
      if (agentSessions === undefined) {
        // Stateless deploy / fleet off: the same machine-readable 503 the
        // sessions routes return, not a bare 404 that reads as "no such profile".
        throw new FeatureUnavailableError(
          'Session activity is not available on this deployment: the agent session store is not configured.',
        );
      }
      const activity = await agentSessions.listProfileActivity({
        accountId: effective.accountId,
        profileId: id,
        sessionLimit: PROFILE_ACTIVITY_SESSION_LIMIT,
        entryLimit: PROFILE_ACTIVITY_ENTRY_LIMIT,
      });
      return {
        data: activity.entries.map((e) => ({
          at: e.at,
          url: e.url,
          agent_session_id: e.agentSessionId,
        })),
        sessions_scanned: activity.sessionsScanned,
        truncated: activity.truncated,
      };
    },
  );

  // ── PATCH /v1/profiles/:id ───────────────────────────────────────────
  // V-326e4 — admin-only on team scope.
  app.patch<{ Params: { id: string } }>(
    '/v1/profiles/:id',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      // Item 6 — a mistyped field on update used to be dropped in silence, so
      // the request answered 200 having changed nothing the caller asked for.
      const body = parseRequestBodyReportingUnknown({
        schema: UpdateProfileRequestSchema,
        req,
        reply,
        route: 'PATCH /v1/profiles/:id',
      });

      const updates: {
        name?: string;
        description?: string | null;
        folder?: string | null;
        tags?: string[];
        icon?: string | null;
        note?: string | null;
      } = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.folder !== undefined) updates.folder = body.folder;
      if (body.tags !== undefined) updates.tags = body.tags;
      if (body.icon !== undefined) updates.icon = body.icon;
      if (body.note !== undefined) updates.note = body.note;

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
  // V-553.B-21 — read:profiles gate; see the GET /v1/profiles comment above.
  app.get(
    '/v1/profiles/trash',
    {
      preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')],
    },
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

  // ── DELETE /v1/profiles/:id/purge (recycle bin — permanent delete) ───
  // Anti-abuse companion: permanently removes ONE trashed profile so a user at
  // their cap can free a slot immediately (trashed now counts toward the cap).
  // Owner-scoped + trashed-only in the service/repo (a live profile is never
  // reachable here) — 404 if no trashed row matches. Same write-scope gate.
  app.delete<{ Params: { id: string } }>(
    '/v1/profiles/:id/purge',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;
      await service.purge({ id, accountId });
      reply.code(204);
    },
  );

  // ── POST /v1/profiles/:id/clone (V-313) ──────────────────────────────
  // Same admin-only-on-team gate as create. Tier cap is checked
  // server-side (matches the create path); 429 / TierLimit on
  // exceeded. Body `name` optional — server auto-derives a non-
  // conflicting `${source} (copy)` if omitted.
  //
  // V-814 — the status above read 402 until it was checked against
  // the class: TierLimitError has always been status 429, type
  // `.../tier-limit`. ADR-004 specified 402 (V-814) for this path and
  // the implementation never followed; see the note in that ADR.
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/clone',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      const parsed = CloneProfileRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // V-946 — report the keys zod stripped. This route is behind
      // `app.requireAuth` + a scope, verified at its registration, so the caller
      // is known and echoing back its own unrecognised keys discloses nothing.
      reportUnknownRequestFields({
        body: req.body ?? {},
        knownKeys: Object.keys(CloneProfileRequestSchema.shape),
        reply,
        logger: req.log,
        route: 'POST /v1/profiles/:id/clone',
      });

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
    // read:profiles gate MUST live here — exportProfile only scopes by
    // accountId, not by scope (like the other GET reads above). Without it a
    // read:sessions-only granular key could read profile metadata it wasn't
    // granted (Fable customer-routes re-audit 2026-07-02).
    { preHandler: [app.requireAuth, app.requireScope('read:profiles'), app.rateLimit('global')] },
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
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = ProfileImportRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Item 6 — an import that carried a mistyped field succeeded with that field ignored.
      reportUnknownRequestFields({
        body: req.body,
        knownKeys: Object.keys(ProfileImportRequestSchema.shape),
        reply,
        logger: req.log,
        route: 'POST /v1/profiles/import',
      });

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
      // V-734 — honour X-Driftstack-Account like every other profile WRITE.
      // This was the only one of the file's write routes that did not, so an
      // admin team member transferring one of the OWNER's profiles had
      // `sourceAccountId` silently set to their OWN account and got a bare
      // `404 profile not found` — the header was ignored rather than refused.
      //
      // Honouring it grants no new power: the sibling DELETE routes already run
      // under this same helper, so an admin can already destroy the owner's
      // profiles outright. Transfer is strictly less destructive than that, and
      // leaving it owner-only was an inconsistency rather than a protection.
      const eff = effectiveAccountIdForWrite(req, ctx);
      const sourceAccountId = eff ?? ctx.account.id;
      const body = req.body as { recipient_account_id?: unknown };
      const raw = typeof body.recipient_account_id === 'string' ? body.recipient_account_id : '';
      if (!/^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
        throw new ValidationError({
          fieldErrors: { recipient_account_id: ['Expected "acc_<uuid>".'] },
          formErrors: [],
        });
      }
      const recipientId = raw.slice(4);
      // V-734 — compare against the SOURCE account, not the caller. Under a
      // team-scoped write the source is the owner, so the caller's own id is the
      // wrong thing to guard on: it let an admin member "transfer" an owner
      // profile to the owner itself (a no-op that should be refused) while
      // wrongly blocking a legitimate transfer to the member's own account.
      if (recipientId === sourceAccountId) {
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
        sourceAccountId,
        recipientAccountId: recipient.id,
        recipientTier: recipient.tier,
      });
      return {
        new_profile: publicProfile(newProfile),
        recipient_account_id: `acc_${recipient.id}`,
      };
    },
  );

  // ── POST /v1/profiles/:id/trim (doc-150 §8 — storage cleanup / eviction) ──
  // A customer over their storage cap reclaims space by trimming a profile's
  // re-fetchable caches (HTTP/Media cache + per-origin CacheStorage/ServiceWorkers)
  // while KEEPING the high-value identity bytes (cookies / localStorage / IndexedDB /
  // tabs). Trim runs OUT-OF-SESSION on a node (the harness is the only decryptor):
  // we resolve the profile's DEK + a presigned R2 GET/PUT (the SAME envelope a
  // session-assign mints, via buildAssignProfileBlock), pick any healthy node, relay
  // a `trimProfile` op, await `trimResult`, then UPDATE size_bytes from the re-sealed
  // size on success. Owner-checked + write-scoped like every mutating profile route.
  //
  // DISCRIMINATED 200 body in every case (mirrors GET /:id/cookies' "null when not
  // wired" style) so the dashboard renders expected-inert states without HTTP-error
  // noise. NEVER log the DEK.
  //   status:'ok'          → { size_bytes, bytes_reclaimed }   (trimmed + persisted)
  //   status:'unavailable' → not wired (R2/fleet off) / no node connected / no stored
  //                          state to trim (a fresh profile has no sealed blob)
  //   status:'timeout'     → node didn't reply (A3 handler pending)
  //   status:'error'       → node reported a failure (reason set) — row NOT updated
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/trim',
    { preHandler: [app.requireAuth, app.requireScope('write:profiles'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const id = uuidFromProfileId(req.params.id);
      // W3120 (doc-150 §8.4) — WHAT to clear. Absent = 'cache', the behaviour this
      // route had before the field existed, so every existing caller is unchanged.
      // A malformed body is a 400 rather than a silent fallback: guessing on a
      // DESTRUCTIVE op is how a customer asking for one thing gets another.
      const scopeParsed = TrimScopeBodySchema.safeParse(req.body ?? {});
      if (!scopeParsed.success) {
        // V-1613 — the two ways this fails need different sentences. `.strict()`
        // rejects an unknown KEY, and answering that with "Invalid scope.
        // Expected one of: cache, cookies, history, all" told a caller who sent
        // `{"scopes":"cookies"}` that `cookies` was among the values they could
        // have used — naming their value back to them as valid while refusing
        // the request, and never mentioning the key that was actually wrong.
        const unknownKeys = scopeParsed.error.issues.find(
          (issue) => issue.code === 'unrecognized_keys',
        );
        throw new BadRequestError(
          unknownKeys !== undefined
            ? `Unexpected field(s): ${unknownKeys.keys.join(', ')}. This endpoint takes only \`scope\`.`
            : `Invalid scope. Expected one of: ${TRIM_PROFILE_SCOPES.join(', ')}.`,
        );
      }
      // Left UNDEFINED when absent rather than defaulted to 'cache', so an
      // existing caller's frame stays byte-identical to what it sent before the
      // field existed. The node already treats a missing scope as cache, so the
      // default would be a key that says what silence already says.
      //
      // ⚠️ NOT because an old node would reject it. `TrimProfileRequest` has no
      // custom `init(from:)` — only `CodingKeys` and a memberwise init — so
      // Swift SYNTHESIZES the decoder, and a synthesized Codable decoder
      // silently IGNORES keys outside `CodingKeys`. The only unknown-thing
      // throws in ControlClient.swift are on the message TYPE tag
      // (`unknown ControlInbound type`), not on fields. An earlier version of
      // this comment claimed the decode was strict about unknown keys; that was
      // false, and it mattered — if it were true, no additive field could ever
      // be safe and the whole optional-contract design would be impossible.
      // Tolerance is what MAKES the contract safe; omitting is belt-and-braces
      // on top of it, not the thing standing between us and a broken node.
      const scope = scopeParsed.data.scope;
      // Owner-check exactly like the other mutating routes: the trim scopes to the
      // OWNER account (self → caller; admin-on-team → owner), and `service.get`
      // 404s an unknown/foreign id so we never confirm another account's profile.
      const eff = effectiveAccountIdForWrite(req, ctx);
      const accountId = eff ?? ctx.account.id;
      await service.get({ id, accountId }); // throws NotFoundError on unknown/foreign

      // #14 — refuse a trim against a profile bound to a still-active session.
      // Trim runs OUT-OF-SESSION on an arbitrary node against R2's last-saved
      // blob; if a live session for this profile is still open, it holds the full
      // un-trimmed state and saves it back over the trimmed blob at teardown (a
      // two-writer lost update — the reclaimed space silently reappears, or the
      // saved state is clobbered). Stop the session first. The owner-check above
      // already ran, so `id` is this account's profile; countActiveForProfile is
      // a partial-index lookup. Guard is skipped when the repo isn't wired (no
      // false positives — behaves exactly as before).
      if (agentSessions !== undefined && (await agentSessions.countActiveForProfile(id)) > 0) {
        return {
          status: 'unavailable' as const,
          reason: 'profile is currently in use — stop its running session before clearing its data',
          blocked: true as const,
        };
      }

      // Control plane / R2 not wired (stateless deploy) → graceful unavailable.
      if (fleetControlRegistry === undefined || r2 === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'profile storage trim is not enabled',
          blocked: true as const,
        };
      }
      // Resolve the per-profile DEK (KMS→TMK→DEK, file 57). Null → profiles feature
      // inert (PROFILE_MASTER_KEY unset) or this profile has no stored DEK → nothing
      // we can open, so there's nothing to trim. NEVER log the DEK.
      let dek: Awaited<ReturnType<typeof service.getProfileDek>>;
      try {
        dek = await service.getProfileDek({ profileId: id, accountId });
      } catch (err) {
        // A corrupt / rotated-but-not-rewrapped wrapped-DEK makes unwrapProfileDek
        // throw. Don't surface a raw 500 — mirror the buildAssignProfileBlock catch
        // below (graceful 'unavailable' + warn). NEVER log the DEK / key material.
        req.log.warn(
          { component: 'profile-trim', profileId: id, err },
          'profile trim DEK resolution failed',
        );
        return {
          status: 'unavailable' as const,
          reason: 'could not resolve the profile encryption key',
          blocked: true as const,
        };
      }
      if (dek === null) {
        return {
          status: 'unavailable' as const,
          reason: 'profile has no encrypted store to trim',
        };
      }
      // Mint the JIT crypto envelope the trim op carries — the SAME presigned GET/PUT
      // path session-dispatch uses (buildAssignProfileBlock). sealedBlobUrl is present
      // ONLY when a sealed blob already exists in R2; absent → a fresh profile with no
      // persisted state → nothing to trim (unavailable, not an error).
      const dekBase64 = dek.toString('base64');
      let block: Awaited<ReturnType<typeof buildAssignProfileBlock>>;
      try {
        block = await buildAssignProfileBlock(r2, id, dekBase64);
      } catch (err) {
        req.log.warn(
          { component: 'profile-trim', profileId: id, err },
          'profile trim R2 url-mint failed',
        );
        return {
          status: 'unavailable' as const,
          reason: 'could not prepare profile storage',
          blocked: true as const,
        };
      }
      if (block.sealedBlobUrl === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'profile has no saved state to trim yet',
        };
      }
      // Pick ANY healthy (connected) node — trim is out-of-session so the profile has
      // no assigned node; any reachable node can run the blob→blob transform.
      const conn = fleetControlRegistry.pickAnyConnected();
      if (conn === undefined) {
        // ⛔ `blocked` separates "there is nothing to clear" (benign) from "the
        // clear could not run" (the customer asked for a destructive action and it
        // did NOT happen). The GUI renders the second as a persistent error; before
        // this flag both flavors were a 5-second auto-dismissing notice, so a
        // refused clear was indistinguishable from a successful no-op.
        return {
          status: 'unavailable' as const,
          reason: 'no fleet node is connected',
          blocked: true as const,
        };
      }
      const releaseProfileTrim = reserveProfileTrim(accountId);
      if (releaseProfileTrim === null) {
        return {
          status: 'unavailable' as const,
          reason: 'another profile trim is already in progress — retry when it finishes',
          blocked: true as const,
        };
      }
      try {
        const outcome = await conn.requestTrim({
          requestId: randomUUID(),
          profileId: id,
          dek: dekBase64,
          sealedBlobURL: block.sealedBlobUrl,
          sealedBlobPutURL: block.sealedBlobPutUrl,
          ...(scope !== undefined ? { scope } : {}),
        });
        // ⛔ W3122 — an `ok` from the node is NOT evidence the requested scope ran.
        // A synthesized Codable decoder ignores keys outside `CodingKeys`, which
        // is exactly what makes an ADDITIVE field safe to land on either side
        // first. `scope` is not additive: it CHANGES WHAT THE OP DOES. So a node
        // predating the field accepts `scope: 'cookies'`, silently drops it, runs
        // a cache trim, and replies ok — and the customer is told they were
        // signed out everywhere while their cookies are untouched. A silent false
        // success on a destructive op, and `pickAnyConnected()` is version-blind,
        // so which node answers is arbitrary.
        //
        // The echo closes it. A node that HAS the field always echoes it, the
        // default included, so an ABSENT echo means "old node" unambiguously.
        // Only checked when a scope was actually asked for: a caller that sent
        // none wanted the cache trim an old node performs, and failing that would
        // break every existing caller against every node.
        if (outcome.status === 'ok' && scope !== undefined && outcome.appliedScope !== scope) {
          req.log.warn(
            {
              component: 'profile-trim',
              profileId: id,
              requested: scope,
              applied: outcome.appliedScope ?? 'none',
            },
            'fleet node did not apply the requested trim scope — reporting failure rather than a false success',
          );
          return {
            status: 'error' as const,
            // Honest about BOTH halves: the requested op did not happen, and the
            // node did do something — it re-sealed the blob after a cache trim,
            // so telling the customer "nothing happened" would be its own lie.
            reason:
              outcome.appliedScope === undefined
                ? 'the fleet node that handled this is too old to clear anything beyond the cache. It cleared cached files instead; cookies, site data and tabs are unchanged. Retry once the fleet is updated'
                : `the fleet node cleared "${outcome.appliedScope}" instead of "${scope}". Nothing else was changed`,
          };
        }
        if (outcome.status === 'ok') {
          // Persist the new (smaller) sealed size so the storage meter + launch quota
          // gate reflect the reclaimed bytes immediately. Only on a confirmed ok.
          // The node already re-sealed + PUT the smaller blob — the trim SUCCEEDED.
          // A failure to persist the new size must NOT surface as a 500 (the storage
          // was reclaimed; only the meter row lags until the next size write). Swallow+warn.
          try {
            await service.recordTrim({
              profileId: id,
              accountId,
              newSizeBytes: outcome.newSizeBytes,
              // 'history'/'all' delete the remembered tabs, so the saved-tabs
              // stamp must go with them — see recordTrim.
              clearedSavedTabs: scope === 'history' || scope === 'all',
            });
          } catch (err) {
            req.log.warn(
              { component: 'profile-trim', profileId: id, err },
              'profile trim succeeded on the node but the size-meter DB update failed',
            );
          }
          return {
            status: 'ok' as const,
            size_bytes: outcome.newSizeBytes,
            bytes_reclaimed: outcome.bytesReclaimed,
          };
        }
        if (outcome.status === 'error') {
          // Node reported a failure — do NOT update the row (the old blob is untouched).
          return {
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        return { status: 'timeout' as const };
      } finally {
        releaseProfileTrim();
      }
    },
  );
}
