// V-237 — customer self-profile endpoint.
// GET /v1/account/me — returns the calling account's identity + tier
// + concurrent-session usage/cap + profile usage/cap. Powers the GUI
// client's tier-aware enforcement display (file 128 spec mirror) so
// the customer sees "X / Y concurrent sessions" + "P / Q profiles"
// before the API enforces the cap with a 402.
//
// Distinct from `/v1/account/rate-limits` (per-bucket limit config)
// and `/v1/account/audit-log` (event ledger) — this is the dashboard
// header view.

import type { FastifyInstance } from 'fastify';
import {
  AVATAR_MAX_BYTES,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  UpdateAccountMeRequestSchema,
  UploadAvatarRequestSchema,
  type AccountTier,
} from '@driftstack/api-types';
import type { AccountAuthRepo } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { SessionRepo } from '../services/sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';
import type { MfaService } from '../services/mfa.js';
import { avatarKey, type R2 } from '../lib/r2.js';
import {
  BadRequestError,
  ConflictError,
  FeatureUnavailableError,
  NotFoundError,
} from '../lib/errors.js';

/** V-352b — avatar presigned-GET TTL. 1h is long enough that a single
 *  dashboard render doesn't churn signed URLs but short enough that
 *  rotating the bucket secret invalidates outstanding URLs in <1h. */
const AVATAR_PRESIGN_TTL_SECONDS = 60 * 60;

export interface AccountMeRoutesOptions {
  /** Session count source — same repo SessionsService uses. */
  sessionRepo: SessionRepo;
  /** Profile count source — same repo ProfilesService uses. */
  profilesRepo: ProfilesRepo;
  /** V-352 — needed for PATCH /v1/account/me (name + timezone update). */
  authRepo: AccountAuthRepo;
  /** V-352 — invalidated on PATCH /v1/account/me so the next request
   *  picks up the updated row instead of the stale cached AccountContext. */
  authCache?: AuthCache | null;
  /** V-352b — public-bucket R2 client for avatar upload + presigned GET.
   *  Null when public bucket is not configured (avatar endpoints return 503). */
  r2Public?: R2 | null;
  /** V-353h — MFA service. When wired, GET /v1/account/me surfaces
   *  `mfa_enrolled` so the dashboard can render enrollment status
   *  without a second roundtrip. Null = MFA not wired (flag always
   *  false on the response). */
  mfaService?: MfaService | null;
}

/**
 * Resolve the profile cap for a tier. `PROFILES_PER_TIER` returns
 * `'custom'` for enterprise (negotiated per-customer); we surface
 * that as `null` to the customer (read: "no fixed cap on this tier;
 * see your contract"). All other tiers return a numeric cap.
 */
function profileCapFor(tier: AccountTier): number | null {
  const cap = PROFILES_PER_TIER[tier];
  return cap === 'custom' ? null : cap;
}

