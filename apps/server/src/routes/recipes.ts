// AI-B4 — POST /v1/recipes route surface. Write-only at v1.0; read /
// list / execute / delete are v1.1 D2/D3 scope.
//
// Activation gate matches the rest of Wave 1119+: when both
// recipesRepo + agentSessionsRepo are wired in AppDeps,
// registerRecipesRoutes runs. When omitted, registerRecipesDisabledRoutes
// surfaces 503 FeatureUnavailable so SDK + dashboard get a machine-
// readable "not yet enabled" signal vs 404.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FeatureUnavailableError, NotFoundError, ValidationError } from '../lib/errors.js';
import type { RecipesRepo, RecipeRecord } from '../services/recipes.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

const CreateRecipeRequestSchema = z.object({
  agent_session_id: z.string().min(1),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

interface PublicRecipe {
  id: string;
  account_id: string;
  agent_session_id: string | null;
  label: string;
  description: string | null;
  intent_count: number;
  created_at: string;
  updated_at: string;
}

function publicRecipe(rec: RecipeRecord): PublicRecipe {
  return {
    id: rec.id,
    account_id: rec.accountId,
    agent_session_id: rec.agentSessionId,
    label: rec.label,
    description: rec.description,
    intent_count: rec.intentLog.length,
    created_at: rec.createdAt.toISOString(),
    updated_at: rec.updatedAt.toISOString(),
  };
}

export interface RecipesRoutesDeps {
  recipes: RecipesRepo;
  agentSessions: AgentSessionsRepo;
}

export function registerRecipesRoutes(app: FastifyInstance, deps: RecipesRoutesDeps): void {
  const { recipes, agentSessions } = deps;

  app.post(
    '/v1/recipes',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = CreateRecipeRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      // Load the source agent session to snapshot its intent_log +
      // transcript. The session MUST belong to the caller's account
      // (cross-account 404 instead of 403 — don't leak existence).
      const source = await agentSessions.get(parsed.data.agent_session_id);
      if (source === null || source.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${parsed.data.agent_session_id} not found.`);
      }

      // Extract the intents from the transcript's plan-executed
      // entries. The transcript stores agent-side bodies as either
      // 'refused: ...' / 'clarify: ...' / a multi-line executor
      // summary; the plan intents themselves aren't easily recoverable
      // from the transcript alone. For v1.0 we snapshot the
      // transcript + an EMPTY intent_log; a follow-up extracts the
      // plan-intents from the agent-side transcript entries that
      // carry them in machine-readable form (a separate slice will
      // change AgentRuntime to persist intents inline; until then,
      // recipes are a stored conversation snapshot, not a replayable
      // intent list).
      const intentLog = [] as const;

      const created = await recipes.create({
        accountId: ctx.account.id,
        agentSessionId: source.id,
        label: parsed.data.label,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        intentLog,
        transcriptSnapshot: source.transcript,
      });
      return reply.code(201).send(publicRecipe(created));
    },
  );
}

// Disabled stub — registered when recipesRepo is undefined in
// AppDeps. Same activation-gate pattern as agent-sessions / billing /
// session-egress. Surfaces 503 FeatureUnavailable so SDK + dashboard
// get a machine-readable signal vs 404.
export function registerRecipesDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'Recipes are not yet enabled on this deployment. The recipe library ' +
    'requires the agent layer + recipes table to be wired; see ' +
    'docs/internal/2026-05-17-q-queue-loop-handoff.md.';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.post('/v1/recipes', stub);
}
