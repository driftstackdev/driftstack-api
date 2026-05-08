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
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  UpdateAccountMeRequestSchema,
  type AccountTier,
} from '@driftstack/api-types';
import type { AccountAuthRepo } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { SessionRepo } from '../services/sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

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

  app.get(
    '/v1/account/me',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const accountId = ctx.account.id;
      const tier = ctx.account.tier;

      // Parallel fan-out: counts + tier-derived caps. Tier caps come
      // from in-memory constants so they cost nothing.
      const [activeSessions, profileCount] = await Promise.all([
        sessionRepo.countActiveSessions(accountId),
        profilesRepo.countByAccount(accountId),
      ]);

      return {
        id: `acc_${accountId}`,
        email: ctx.account.email,
        name: ctx.account.name,
        tier,
        status: ctx.account.status,
        // V-352 — IANA timezone (null = UTC fallback for client renders).
        timezone: ctx.account.timezone,
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
      const updated = await authRepo.updateAccountBasics(ctx.account.id, parsed.data);
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
      return {
        id: `acc_${updated.id}`,
        email: updated.email,
        name: updated.name,
        tier: updated.tier,
        status: updated.status,
        timezone: updated.timezone,
      };
    },
  );
}
