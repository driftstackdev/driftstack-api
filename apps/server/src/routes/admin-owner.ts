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
import type { PlatformSecretsService } from '../services/platform-secrets.js';
import type { AdminAuditService } from '../services/admin-audit.js';
import { FeatureUnavailableError, NotFoundError, ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import { TIER_MONTHLY_PRICE_CENTS } from '../lib/cost-defaults.js';
import {
  isValidPlatformSecretValue,
  PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES,
} from '../lib/platform-secret-value-encryption.js';

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
   * audit-before-response, on both success AND failure); the secrets routes
   * write `secret.created|updated|deleted|revealed` the same way.
   */
  audit: AdminAuditService;
  /**
   * Platform-secrets service (secrets Phase A, migration 0074). Encrypted
   * at rest (BYOK blob pattern under MFA_ENCRYPTION_KEY); list is metadata-
   * only, reveal is the single decrypt path and ALWAYS audited.
   */
  secrets: PlatformSecretsService;
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

// Secrets Phase A slice 2. The route layer re-validates what the service also
// enforces (slug + bounds) so a bad request 400s before touching the service;
// the service stays the backstop for non-route callers.
const SecretNameParamsSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?$/, 'lowercase snake_case slug'),
});
const SetSecretBodySchema = z.object({
  value: z.string().refine(isValidPlatformSecretValue, {
    message: `must be 1-${PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES.toString()} exact UTF-8 bytes`,
  }),
  description: z.string().max(256).nullable().optional(),
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

  // ── Secrets Phase A slice 2 — owner-only platform-secret management. ──
  // Encrypted at rest (migration 0074); list NEVER returns values; reveal is
  // the single decrypt path and is ALWAYS audited (D-025: audit before
  // returning, success AND error — a reveal you can't account for is the
  // failure mode this surface exists to prevent).

  app.get(
    '/v1/admin/owner/secrets',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    async () => {
      const metas = await opts.secrets.list();
      return {
        enabled: opts.secrets.enabled,
        secrets: metas.map((m) => ({
          name: m.name,
          description: m.description,
          created_at: m.createdAt.toISOString(),
          updated_at: m.updatedAt.toISOString(),
        })),
      };
    },
  );

  app.put<{ Params: { name: string }; Body: unknown }>(
    '/v1/admin/owner/secrets/:name',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireOwner');
      // V-352b mapping the service header documents: key unset → clean 503,
      // not a generic 500 from the service's plain Error.
      if (!opts.secrets.enabled) {
        throw new FeatureUnavailableError(
          'Platform secrets are disabled on this deployment (MFA_ENCRYPTION_KEY unset).',
        );
      }
      const params = SecretNameParamsSchema.safeParse(req.params);
      if (!params.success) throw new ValidationError(params.error.flatten());
      const body = SetSecretBodySchema.safeParse(req.body);
      if (!body.success) throw new ValidationError(body.error.flatten());

      // Preclassify only for a meaningful failure audit if validation/storage
      // fails before the atomic upsert returns. Success always uses the
      // repository-authoritative outcome, never this metadata snapshot.
      let action: 'secret.created' | 'secret.updated' = 'secret.updated';
      try {
        const existing = await opts.secrets.list();
        action = existing.some((m) => m.name === params.data.name)
          ? 'secret.updated'
          : 'secret.created';
        const outcome = await opts.secrets.set({
          name: params.data.name,
          value: body.data.value,
          description: body.data.description ?? null,
          updatedByKeyId: ctx.apiKey.id,
        });
        action = outcome === 'updated' ? 'secret.updated' : 'secret.created';
        await opts.audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action,
          targetResourceId: params.data.name,
          // NEVER the value — name + description only (D-025 + the taint rule).
          inputPayload: { name: params.data.name, description: body.data.description ?? null },
          result: 'success',
          ipAddress: readClientIp(req),
        });
        void reply.code(outcome === 'updated' ? 200 : 201);
        return { name: params.data.name, status: outcome };
      } catch (err) {
        const code =
          err instanceof Error && err.name
            ? err.name.toLowerCase().replace(/error$/, '')
            : 'unknown';
        await opts.audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action,
          targetResourceId: params.data.name,
          inputPayload: { name: params.data.name },
          result: `error: ${code}`,
          ipAddress: readClientIp(req),
        });
        throw err;
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/v1/admin/owner/secrets/:name/reveal',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    async (req) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireOwner');
      // Same V-352b mapping as PUT — reveal needs the key to decrypt.
      if (!opts.secrets.enabled) {
        throw new FeatureUnavailableError(
          'Platform secrets are disabled on this deployment (MFA_ENCRYPTION_KEY unset).',
        );
      }
      const params = SecretNameParamsSchema.safeParse(req.params);
      if (!params.success) throw new ValidationError(params.error.flatten());
      try {
        const value = await opts.secrets.reveal(params.data.name);
        if (value === null) throw new NotFoundError(`Secret ${params.data.name} not found.`);
        await opts.audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'secret.revealed',
          targetResourceId: params.data.name,
          inputPayload: { name: params.data.name },
          result: 'success',
          ipAddress: readClientIp(req),
        });
        // The one place plaintext crosses the API boundary — owner-only,
        // audited above BEFORE the response leaves.
        return { name: params.data.name, value: value as string };
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          const code =
            err instanceof Error && err.name
              ? err.name.toLowerCase().replace(/error$/, '')
              : 'unknown';
          await opts.audit.record({
            adminAccountId: ctx.account.id,
            adminKeyId: ctx.apiKey.id,
            action: 'secret.revealed',
            targetResourceId: params.data.name,
            inputPayload: { name: params.data.name },
            result: `error: ${code}`,
            ipAddress: readClientIp(req),
          });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/v1/admin/owner/secrets/:name',
    { preHandler: [app.requireOwner, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireOwner');
      const params = SecretNameParamsSchema.safeParse(req.params);
      if (!params.success) throw new ValidationError(params.error.flatten());
      // Audit-before-response on BOTH success AND failure (D-025), mirroring the
      // PUT + reveal siblings — a failed deletion of a high-value platform secret
      // must still leave a trace. (A benign not-found is excluded, same as reveal.)
      try {
        const removed = await opts.secrets.remove(params.data.name);
        if (!removed) throw new NotFoundError(`Secret ${params.data.name} not found.`);
        await opts.audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'secret.deleted',
          targetResourceId: params.data.name,
          inputPayload: { name: params.data.name },
          result: 'success',
          ipAddress: readClientIp(req),
        });
        return reply.code(204).send();
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          const code =
            err instanceof Error && err.name
              ? err.name.toLowerCase().replace(/error$/, '')
              : 'unknown';
          await opts.audit.record({
            adminAccountId: ctx.account.id,
            adminKeyId: ctx.apiKey.id,
            action: 'secret.deleted',
            targetResourceId: params.data.name,
            inputPayload: { name: params.data.name },
            result: `error: ${code}`,
            ipAddress: readClientIp(req),
          });
        }
        throw err;
      }
    },
  );
}
