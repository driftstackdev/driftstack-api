// AI-B4 — recipe library routes. POST /v1/recipes (create) + GET
// /v1/recipes (list) + GET /v1/recipes/:id (detail) + DELETE
// /v1/recipes/:id. The read/management path (list/get/delete) was
// pulled forward from the v1.1 D2/D3 defer (V-530.I/.J); recipe
// EXECUTION stays v1.1 (gated on the harness-wired AgentExecutor).
//
// Activation gate matches the rest of Slice 1119.2+: when both
// recipesRepo + agentSessionsRepo are wired in AppDeps,
// registerRecipesRoutes runs. When omitted, registerRecipesDisabledRoutes
// surfaces 503 FeatureUnavailable so SDK + dashboard get a machine-
// readable "not yet enabled" signal vs 404.

import { parseRequestBodyReportingUnknown } from '../lib/unknown-request-fields.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PaginationQuerySchema, type AccountTier } from '@driftstack/api-types';
import {
  ConflictError,
  FeatureUnavailableError,
  ForbiddenError,
  NotFoundError,
  TierLimitError,
  ValidationError,
} from '../lib/errors.js';
import {
  recipeLimitFor,
  suggestRecipeMetadata,
  type RecipesRepo,
  type RecipeRecord,
} from '../services/recipes.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { resolveEffectiveAccount, type AccountAuthRepo } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { readClientIp } from '../lib/client-ip.js';
import { callerCanAccessAgentSession } from './agent-sessions.js';
import type { AgentIntent } from '../services/agent-decomposer.js';
import { publicAgentIntent } from '../services/agent-public-redaction.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

const RECIPES_TEAM_ROLE_DETAIL = "Recipes in a team owner's workspace require the admin role.";

/**
 * Security sweep #15 — the workspace a recipe write acts in: the caller's own, or
 * the team owner's that `X-Driftstack-Account` names. Recipes were filed under the
 * caller whatever the header said, so a recipe saved from the owner's session in the
 * owner's workspace landed in the member's personal account, out of the owner's
 * sight, and outlived the member's removal. A write in a teammate's workspace needs
 * the admin role. Returns undefined for the caller's own workspace.
 *
 * The two reads resolve the header in their own handlers and require the admin role
 * there too: a recipe is a saved copy of a session's steps, and the owner's agent
 * sessions are read by admins only.
 */
function effectiveAccountIdForWrite(
  request: FastifyRequest,
  ctx: NonNullable<FastifyRequest['account']>,
): string | undefined {
  const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
  if (effective.kind !== 'team') return undefined;
  if (effective.role !== 'admin') {
    throw new ForbiddenError(RECIPES_TEAM_ROLE_DETAIL);
  }
  return effective.accountId;
}

const CreateRecipeRequestSchema = z.object({
  // Cap at 100 chars — canonical `agt_<36-char-uuid>` is 40 chars,
  // in-memory test fixtures use `agt_inmem_<counter>` (~19 chars).
  // Without a cap, a customer could POST a multi-MB string that
  // flows into the 404 NotFoundError detail and bloats the
  // problem+json body.
  agent_session_id: z.string().min(1).max(100),
  // `.min(1)` counts RAW characters, so a label of three spaces passes zod and then
  // reaches `validateLabelAndDescription`, which trims first and throws a plain
  // `Error` — not an ApiError — so the customer got a 500 for typing whitespace.
  // Measured: `{"label":"   "}` answered 500 before this refine. The service and repo
  // copies stay as they are; they are defence in depth for callers that do not arrive
  // through this schema, and this is the boundary where every other validation failure
  // on this route is already turned into a 400.
  //
  // ⚠️ Two content-parity guards pinned the single-line spelling of this chain.
  // Prettier wraps it once a refine is added, whatever the message length, so those
  // pins are updated in the same commit to be newline-tolerant — they protect the
  // BOUND, and a line break is not a change to it.
  //
  // Deliberately NOT quoting the pinned substring here: a comment that repeats the
  // exact text a guard matches inflates every later count over that text. It did —
  // a mutation over the bound found two occurrences, one of them this comment.
  label: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => v.trim().length > 0, 'label cannot be blank'),
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
  /** Reads a team owner's plan, which bounds the recipes saved in their workspace. */
  authRepo: Pick<AccountAuthRepo, 'getAccount'>;
  /** Optional, matching every other audit-emitting route: absent simply omits the row. */
  accountAudit?: AccountAuditService;
}

