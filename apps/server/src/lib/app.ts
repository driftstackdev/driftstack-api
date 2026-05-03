// Fastify app builder.
//
// Pure factory: takes its dependencies as arguments, returns a configured
// `FastifyInstance`. Tests build the app with in-memory adapters; production
// wires the same builder to Drizzle + ioredis.

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';
import type { AccountAuthRepo } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { AuthCoalescer } from '../services/auth-coalescer.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import type { SessionsService } from '../services/sessions.js';
import type { ApiKeysService } from '../services/api-keys.js';
import type { UsageService } from '../services/usage.js';
import type { WebhooksService, WebhooksAdminService } from '../services/webhooks.js';
import type { AdminAuditService } from '../services/admin-audit.js';
import type { AccountsAdminService } from '../services/admin-accounts.js';
import type { RateLimitOverridesService } from '../services/rate-limit-overrides.js';
import type { LegalService } from '../services/legal.js';
import type { AuthFlowsService } from '../services/auth-flows.js';
import type { StripeWebhooksService } from '../services/stripe-webhooks.js';
import type { ProfilesService } from '../services/profiles.js';
import type { BillingService } from '../services/billing.js';
import type { SessionRepo } from '../services/sessions.js';
import type { ApiKeysRepo } from '../services/api-keys.js';
import type { Driver } from '../drivers/types.js';
import authPlugin from '../middleware/auth.js';
import rateLimitPlugin from '../middleware/rate-limit.js';
import requestIdPlugin from '../middleware/request-id.js';
import { registerErrorHandler } from '../middleware/error-handler.js';
import { registerSessionRoutes } from '../routes/sessions.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerOpenApiRoutes } from '../routes/openapi.js';
import { registerWebhookRoutes } from '../routes/webhooks.js';
import { registerAdminAccountsRoutes } from '../routes/admin-accounts.js';
import { registerAdminWebhookRoutes } from '../routes/admin-webhooks.js';
import { registerAdminAuditLogRoutes } from '../routes/admin-audit-log.js';
import { registerLegalRoutes } from '../routes/legal.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerStripeWebhookRoutes } from '../routes/webhooks-stripe.js';
import { registerProfileRoutes } from '../routes/profiles.js';
import { registerBillingRoutes } from '../routes/billing.js';
import { registerAdminForceActionRoutes } from '../routes/admin-force-actions.js';

export interface ReadinessCheck {
  /** Display name surfaced in the /ready response (e.g. "postgres", "redis", "r2"). */
  name: string;
  /** Async probe — throws or rejects on failure, resolves on success. */
  fn: () => Promise<unknown>;
  /** Per-check timeout in ms. Default 1500. */
  timeoutMs?: number;
}

async function runWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let to: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (to !== undefined) clearTimeout(to);
  }
}

