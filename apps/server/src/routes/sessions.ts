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
  ExtractRequestSchema,
  SearchRequestSchema,
  SessionLoginRequestSchema,
  CreateSessionRequestSchema,
  LaunchProfileRequestSchema,
  InteractRequestSchema,
  NavigateRequestSchema,
  PaginationQuerySchema,
  WaitRequestSchema,
  type AccountTier,
} from '@driftstack/api-types';
import type { SessionRecord, SessionsService } from '../services/sessions.js';
import type { ProfilesService } from '../services/profiles.js';
import { GUIInputRequestSchema } from '../schemas/gui-input.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { AccountAuthRepo } from '../services/auth.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { parseProfileId } from '../lib/profile-id.js';

/**
 * Resolves the effective account for a live driver operation and enforces
 * the team-admin role gate before the service can claim or contact that
 * runtime. Returns the effective accountId when team-scoped and undefined
 * when self-scoped (the service uses ctx.account.id by default).
 *
 * Persisted metadata reads (list / describe) remain available to team
 * members and use resolveEffectiveAccount inline. Live state is deliberately
 * different: it exposes cookies and localStorage and owns the driver while
 * capturing, so it must use this gate too.
 */
function effectiveAccountIdForLiveOperation(
  request: FastifyRequest,
  ctx: NonNullable<FastifyRequest['account']>,
): string | undefined {
  const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
  if (effective.kind !== 'team') return undefined;
  if (effective.role !== 'admin') {
    throw new ForbiddenError(
      'Live session operations on a team owner require admin role on that team.',
    );
  }
  return effective.accountId;
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
    // Migration 0045 — harness-reported egress capabilities. null until
    // SOCKS5 handshake completes or for non-SOCKS5 sessions. Cross-agent
    // contract shape: { udp_associate, quic_route, warnings[] }.
    egress_capabilities: s.egressCapabilities,
    // Arc 5 EGRESS eg.1 — migration 0054 raw harness-emitted payload.
    // Null until the harness emits; opaque JSON record. Consumers
    // should prefer `egress_capabilities` for typed access.
    egress_capability_report: s.egressCapabilityReport,
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
  /**
   * 2026-05-20 — antidetect-browser profile binding. When wired, the
   * sessions-create handler validates the optional `profile_id` body
   * field (cross-account profile_id 404s) + bumps last_used_at on the
   * profile. Optional so the routes still register in test fixtures
   * that don't materialise a ProfilesService.
   */
  profilesService?: ProfilesService;
  /**
   * Fail-closed switch for the direct session-create surface. These routes
   * have no typed owner-validated egress input and pass no proxy authority to
   * SessionsService/the driver, so `true` disables creation rather than
   * accepting a shape-only raw `proxy` field.
   */
  egressProxyRequired?: boolean;
}

const DIRECT_SESSION_EGRESS_GUIDANCE =
  'Use POST /v1/agent-sessions with an owned saved proxy_id for customer-controlled egress.';