export function registerAccountMeRoutes(app: FastifyInstance, opts: AccountMeRoutesOptions): void {
  const { sessionRepo, profilesRepo, authRepo } = opts;
  const authCache = opts.authCache ?? null;
  const r2Public = opts.r2Public ?? null;
  const mfaService = opts.mfaService ?? null;

  // V-352b — best-effort presigned GET URL for the avatar. Returns null
  // when no avatar is set, when the public R2 bucket is not configured,
  // or when the presign call itself fails (logged + swallowed: a stale
  // /me read should never 500 just because R2 hiccuped).
  async function presignAvatar(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (!r2Public) return null;
    try {
      return await r2Public.presignGet({
        key,
        expiresIn: AVATAR_PRESIGN_TTL_SECONDS,
      });
    } catch (err) {
      app.log.warn({ err, key }, 'avatar presign failed');
      return null;
    }
  }

  app.get(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const accountId = ctx.account.id;
      const tier = ctx.account.tier;

      // Parallel fan-out: counts + tier-derived caps + avatar presign + MFA.
      // Tier caps come from in-memory constants so they cost nothing.
      const [activeSessions, profileCount, avatarUrl, mfaStatus] = await Promise.all([
        sessionRepo.countActiveSessions(accountId),
        profilesRepo.countByAccount(accountId),
        presignAvatar(ctx.account.avatarR2Key),
        mfaService ? mfaService.getStatus(accountId) : Promise.resolve(null),
      ]);

      return {
        id: `acc_${accountId}`,
        email: ctx.account.email,
        name: ctx.account.name,
        tier,
        status: ctx.account.status,
        // V-352 — IANA timezone (null = UTC fallback for client renders).
        timezone: ctx.account.timezone,
        // V-298a — readable account handle (null when unset).
        slug: ctx.account.slug,
        // V-298b — data-residency region preference (null when unset).
        region: ctx.account.region,
        // V-352b — presigned R2 GET URL for the customer's uploaded
        // avatar; null when none uploaded or the public bucket isn't
        // wired in this deploy. URL is short-lived (1h).
        avatar_url: avatarUrl,
        // V-353h — MFA enrollment flag for dashboard header / settings.
        mfa_enrolled: mfaStatus !== null && mfaStatus.enrolled,
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
        // V-326c — owner accounts the caller is a member of (empty
        // array when not on any team). Each entry exposes the public
        // owner id + the role granted to the caller. Used by the
        // dashboard / GUI to render an "acting as" account picker.
        teams: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  // V-352 — partial update of the calling account's basics
  // (name + timezone). Other fields (email / tier / status /
  // stripeCustomerId) have dedicated flows and aren't reachable here.
  // Note: V-326 effective-account header is intentionally NOT honored
  // — /v1/account/me always operates on the caller's own account.
  // Acting on a team owner's account.name / timezone would be
  // surprising; if needed, lands in V-352c with explicit semantics.
  app.patch(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = UpdateAccountMeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      let updated;
      try {
        updated = await authRepo.updateAccountBasics(ctx.account.id, parsed.data);
      } catch (err) {
        // V-298a — repo throws SLUG_TAKEN when the unique-constraint
        // collides with another account's slug. 409 surfaces it.
        if (err instanceof Error && err.message === 'SLUG_TAKEN') {
          throw new ConflictError('That slug is already taken. Pick a different one.');
        }
        throw err;
      }
      if (!updated) throw new NotFoundError('Account not found.');
      // Invalidate the cached AccountContext so the next request reads
      // the freshly-updated row. Best-effort; cache failure must never
      // block the user-facing op.
      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }
      // Return the same full-shape response as GET /me — the OpenAPI
      // spec + every SDK type claim AccountMeResponse (15 fields).
      // Previously the route returned only the 8 written/persisted
      // fields, causing a type-vs-runtime mismatch on every SDK
      // consumer (avatar_url / mfa_enrolled / concurrent_session_*
      // / profile_* / teams[] all undefined under types claiming
      // string|null / boolean / number / array).
      const tier = updated.tier;
      const [activeSessions, profileCount, avatarUrl, mfaStatus] = await Promise.all([
        sessionRepo.countActiveSessions(updated.id),
        profilesRepo.countByAccount(updated.id),
        presignAvatar(updated.avatarR2Key),
        mfaService ? mfaService.getStatus(updated.id) : Promise.resolve(null),
      ]);
      return {
        id: `acc_${updated.id}`,
        email: updated.email,
        name: updated.name,
        tier,
        status: updated.status,
        timezone: updated.timezone,
        slug: updated.slug,
        region: updated.region,
        avatar_url: avatarUrl,
        mfa_enrolled: mfaStatus !== null && mfaStatus.enrolled,
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
        teams: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  // V-352b — upload (or replace) the calling account's avatar. Inline
  // base64 body, validated for MIME + size, written to R2 public
  // bucket, then the DB pointer + auth-cache flush. The client gets a
  // presigned GET URL (same shape as /v1/account/me) so it never has
  // to handle bucket URLs directly.
  //
  // bodyLimit override: Fastify defaults to 1 MiB JSON. A 2 MiB raw
  // image becomes ~2.8 MiB base64; we cap the route at 3.5 MiB so a
  // legitimate 2 MiB upload + JSON envelope fits and anything beyond
  // is short-circuited as 413 by Fastify before our handler runs.
  app.post(
    '/v1/account/me/avatar',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
      bodyLimit: 3.5 * 1024 * 1024,
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      if (!r2Public) {
        throw new FeatureUnavailableError('Avatar uploads are not available on this deployment.');
      }
      const parsed = UploadAvatarRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(parsed.data.data_base64, 'base64');
      } catch {
        throw new BadRequestError('data_base64 is not valid base64.');
      }
      if (bytes.length === 0) {
        throw new BadRequestError('Avatar image is empty.');
      }
      if (bytes.length > AVATAR_MAX_BYTES) {
        throw new BadRequestError(`Avatar image is too large. Max ${AVATAR_MAX_BYTES} bytes.`);
      }

      const key = avatarKey(ctx.account.id, parsed.data.content_type);
      try {
        await r2Public.putObject({
          key,
          body: bytes,
          contentType: parsed.data.content_type,
        });
      } catch (err) {
        app.log.error({ err, key }, 'avatar upload to R2 failed');
        throw new FeatureUnavailableError('Avatar storage is temporarily unavailable.');
      }

      const updated = await authRepo.updateAccountBasics(ctx.account.id, {
        avatarR2Key: key,
      });
      if (!updated) throw new NotFoundError('Account not found.');

      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }

      const url = await presignAvatar(updated.avatarR2Key);
      reply.code(200);
      return {
        avatar_url: url,
        content_type: parsed.data.content_type,
        bytes: bytes.length,
      };
    },
  );

  // V-352b — clear the avatar pointer on the account row. The R2
  // object is intentionally left in place: a future sweeper job
  // collects orphaned avatar keys (off the hot path; avatars are
  // already public-readable so leaving stale objects is no worse
  // than the public bucket already is). Returns 204.
  app.delete(
    '/v1/account/me/avatar',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const updated = await authRepo.updateAccountBasics(ctx.account.id, {
        avatarR2Key: null,
      });
      if (!updated) throw new NotFoundError('Account not found.');

      if (authCache) {
        try {
          await authCache.invalidateAccount(ctx.account.id);
        } catch {
          /* swallow */
        }
      }

      reply.code(204);
      return null;
    },
  );
}
