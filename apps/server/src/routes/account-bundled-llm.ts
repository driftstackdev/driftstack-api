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
// 2026-09-19 — a NEW value is further bounded to BUNDLED_CAP_MAX_NEW_WRITE_CENTS
// ($100). The schema below keeps the storage bound because a stored cap above
// $100 is grandfathered and may be re-sent unchanged; the tighter bound is applied
// against the stored value (bundledCapWriteRefusal), not by the schema alone.
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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { z } from 'zod';
import {
  bundledCapWriteRefusal,
  movedAccountConsent,
  movedAccountCapWriteRefusal,
  movedAccountCreditsView,
  type BundledLlmService,
  type MovedAccountCreditsView,
} from '../services/bundled-llm.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { BadRequestError, ForbiddenError, ValidationError } from '../lib/errors.js';
// S42 2026-07-07 (founder-approved) — bundled-LLM consent tier gate.
import { requireBundledLlmTier } from '../lib/errors-helpers.js';
import { readClientIp } from '../lib/client-ip.js';
// S13 — the moved-account leg (§8.6). `aiIncludedForTier`/`ownKeyAllowedForTier`
// are the PLAN entitlement this route gates on for a moved account, in place
// of `requireBundledLlmTier` (that gate is legacy-only, S42).
import {
  aiIncludedForTier,
  aiNotOnPlanDetail,
  ownKeyAllowedForTier,
} from '../services/ai-entitlements.js';
import type { AiCreditsRuntime, CreditAccountRecord } from '../services/ai-credits-runtime.js';
import type { AccountTier } from '@driftstack/api-types';

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
  /**
   * S13 — what these three routes need to give a MOVED account (`billing_mode
   * = 'credits'`) the old shape's meaning instead of its old storage (§8.6):
   * `mode` to tell `enforce` from `shadow`/`off` (only `enforce` treats the
   * account as moved — §4.1's table), `accounts` for the account's
   * `ai_source` and the write that sets it, `windows` for its current
   * credit window. Optional and absent while `DRIFTSTACK_AI_CREDITS_MODE` is
   * off, same as every other credits wiring — every existing deployment and
   * test fixture is unaffected.
   */
  aiCredits?: Pick<AiCreditsRuntime, 'mode' | 'accounts' | 'windows'>;
}

