// AI-B4 — recipe library routes. POST /v1/recipes (create) + GET
// /v1/recipes (list) + GET /v1/recipes/:id (detail) + DELETE
// /v1/recipes/:id. The read/management path (list/get/delete) was
// pulled forward from the v1.1 D2/D3 defer (V-530.I/.J); recipe
// EXECUTION stays v1.1 (gated on the harness-wired AgentExecutor).
//
// Activation gate matches the rest of Wave 1119+: when both
// recipesRepo + agentSessionsRepo are wired in AppDeps,
// registerRecipesRoutes runs. When omitted, registerRecipesDisabledRoutes
// surfaces 503 FeatureUnavailable so SDK + dashboard get a machine-
// readable "not yet enabled" signal vs 404.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PaginationQuerySchema } from '@driftstack/api-types';
import { FeatureUnavailableError, NotFoundError, ValidationError } from '../lib/errors.js';
import { suggestRecipeMetadata, type RecipesRepo, type RecipeRecord } from '../services/recipes.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import type { AgentIntent } from '../services/agent-decomposer.js';
import { publicAgentIntent } from '../services/agent-public-redaction.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

const CreateRecipeRequestSchema = z.object({
  // Cap at 100 chars — canonical `agt_<36-char-uuid>` is 40 chars,
  // in-memory test fixtures use `agt_inmem_<counter>` (~19 chars).
  // Without a cap, a customer could POST a multi-MB string that
  // flows into the 404 NotFoundError detail and bloats the
  // problem+json body.
  agent_session_id: z.string().min(1).max(100),
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

// Detail view (GET /:id) carries the public intent_log on top of the list
// metadata. Secret type values stay in the encrypted repository record for
// future server-side replay, but are never returned to ordinary `read` scope.
// The transcript snapshot also stays internal (heavy; not needed for recipe
// management).
interface PublicRecipeDetail extends PublicRecipe {
  intent_log: ReadonlyArray<AgentIntent>;
}

function publicRecipeDetail(rec: RecipeRecord): PublicRecipeDetail {
  return { ...publicRecipe(rec), intent_log: rec.intentLog.map(publicAgentIntent) };
}

export interface RecipesRoutesDeps {
  recipes: RecipesRepo;
  agentSessions: AgentSessionsRepo;
}

export function registerRecipesRoutes(app: FastifyInstance, deps: RecipesRoutesDeps): void {
  const { recipes, agentSessions } = deps;

  // Doc-132 §5.2 (recipe auto-generation) v1.0 slice — a deterministic
  // label/description suggestion derived from the session's OWN
  // intent_log, so the "Save recipe" dialog can prefill something
  // useful instead of a blank form. Same ownership check + intent_log
  // assembly as POST /v1/recipes below; read-only (`read` scope), so
  // it's safe to call speculatively before the customer decides to save.
  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/recipe-suggestion',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const source = await agentSessions.get(req.params.id);
      if (source === null || source.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      const intentLog: AgentIntent[] = source.transcript.flatMap((entry) => entry.intents ?? []);
      const suggestion = suggestRecipeMetadata(intentLog);
      return {
        suggested_label: suggestion.suggestedLabel,
        suggested_description: suggestion.suggestedDescription,
        intent_count: intentLog.length,
      };
    },
  );

  app.post(
    '/v1/recipes',
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
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

      // Q.5.c — assemble intent_log from the transcript's
      // plan-executed agent turns. AgentRuntime persists each
      // plan's structured intent array on the transcript entry's
      // optional `intents` field (Q.5.c follow-up). flatMap
      // produces a concatenated intent_log in turn order so
      // replay walks them in the same sequence the customer's
      // session originally executed.
      const intentLog: AgentIntent[] = source.transcript.flatMap((entry) => entry.intents ?? []);

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

  // V-530.I (D2) — list the caller's saved recipes, newest first.
  // Read-path only (recipe execution stays gated on the harness
  // executor). `read` scope; keyset-paginated via the shared
  // PaginationQuerySchema (limit + opaque cursor).
  app.get(
    '/v1/recipes',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = PaginationQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const page = await recipes.list({
        accountId: ctx.account.id,
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      });
      return {
        data: page.data.map(publicRecipe),
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
      };
    },
  );

  // V-530.J (D2) — fetch one recipe in full (includes the public intent_log;
  // sensitive type values are omitted). `read` scope. Cross-account / missing
  // → 404 (existence not leaked).
  app.get<{ Params: { id: string } }>(
    '/v1/recipes/:id',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const rec = await recipes.getById({ accountId: ctx.account.id, id: req.params.id });
      if (rec === null) throw new NotFoundError(`Recipe ${req.params.id} not found.`);
      return publicRecipeDetail(rec);
    },
  );

  // V-530.J (D3) — delete one recipe. `write` scope (mutation, mirrors
  // POST). 204 on success; cross-account / missing → 404.
  app.delete<{ Params: { id: string } }>(
    '/v1/recipes/:id',
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const deleted = await recipes.deleteById({ accountId: ctx.account.id, id: req.params.id });
      if (!deleted) throw new NotFoundError(`Recipe ${req.params.id} not found.`);
      return reply.code(204).send();
    },
  );
}

// Disabled stub — registered when recipesRepo OR agentSessionsRepo is
// undefined in AppDeps (the gate requires both; see app.ts).
// Same activation-gate pattern as agent-sessions / billing /
// session-egress. Surfaces 503 FeatureUnavailable so SDK + dashboard
// get a machine-readable deployment-state signal instead of 404.
export function registerRecipesDisabledRoutes(app: FastifyInstance): void {
  // Customer-facing detail. Lands verbatim in the SDK's 503 problem
  // body. Same fix shape as agent-sessions / byok-anthropic /
  // proxy disabled-stubs (slices 87 + 88): point at customer-facing
  // docs URL, NOT the internal handoff/design doc.
  const detail =
    'Recipes are unavailable on this deployment. ' +
    'Contact the deployment operator if recipe access is expected. See ' +
    'https://docs.driftstack.dev/api/recipes/ for the supported API flow.';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.get('/v1/agent-sessions/:id/recipe-suggestion', stub);
  app.post('/v1/recipes', stub);
  app.get('/v1/recipes', stub);
  app.get('/v1/recipes/:id', stub);
  app.delete('/v1/recipes/:id', stub);
}
