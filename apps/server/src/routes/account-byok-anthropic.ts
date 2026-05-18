// AI-CHAT BYOK Anthropic — customer-facing key-management routes.
// Tier-3 verdicts LOCKED 2026-05-17:
//   Q3 team-scope: account_owner-only (members USE, can't SET/CLEAR/TEST)
//
// Surface:
//   PUT    /v1/account/me/byok-anthropic-key       — set/rotate
//   DELETE /v1/account/me/byok-anthropic-key       — clear
//   GET    /v1/account/me/byok-anthropic-key       — metadata only
//   POST   /v1/account/me/byok-anthropic-key/test  — connection test
//
// Activation-gate pattern (6th gated feature; matches billing /
// session-proxy / saved-proxies / agent-sessions / fleet-events).
// When `byokAnthropicService` is unset in AppDeps (i.e.
// MFA_ENCRYPTION_KEY env not configured), `registerAccountByokAnthropicDisabledRoutes`
// surfaces 503 + FeatureUnavailable on the same paths.
//
// Audit log entries land in a follow-up slice — the V-216
// `AccountAuditAction` enum needs 3 new additive values
// (`account.byok_anthropic_key_{set,cleared,tested}`) which is a
// Class-A schema change that ships separately. Per Q2 verdict, when
// audit DOES land, it records `account_id` + timestamp + event only;
// NO key-prefix fingerprint.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BYOKAnthropicService } from '../services/byok-anthropic.js';
import { InvalidKeyFormatError } from '../services/byok-anthropic.js';
import { BadRequestError, FeatureUnavailableError } from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';

export interface AccountByokAnthropicRoutesOptions {
  service: BYOKAnthropicService;
  /** Now-provider (test-injectable). Defaults to `new Date()`. */
  now?: () => Date;
  /** Connection-tester (test-injectable). Pure boundary so unit tests
   *  don't need to mock Anthropic SDK HTTP. Returns the result for the
   *  POST /test endpoint. */
  testConnection?: (key: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Arc 7 obs.4 — optional metrics registry. When wired, the
   *  /test endpoint increments
   *  `driftstack_byok_anthropic_test_total{outcome}` per call. */
  metrics?: MetricsRegistry;
}

/** Map a connection-test result + reason string to one of the
 *  bounded `outcome` label values. Keeps label cardinality fixed
 *  even as the underlying error messages evolve. */
function classifyTestOutcome(
  result: { ok: true } | { ok: false; reason: string },
): 'ok' | 'invalid' | 'quota_exceeded' | 'not_wired' | 'unknown' {
  if (result.ok) return 'ok';
  const r = result.reason.toLowerCase();
  if (r.includes('not yet wired')) return 'not_wired';
  if (r.includes('quota') || r.includes('rate limit') || r.includes('rate-limit')) {
    return 'quota_exceeded';
  }
  if (r.includes('invalid') || r.includes('unauthorized') || r.includes('forbidden')) {
    return 'invalid';
  }
  return 'unknown';
}

function defaultTestConnection(): Promise<{ ok: false; reason: string }> {
  // The real Anthropic-SDK-backed tester lands with AI-B1.b. Until
  // then, surface a deterministic "not yet wired" reason so the
  // dashboard can render a meaningful state.
  return Promise.resolve({
    ok: false,
    reason: 'Connection tester not yet wired. AI-B1.b ships the Anthropic SDK call.',
  });
}

export function registerAccountByokAnthropicRoutes(
  app: FastifyInstance,
  opts: AccountByokAnthropicRoutesOptions,
): void {
  const { service } = opts;
  const now = opts.now ?? (() => new Date());
  const testConnection = opts.testConnection ?? defaultTestConnection;
  const metrics = opts.metrics;

  // GET /v1/account/me/byok-anthropic-key — metadata only; NEVER
  // returns plaintext. Read scope is sufficient (any account holder
  // can see whether their account has a BYOK key set).
  app.get(
    '/v1/account/me/byok-anthropic-key',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const meta = await service.getMetadata({ accountId: ctx.account.id });
      return {
        has_key: meta.hasKey,
        set_at: meta.setAt ? meta.setAt.toISOString() : null,
        last_used_at: meta.lastUsedAt ? meta.lastUsedAt.toISOString() : null,
      };
    },
  );

  // PUT /v1/account/me/byok-anthropic-key — set or rotate. account_owner
  // scope required (Q3 verdict; team members may USE the resolved key
  // but cannot manage it).
  app.put(
    '/v1/account/me/byok-anthropic-key',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const body = (request.body ?? {}) as { api_key?: unknown };
      if (typeof body.api_key !== 'string' || body.api_key.length === 0) {
        throw new BadRequestError('Body must include a non-empty `api_key` string.');
      }
      try {
        const { setAt } = await service.setKey({
          accountId: ctx.account.id,
          plaintext: body.api_key,
          now: now(),
        });
        return { set_at: setAt.toISOString() };
      } catch (err) {
        if (err instanceof InvalidKeyFormatError) {
          throw new BadRequestError(err.message);
        }
        throw err;
      }
    },
  );

  // DELETE /v1/account/me/byok-anthropic-key — clear. account_owner
  // scope required. 204 No Content on success.
  app.delete(
    '/v1/account/me/byok-anthropic-key',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
    },
    async (request: FastifyRequest, reply: FastifyReply): Promise<null> => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      await service.clearKey({ accountId: ctx.account.id, now: now() });
      reply.code(204);
      return null;
    },
  );

  // POST /v1/account/me/byok-anthropic-key/test — connection test.
  // Returns ok/error WITHOUT echoing any part of the key. account_owner
  // scope so team members can't burn the owner's quota.
  app.post(
    '/v1/account/me/byok-anthropic-key/test',
    {
      preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const plaintext = await service.getPlaintext({ accountId: ctx.account.id });
      if (plaintext === null) {
        try {
          metrics?.inc(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'not_set' });
        } catch {
          // Swallow; metrics are best-effort.
        }
        throw new BadRequestError(
          'No BYOK Anthropic key is set on this account. ' +
            'Use PUT /v1/account/me/byok-anthropic-key first.',
        );
      }
      const result = await testConnection(plaintext);
      try {
        metrics?.inc(METRIC_NAMES.byokAnthropicTestTotal, {
          outcome: classifyTestOutcome(result),
        });
      } catch {
        // Swallow; metrics are best-effort.
      }
      return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason };
    },
  );
}

/** Disabled-stub registrar — activation-gate pattern partner. Used
 *  when MFA_ENCRYPTION_KEY is unset (the BYOK service can't be
 *  constructed without it). Mirrors the 5 other gated features. */
export function registerAccountByokAnthropicDisabledRoutes(app: FastifyInstance): void {
  // Customer-facing detail. Lands verbatim in the SDK's 503 problem
  // body — point at the customer-facing docs URL, NOT the internal
  // design doc. Same fix shape as agent-sessions disabled-stub
  // (slice 87 / 6efc0a34).
  const detail =
    'BYOK Anthropic key management is not yet enabled on this deployment. ' +
    'Once the operator configures the deployment, customers can store their ' +
    'own Anthropic key via PUT /v1/account/me/byok-anthropic-key. See ' +
    'https://docs.driftstack.dev/api/byok-anthropic/ for the full flow.';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.get('/v1/account/me/byok-anthropic-key', stub);
  app.put('/v1/account/me/byok-anthropic-key', stub);
  app.delete('/v1/account/me/byok-anthropic-key', stub);
  app.post('/v1/account/me/byok-anthropic-key/test', stub);
}