export function registerAccountBundledLlmRoutes(
  app: FastifyInstance,
  opts: AccountBundledLlmRoutesOptions,
): void {
  const { service } = opts;
  const accountAudit = opts.accountAudit;
  const aiCredits = opts.aiCredits;

  /**
   * S13/§8.6 — whether `accountId` is MOVED for these three routes: only
   * true under `enforce` (§4.1's table treats `shadow` and `off` as legacy,
   * whatever `billing_mode` says), and only when the account was actually
   * cut over. No lock (§4.4: the tier/source read may run without one); the
   * one WRITE this file makes (`setAiSource`, in the PATCH) takes its own.
   */
  async function resolveMovedAccount(accountId: string): Promise<CreditAccountRecord | null> {
    if (aiCredits === undefined || aiCredits.mode !== 'enforce') return null;
    const credit = await aiCredits.accounts.ensureAccount(accountId);
    return credit.billingMode === 'credits' ? credit : null;
  }

  /**
   * S13 — the settings/status numbers for a moved account, from the same
   * three no-lock reads every one of these routes needs (§8.6). Composed
   * here once so GET settings, GET status and the PATCH's cap check and
   * response all read the identical numbers the identical way.
   */
  async function movedAccountView(
    accountId: string,
    credit: CreditAccountRecord,
  ): Promise<MovedAccountCreditsView> {
    // `aiCredits` is defined whenever this is reachable — only `resolveMovedAccount`
    // (which requires it) ever produces the `credit` this takes.
    const runtime = aiCredits;
    if (runtime === undefined) throw new Error('movedAccountView called with no aiCredits runtime');
    const [currentWindow, otherLiveGrantedMicro, spendableMicro] = await Promise.all([
      runtime.windows.currentWindow(accountId),
      runtime.accounts.otherLiveGrantedMicro(accountId),
      runtime.accounts.spendableMicro(accountId),
    ]);
    const chargedInWindowMicro =
      currentWindow === null
        ? 0
        : await runtime.accounts.chargedInWindowMicro(accountId, currentWindow.id);
    return movedAccountCreditsView({
      aiSource: credit.aiSource,
      currentWindow,
      otherLiveGrantedMicro,
      spendableMicro,
      chargedInWindowMicro,
      now: new Date(),
    });
  }

  /**
   * S13/§8.6 item 6 — the moved-account leg of the PATCH. The old cap column
   * is never read or written here; `consent` writes `credit_accounts.ai_source`
   * through `setAiSource`, under ITS OWN account lock (never this function's
   * — there is no wider transaction to hold it in, and nothing else this
   * route does needs the account locked).
   */
  async function handleMovedPatch(
    request: FastifyRequest,
    accountId: string,
    tier: AccountTier,
    credit: CreditAccountRecord,
    patch: { readonly consent?: boolean; readonly monthly_cap_usd_cents?: number },
  ): Promise<{ consent: boolean; monthly_cap_usd_cents: number }> {
    if (aiCredits === undefined)
      throw new Error('handleMovedPatch called with no aiCredits runtime');

    // The plan entitlement, not the legacy tier gate (§8.6 item 1): a plan
    // with no AI at all refuses `consent:true` even for a moved account.
    if (patch.consent === true && !aiIncludedForTier(tier)) {
      throw new ForbiddenError(aiNotOnPlanDetail(tier), { ai_not_on_plan: true });
    }

    // One read, before any write, so the cap check and the PATCH's own
    // `monthly_cap_usd_cents` echo use the exact same number (cap does not
    // depend on `ai_source`, so nothing below needs to re-read it).
    const before = await movedAccountView(accountId, credit);

    if (patch.monthly_cap_usd_cents !== undefined) {
      const refusal = movedAccountCapWriteRefusal({
        requestedCents: patch.monthly_cap_usd_cents,
        currentCapCents: before.capCents,
      });
      if (refusal !== null) {
        throw new ValidationError({
          formErrors: [],
          fieldErrors: { monthly_cap_usd_cents: [refusal] },
        });
      }
    }

    // ⛔ A SAVE THAT WOULD NOT CHANGE THE CONSENT PROJECTION WRITES NOTHING.
    // The dashboard sends `consent: true` on EVERY save of this form, so
    // writing on every `consent` would turn a Team account on `'credits'`
    // into automatic (its usable stored key first, credits only after) each
    // time the customer saved anything — a change of who pays, made without
    // anyone choosing it, and invisible to the consent audit because the
    // true/false projection had not moved (S13 audit #12). So `ai_source`
    // is written only when the requested consent DIFFERS from the projection
    // (`ai_source !== 'own_key'`), and every write is audited as
    // `account.ai_source_changed` below. (The coordinator amends §8.6's
    // "consent:true → automatic" to this.)
    let nextAiSource = credit.aiSource;
    if (patch.consent !== undefined && patch.consent !== before.consent) {
      if (patch.consent) {
        const updated = await aiCredits.accounts.setAiSource(accountId, {
          aiSource: null,
          setBy: 'customer',
        });
        nextAiSource = updated.aiSource;
      } else if (ownKeyAllowedForTier(tier)) {
        const updated = await aiCredits.accounts.setAiSource(accountId, {
          aiSource: 'own_key',
          setBy: 'customer',
        });
        nextAiSource = updated.aiSource;
      }
    }
    // `consent:false` on a plan that forbids an own key (Personal): ACCEPTED
    // and changes nothing — no write, so `nextAiSource` stays what it was,
    // and the response tells the truth: `consent: true` (§8.6 item 6).

    if (accountAudit !== undefined && nextAiSource !== credit.aiSource) {
      try {
        // Same action and payload `PATCH /v1/account/me/ai-settings` writes
        // for the same change.
        await accountAudit.record({
          accountId,
          actorType: 'customer',
          action: 'account.ai_source_changed',
          targetResourceId: `account_${accountId}`,
          payload: { from: credit.aiSource, to: nextAiSource },
          ipAddress: readClientIp(request),
        });
      } catch {
        /* swallow */
      }
    }

    if (patch.consent !== undefined && accountAudit !== undefined) {
      const nextConsent = movedAccountConsent(nextAiSource);
      if (before.consent !== nextConsent) {
        try {
          await accountAudit.record({
            accountId,
            actorType: 'customer',
            action: 'account.bundled_llm_consent_changed',
            targetResourceId: `account_${accountId}`,
            payload: {
              from: before.consent,
              to: nextConsent,
              ai_source_from: credit.aiSource,
              ai_source_to: nextAiSource,
            },
            ipAddress: readClientIp(request),
          });
        } catch {
          /* swallow */
        }
      }
    }

    return { consent: movedAccountConsent(nextAiSource), monthly_cap_usd_cents: before.capCents };
  }

  app.get(
    '/v1/account/me/bundled-llm-settings',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const moved = await resolveMovedAccount(ctx.account.id);
      if (moved !== null) {
        const view = await movedAccountView(ctx.account.id, moved);
        return { consent: view.consent, monthly_cap_usd_cents: view.capCents };
      }
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
      const moved = await resolveMovedAccount(ctx.account.id);
      if (moved !== null) {
        const view = await movedAccountView(ctx.account.id, moved);
        return {
          consent: view.consent,
          cap_cents: view.capCents,
          used_this_month_cents: view.usedThisMonthCents,
          remaining_cents: view.remainingCents,
          refused_count_this_month: 0,
          month_started_at: view.monthStartedAt.toISOString(),
        };
      }
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
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = PatchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(PatchBodySchema),
        reply,
        logger: request.log,
        route: 'PATCH /v1/account/me/bundled-llm-settings',
      });
      const moved = await resolveMovedAccount(ctx.account.id);
      if (moved !== null) {
        return handleMovedPatch(request, ctx.account.id, ctx.account.tier, moved, parsed.data);
      }
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
      if (parsed.data.monthly_cap_usd_cents !== undefined) {
        const refusal = bundledCapWriteRefusal({
          requestedCents: parsed.data.monthly_cap_usd_cents,
          currentCents: prior?.monthlyCapUsdCents ?? null,
        });
        // The same problem type and field-error shape as a schema failure, so a
        // client that already renders "fails schema" renders this one too.
        if (refusal !== null) {
          throw new ValidationError({
            formErrors: [],
            fieldErrors: { monthly_cap_usd_cents: [refusal] },
          });
        }
      }
      // S16 audit #11 — "moved or not" was decided above from an UNLOCKED
      // read; a cutover can take the account between that read and this
      // write. So the write takes the lock the cutover takes first, re-reads
      // `billing_mode` under it, and writes the legacy columns only if the
      // account is still legacy: a save racing a cutover either lands before
      // the move (and is in its snapshot) or answers as a moved account —
      // never lands in columns a moved account no longer reads.
      const write = await service.updateLegacySettings({
        accountId: ctx.account.id,
        ...(parsed.data.consent !== undefined ? { consent: parsed.data.consent } : {}),
        ...(parsed.data.monthly_cap_usd_cents !== undefined
          ? { monthlyCapUsdCents: parsed.data.monthly_cap_usd_cents }
          : {}),
        refuseIfMoved: aiCredits !== undefined && aiCredits.mode === 'enforce',
      });
      if (write.outcome === 'not_found') {
        throw new BadRequestError('Account row not found — re-authenticate and retry.');
      }
      if (write.outcome === 'moved') {
        const movedNow = await resolveMovedAccount(ctx.account.id);
        if (movedNow === null) {
          throw new Error(
            'the bundled-LLM settings write saw a moved account the credits read did not',
          );
        }
        return handleMovedPatch(request, ctx.account.id, ctx.account.tier, movedNow, parsed.data);
      }
      const next = write.next;
      // 2026-05-20 — audit emit ONLY when consent actually changed.
      // Cap-only PATCHes don't audit (separate enum value if later
      // needed). Best-effort emit; audit failure must not break the
      // PATCH response. `write.prior` is the row as the write locked it.
      if (
        accountAudit !== undefined &&
        parsed.data.consent !== undefined &&
        write.prior.consent !== next.consent
      ) {
        try {
          await accountAudit.record({
            accountId: ctx.account.id,
            actorType: 'customer',
            action: 'account.bundled_llm_consent_changed',
            targetResourceId: `account_${ctx.account.id}`,
            payload: {
              from: write.prior.consent,
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
