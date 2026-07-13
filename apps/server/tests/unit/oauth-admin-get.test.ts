// V-667.D — unit tests for the GET /v1/admin/oauth/clients/:id route
// and the OAuthService.getClient pass-through.
//
// Uses the same lightweight Fastify harness as V-667.C — minimal
// decorator stubs for requireScope + requireAuth so the admin route
// binds, then exercises the public response shape.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';

async function buildHarness(svc: OAuthService): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerOAuthRoutes(app, { service: svc, rateLimitStore: new MemoryRateLimitStore() });
  await app.ready();
  return app;
}

interface AdminGetResponse {
  client_id: string;
  label: string;
  redirect_uris: readonly string[];
  account_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

describe('V-667.D OAuthService.getClient — service pass-through', () => {
  it('returns the stored client envelope', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
    });
    const fetched = await svc.getClient(reg.client_id);
    expect(fetched).not.toBeNull();
    expect(fetched?.label).toBe('AppOne');
    expect(fetched?.redirect_uris).toEqual(['https://app.example/cb']);
  });

  it('returns null for an unknown client_id', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    expect(await svc.getClient('oac_does_not_exist')).toBeNull();
  });

  it('returns the client with revoked_at populated after revocation', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
    });
    await svc.revokeClient(reg.client_id);
    const fetched = await svc.getClient(reg.client_id);
    expect(fetched?.revoked_at).not.toBeNull();
  });
});

describe('V-667.D GET /v1/admin/oauth/clients/:id — route layer', () => {
  it('200 with the envelope (no secret) for a real client', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
      account_id: 'acc_owner',
    });
    const app = await buildHarness(svc);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/oauth/clients/${reg.client_id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminGetResponse>();
    expect(body.client_id).toBe(reg.client_id);
    expect(body.label).toBe('AppOne');
    expect(body.redirect_uris).toEqual(['https://app.example/cb']);
    expect(body.account_id).toBe('acc_owner');
    expect(body.revoked_at).toBeNull();
    // Critical: the route MUST NOT echo back the (hashed) secret.
    expect(JSON.stringify(body)).not.toMatch(/client_secret/);
    expect(JSON.stringify(body)).not.toMatch(/secret_hash/);
    await app.close();
  });

  it('404 for an unknown client_id', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const app = await buildHarness(svc);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/oauth/clients/oac_does_not_exist',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('200 with revoked_at populated after the client is revoked', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'AppGone',
      redirect_uris: ['https://app.example/cb'],
    });
    await svc.revokeClient(reg.client_id);
    const app = await buildHarness(svc);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/oauth/clients/${reg.client_id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminGetResponse>();
    expect(body.revoked_at).not.toBeNull();
    await app.close();
  });
});
