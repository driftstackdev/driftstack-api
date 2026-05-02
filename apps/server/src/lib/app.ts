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
import type { RateLimitStore } from '../services/rate-limit.js';
import type { SessionsService } from '../services/sessions.js';
import authPlugin from '../middleware/auth.js';
import rateLimitPlugin from '../middleware/rate-limit.js';
import requestIdPlugin from '../middleware/request-id.js';
import { registerErrorHandler } from '../middleware/error-handler.js';
import { registerSessionRoutes } from '../routes/sessions.js';

export interface AppDeps {
  logger: Logger;
  authRepo: AccountAuthRepo;
  rateLimitStore: RateLimitStore;
  sessionsService: SessionsService;
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
  await app.register(authPlugin, { authRepo: deps.authRepo });
  await app.register(rateLimitPlugin, { store: deps.rateLimitStore });

  registerErrorHandler(app);

  registerSessionRoutes(app, { service: deps.sessionsService });

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
