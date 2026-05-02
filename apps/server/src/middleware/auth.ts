// Auth middleware: validates the Authorization header, attaches the
// account context to `request.account`, and rejects with the appropriate
// problem+json error if the key is missing/invalid/revoked/expired.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountAuthRepo, AccountContext } from '../services/auth.js';
import { authenticate, extractBearerToken, requireScope } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { AuthCoalescer } from '../services/auth-coalescer.js';
import type { ApiKeyScope } from '@driftstack/api-types';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountContext | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireScope: (
      scope: ApiKeyScope,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  authRepo: AccountAuthRepo;
  authCache: AuthCache | null;
  authCoalescer: AuthCoalescer | null;
}

function authPlugin(
  app: FastifyInstance,
  opts: AuthPluginOptions,
  done: (err?: Error) => void,
): void {
  app.decorateRequest('account', null);

  const requireAuth = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    const ctx = await authenticate(
      opts.authRepo,
      token,
      opts.authCache,
      new Date(),
      opts.authCoalescer,
    );
    request.account = ctx;
  };

  app.decorate('requireAuth', requireAuth);

  app.decorate('requireScope', (scope: ApiKeyScope) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.account) {
        await requireAuth(request, reply);
      }
      if (request.account) requireScope(request.account, scope);
    };
  });

  done();
}

export default fp(authPlugin, { name: 'auth' });
