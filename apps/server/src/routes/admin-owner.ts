// Owner-only platform routes (master-owner cockpit).
//
//   GET /v1/admin/owner/platform-status  — activation flags
//   GET /v1/admin/owner/pricing          — current per-tier monthly pricing (read-only)
//
// Read-only operational snapshot for the project OWNER: which
// activation-gated features are wired in THIS deployment (billing /
// livekit / crypto / oauth-client / sentry) plus the permissive-CORS
// posture. Owner-gated via `app.requireOwner` — an identity check on the
// configured owner email, NOT a staff scope — per the master-owner model:
// staff-admins keep their existing powers; the owner alone gets the
// high-power project-config surface (this is its first consumer).
//
// NO secrets are exposed — only boolean "is it configured" flags, each
// derived from the exact same `deps.X !== undefined` check app.ts uses to
// decide whether to register that feature's routes, so the flag truthfully
// reflects whether the feature is live in this deployment.

import type { FastifyInstance } from 'fastify';
import { TIER_MONTHLY_PRICE_CENTS } from '../lib/cost-defaults.js';

export interface OwnerPlatformStatus {
  billing: boolean;
  livekit: boolean;
  crypto: boolean;
  oauth_client: boolean;
  sentry: boolean;
  permissive_cors: boolean;
}

export interface AdminOwnerRoutesOptions {
  platformStatus: OwnerPlatformStatus;
}

export function registerAdminOwnerRoutes(
  app: FastifyInstance,
  opts: AdminOwnerRoutesOptions,
): void {
  app.get(
    '/v1/admin/owner/platform-status',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    () => {
      // Boot-time activation posture; no secrets, no per-request state.
      // Sync handler — no I/O, so no async (avoids require-await lint).
      return { features: opts.platformStatus };
    },
  );

  app.get(
    '/v1/admin/owner/pricing',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    () => {
      // Current per-tier monthly pricing (cents) — the single source that
      // the crypto-checkout charge, the cost-cap thresholds, and the
      // customer-facing display all derive from (TIER_MONTHLY_PRICE_CENTS).
      // READ-ONLY: the foundation for owner-editable pricing. Making this
      // DB-sourced + live-editable + Stripe-synced is the separate,
      // founder-design-gated pricing-as-data arc (grandfathering + sync
      // semantics must be decided first) — no mutation here.
      const tiers = Object.entries(TIER_MONTHLY_PRICE_CENTS).map(([tier, monthlyCents]) => ({
        tier,
        monthly_cents: monthlyCents ?? 0,
      }));
      return { tiers };
    },
  );
}
