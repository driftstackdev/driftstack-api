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
import type { BYOKAnthropicService } from '../services/byok-anthropic.js';
import type { InMemoryByokKeyCache } from '../services/byok-anthropic-key-cache.js';
import {
  ByokAnthropicRequiredError,
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
  // v2-#19 — wall-clock close timestamp; distinct from updated_at
  // which moves on every transcript append. NULL while active.
  closed_at: string | null;
  // v2-#35 — team-RBAC attribution. NULL when the auth context is
  // account-scoped (no specific team-member id resolvable). Today
  // always NULL for password / OAuth account-scoped sessions until
  // V-298 team-membership auth lands; surfaced on the read shape now
  // so the dashboard's "started by alice@" UI can wire against a
  // stable field.
  created_by_user_id: string | null;
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
    closed_at: rec.closedAt !== null ? rec.closedAt.toISOString() : null,
    created_by_user_id: rec.createdByUserId,
    created_at: rec.createdAt.toISOString(),
    updated_at: rec.updatedAt.toISOString(),
  };
}

export interface AgentSessionsRoutesDeps {
  runtime: AgentRuntime;
  sessions: AgentSessionsRepo;
  /** Q.1.c — optional. When wired, the route decrypts the
   *  customer's stored BYOK key on session-create and caches the
   *  plaintext for the session lifetime. Absent when MFA_ENCRYPTION_KEY
   *  isn't set (BYOK-per-customer-storage gate). */
  byokService?: BYOKAnthropicService;
  /** Q.1.c — required when byokService is wired. The in-memory
   *  cache that holds plaintexts for the session lifetime. */
  byokKeyCache?: InMemoryByokKeyCache;
  /** Q.1 — which decomposer impl bootstrap wired. Defaults to
   *  'deterministic'. The ByokAnthropicRequired 502 only fires
   *  when this is 'claude' (deterministic ignores keys entirely
   *  so the gate would be a false alarm). */
  agentDecomposerKind?: 'claude' | 'deterministic';
  /** Q.1.d — deployment fallback Anthropic key. Used only when:
   *  (a) the request has no x-byok-anthropic-api-key header
   *  (b) the session has no cached stored key
   *  (c) `allowFallbackForUnconfiguredCustomers` is true.
   *  Default is undefined (prod posture per Tier-3 verdict). */
  deploymentFallbackKey?: string;
  /** Q.1.d — staging-only opt-in. When false (the prod default),
   *  unconfigured customers get 502 ByokAnthropicRequired instead
   *  of silently consuming the deployment fallback. */
  allowFallbackForUnconfiguredCustomers?: boolean;
}

