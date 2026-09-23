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
// ACT-AS (the `X-Driftstack-Account` header). Both GETs — and
// `GET /v1/ai/models` in `routes/ai-models.ts` — honour it through the ONE
// resolver and membership check `GET /v1/billing` uses
// (`resolveEffectiveAccount`): a team member acting as the owner reads the
// OWNER's plan, balance and ledger, because the turns they start while acting
// run on the owner's plan. The PATCH REFUSES a header naming any account but
// the caller's own, with the self-workspace 400 `routes/billing-crypto.ts`
// already uses, before it reads the body: choosing where an account's AI is
// paid from is the owner's own decision, and silently writing the MEMBER's
// account instead (what it did before the S14 audit, #9) changed the wrong
// account while claiming the team one.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AgentModelSchema,
  AiLedgerQuerySchema,
  deploymentKeyModelRefusal,
  UpdateAiSettingsRequestSchema,
  type AccountAiState,
  type AccountTier,
  type AiLedgerPage,
  type AiSource,
  type AiSourceSetBy,
  type CreditLotKind,
} from '@driftstack/api-types';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { BadRequestError, ConflictError, ForbiddenError, ValidationError } from '../lib/errors.js';
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
  livePlanOverrideCredits,
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

/** `stateReads.planOverride` and `stateReads.refreshCredits`, required the same
 *  way — optional on the type only (see their own doc comments). */
function requireOverrideAndRefresh(
  stateReads: AiCreditsStateReads,
): Required<Pick<AiCreditsStateReads, 'planOverride' | 'refreshCredits'>> {
  const { planOverride, refreshCredits } = stateReads;
  if (planOverride === undefined || refreshCredits === undefined) {
    throw new Error(
      'aiCredits.stateReads.planOverride and .refreshCredits are required by routes/account-ai.ts; this fixture predates the S14 audit fixes',
    );
  }
  return { planOverride, refreshCredits };
}

/** The effective account's tier: the caller's own when acting as themself
 *  (no extra read), or the team owner's when acting as one — mirrors
 *  `routes/admin.ts`'s `authRepo.getAccount(effective.accountId)` pattern.
 *  Shared with `routes/ai-models.ts`, whose `available_on_your_plan` is the
 *  effective account's plan for the same reason. */
