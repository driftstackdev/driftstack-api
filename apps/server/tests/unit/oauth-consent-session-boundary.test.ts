import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';
import type { AccountContext } from '../../src/services/auth.js';

function accountContext(
  kind: 'api-key' | 'web-session',
  tier: AccountTier = 'api_builder',
): AccountContext {
  const now = new Date('2026-07-13T22:00:00.000Z');
  const scopes: ApiKeyScope[] = ['read', 'write', 'account_owner'];
  return {
    account: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'customer@example.test',
      name: null,
      tier,
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: now,
      updatedAt: now,
    },
    apiKey: {
      id: kind === 'web-session' ? 'wsk_session-1' : 'key_test',
      accountId: '00000000-0000-4000-8000-000000000001',
      name: kind,
      keyPrefix: kind,
      keyHash: '',
      scopes,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: now,
    },
    rateLimitOverrides: {},
    teams: [],
    webSession: kind === 'web-session' ? { id: 'session-1', mfaSatisfiedAt: null } : null,
  };
}

async function buildHarness(service: OAuthService): Promise<{
  app: FastifyInstance;
  requestedRateLimitBucket: string | null;
}> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorateRequest('account', null);
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('requireAuth', (request) => {
    request.account = accountContext(
      request.headers['x-test-auth-kind'] === 'web-session' ? 'web-session' : 'api-key',
      request.headers['x-test-tier'] === 'free' ? 'free' : 'api_builder',
    );
    return Promise.resolve();
  });
  let requestedRateLimitBucket: string | null = null;
  app.decorate('rateLimit', (bucket: string) => {
    requestedRateLimitBucket = bucket;
    return () => Promise.resolve();
  });
  registerOAuthRoutes(app, { service, rateLimitStore: new MemoryRateLimitStore() });
  await app.ready();
  return { app, requestedRateLimitBucket };
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('OAuth dashboard consent boundary', () => {
  it('rejects API keys before parsing or consuming consent, then allows the web session', async () => {
    const service = new OAuthService(new InMemoryOAuthStore());
    const registration = await service.registerClient({
      label: 'Consent test',
      redirect_uris: ['https://client.example.test/callback'],
    });
    const verifier = 'v'.repeat(64);
    const authorization = await service.authorize({
      client_id: registration.client_id,
      redirect_uri: 'https://client.example.test/callback',
      state: 'state_12345678',
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    const { app, requestedRateLimitBucket } = await buildHarness(service);

    try {
      expect(requestedRateLimitBucket).toBe('global');

      const malformedApiKeyAttempt = await app.inject({
        method: 'POST',
        url: '/v1/oauth/authorize/complete',
        headers: { 'x-test-auth-kind': 'api-key' },
        payload: {},
      });
      expect(malformedApiKeyAttempt.statusCode).toBe(403);
      expect(malformedApiKeyAttempt.json<{ detail: string }>().detail).toBe(
        'OAuth authorization requires an interactive dashboard session.',
      );

      const freeAttempt = await app.inject({
        method: 'POST',
        url: '/v1/oauth/authorize/complete',
        headers: { 'x-test-auth-kind': 'web-session', 'x-test-tier': 'free' },
        payload: { authorization_id: authorization.authorization_id },
      });
      expect(freeAttempt.statusCode).toBe(403);
      expect(freeAttempt.json<{ detail: string }>().detail).toContain('apiAccess');

      const approval = await app.inject({
        method: 'POST',
        url: '/v1/oauth/authorize/complete',
        headers: { 'x-test-auth-kind': 'web-session' },
        payload: { authorization_id: authorization.authorization_id },
      });
      expect(approval.statusCode, approval.body).toBe(200);

      const token = await service.exchangeCode({
        code: approval.json<{ code: string }>().code,
        code_verifier: verifier,
        client_id: registration.client_id,
        client_secret: registration.client_secret,
        redirect_uri: 'https://client.example.test/callback',
      });
      expect(token.scope).toEqual(['read:sessions']);
    } finally {
      await app.close();
    }
  });
});