export function registerRecipesRoutes(app: FastifyInstance, deps: RecipesRoutesDeps): void {
  const { recipes, agentSessions, accountAudit, authRepo } = deps;

  /**
   * The workspace's account and plan: the caller's own when `eff` is undefined, or
   * the team owner's that `effectiveAccountIdForWrite` resolved.
   */
  async function workspaceOf(
    eff: string | undefined,
    ctx: NonNullable<FastifyRequest['account']>,
  ): Promise<{ accountId: string; tier: AccountTier }> {
    if (eff === undefined) return { accountId: ctx.account.id, tier: ctx.account.tier };
    const owner = await authRepo.getAccount(eff);
    if (!owner) throw new ForbiddenError('Owner account no longer exists.');
    return { accountId: owner.id, tier: owner.tier };
  }

  /**
   * Best-effort audit of a recipe lifecycle event. Mirrors the shape
   * `account-web-sessions.ts` uses: null-guarded, swallowing, and never able to
   * fail the operation the customer asked for — an audit hiccup must not turn a
   * successful delete into an error.
   *
   * `actorKeyId` is the point of the row. In the caller's own workspace both
   * `accountId` and `actorAccountId` are the caller's own account and neither
   * distinguishes one human from another on an account whose keys are shared. The
   * key id does. In a team owner's workspace the row lands on the owner's log (the
   * account the recipe belongs to), with the member as the actor.
   */
  async function emitRecipeAudit(
    req: FastifyRequest,
    ctx: NonNullable<FastifyRequest['account']>,
    workspaceAccountId: string,
    action: 'recipe.created' | 'recipe.deleted',
    recipeId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!accountAudit) return;
    try {
      await accountAudit.record({
        accountId: workspaceAccountId,
        actorType: 'customer',
        actorAccountId: ctx.account.id,
        actorKeyId: ctx.apiKey.id,
        action,
        targetResourceId: `recipe_${recipeId}`,
        payload,
        ipAddress: readClientIp(req),
      });
    } catch {
      // Swallow — an audit failure must not fail the recipe operation.
    }
  }

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
      // V-736 — the canonical predicate, not raw owner-equality. A team admin who
      // launched a session ON the owner can read it, stream its whole transcript
      // and delete it, but raw `!== ctx.account.id` locked them out of this one:
      // a bare 404 for a session they own the launch of. These were the last two
      // raw-equality sites in routes/; every agent-session route already uses
      // callerCanAccessAgentSession, whose own comment records this exact bug
      // being fixed across the rest of the surface (audit wxzlp9yiz #4).
      //
      // Not a header defect: the predicate reads ctx.teams, resolved server-side
      // by requireAuth, so no header can forge membership. The suggestion stores
      // nothing; the recipe routes below, which do, act in the workspace the
      // header names (security sweep #15).
      if (source === null || !callerCanAccessAgentSession(ctx, source.accountId)) {
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
      // Item 6 — a mistyped field on recipe creation used to be dropped in
      // silence, so the recipe saved without the option the caller set.
      const body = parseRequestBodyReportingUnknown({
        schema: CreateRecipeRequestSchema,
        req,
        reply,
        route: 'POST /v1/recipes',
      });

      // Load the source agent session to snapshot its intent_log +
      // transcript. It must belong to the workspace the recipe is saved in —
      // the caller's own, or the team owner's the header names, which needs the
      // admin role (security sweep #15). A session of any other account is a
      // cross-account copy neither owner authorized: 404, not 403, so existence
      // is not disclosed.
      const workspace = await workspaceOf(effectiveAccountIdForWrite(req, ctx), ctx);
      const source = await agentSessions.get(body.agent_session_id);
      if (source === null || source.accountId !== workspace.accountId) {
        throw new NotFoundError(`AgentSession ${body.agent_session_id} not found.`);
      }

      // Q.5.c — assemble intent_log from the transcript's
      // plan-executed agent turns. AgentRuntime persists each
      // plan's structured intent array on the transcript entry's
      // optional `intents` field (Q.5.c follow-up). flatMap
      // produces a concatenated intent_log in turn order so
      // replay walks them in the same sequence the customer's
      // session originally executed.
      const intentLog: AgentIntent[] = source.transcript.flatMap((entry) => entry.intents ?? []);

      // Security sweep #7 — each save copied the whole transcript, with no cap and
      // no dedupe: one session saved 60 times was 60 copies. Now a session is saved
      // once (an exact repeat answers with that recipe) and an account keeps at most
      // its plan's number of recipes, both decided under the repository's lock.
      const limit = recipeLimitFor(workspace.tier);
      const outcome = await recipes.createIfUnderLimit({
        accountId: workspace.accountId,
        agentSessionId: source.id,
        label: body.label,
        ...(body.description !== undefined ? { description: body.description } : {}),
        intentLog,
        transcriptSnapshot: source.transcript,
        limit,
      });
      if (outcome.kind === 'session_already_saved') {
        throw new ConflictError(
          `This session is already saved as recipe ${outcome.recipeId}. Delete that recipe to save the session again.`,
          { recipe_id: outcome.recipeId },
        );
      }
      if (outcome.kind === 'limit_reached') {
        throw new TierLimitError(
          `Your plan keeps up to ${limit.toString()} recipes, and this account has ${outcome.current.toString()}. Delete a recipe to save a new one.`,
          { limit, current: outcome.current, resource: 'recipe', tier: workspace.tier },
        );
      }
      // A retried save: the recipe it made the first time, and no second audit row.
      if (outcome.kind === 'existing') return reply.code(201).send(publicRecipe(outcome.record));
      const created = outcome.record;
      await emitRecipeAudit(req, ctx, workspace.accountId, 'recipe.created', created.id, {
        label: created.label,
        agent_session_id: source.id,
        intent_count: intentLog.length,
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
      // Security sweep #15 — the workspace the header names. In a teammate's
      // workspace the admin role is required, as for the owner's agent sessions:
      // a recipe is a saved copy of a session's steps.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(RECIPES_TEAM_ROLE_DETAIL);
      }
      const accountId = effective.accountId;
      const page = await recipes.list({
        accountId,
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
      // Same workspace and role rule as the list above (security sweep #15).
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(RECIPES_TEAM_ROLE_DETAIL);
      }
      const accountId = effective.accountId;
      const rec = await recipes.getById({ accountId, id: req.params.id });
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
      const accountId = effectiveAccountIdForWrite(req, ctx) ?? ctx.account.id;
      // Read before deleting so the audit row can carry the label. The row is the
      // ONLY trace that survives the delete — recording a bare id would say that
      // something was destroyed without saying what. One indexed lookup on a rare
      // operation. A concurrent delete between the two still 404s, unchanged.
      const existing = await recipes.getById({ accountId, id: req.params.id });
      const deleted = await recipes.deleteById({ accountId, id: req.params.id });
      if (!deleted) throw new NotFoundError(`Recipe ${req.params.id} not found.`);
      await emitRecipeAudit(req, ctx, accountId, 'recipe.deleted', req.params.id, {
        ...(existing !== null ? { label: existing.label } : {}),
      });
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
    'https://docs.driftstack.io/api/recipes/ for the supported API flow.';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.get('/v1/agent-sessions/:id/recipe-suggestion', stub);
  app.post('/v1/recipes', stub);
  app.get('/v1/recipes', stub);
  app.get('/v1/recipes/:id', stub);
  app.delete('/v1/recipes/:id', stub);
}
