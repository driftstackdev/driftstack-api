// AI-D — /v1/agent-sessions/* routes. Exposes the AgentRuntime
// (AI-COMPOSE composition slice, commit 09487cc6) over HTTP so the
// dashboard chat UI + SDK consumers can drive multi-turn agent
// sessions:
//
//   POST   /v1/agent-sessions            — create a new agent session
//   GET    /v1/agent-sessions/{id}       — read agent session state
//   POST   /v1/agent-sessions/{id}/message — run one decompose→execute turn
//   DELETE /v1/agent-sessions/{id}       — close the agent session
//
// Activation gate matches the rest of Wave 1119 — when `agentRuntime`
// is undefined in AppDeps, `registerAgentSessionsDisabledRoutes`
// surfaces 503 FeatureUnavailable on every endpoint so SDK + dashboard
// see a machine-readable "not yet enabled" signal instead of bare 404.
//
// Default-tier token budgets are intentionally hardcoded here for the
// v0 launch — tier-derived caps land in B3 (separate slice). Founder
// reviews this constant before flipping the gate on.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentRuntime } from '../services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../services/agent-sessions.js';
import {
  ConflictError,
  FeatureUnavailableError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';

const DEFAULT_TOKEN_BUDGET = 100_000;

const CreateAgentSessionRequestSchema = z.object({
  driftstack_session_id: z.string().min(1).optional(),
  token_budget: z.number().int().positive().optional(),
});

const RunTurnRequestSchema = z.object({
  user_message: z.string().min(1).max(8000),
});

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

interface PublicAgentSession {
  id: string;
  account_id: string;
  driftstack_session_id: string | null;
  status: string;
  closed_reason: string | null;
  token_budget_total: number;
  token_budget_remaining: number;
  transcript_length: number;
  created_at: string;
  updated_at: string;
}

function publicAgentSession(rec: AgentSessionRecord): PublicAgentSession {
  return {
    id: rec.id,
    account_id: rec.accountId,
    driftstack_session_id: rec.driftstackSessionId,
    status: rec.status,
    closed_reason: rec.closedReason,
    token_budget_total: rec.tokenBudgetTotal,
    token_budget_remaining: rec.tokenBudgetRemaining,
    transcript_length: rec.transcript.length,
    created_at: rec.createdAt.toISOString(),
    updated_at: rec.updatedAt.toISOString(),
  };
}

export interface AgentSessionsRoutesDeps {
  runtime: AgentRuntime;
  sessions: AgentSessionsRepo;
}

export function registerAgentSessionsRoutes(
  app: FastifyInstance,
  deps: AgentSessionsRoutesDeps,
): void {
  const { runtime, sessions } = deps;

  app.post(
    '/v1/agent-sessions',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = CreateAgentSessionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const created = await sessions.create({
        accountId: ctx.account.id,
        tokenBudgetTotal: parsed.data.token_budget ?? DEFAULT_TOKEN_BUDGET,
        ...(parsed.data.driftstack_session_id !== undefined
          ? { driftstackSessionId: parsed.data.driftstack_session_id }
          : {}),
      });
      return reply.code(201).send(publicAgentSession(created));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const rec = await sessions.get(req.params.id);
      if (rec === null || rec.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      return publicAgentSession(rec);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/message',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = RunTurnRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Cross-account guard before runtime.runTurn — the runtime
      // throws on unknown ids, but we want 403/404 distinction over
      // "not found" generic.
      const pre = await sessions.get(req.params.id);
      if (pre === null || pre.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // BYOK Anthropic key resolution (Tier-3 LOCKED 2026-05-16). For
      // v1.0 the header is the channel — customer-stored per-account
      // keys land in a follow-up slice. Until then any header value
      // passes through to AgentRuntime which threads to the decomposer.
      // NEVER logged, NEVER echoed; the header itself is plain HTTP
      // and lives only for the request lifetime.
      const headerByokKey =
        typeof req.headers['x-byok-anthropic-api-key'] === 'string'
          ? req.headers['x-byok-anthropic-api-key']
          : undefined;
      const result = await runtime.runTurn({
        agentSessionId: req.params.id,
        userMessage: parsed.data.user_message,
        ...(headerByokKey !== undefined ? { byokApiKey: headerByokKey } : {}),
      });
      if (result.kind === 'session-closed') {
        throw new ConflictError(
          `Agent session is ${result.session.status} (${result.reason}). Start a new agent session.`,
        );
      }
      if (result.kind === 'plan-executed') {
        // Narrow the decomposer to the plan variant — TS can't infer
        // it across the runTurn discriminant without a manual branch.
        const plan = result.decomposer;
        if (plan.kind !== 'plan') {
          throw new Error('runtime invariant: plan-executed without plan decomposer');
        }
        return {
          kind: result.kind,
          session: publicAgentSession(result.session),
          intents: plan.intents,
          results: result.executor.results,
          ok: result.executor.ok,
        };
      }
      if (result.kind === 'clarify') {
        return {
          kind: result.kind,
          session: publicAgentSession(result.session),
          clarifying_question: result.decomposer.clarifyingQuestion,
        };
      }
      // refuse
      return {
        kind: result.kind,
        session: publicAgentSession(result.session),
        refuse_reason: result.decomposer.refuseReason,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const pre = await sessions.get(req.params.id);
      if (pre === null || pre.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      await sessions.closeWithReason(req.params.id, 'customer-closed');
      return reply.code(204).send();
    },
  );
}

// Disabled stubs — registered when agentRuntime is undefined in
// AppDeps. Same activation-gate pattern as billing / session-egress /
// saved-proxies. Surfaces 503 FeatureUnavailable on every method so
// SDK + dashboard get a machine-readable signal vs 404.
export function registerAgentSessionsDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'AI chat agent is not yet enabled on this deployment. The AgentRuntime ' +
    'requires an LLM key path (BYOK or bundled) to be configured; see the ' +
    'AI-CHAT design doc.';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.post('/v1/agent-sessions', stub);
  app.get('/v1/agent-sessions/:id', stub);
  app.post('/v1/agent-sessions/:id/message', stub);
  app.delete('/v1/agent-sessions/:id', stub);
}