function assertDirectSessionEgressAvailable(rawBody: unknown, egressProxyRequired: boolean): void {
  if (egressProxyRequired) {
    throw new BadRequestError(
      'Direct session creation is disabled on this deployment because required customer egress ' +
        `is not available on this API surface. ${DIRECT_SESSION_EGRESS_GUIDANCE}`,
    );
  }
  if (
    typeof rawBody === 'object' &&
    rawBody !== null &&
    Object.prototype.hasOwnProperty.call(rawBody, 'proxy')
  ) {
    throw new BadRequestError(
      'The raw proxy field is not supported for direct session creation and was not applied. ' +
        DIRECT_SESSION_EGRESS_GUIDANCE,
    );
  }
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
  const profilesService = opts.profilesService;
  const egressProxyRequired = opts.egressProxyRequired ?? false;

  // 2026-05-20 — shared helper used by both POST /v1/sessions (when
  // profile_id is supplied in the body) and POST /v1/profiles/:id/launch.
  // Validates ownership, inherits archetype default, stamps the binding
  // into session metadata, then bumps profile.last_used_at after the
  // create succeeds.
  //
  // doc-150 item 6 — HARD per-account storage-quota gate. A profile-backed
  // session-create is the point where NEW persisted state starts growing, so
  // a launch is refused (409 storage_quota_exceeded) BEFORE the driver
  // dispatch when the OWNER's aggregate profile size_bytes has reached its
  // tier's hard cap. Enterprise is soft-only (never blocked). Sessions
  // WITHOUT a profile never call this helper, so they're never gated. `tier`
  // is the OWNER's tier (the storage belongs to the owner account).
  async function resolveProfileBinding(
    profileId: string,
    accountId: string,
    tier: AccountTier,
  ): Promise<{ archetype: string; metadata: Record<string, unknown> }> {
    if (!profilesService) {
      throw new NotFoundError(`Profile ${profileId} not found.`);
    }
    // service.get throws NotFoundError on missing / cross-account
    // mismatch; propagate as-is (already returns 404, not 403, so we
    // don't leak profile existence to outsiders).
    const profile = await profilesService.get({ id: profileId, accountId });
    // Storage-quota gate runs AFTER ownership is confirmed (we only meter the
    // account that actually owns the resolved profile) and BEFORE the create
    // returns to the caller's dispatch path. Throws StorageQuotaExceededError
    // (409) when over the hard cap; no-op otherwise.
    await profilesService.assertWithinStorageQuotaForLaunch({ accountId, tier });
    return {
      archetype: profile.archetype,
      metadata: { profile_id: profile.id, profile_name: profile.name },
    };
  }

  // ── POST /v1/sessions ──────────────────────────────────────────────────
  // V-326e1 — when X-Driftstack-Account is set, the new session is
  // created on the OWNER's account. Caller's role MUST be 'admin' on
  // that team (Q1 verdict — member is read-only on writes); 'member'
  // role gets 403. Tier-derived concurrent cap uses the OWNER's tier.
  app.post(
    '/v1/sessions',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('write:sessions'),
        app.rateLimit('sessions:create'),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(request);
      const rawBody = request.body ?? {};
      // This route has no typed/consumed proxy transport. Reject an explicit
      // raw field before Zod can strip it, and disable the whole direct surface
      // when deployment policy requires egress. Both branches run before any
      // account/profile/session/driver side effect.
      assertDirectSessionEgressAvailable(rawBody, egressProxyRequired);
      const body = CreateSessionRequestSchema.parse(rawBody);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      // 2026-05-20 — resolve profile_id binding BEFORE create so the
      // archetype default + metadata stamps flow into the session row
      // atomically. The bump-last-used happens AFTER create so a
      // create-failed path doesn't leave the profile reading "used".
      const ownerAccountId = effective.kind === 'team' ? effective.accountId : ctx.account.id;
      // Resolve the OWNER's tier up front. For a team-scoped create the
      // session is owned by the team owner, so BOTH the storage-quota gate
      // (doc-150 item 6, metered against the owner's stored profiles) AND the
      // concurrent-cap tier use the owner's tier. The admin-role check + owner-
      // existence guard move up here too so they run before any owner-scoped
      // side effect. Self-scoped uses the caller's own tier.
      let ownerTier: AccountTier;
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
        ownerTier = owner.tier;
      } else {
        ownerTier = ctx.account.tier;
      }
      // Accept the canonical prof_<uuid> the profiles API returns OR a bare uuid
      // (parseProfileId normalizes + 400s on bad) → the bare uuid used by the
      // repo/touch. Matches /v1/agent-sessions (W335); resolves the divergence.
      const profileBareId =
        body.profile_id !== undefined ? parseProfileId(body.profile_id) : undefined;
      const profileBinding =
        profileBareId !== undefined
          ? await resolveProfileBinding(profileBareId, ownerAccountId, ownerTier)
          : null;
      const bodyWithProfile =
        profileBinding !== null
          ? {
              ...body,
              archetype: body.archetype ?? profileBinding.archetype,
              metadata: { ...(body.metadata ?? {}), ...profileBinding.metadata },
            }
          : body;
      let created: SessionRecord;
      if (effective.kind === 'team') {
        created = await service.create(ctx, bodyWithProfile, {
          effectiveAccountId: ownerAccountId,
          effectiveTier: ownerTier,
          ...(profileBinding !== null ? { inheritedProfileArchetype: true } : {}),
        });
      } else {
        created = await service.create(
          ctx,
          bodyWithProfile,
          profileBinding !== null ? { inheritedProfileArchetype: true } : {},
        );
      }
      // Fire-and-forget touch on the profile — if it fails the customer
      // still gets their session (the binding is recorded in metadata).
      if (profileBinding !== null && profilesService && profileBareId !== undefined) {
        void profilesService
          .touch({ id: profileBareId, accountId: ownerAccountId, at: new Date() })
          .catch(() => undefined);
      }
      return reply.code(201).send(publicSession(created));
    },
  );

  // ── POST /v1/profiles/:id/launch ───────────────────────────────────────
  // 2026-05-20 — antidetect-browser-style: one-shot "launch this profile"
  // verb. Equivalent to POST /v1/sessions with {profile_id: <id>,
  // archetype: <profile.archetype>} but
  // saves the customer one round-trip + a name-lookup. The endpoint
  // path lives under /v1/profiles because semantically it's a profile-
  // verb (the resulting session is a side-effect); the handler lives
  // here to keep the create-with-profile_id logic in one place.
  app.post<{ Params: { id: string } }>(
    '/v1/profiles/:id/launch',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('write:sessions'),
        app.rateLimit('sessions:create'),
      ],
    },
    async (request, reply) => {
      const ctx = requireCtx(request);
      const rawBody = request.body ?? {};
      // Keep the same fail-closed transport boundary as POST /v1/sessions.
      // This precedes profile lookup, quota checks, create and touch.
      assertDirectSessionEgressAvailable(rawBody, egressProxyRequired);
      const launchBody = LaunchProfileRequestSchema.parse(rawBody);
      const profileIdPrefixed = request.params.id;
      // Strip prof_ prefix to the raw UUID (matches PROFILE_ID_RE in
      // routes/profiles.ts).
      const profileIdMatch =
        /^prof_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
          profileIdPrefixed,
        );
      if (profileIdMatch === null) {
        throw new BadRequestError(
          `Invalid profile id ${profileIdPrefixed} (expected prof_<uuid>).`,
        );
      }
      const profileId = profileIdMatch[1] as string;
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const ownerAccountId = effective.kind === 'team' ? effective.accountId : ctx.account.id;
      // Resolve the OWNER's tier up front (storage-quota gate + concurrent cap
      // both meter the owner). Admin-role + owner-existence guards move ahead of
      // the binding so they run before any owner-scoped side effect — mirrors
      // POST /v1/sessions. A profile launch is ALWAYS profile-backed, so the
      // doc-150 item 6 storage gate inside resolveProfileBinding always runs.
      let ownerTier: AccountTier;
      if (effective.kind === 'team') {
        if (effective.role !== 'admin') {
          throw new ForbiddenError(
            'Launching a profile on a team owner requires admin role on that team.',
          );
        }
        const owner = await authRepo.getAccount(effective.accountId);
        if (!owner) {
          throw new ForbiddenError('Owner account no longer exists.');
        }
        ownerTier = owner.tier;
      } else {
        ownerTier = ctx.account.tier;
      }
      const binding = await resolveProfileBinding(profileId, ownerAccountId, ownerTier);
      const body = {
        archetype: binding.archetype,
        label: launchBody.label,
        metadata: binding.metadata,
        profile_id: profileId,
      } as const;
      let created: SessionRecord;
      if (effective.kind === 'team') {
        created = await service.create(ctx, body, {
          effectiveAccountId: ownerAccountId,
          effectiveTier: ownerTier,
          inheritedProfileArchetype: true,
        });
      } else {
        created = await service.create(ctx, body, { inheritedProfileArchetype: true });
      }
      if (profilesService) {
        void profilesService
          .touch({ id: profileId, accountId: ownerAccountId, at: new Date() })
          .catch(() => undefined);
      }
      return reply.code(201).send(publicSession(created));
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
  // V-326e3 — admin-only when targeting an owner via X-Driftstack-
  // Account; member role gets 403.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/navigate',
    {
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = NavigateRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.navigate(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return {
        url: result.url,
        final_url: result.finalUrl,
        status: result.status,
        duration_ms: result.durationMs,
      };
    },
  );

  // ── POST /v1/sessions/:id/interact ─────────────────────────────────────
  // V-326e3 — same admin-only gate as navigate.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/interact',
    {
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = InteractRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.interact(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return { ok: true as const, duration_ms: result.durationMs };
    },
  );

  // ── POST /v1/sessions/:id/gui-input ────────────────────────────────────
  // GUI-control plane (L-001). Coordinate-level primitives that bypass
  // the behavioral simulation layer. Gated behind `gui_control` scope —
  // customer keys never carry this; only enterprise self-hosted GUI
  // keys do. See docs/locked-decisions.md.
  // V-326e3 — same admin-only gate as the other write actions.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/gui-input',
    {
      preHandler: [app.requireAuth, app.requireScope('gui_control'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = GUIInputRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.guiInput(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return { ok: true as const, duration_ms: result.durationMs };
    },
  );

  // ── POST /v1/sessions/:id/wait ─────────────────────────────────────────
  // V-326e3 — same admin-only gate.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/wait',
    {
      // wait is a state-mutating driver op (drives the live session, writes a
      // `waited` event, and forces `errored` on timeout) — same write gate as
      // navigate/interact, NOT a read. A read-only scope must NOT drive sessions.
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = WaitRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.wait(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return { satisfied: result.satisfied, duration_ms: result.durationMs };
    },
  );

  // ── GET /v1/sessions/:id ───────────────────────────────────────────────
  // Detail endpoint — surfaces the session record + harness-reported
  // egress_capabilities (migration 0045, cross-agent contract 7d5992d9).
  // V-326e3 — describe is a READ; both 'member' and 'admin' roles allowed
  // on team-scoped requests.
  // #122 — read:sessions floor. GET /v1/sessions (list) already gates
  // read:sessions in SessionsService.list() (V-553.B-21), but the
  // single-session reads below (describe / getState) went through
  // service methods that only enforce ownership, NOT scope — so a
  // narrow write:sessions-only or gui_control key could read one
  // session's full record + live state (url / cookies / localStorage)
  // even though it can't list. Closing the gap at the route layer (the
  // service's requireOwned is SHARED with the write actions, which must
  // NOT get a read gate) makes single-session reads consistent with the
  // list route. Broad `read` + `account_owner` bearers satisfy it via
  // the V-481 broad-satisfies-granular rule, so existing keys and the
  // dashboard are unaffected.
  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id',
    {
      preHandler: [app.requireAuth, app.requireScope('read:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const session = await service.describe(
        ctx,
        id,
        effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {},
      );
      return publicSession(session);
    },
  );

  // ── GET /v1/sessions/:id/state ─────────────────────────────────────────
  // Live state exposes cookies/localStorage and claims the driver while it
  // captures. Team members may read persisted list/detail metadata, but only
  // team admins may perform this live operation on the owner's session.
  // `read:sessions` remains the API-key scope floor for self and team-admin
  // callers; broad `read` / `account_owner` keys continue to satisfy it.
  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/state',
    {
      preHandler: [app.requireAuth, app.requireScope('read:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const state = await service.getState(
        ctx,
        id,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return {
        url: state.url,
        title: state.title,
        cookies: state.cookies,
        local_storage: state.localStorage,
        // W615 — page lifecycle for pollers (GUI loading bar / error overlay).
        page_state: state.pageState,
        captured_at: state.capturedAt.toISOString(),
      };
    },
  );

  // ── POST /v1/sessions/:id/capture ──────────────────────────────────────
  // V-326e3 — capture is a WRITE (it mutates the driver state via
  // screenshot/snapshot ops + records billed events). Admin-only on
  // team-scoped requests.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/capture',
    {
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = CaptureRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.capture(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return {
        kind: result.kind,
        data: result.data,
        encoding: result.encoding,
        byte_size: result.byteSize,
        duration_ms: result.durationMs,
      };
    },
  );

  // ── POST /v1/sessions/:id/extract ──────────────────────────────────────
  // Read structured page data (harness `extract` intent, A3 W456). A driver
  // read-op like capture; same admin-only write-scope gate (it drives the
  // session). Returns the extracted `value` map keyed by each extraction name.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/extract',
    {
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = ExtractRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.extract(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return { value: result.value, duration_ms: result.durationMs };
    },
  );

  // ── POST /v1/sessions/:id/search ───────────────────────────────────────
  // Find the search field, type the query, submit (harness `search` intent).
  // A driver write-op; same admin-only write-scope gate.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/search',
    {
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = SearchRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.search(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      if (result.queryTruncated) {
        return {
          submitted: false as const,
          query_truncated: true as const,
          duration_ms: result.durationMs,
        };
      }
      return {
        submitted: result.submitted,
        query_truncated: false as const,
        ...(result.resultsVisible !== undefined ? { results_visible: result.resultsVisible } : {}),
        duration_ms: result.durationMs,
      };
    },
  );

  // ── POST /v1/sessions/:id/login ────────────────────────────────────────
  // Heuristic credential login (harness `login` intent). A driver write-op;
  // same admin-only write-scope gate. The password is never logged.
  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/login',
    {
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = requireCtx(request);
      const id = uuidFromPrefixedId(request.params.id, 'ses');
      const body = SessionLoginRequestSchema.parse(request.body ?? {});
      const eff = effectiveAccountIdForLiveOperation(request, ctx);
      const result = await service.login(
        ctx,
        id,
        body,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      if (!result.submitted) {
        return {
          submitted: false as const,
          credentials_truncated: true as const,
          logged_in: false as const,
          duration_ms: result.durationMs,
        };
      }
      return {
        submitted: true as const,
        credentials_truncated: false as const,
        logged_in: result.loggedIn,
        ...(result.postLoginUrl !== undefined ? { post_login_url: result.postLoginUrl } : {}),
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
      preHandler: [app.requireAuth, app.requireScope('write:sessions'), app.rateLimit('global')],
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