export async function resolveEffectiveTier(
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
 *  the cast is checked, not assumed. Carries what running tasks HOLD on the
 *  lot, so `extras[].remaining_credits` excludes it (S14 audit #3). */
function toExtraLotFacts(lot: {
  readonly kind: CreditLotKind;
  readonly remainingMicro: number;
  readonly heldMicro: number;
  readonly expiresAt: Date;
}): ExtraLotFacts {
  if (lot.kind === 'monthly') {
    throw new Error("liveExtraLots returned a 'monthly' lot; its own query excludes that kind");
  }
  return {
    kind: lot.kind,
    remainingMicro: lot.remainingMicro,
    heldMicro: lot.heldMicro,
    expiresAt: lot.expiresAt,
  };
}

/**
 * The smallest minimum to start among the models a task could run on credits
 * right now, or null when there is none (S14 audit #4). Per model, exactly the
 * two questions `reserve()`'s `priceModel` asks: may the deployment's key run
 * it (`deploymentKeyModelRefusal`), and does the card in force carry a row for
 * it. Every plan with AI may run every such model on credits, so this is not
 * narrowed by tier; a plan without AI is refused before this matters.
 */
async function smallestMinStartMicro(
  stateReads: AiCreditsStateReads,
  cardVersion: number,
): Promise<number | null> {
  const runnable = AgentModelSchema.options.filter(
    (model) => deploymentKeyModelRefusal(model) === null,
  );
  const rows = await Promise.all(runnable.map((model) => stateReads.modelRow(cardVersion, model)));
  let smallest: number | null = null;
  for (const row of rows) {
    if (row !== null && (smallest === null || row.minStartMicro < smallest)) {
      smallest = row.minStartMicro;
    }
  }
  return smallest;
}

/** The empty page a ledger read answers for an account nothing on the credits
 *  ledger governs (S14 audit #8). */
function emptyLedgerPage(): AiLedgerPage {
  return { data: [], has_more: false, next_cursor: null };
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
    const { planOverride } = requireOverrideAndRefresh(stateReads);
    const [ownKey, cardInForce, nextCard, override] = await Promise.all([
      byokService === undefined
        ? Promise.resolve({ hasKey: false, usable: false, setAt: null, expiresAt: null })
        : byokService.getUsabilityFacts({ accountId: args.accountId, now: at }),
      stateReads.cardInForce(at),
      stateReads.nextAnnouncedCard(at),
      planOverride(args.accountId),
    ]);
    if (cardInForce === null) {
      throw new Error(
        'no AI credits rate card is in force — publish one before enabling AI credits',
      );
    }
    const planOverrideMonthlyCredits = livePlanOverrideCredits(override, at);
    if (!isMoved(args.billingMode)) {
      return buildLegacyAccountAiState({
        tier: args.tier,
        ownKey,
        rateCard: cardInForce,
        nextRateCard: nextCard,
        planOverrideMonthlyCredits,
      });
    }
    const [
      currentWindow,
      availableMicro,
      reservedInFlightMicro,
      pendingClaimsMicro,
      debtReason,
      tasksInFlight,
      minStartMicro,
    ] = await Promise.all([
      aiCredits.windows.currentWindow(args.accountId),
      aiCredits.accounts.spendableMicro(args.accountId),
      stateReads.heldMicro(args.accountId),
      stateReads.pendingClaimTotalMicro(args.accountId),
      stateReads.latestDebtReason(args.accountId),
      stateReads.openEnforceCountNoLock(args.accountId),
      smallestMinStartMicro(stateReads, cardInForce.version),
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
      minStartMicro,
      planOverrideMonthlyCredits,
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
      let credit = await aiCredits.accounts.ensureAccount(effective.accountId);
      if (isMoved(credit.billingMode)) {
        // §6.4 — "lazily … in `GET /v1/account/me/ai`" (S14 audit #5): a window
        // that is due but not yet written (between its boundary and the
        // boundary job or the 15-minute sweep) would otherwise read as
        // `monthly: null`/`no_credits` while `reserve()`, which refreshes
        // first, ran the task. MOVED accounts only: nothing on the credits
        // ledger governs a legacy one.
        //
        // ⛔ A FAILED REFRESH NEVER FAILS THE GET. It is logged and the route
        // answers from what is stored — the same promise `reserve()` makes
        // under its savepoint (H5), and the coverage sweep retries the account.
        // The account row is re-read only after a refresh that ran: the refresh
        // may have repaid debt, and `debtMicro` below must be the one it left.
        const { refreshCredits } = requireOverrideAndRefresh(requireStateReads(aiCredits));
        try {
          await refreshCredits(effective.accountId);
          credit = await aiCredits.accounts.ensureAccount(effective.accountId);
        } catch (err) {
          request.log.error(
            {
              component: 'account-ai',
              event: 'ai_credits_refresh_failed',
              trigger: 'account_state_read',
              accountId: effective.accountId,
              err:
                err instanceof Error
                  ? { name: err.name, message: err.message }
                  : { value: String(err) },
            },
            'refreshing AI credits before GET /v1/account/me/ai failed — answering from the stored balance',
          );
        }
      }
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
      // S14 audit #9 — refused BEFORE the body is read or anything is written;
      // see the file header. A header naming the caller's own account resolves
      // to `self` and is no header at all; one naming an account the caller is
      // not a member of is refused by the resolver itself (403).
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      if (effective.kind !== 'self') {
        throw new BadRequestError(
          'AI settings can be changed only in the Self workspace. Remove X-Driftstack-Account and retry.',
        );
      }
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
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const parsed = AiLedgerQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const stateReads = requireStateReads(aiCredits);
      // S14 audit #8 — an account that has not been moved reads an EMPTY
      // ledger, the same gate `GET /v1/account/me/ai` answers `billing:
      // 'legacy'` behind. Shadow-mode grants DO write rows for it, but those
      // rows fund nothing the account can spend: showing a +5,000 grant beside
      // a state that says the account is not on credits at all would be two
      // answers to one question.
      const credit = await aiCredits.accounts.ensureAccount(effective.accountId);
      if (!isMoved(credit.billingMode)) return emptyLedgerPage();
      const page = await stateReads.ledgerPageWithBalance(effective.accountId, {
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
