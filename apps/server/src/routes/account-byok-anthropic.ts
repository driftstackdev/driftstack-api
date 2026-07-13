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
import type { AccountAuditService } from '../services/account-audit.js';
import { BadRequestError, FeatureUnavailableError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import { testAnthropicKey, type AnthropicKeyTestResult } from '../services/anthropic-key-tester.js';

export interface AccountByokAnthropicRoutesOptions {
  service: BYOKAnthropicService;
  /** Now-provider (test-injectable). Defaults to `new Date()`. */
  now?: () => Date;
  /** Connection-tester (test-injectable). Pure boundary so unit tests
   *  don't need to mock Anthropic SDK HTTP. Returns the result for the
   *  POST /test endpoint. */
  testConnection?: (key: string) => Promise<AnthropicKeyTestResult>;
  /** Arc 7 obs.4 — optional metrics registry. When wired, the
   *  /test endpoint increments
   *  `driftstack_byok_anthropic_test_total{outcome}` per call. */
  metrics?: MetricsRegistry;
  /** 2026-05-20 — customer audit-log writer. When wired (which is
   *  the standard prod posture), set/clear/test on the BYOK key
   *  emits `account.byok_anthropic_key_{set,cleared,tested}` per
   *  the pre-launch audit-coverage gap closed 2026-05-20. Payload
   *  carries NO key-prefix fingerprint — only the event + timestamp
   *  + ipAddress (matches the rest of the account-audit-log surface).
   *  Optional so test fixtures + the activation-gate-off stub
   *  variant compile without it. */
  accountAudit?: AccountAuditService;
}

/** Map a connection-test result to one of the bounded `outcome` label
 *  values. The tester supplies a typed outcome so customer-facing copy can
 *  evolve without changing metric or audit cardinality. */
function classifyTestOutcome(
  result: AnthropicKeyTestResult,
): 'ok' | 'invalid' | 'quota_exceeded' | 'unknown' {
  return result.ok ? 'ok' : result.outcome;
}

export function registerAccountByokAnthropicRoutes(
  app: FastifyInstance,
  opts: AccountByokAnthropicRoutesOptions,
): void {
  const { service } = opts;
  const now = opts.now ?? (() => new Date());
  const testConnection = opts.testConnection ?? testAnthropicKey;
  const metrics = opts.metrics;
  const accountAudit = opts.accountAudit;

  // 2026-05-20 — best-effort audit emit. Wraps the record call so the
  // route never 5xx's because audit failed (mirrors the
  // emitAuditBestEffort pattern in services/auth-flows.ts +
  // services/webhooks.ts). Payload intentionally minimal — NO
  // key-prefix fingerprint per Q2 verdict 2026-05-17.
  async function emitAudit(
    accountId: string,
    action:
      | 'account.byok_anthropic_key_set'
      | 'account.byok_anthropic_key_cleared'
      | 'account.byok_anthropic_key_tested',
    request: FastifyRequest,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (!accountAudit) return;
    try {
      await accountAudit.record({
        accountId,
        actorType: 'customer',
        action,
        targetResourceId: `account_${accountId}`,
        payload: extra ?? {},
        ipAddress: readClientIp(request),
      });
    } catch {
      // Swallow; audit emit failures must NOT break the customer
      // operation. Sentry breadcrumb on the route handler captures
      // the failure for ops triage.
    }
  }

  // GET /v1/account/me/byok-anthropic-key — metadata only; NEVER
  // returns plaintext. Broad read is required because set/use timestamps
  // are account-wide credential metadata, not a resource-granular read.
  app.get(
    '/v1/account/me/byok-anthropic-key',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
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
        // 2026-05-20 — audit emit AFTER successful set. Drift-test
        // landed alongside the enum extension; ipAddress carried so
        // the audit log shows where the key was set from (useful for
        // incident response on compromised credentials).
        await emitAudit(ctx.account.id, 'account.byok_anthropic_key_set', request, {
          set_at: setAt.toISOString(),
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
      // 2026-05-20 — audit emit AFTER successful clear. Even an
      // idempotent clear-on-already-cleared rates an audit entry so
      // operators investigating a "key disappeared" report can see
      // every DELETE attempt.
      await emitAudit(ctx.account.id, 'account.byok_anthropic_key_cleared', request);
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
      const outcome = classifyTestOutcome(result);
      try {
        metrics?.inc(METRIC_NAMES.byokAnthropicTestTotal, {
          outcome,
        });
      } catch {
        // Swallow; metrics are best-effort.
      }
      // 2026-05-20 — audit emit. Payload carries the bounded outcome
      // label (ok / invalid / quota_exceeded / unknown)
      // so customers can correlate test-failure cadence with their
      // own key-rotation activity. No plaintext, no key-prefix, no
      // Anthropic-side response body.
      await emitAudit(ctx.account.id, 'account.byok_anthropic_key_tested', request, {
        outcome,
      });
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
