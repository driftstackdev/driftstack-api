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
import type { PricingService } from '../services/pricing.js';

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
  pricing: PricingService;
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
    async () => {
      // Current per-tier monthly pricing (cents) via PricingService — the DB
      // pricing table (migration 0067), falling back to the TIER_MONTHLY_PRICE_CENTS
      // constant per tier (seeded == constants, so identical until an owner edits).
      // READ-ONLY here; owner-edit (CRUD) + the crypto/cost-cap rewire onto this
      // same service are the next pricing-as-data increments.
      const rows = await opts.pricing.listEffective();
      return { tiers: rows.map((r) => ({ tier: r.tier, monthly_cents: r.monthlyCents })) };
    },
  );
}
