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
  type AccountTier,
} from '@driftstack/api-types';
import type { SessionRepo } from '../services/sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';

export interface AccountMeRoutesOptions {
  /** Session count source — same repo SessionsService uses. */
  sessionRepo: SessionRepo;
  /** Profile count source — same repo ProfilesService uses. */
  profilesRepo: ProfilesRepo;
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
  const { sessionRepo, profilesRepo } = opts;

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
        concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS[tier],
        concurrent_session_active: activeSessions,
        profile_cap: profileCapFor(tier),
        profile_count: profileCount,
      };
    },
  );
}