export interface AppDeps {
  logger: Logger;
  authRepo: AccountAuthRepo;
  authCache: AuthCache | null;
  authCoalescer: AuthCoalescer | null;
  rateLimitStore: RateLimitStore;
  sessionsService: SessionsService;
  apiKeysService: ApiKeysService;
  usageService: UsageService;
  webhooksService: WebhooksService;
  webhooksAdminService: WebhooksAdminService;
  adminAuditService: AdminAuditService;
  accountsAdminService: AccountsAdminService;
  rateLimitOverridesService: RateLimitOverridesService;
  legalService: LegalService;
  /**
   * V-079: user-facing auth flows. Optional during the migration window —
   * when omitted, the /v1/auth/* routes are not registered. Once the
   * onboarding flow lands in production this becomes required.
   */
  authFlowsService?: AuthFlowsService;
  /**
   * V-080: inbound Stripe webhook handler. Optional — when both
   * `stripeWebhooksService` and `stripeWebhookSigningSecret` are
   * provided, POST /v1/webhooks/stripe is registered with raw-body
   * parsing + signature verification.
   */
  stripeWebhooksService?: StripeWebhooksService;
  /** Stripe webhook signing secret (whsec_...). Required if `stripeWebhooksService` is set. */
  stripeWebhookSigningSecret?: string;
  /** V-081: profile CRUD service. Optional during scaffolding window. */
  profilesService?: ProfilesService;
  /** V-082: billing service (Stripe checkout / portal / trial-pack). Optional. */
  billingService?: BillingService;
  /**
   * V-100: admin force-action route deps. Routes register only when
   * all four are provided (sessionRepo / apiKeysRepo / driver / audit
   * are all needed for the destroy/revoke handlers).
   */
  sessionRepo?: SessionRepo;
  apiKeysRepo?: ApiKeysRepo;
  driver?: Driver;
  /**
   * Readiness checks executed by `/ready`. Each runs with the
   * supplied (or default 1500ms) timeout; aggregate result drives
   * the HTTP status (200 all-ok, 503 any-fail). Empty array =
   * /ready always returns 200 (process-up semantics only).
   */
  readinessChecks?: ReadinessCheck[];
  /** When true, register a permissive CORS policy. Production locks this down. */
  permissiveCors?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      if (typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128) {
        return inbound;
      }
      return randomUUID();
    },
  });

  // Security headers. Permissive CORS is dev-only; prod sets explicit origins.
  await app.register(helmet, {
    contentSecurityPolicy: false, // API only — no HTML to protect
  });
  await app.register(cors, {
    origin: deps.permissiveCors === true ? true : [/^https?:\/\/localhost(:\d+)?$/],
    credentials: true,
    exposedHeaders: ['x-request-id', 'x-ratelimit-remaining', 'retry-after'],
  });

  await app.register(requestIdPlugin);
  await app.register(authPlugin, {
    authRepo: deps.authRepo,
    authCache: deps.authCache,
    authCoalescer: deps.authCoalescer,
  });
  await app.register(rateLimitPlugin, { store: deps.rateLimitStore });

  registerErrorHandler(app);

  registerSessionRoutes(app, { service: deps.sessionsService });
  registerAdminRoutes(app, {
    apiKeysService: deps.apiKeysService,
    usageService: deps.usageService,
  });
  registerWebhookRoutes(app, { service: deps.webhooksService });
  registerAdminAccountsRoutes(app, {
    accountsAdmin: deps.accountsAdminService,
    usage: deps.usageService,
    rateLimitOverrides: deps.rateLimitOverridesService,
    audit: deps.adminAuditService,
  });
  registerAdminWebhookRoutes(app, {
    webhooksAdmin: deps.webhooksAdminService,
    audit: deps.adminAuditService,
  });
  registerAdminAuditLogRoutes(app, { audit: deps.adminAuditService });
  registerLegalRoutes(app, deps.legalService);
  if (deps.authFlowsService !== undefined) {
    registerAuthRoutes(app, { service: deps.authFlowsService });
  }
  if (deps.stripeWebhooksService !== undefined && deps.stripeWebhookSigningSecret !== undefined) {
    registerStripeWebhookRoutes(app, {
      service: deps.stripeWebhooksService,
      signingSecret: deps.stripeWebhookSigningSecret,
      logger: deps.logger,
    });
  }
  if (deps.profilesService !== undefined) {
    registerProfileRoutes(app, { service: deps.profilesService });
  }
  if (deps.billingService !== undefined) {
    registerBillingRoutes(app, { service: deps.billingService });
  }
  if (
    deps.sessionRepo !== undefined &&
    deps.apiKeysRepo !== undefined &&
    deps.driver !== undefined
  ) {
    registerAdminForceActionRoutes(app, {
      sessionRepo: deps.sessionRepo,
      apiKeysRepo: deps.apiKeysRepo,
      driver: deps.driver,
      audit: deps.adminAuditService,
      authCache: deps.authCache,
    });
  }
  await registerOpenApiRoutes(app);

  // Health endpoint — public, no auth, no rate limit. Liveness only:
  // the process is up and accepting connections. Does not check DB,
  // Redis, or R2 — those checks live on /ready (readiness).
  app.get('/health', () => ({ ok: true }));
  app.get('/healthz', () => ({ ok: true }));

  // Readiness endpoint — public, no auth, no rate limit. Returns 200
  // only when the dependencies the server needs to serve traffic are
  // reachable. Designed for orchestrator readiness probes (the
  // Hetzner deploy reads this; Cloudflare in front of the host reads
  // /health). Production wires `readinessChecks` for postgres + redis
  // + R2; tests typically pass none and /ready returns 200 with an
  // empty checks array.
  app.get('/ready', async (_request, reply) => {
    const checks = deps.readinessChecks ?? [];
    const results = await Promise.all(
      checks.map(async (c) => {
        const start = Date.now();
        try {
          await runWithTimeout(c.fn(), c.timeoutMs ?? 1500);
          return { name: c.name, ok: true, latency_ms: Date.now() - start };
        } catch (err) {
          return {
            name: c.name,
            ok: false,
            latency_ms: Date.now() - start,
            error: err instanceof Error ? err.message : 'unknown',
          };
        }
      }),
    );
    const allReady = results.every((c) => c.ok);
    return reply.code(allReady ? 200 : 503).send({
      ready: allReady,
      checks: results,
    });
  });

  // Whoami — quick smoke test for auth.
  app.get('/v1/whoami', { preHandler: [app.requireAuth, app.rateLimit('global')] }, (request) => {
    const ctx = request.account;
    if (!ctx) {
      // requireAuth either resolves with a context or throws — this branch
      // is unreachable in practice but keeps the type narrow.
      throw new Error('account context missing after requireAuth');
    }
    return {
      account_id: `acc_${ctx.account.id}`,
      api_key_id: `key_${ctx.apiKey.id}`,
      tier: ctx.account.tier,
      scopes: ctx.apiKey.scopes,
    };
  });

  return app;
}
