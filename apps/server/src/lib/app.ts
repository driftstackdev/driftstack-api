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
    audit: deps.adminAuditService,
  });
  registerAdminWebhookRoutes(app, {
    webhooksAdmin: deps.webhooksAdminService,
    audit: deps.adminAuditService,
  });
  registerAdminAuditLogRoutes(app, { audit: deps.adminAuditService });
  await registerOpenApiRoutes(app);

  // Health endpoint — public, no auth, no rate limit.
  app.get('/health', () => ({ ok: true }));
  app.get('/healthz', () => ({ ok: true }));

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
