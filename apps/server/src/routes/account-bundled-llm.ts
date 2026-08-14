// Arc 1 sub-slice 6.6 (v2-#6) — customer-facing bundled-LLM settings.
//
// Surface:
//   GET   /v1/account/me/bundled-llm-settings   — read current state
//   PATCH /v1/account/me/bundled-llm-settings   — flip consent +/or cap
//   GET   /v1/account/me/bundled-llm-status     — spend + remaining (sub-slice 6.7)
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
// account_owner-only for the PATCH. Reads require broad `read` so a
// resource-granular or zero-scope key cannot inspect billing consent/spend.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BundledLlmService } from '../services/bundled-llm.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
// S42 2026-07-07 (founder-approved) — bundled-LLM consent tier gate.
import { requireBundledLlmTier } from '../lib/errors-helpers.js';
import { readClientIp } from '../lib/client-ip.js';

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
  /** 2026-05-20 — customer audit-log writer. PATCH that changes the
   *  consent boolean emits `account.bundled_llm_consent_changed` so
   *  the customer can audit every flip. Cap-only updates don't audit
   *  (less load-bearing for billing-rail switches; if needed later,
   *  separate `account.bundled_llm_cap_changed` enum value can be
   *  added). */
  accountAudit?: AccountAuditService;
}

export function registerAccountBundledLlmRoutes(
  app: FastifyInstance,
  opts: AccountBundledLlmRoutesOptions,
): void {
  const { service } = opts;
  const accountAudit = opts.accountAudit;

  app.get(
    '/v1/account/me/bundled-llm-settings',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
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

  // Arc 1 sub-slice 6.7 (v2-#6) — dashboard data endpoint. Returns
  // consent / cap / month-to-date spend / remaining headroom. The
  // refused_count_this_month field does NOT track anything: refusals
  // do occur — a turn past the cap throws BundledLlmBudgetExhausted
  // and is counted for operators in Prometheus — but no per-account
  // counter is persisted anywhere, so the field reports 0 as a
  // placeholder and the published schema discloses that. Customer +
  // dashboard can branch on `remaining_cents <= 0` for the same
  // "you've hit the cap" UX.
  app.get(
    '/v1/account/me/bundled-llm-status',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const now = new Date();
      const settings = await service.findSettings(ctx.account.id);
      const consent = settings?.consent ?? false;
      const capCents = settings?.monthlyCapUsdCents ?? 2000;
      const usedCents = await service.sumMonthlySpendCents({
        accountId: ctx.account.id,
        now,
      });
      const remaining = Math.max(0, capCents - usedCents);
      return {
        consent,
        cap_cents: capCents,
        used_this_month_cents: usedCents,
        remaining_cents: remaining,
        // Placeholder, not a measurement — see the header comment. When a real
        // counter lands, remove the schema disclosure with it (a guard fails
        // if this stops being a literal, and says so).
        refused_count_this_month: 0,
        // ISO-8601 calendar-month-start so the dashboard can render
        // "resets on <date>" without re-deriving the boundary itself.
        month_started_at: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
        ).toISOString(),
      };
    },
  );

  app.patch(
    '/v1/account/me/bundled-llm-settings',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = PatchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // S42 2026-07-07 (founder-approved) — gate the bundled-billing OPT-IN to
      // the tiers whose TIER_FEATURES.llmBilling is byok_or_bundled(_custom):
      // api_builder / api_scale / enterprise. Only consent=true is gated —
      // consent=false (opting OUT) and cap-only PATCHes stay open on every
      // tier, so a downgraded account can always switch bundled billing off.
      // BYOK settings (routes/account-byok-anthropic.ts) stay open to every
      // aiAgent tier; this route is account_owner-scoped, so ctx.account IS
      // the tier that gets billed.
      if (parsed.data.consent === true) {
        requireBundledLlmTier(ctx.account.tier);
      }
      // Capture prior consent state so we can detect a true toggle
      // (not just a no-op re-write) before emitting the audit row.
      const prior = await service.findSettings(ctx.account.id);
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
      // 2026-05-20 — audit emit ONLY when consent actually changed.
      // Cap-only PATCHes don't audit (separate enum value if later
      // needed). Best-effort emit; audit failure must not break the
      // PATCH response.
      if (
        accountAudit !== undefined &&
        parsed.data.consent !== undefined &&
        (prior?.consent ?? false) !== next.consent
      ) {
        try {
          await accountAudit.record({
            accountId: ctx.account.id,
            actorType: 'customer',
            action: 'account.bundled_llm_consent_changed',
            targetResourceId: `account_${ctx.account.id}`,
            payload: {
              from: prior?.consent ?? false,
              to: next.consent,
            },
            ipAddress: readClientIp(request),
          });
        } catch {
          /* swallow */
        }
      }
      return {
        consent: next.consent,
        monthly_cap_usd_cents: next.monthlyCapUsdCents,
      };
    },
  );
}
