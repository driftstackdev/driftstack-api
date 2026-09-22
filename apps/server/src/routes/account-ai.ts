// S14 — Phase-2-facing read/settings API for AI credits (dark: registered
// only while `DRIFTSTACK_AI_CREDITS_MODE` is `shadow` or `enforce`).
//
//   GET   /v1/account/me/ai              — plan, source, balance, blockers
//   PATCH /v1/account/me/ai-settings     — choose the account's AI source
//   GET   /v1/account/me/ai/ledger       — the account's credit ledger
//
// ⛔ NOTHING HERE IS PUBLISHED. Same posture as `routes/admin-ai-credits.ts`:
// these three are recorded as deliberately undocumented in
// `every-registered-route-is-in-the-spec-or-exempt-for-a-stated-reason` and
// `a-route-in-neither-the-spec-nor-the-docs-is-a-decision`, and NOTHING here
// is registered in `lib/openapi.ts`'s published document.
//
// ⚠️ ONLY `GET /v1/account/me/ai` HONOURS ACT-AS (the `X-Driftstack-Account`
// header, `resolveEffectiveAccount` — same mechanism `GET /v1/billing` uses).
// The brief names this for that one route only; the PATCH is account-owner
// scoped (a team member acting-as never holds `account_owner` on the account
// they are acting as, so act-as would be unreachable there in practice) and
// the ledger read stays on the caller's own account, matching every other
// account-scoped GET in this file family (`account-bundled-llm.ts`,
// `account-byok-anthropic.ts`) that does not act-as either. A later slice can
// widen the ledger the same way if a real need shows up; this is a decision,
// recorded here, not an oversight.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AiLedgerQuerySchema,
  UpdateAiSettingsRequestSchema,
  type AccountAiState,
  type AccountTier,
  type AiLedgerPage,
  type AiSource,
  type AiSourceSetBy,
  type CreditLotKind,
} from '@driftstack/api-types';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { ConflictError, ForbiddenError, ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import type { AccountAuthRepo } from '../services/auth.js';
import type { AccountAuditService } from '../services/account-audit.js';
import type { BYOKAnthropicService } from '../services/byok-anthropic.js';
import { OWN_KEY_NOT_ON_PLAN_DETAIL, ownKeyAllowedForTier } from '../services/ai-entitlements.js';
import {
  buildAccountAiState,
  buildLedgerEntry,
  buildLegacyAccountAiState,
  type ExtraLotFacts,
} from '../services/ai-account-state.js';
import type { AiCreditsRuntime, AiCreditsStateReads } from '../services/ai-credits-runtime.js';

export interface AccountAiRoutesDeps {
  /** Required: `lib/app.ts` registers this file only when `deps.aiCredits` is
   *  defined (mode `shadow`|`enforce`) — see the file header. */
  aiCredits: AiCreditsRuntime;
  /** Optional: BYOK is its own independently-gated feature
   *  (`deps.byokAnthropicService`, gated on an encryption key being
   *  configured). A deployment running AI credits with BYOK unwired answers
   *  `own_key: {has_key: false, usable: false, ...}` — truthfully: no key is
   *  possible when the feature that would store one is not running. */
  byokService?: Pick<BYOKAnthropicService, 'getUsabilityFacts'>;
  authRepo: Pick<AccountAuthRepo, 'getAccount'>;
  accountAudit?: AccountAuditService;
  /** Injectable clock for tests. */
  now?: () => Date;
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

/**
 * S14's `stateReads` bundle, required. Every deployment that builds
 * `aiCredits` at all populates it (see `AiCreditsRuntime.stateReads`'s own
 * doc comment) — a fixture that leaves it undefined does not support this
 * route family and has been wired into the wrong test.
 */
function requireStateReads(aiCredits: AiCreditsRuntime): AiCreditsStateReads {
  if (aiCredits.stateReads === undefined) {
    throw new Error(
      'aiCredits.stateReads is required by routes/account-ai.ts; this AiCreditsRuntime fixture predates S14',
    );
  }
  return aiCredits.stateReads;
}

/** The effective account's tier: the caller's own when acting as themself
 *  (no extra read), or the team owner's when acting as one — mirrors
 *  `routes/admin.ts`'s `authRepo.getAccount(effective.accountId)` pattern. */
async function resolveEffectiveTier(
  ctx: NonNullable<FastifyRequest['account']>,
  effective: { readonly kind: 'self' | 'team'; readonly accountId: string },
  authRepo: Pick<AccountAuthRepo, 'getAccount'>,
): Promise<AccountTier> {
  if (effective.kind === 'self') return ctx.account.tier;
  const owner = await authRepo.getAccount(effective.accountId);
  if (owner === null) {
    throw new Error('X-Driftstack-Account named a membership whose owner account no longer exists');
  }
  return owner.tier;
}

/** Only lots the query already filtered to `kind <> 'monthly'` reach this —
 *  the cast is checked, not assumed. */
function toExtraLotFacts(lot: {
  readonly kind: CreditLotKind;
  readonly remainingMicro: number;
  readonly expiresAt: Date;
}): ExtraLotFacts {
  if (lot.kind === 'monthly') {
    throw new Error("liveExtraLots returned a 'monthly' lot; its own query excludes that kind");
  }
  return { kind: lot.kind, remainingMicro: lot.remainingMicro, expiresAt: lot.expiresAt };
}

export function registerAccountAiRoutes(app: FastifyInstance, deps: AccountAiRoutesDeps): void {
  const { aiCredits, byokService, authRepo, accountAudit } = deps;
  const now = deps.now ?? ((): Date => new Date());

  /** §4.1's table: only `enforce` treats `billing_mode = 'credits'` as MOVED
   *  — `shadow` (and, structurally, `off`, though this file is never
   *  registered then) is legacy for every customer-facing purpose. Same gate
   *  as `routes/account-bundled-llm.ts`'s `resolveMovedAccount` (S13). */
  function isMoved(billingMode: 'legacy' | 'credits'): boolean {
    return aiCredits.mode === 'enforce' && billingMode === 'credits';
  }

  /**
   * Everything `buildAccountAiState`/`buildLegacyAccountAiState` need for
   * ONE account, gathered the one way both `GET /v1/account/me/ai` and the
   * PATCH's echoed response do it — so the two can never disagree about how
   * a fact was read. `aiSource`/`aiSourceSetBy` are taken as arguments rather
   * than re-read here: the PATCH already holds the record its own write (or
   * its own idempotent no-write) produced, and re-reading here could race a
   * concurrent change into the response it is about to send.
   */
  async function buildState(args: {
    readonly tier: AccountTier;
    readonly accountId: string;
    readonly billingMode: 'legacy' | 'credits';
    readonly aiSource: AiSource | null;
    readonly aiSourceSetBy: AiSourceSetBy | null;
    readonly debtMicro: number;
  }): Promise<AccountAiState> {
    const at = now();
    const stateReads = requireStateReads(aiCredits);
    const [ownKey, cardInForce, nextCard] = await Promise.all([
      byokService === undefined
        ? Promise.resolve({ hasKey: false, usable: false, setAt: null, expiresAt: null })
        : byokService.getUsabilityFacts({ accountId: args.accountId, now: at }),
      stateReads.cardInForce(at),
      stateReads.nextAnnouncedCard(at),
    ]);
    if (cardInForce === null) {
      throw new Error(
        'no AI credits rate card is in force — publish one before enabling AI credits',
      );
    }
    if (!isMoved(args.billingMode)) {
      return buildLegacyAccountAiState({
        tier: args.tier,
        ownKey,
        rateCard: cardInForce,
        nextRateCard: nextCard,
      });
    }
    const [
      currentWindow,
      availableMicro,
      reservedInFlightMicro,
      pendingClaimsMicro,
      debtReason,
      tasksInFlight,
    ] = await Promise.all([
      aiCredits.windows.currentWindow(args.accountId),
      aiCredits.accounts.spendableMicro(args.accountId),
      stateReads.heldMicro(args.accountId),
      stateReads.pendingClaimTotalMicro(args.accountId),
      stateReads.latestDebtReason(args.accountId),
      stateReads.openEnforceCountNoLock(args.accountId),
    ]);
    const [monthlyLot, extraLotsRaw] = await Promise.all([
      currentWindow === null
        ? Promise.resolve(null)
        : stateReads.monthlyLotForWindow(args.accountId, currentWindow.id),
      stateReads.liveExtraLots(args.accountId),
    ]);
    return buildAccountAiState({
      tier: args.tier,
      aiSource: args.aiSource,
      aiSourceSetBy: args.aiSourceSetBy,
      ownKey,
      currentWindow:
        currentWindow === null
          ? null
          : { windowStart: currentWindow.windowStart, windowEnd: currentWindow.windowEnd },
      monthlyLot:
        monthlyLot === null
          ? null
          : {
              grantedMicro: monthlyLot.grantedMicro,
              remainingMicro: monthlyLot.remainingMicro,
              heldMicro: monthlyLot.heldMicro,
            },
      extraLots: extraLotsRaw.map(toExtraLotFacts),
      availableMicro,
      reservedInFlightMicro,
      pendingClaimsMicro,
      debtMicro: args.debtMicro,
      debtReason,
      tasksInFlight,
      rateCard: cardInForce,
      nextRateCard: nextCard,
    });
  }

  app.get(
    '/v1/account/me/ai',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request): Promise<AccountAiState> => {
      const ctx = requireCtx(request);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const tier = await resolveEffectiveTier(ctx, effective, authRepo);
      const credit = await aiCredits.accounts.ensureAccount(effective.accountId);
      return buildState({
        tier,
        accountId: effective.accountId,
        billingMode: credit.billingMode,
        aiSource: credit.aiSource,
        aiSourceSetBy: credit.aiSourceSetBy,
        debtMicro: credit.debtMicro,
      });
    },
  );

  app.patch(
    '/v1/account/me/ai-settings',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
    },
    async (request: FastifyRequest, reply: FastifyReply): Promise<AccountAiState> => {
      const ctx = requireCtx(request);
      const accountId = ctx.account.id;
      const tier = ctx.account.tier;
      const parsed = UpdateAiSettingsRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(UpdateAiSettingsRequestSchema),
        reply,
        logger: request.log,
        route: 'PATCH /v1/account/me/ai-settings',
      });

      const credit = await aiCredits.accounts.ensureAccount(accountId);
      if (!isMoved(credit.billingMode)) {
        throw new ConflictError("AI credits aren't active on this account yet.", {
          credits_not_active: true,
        });
      }
      if (parsed.data.ai_source === 'own_key' && !ownKeyAllowedForTier(tier)) {
        throw new ForbiddenError(OWN_KEY_NOT_ON_PLAN_DETAIL, { own_key_not_on_plan: true });
      }

      // Idempotent: a resend of the value already on file writes nothing —
      // no `setAiSource` call, no audit row (§9.3; S14 brief item 3).
      let aiSource = credit.aiSource;
      let aiSourceSetBy = credit.aiSourceSetBy;
      if (credit.aiSource !== parsed.data.ai_source) {
        const updated = await aiCredits.accounts.setAiSource(accountId, {
          aiSource: parsed.data.ai_source,
          setBy: 'customer',
        });
        aiSource = updated.aiSource;
        aiSourceSetBy = updated.aiSourceSetBy;
        if (accountAudit !== undefined) {
          try {
            await accountAudit.record({
              accountId,
              actorType: 'customer',
              action: 'account.ai_source_changed',
              targetResourceId: `account_${accountId}`,
              payload: { from: credit.aiSource, to: updated.aiSource },
              ipAddress: readClientIp(request),
            });
          } catch {
            /* best-effort — an audit failure must not break the PATCH */
          }
        }
      }

      return buildState({
        tier,
        accountId,
        billingMode: credit.billingMode,
        aiSource,
        aiSourceSetBy,
        debtMicro: credit.debtMicro,
      });
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/v1/account/me/ai/ledger',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request): Promise<AiLedgerPage> => {
      const ctx = requireCtx(request);
      const accountId = ctx.account.id;
      const parsed = AiLedgerQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const stateReads = requireStateReads(aiCredits);
      const page = await stateReads.ledgerPageWithBalance(accountId, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      });
      return {
        data: page.entries.map((entry) =>
          buildLedgerEntry({
            id: entry.id,
            kind: entry.kind,
            deltaMicro: entry.lotDeltaMicro - entry.debtDeltaMicro,
            balanceAfterMicro: entry.balanceAfterMicro,
            createdAt: entry.createdAt,
            lotExpiresAt: entry.lotExpiresAt,
            agentSessionId: entry.agentSessionId,
            model: entry.model,
            rateCardVersion: entry.rateCardVersion,
          }),
        ),
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      };
    },
  );
}
