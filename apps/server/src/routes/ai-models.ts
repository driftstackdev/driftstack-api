// S14 — `GET /v1/ai/models`: the public model catalogue on AI credits (dark:
// registered only while `DRIFTSTACK_AI_CREDITS_MODE` is `shadow` or
// `enforce`). §9.2 plus the design's shape — see
// `services/ai-account-state.ts`'s `buildModelCatalogueEntry` for the
// per-model derivation this route only gathers the inputs for.
//
// ⛔ NOTHING HERE IS PUBLISHED — same posture as `routes/account-ai.ts`; see
// that file's header for the three guard tests this route is recorded in
// instead of `lib/openapi.ts`.
//
// Read scope, no act-as: the catalogue plus `available_on_your_plan` depends
// only on the CALLER's own tier, and no other route in this family act-as's
// except `GET /v1/account/me/ai` (see that file's header for why).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AgentModelSchema,
  AI_CREDITS_MODEL_DECISION,
  type AiModelCatalogueResponse,
} from '@driftstack/api-types';
import {
  buildModelCatalogueEntry,
  type RateCardModelPrices,
} from '../services/ai-account-state.js';
import type { AiCreditsRuntime, AiCreditsStateReads } from '../services/ai-credits-runtime.js';

export interface AiModelsRoutesDeps {
  /** Required: `lib/app.ts` registers this file only when `deps.aiCredits` is
   *  defined (mode `shadow`|`enforce`). */
  aiCredits: AiCreditsRuntime;
  /** Injectable clock for tests. */
  now?: () => Date;
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

function requireStateReads(aiCredits: AiCreditsRuntime): AiCreditsStateReads {
  if (aiCredits.stateReads === undefined) {
    throw new Error(
      'aiCredits.stateReads is required by routes/ai-models.ts; this AiCreditsRuntime fixture predates S14',
    );
  }
  return aiCredits.stateReads;
}

export function registerAiModelsRoutes(app: FastifyInstance, deps: AiModelsRoutesDeps): void {
  const { aiCredits } = deps;
  const now = deps.now ?? ((): Date => new Date());

  app.get(
    '/v1/ai/models',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request): Promise<AiModelCatalogueResponse> => {
      const ctx = requireCtx(request);
      const tier = ctx.account.tier;
      const at = now();
      const stateReads = requireStateReads(aiCredits);
      const cardInForce = await stateReads.cardInForce(at);
      if (cardInForce === null) {
        throw new Error(
          'no AI credits rate card is in force — publish one before enabling AI credits',
        );
      }
      const nextCard = await stateReads.nextAnnouncedCard(at);
      const data = await Promise.all(
        AgentModelSchema.options.map(async (model) => {
          const decision = AI_CREDITS_MODEL_DECISION[model];
          const pricesInForce: RateCardModelPrices | null =
            decision === 'on_credits'
              ? await stateReads.modelRow(cardInForce.version, model)
              : null;
          const pricesNext: RateCardModelPrices | null =
            decision === 'on_credits' && nextCard !== null
              ? await stateReads.modelRow(nextCard.version, model)
              : null;
          return buildModelCatalogueEntry({
            model,
            tier,
            rateCard: cardInForce,
            pricesInForce,
            nextRateCard: nextCard,
            pricesNext,
          });
        }),
      );
      return { data };
    },
  );
}