export function registerAgentSessionsRoutes(
  app: FastifyInstance,
  deps: AgentSessionsRoutesDeps,
): void {
  const {
    runtime,
    sessions,
    byokService,
    byokKeyCache,
    agentDecomposerKind = 'deterministic',
    deploymentFallbackKey,
    allowFallbackForUnconfiguredCustomers,
  } = deps;

  app.post(
    '/v1/agent-sessions',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = CreateAgentSessionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // v2-#19 — Stripe-pattern idempotency. Header name is lowercase
      // per Fastify's normalised headers map; the dashboard / SDK send
      // it as `Idempotency-Key` and the wire-level toLowerCase happens
      // before this handler sees it. Empty string treated as "absent"
      // so a stray `Idempotency-Key:` from an over-eager proxy doesn't
      // collapse all sessions to a single phantom-keyed row.
      const rawHeader = req.headers['idempotency-key'];
      const idempotencyKey =
        typeof rawHeader === 'string' && rawHeader.length > 0 ? rawHeader : null;
      if (idempotencyKey !== null) {
        const existing = await sessions.findByIdempotencyKey(ctx.account.id, idempotencyKey);
        if (existing !== null) {
          // Replay the prior 201 response. We re-attach the cached
          // BYOK key plaintext too: if the original session-create
          // hydrated the cache, the cache lives in memory and may
          // have evicted (single-replica today; survives a request
          // but not a redeploy). A second hydration here is cheap
          // (one AES-GCM unwrap) and keeps the replay behaviour
          // observably-identical to the first call.
          if (byokService !== undefined && byokKeyCache !== undefined) {
            // v2-#21 — pass `now` so a stored key older than the TTL
            // resolves to null + the resolution chain falls through to
            // header / fallback / 502.
            const stored = await byokService.getPlaintext({
              accountId: ctx.account.id,
              now: new Date(),
            });
            if (stored !== null) byokKeyCache.set(existing.id, stored);
          }
          return reply.code(201).send(publicAgentSession(existing));
        }
      }
      const created = await sessions.create({
        accountId: ctx.account.id,
        tokenBudgetTotal: parsed.data.token_budget ?? DEFAULT_TOKEN_BUDGET,
        ...(parsed.data.driftstack_session_id !== undefined
          ? { driftstackSessionId: parsed.data.driftstack_session_id }
          : {}),
        ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      });
      // Q.1.c — decrypt the customer's stored BYOK key ONCE at
      // session-create and stash plaintext in the per-session cache.
      // Bounds AES-GCM unwrap to one operation per session.
      // v2-#21 — pass `now` so the TTL gate fires for stored keys
      // older than maxKeyAgeMs (90d default).
      if (byokService !== undefined && byokKeyCache !== undefined) {
        const stored = await byokService.getPlaintext({
          accountId: ctx.account.id,
          now: new Date(),
        });
        if (stored !== null) {
          byokKeyCache.set(created.id, stored);
        }
      }
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
    // v2-#13 — dedicated bucket for AI chat turns (separate from
    // 'global' so a customer hammering chat doesn't burn through
    // their generic API quota). Bucket capacity scales per tier;
    // see TIER_RATE_LIMIT_DEFAULTS in @driftstack/api-types.
    { preHandler: [app.requireAuth, app.rateLimit('agent_sessions:message')] },
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
      // Q.1.c + Q.1.d — BYOK Anthropic key resolution chain (founder
      // verdicts 2026-05-17 layering onto BYOK Tier-3 LOCKED 2026-05-16
      // — customer brings their own Anthropic key). Priority order:
      //
      //   1. Per-request header (`x-byok-anthropic-api-key`) — the
      //      customer's explicit per-turn override. Header wins even
      //      when a stored key is cached (matches the Stripe / Mailgun
      //      "header overrides default" UX).
      //   2. Session-cached stored key — decrypted once on session
      //      create from `accounts.byok_anthropic_api_key_ciphertext`.
      //      Hit on the cache means the customer has set their key via
      //      PUT /v1/account/me/byok-anthropic-key.
      //   3. Deployment fallback key — Q.1.d HARD-502 in prod
      //      (`allowFallbackForUnconfiguredCustomers === false`); only
      //      consumed on staging where the flag is opted in for demo
      //      flows without BYOK setup.
      //
      // If nothing resolves AND fallback is gated, throw
      // ByokAnthropicRequiredError so the customer sees the
      // problem-type that points them at PUT /byok-anthropic-key.
      // NEVER logged; the key plaintext is held in-memory only.
      const headerByokKey =
        typeof req.headers['x-byok-anthropic-api-key'] === 'string'
          ? req.headers['x-byok-anthropic-api-key']
          : undefined;
      const cachedByokKey = byokKeyCache?.get(req.params.id);
      const resolvedByokKey =
        headerByokKey ??
        cachedByokKey ??
        (allowFallbackForUnconfiguredCustomers === true ? deploymentFallbackKey : undefined);
      // Q.1 — the ByokAnthropicRequired 502 only fires when the
      // deployment is wired for Claude. Deterministic ignores keys
      // entirely (the decomposer never reads byokAnthropicApiKey)
      // so gating would surface a false alarm to customers whose
      // turn would have succeeded with a deterministic plan output.
      if (resolvedByokKey === undefined && agentDecomposerKind === 'claude') {
        throw new ByokAnthropicRequiredError(
          'No Anthropic API key configured for this account. ' +
            'PUT /v1/account/me/byok-anthropic-key to set a stored key, ' +
            'or supply x-byok-anthropic-api-key on the request header.',
        );
      }
      const result = await runtime.runTurn({
        agentSessionId: req.params.id,
        userMessage: parsed.data.user_message,
        ...(resolvedByokKey !== undefined ? { byokApiKey: resolvedByokKey } : {}),
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
      // Q.1.c — clear the cached plaintext on customer close. The
      // delete is idempotent so concurrent budget-exhausted close
      // from the runtime is safe.
      byokKeyCache?.delete(req.params.id);
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
