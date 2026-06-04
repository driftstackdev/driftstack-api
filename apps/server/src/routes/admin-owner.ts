// Owner-only platform routes (master-owner cockpit).
//
//   GET   /v1/admin/owner/platform-status  — activation flags
//   GET   /v1/admin/owner/pricing          — current per-tier monthly pricing
//   PATCH /v1/admin/owner/pricing/:tier    — edit a tier's monthly price (audited)
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
import { z } from 'zod';
import type { AccountTier } from '@driftstack/api-types';
import type { PricingService } from '../services/pricing.js';
import type { AdminAuditService } from '../services/admin-audit.js';
import { ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
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
  pricing: PricingService;
  /**
   * Admin audit recorder. The owner price-edit route writes a
   * `pricing.updated` admin_audit_log row before returning (D-025:
   * audit-before-response, on both success AND failure).
   */
  audit: AdminAuditService;
}

// Only the priced tiers are editable — the pricing table + PricingService
// derive from TIER_MONTHLY_PRICE_CENTS, so an edit to a non-priced tier
// (e.g. free) would persist a row no reader surfaces. Mirrors the
// SUPPORTED_PRODUCTS-from-the-price-map pattern in billing-crypto.ts.
const EDITABLE_TIERS = Object.keys(TIER_MONTHLY_PRICE_CENTS) as [string, ...string[]];
const EditPricingParamsSchema = z.object({ tier: z.enum(EDITABLE_TIERS) });
// Ceiling mirrors PricingService.MAX_MONTHLY_CENTS + the crypto price_cents
// bound; the service re-validates as a backstop.
const EditPricingBodySchema = z.object({
  monthly_cents: z.number().int().positive().max(1_000_000),
});

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

  // Owner-only: edit a tier's monthly price (pricing-as-data Phase A). The
  // DB pricing table (migration 0067) is the source of truth; an edit here
  // is reflected by BOTH readers that consume PricingService.listEffective()
  // — the owner /pricing view above AND the crypto-checkout charge — so the
  // price customers pay actually changes (no editable-price-that-doesn't-
  // charge footgun). Owner-gated (identity, not scope) + audited per D-025.
  app.patch<{ Params: { tier: string } }>(
    '/v1/admin/owner/pricing/:tier',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireOwner');

      const params = EditPricingParamsSchema.safeParse(req.params);
      if (!params.success) throw new ValidationError(params.error.flatten());
      const body = EditPricingBodySchema.safeParse(req.body);
      if (!body.success) throw new ValidationError(body.error.flatten());

      const tier = params.data.tier as AccountTier;
      const monthlyCents = body.data.monthly_cents;

      // D-025: audit BEFORE returning, on success AND error. A failed edit
      // (e.g. DB write error) still records the attempt before re-throwing.
      try {
        const updated = await opts.pricing.setPrice(tier, monthlyCents, ctx.apiKey.id);
        await opts.audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'pricing.updated',
          targetResourceId: tier,
          inputPayload: { tier, monthly_cents: monthlyCents },
          result: 'success',
          ipAddress: readClientIp(req),
        });
        void reply.code(200);
        return { tier: updated.tier, monthly_cents: updated.monthlyCents };
      } catch (err) {
        const code =
          err instanceof Error && err.name
            ? err.name.toLowerCase().replace(/error$/, '')
            : 'unknown';
        await opts.audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'pricing.updated',
          targetResourceId: tier,
          inputPayload: { tier, monthly_cents: monthlyCents },
          result: `error: ${code}`,
          ipAddress: readClientIp(req),
        });
        throw err;
      }
    },
  );
}
