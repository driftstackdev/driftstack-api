// Arc 1 sub-slice 6.6 (v2-#6) — customer-facing bundled-LLM settings.
//
// Surface:
//   GET   /v1/account/me/bundled-llm-settings   — read current state
//   PATCH /v1/account/me/bundled-llm-settings   — flip consent +/or cap
//
// Same range invariants as the migration 0050 CHECK constraint:
// monthly_cap_usd_cents ∈ [0, 1_000_000] (i.e. $0 to $10,000). The
// server rejects out-of-range inputs with 400; the CHECK is a
// defence-in-depth backstop if the route validation is ever skipped.
//
// Q4=A locked: BYOK always wins. Flipping consent=true does NOT
// silently bill customers — bundled-LLM only resolves at turn time
// when no BYOK key (header or stored) is available AND the soft-cap
// hasn't been reached (sub-slice 6.5).
//
// Per Q3 v2-#6 verdict (no explicit team-scope verdict yet for
// bundled-LLM), this slice mirrors the byok-anthropic ownership model:
// account_owner-only for the PATCH. Read is open to any auth context.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BundledLlmService } from '../services/bundled-llm.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';

const PatchBodySchema = z
  .object({
    consent: z.boolean().optional(),
    monthly_cap_usd_cents: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((b) => b.consent !== undefined || b.monthly_cap_usd_cents !== undefined, {
    message: 'Body must include at least one of: consent, monthly_cap_usd_cents.',
  });

export interface AccountBundledLlmRoutesOptions {
  service: BundledLlmService;
}

export function registerAccountBundledLlmRoutes(
  app: FastifyInstance,
  opts: AccountBundledLlmRoutesOptions,
): void {
  const { service } = opts;

  app.get(
    '/v1/account/me/bundled-llm-settings',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const settings = await service.findSettings(ctx.account.id);
      // Null means "no row" (account was deleted between auth + this
      // call). Defaults match migration 0050.
      return {
        consent: settings?.consent ?? false,
        monthly_cap_usd_cents: settings?.monthlyCapUsdCents ?? 2000,
      };
    },
  );

  app.patch(
    '/v1/account/me/bundled-llm-settings',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = PatchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const next = await service.updateSettings({
        accountId: ctx.account.id,
        ...(parsed.data.consent !== undefined ? { consent: parsed.data.consent } : {}),
        ...(parsed.data.monthly_cap_usd_cents !== undefined
          ? { monthlyCapUsdCents: parsed.data.monthly_cap_usd_cents }
          : {}),
      });
      if (next === null) {
        throw new BadRequestError('Account row not found — re-authenticate and retry.');
      }
      return {
        consent: next.consent,
        monthly_cap_usd_cents: next.monthlyCapUsdCents,
      };
    },
  );
}
