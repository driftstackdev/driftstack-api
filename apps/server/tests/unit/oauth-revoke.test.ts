// V-667.C — unit tests for OAuth token revocation (RFC 7009).
//
// Two layers under test:
//   1. OAuthService.revokeToken — service-level pass-through to the store.
//   2. POST /v1/oauth/revoke route — always-200 posture and validation.

import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * End-to-end OAuth dance against an InMemoryOAuthStore — returns a
 * minted access token. Reused by the service + route specs so each
 * test starts from a real token, not a hand-rolled fixture.
 */
async function mintAccessToken(svc: OAuthService): Promise<string> {
  const reg = await svc.registerClient({
    label: 'TestApp',
    redirect_uris: ['https://app.example/cb'],
  });
  const verifier = 'v'.repeat(64);
  const challenge = s256(verifier);
  const authorize = await svc.authorize({
    client_id: reg.client_id,
    redirect_uri: 'https://app.example/cb',
    state: 'st_' + 'x'.repeat(20),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: ['read:sessions'],
  });
  const approval = await svc.approveAuthorization({
    authorization_id: authorize.authorization_id,
    account_id: 'acc_test',
  });
  const exchange = await svc.exchangeCode({
    code: approval.code,
    code_verifier: verifier,
    client_id: reg.client_id,
    client_secret: reg.client_secret,
    redirect_uri: 'https://app.example/cb',
  });
  return exchange.access_token;
}

async function buildRouteHarness(svc: OAuthService): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerErrorHandler(app);
  // V-667.C — registerOAuthRoutes attaches an admin route guarded by
  // app.requireScope (a decorator wired by the full buildApp factory).
  // Tests here only exercise the public /v1/oauth/* surface; decorate
  // a no-op requireScope so the admin route binds without failing.
  // Decorator returns a preHandler — Fastify lets sync preHandlers
  // resolve via Promise.resolve(), so the no-op stub does not need
  // to be async.
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerOAuthRoutes(app, { service: svc, rateLimitStore: new MemoryRateLimitStore() });
  await app.ready();
  return app;
}

describe('V-667.C OAuthService.revokeToken — service layer', () => {
  it('deletes the token so the next introspect returns null', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const token = await mintAccessToken(svc);
    expect(await svc.introspect(token)).not.toBeNull();
    await svc.revokeToken(token);
    expect(await svc.introspect(token)).toBeNull();
  });

  it('is idempotent — revoking an unknown token is a silent no-op', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    await expect(svc.revokeToken('not-a-real-token')).resolves.toBeUndefined();
  });

  it('forwards to the store.revokeToken hook (spy-based)', async () => {
    const revokeSpy = vi.fn(() => Promise.resolve());
    // Object spread skips class-prototype methods (only own properties
    // are enumerated), so spreading `new InMemoryOAuthStore()` would
    // drop every method except instance fields. Use the instance
    // directly, then shadow `revokeToken` via Object.assign so the
    // spy intercepts the call without TS treating it as a missing
    // implementation.
    const store = new InMemoryOAuthStore();
    Object.assign(store, { revokeToken: revokeSpy });
    const svc = new OAuthService(store);
    await svc.revokeToken('opaque-token');
    expect(revokeSpy).toHaveBeenCalledWith('opaque-token');
  });
});

describe('V-667.C POST /v1/oauth/revoke — route layer', () => {
  it('200 + revokes a real minted token', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const token = await mintAccessToken(svc);
    const app = await buildRouteHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oauth/revoke',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    // Subsequent introspect on the same token should now return active:false.
    const intro = await app.inject({
      method: 'POST',
      url: '/v1/oauth/introspect',
      payload: { token },
    });
    expect(intro.json<{ active: boolean }>().active).toBe(false);
    await app.close();
  });

  it('200 even for an unknown token (RFC 7009 — no enumeration)', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const app = await buildRouteHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oauth/revoke',
      payload: { token: 'never-issued' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts the optional token_type_hint without storing it', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const token = await mintAccessToken(svc);
    const app = await buildRouteHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oauth/revoke',
      payload: { token, token_type_hint: 'access_token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('400 on missing token field', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const app = await buildRouteHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oauth/revoke',
      payload: { token_type_hint: 'access_token' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 on invalid token_type_hint value', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const app = await buildRouteHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oauth/revoke',
      payload: { token: 'tok', token_type_hint: 'mtls_jwt' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('V-667.C — introspect contract preserved after revoke', () => {
  it('introspect returns active:true before revoke and active:false after', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const token = await mintAccessToken(svc);
    const app = await buildRouteHarness(svc);

    const before = await app.inject({
      method: 'POST',
      url: '/v1/oauth/introspect',
      payload: { token },
    });
    expect(before.json<{ active: boolean; scope: string[] }>().active).toBe(true);
    expect(before.json<{ active: boolean; scope: string[] }>().scope).toEqual(['read:sessions']);

    await app.inject({ method: 'POST', url: '/v1/oauth/revoke', payload: { token } });

    const after = await app.inject({
      method: 'POST',
      url: '/v1/oauth/introspect',
      payload: { token },
    });
    expect(after.json<{ active: boolean }>().active).toBe(false);
    await app.close();
  });
});
