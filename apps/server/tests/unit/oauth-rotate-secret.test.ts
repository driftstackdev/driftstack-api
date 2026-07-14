// V-667.E — unit tests for OAuth rotate-client-secret.
//
// Layers under test:
//   1. OAuthService.rotateClientSecret — generates a fresh plaintext,
//      stores the hash, returns the plaintext, errors when the client
//      is unknown or revoked.
//   2. POST /v1/admin/oauth/clients/:id/rotate-secret — returns 200
//      + the new plaintext (shown ONCE), 401 on unknown / revoked.
//   3. Behaviour invariant — already-issued access tokens stay valid
//      after rotation (the secret is only consulted on /token exchange).

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { InMemoryOAuthStore, OAuthError, OAuthService } from '../../src/services/oauth.js';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';

class RevokeBeforeRotateStore extends InMemoryOAuthStore {
  override async rotateClientSecretHash(id: string, newHash: string): Promise<boolean> {
    await this.revokeClient(id, Date.now());
    return super.rotateClientSecretHash(id, newHash);
  }
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

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

async function mintToken(svc: OAuthService): Promise<{
  client_id: string;
  client_secret: string;
  access_token: string;
}> {
  const reg = await svc.registerClient({
    label: 'App',
    redirect_uris: ['https://app.example/cb'],
  });
  const verifier = 'v'.repeat(64);
  const authorize = await svc.authorize({
    client_id: reg.client_id,
    redirect_uri: 'https://app.example/cb',
    state: 's'.repeat(20),
    code_challenge: s256(verifier),
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
  return {
    client_id: reg.client_id,
    client_secret: reg.client_secret,
    access_token: exchange.access_token,
  };
}

describe('V-667.E OAuthService.rotateClientSecret — service layer', () => {
  it('returns a fresh plaintext that differs from the previous one', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const rotated = await svc.rotateClientSecret(reg.client_id);
    expect(rotated.client_secret).toMatch(/^oas_/);
    expect(rotated.client_secret).not.toBe(reg.client_secret);
  });

  it('throws invalid_client OAuthError on an unknown client_id', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    await expect(svc.rotateClientSecret('oac_does_not_exist')).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws invalid_client on a revoked client', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    await svc.revokeClient(reg.client_id);
    await expect(svc.rotateClientSecret(reg.client_id)).rejects.toThrow(
      /unknown or revoked client_id/,
    );
  });

  it('rejects when revocation wins at the authoritative secret-swap boundary', async () => {
    const store = new RevokeBeforeRotateStore();
    const svc = new OAuthService(store);
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });

    await expect(svc.rotateClientSecret(reg.client_id)).rejects.toThrow(
      /unknown or revoked client_id/,
    );

    const after = await store.getClient(reg.client_id);
    expect(after?.revoked_at).not.toBeNull();
    expect(after?.client_secret_hash).toBe(
      createHash('sha256').update(reg.client_secret).digest('hex'),
    );
  });

  it('preserves client_id + redirect_uris across rotation', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    await svc.rotateClientSecret(reg.client_id);
    const after = await svc.getClient(reg.client_id);
    expect(after?.client_id).toBe(reg.client_id);
    expect(after?.redirect_uris).toEqual(['https://app.example/cb']);
    expect(after?.revoked_at).toBeNull();
  });

  it('exchange with the OLD secret fails after rotation', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const verifier = 'v'.repeat(64);
    const authorize = await svc.authorize({
      client_id: reg.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 's'.repeat(20),
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    const approval = await svc.approveAuthorization({
      authorization_id: authorize.authorization_id,
      account_id: 'acc_test',
    });
    await svc.rotateClientSecret(reg.client_id);
    // OLD secret is no longer good.
    await expect(
      svc.exchangeCode({
        code: approval.code,
        code_verifier: verifier,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://app.example/cb',
      }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('already-issued access tokens stay valid after rotation', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const minted = await mintToken(svc);
    await svc.rotateClientSecret(minted.client_id);
    // Bearer-authenticated tokens don't re-consult client_secret.
    const introspect = await svc.introspect(minted.access_token);
    expect(introspect).not.toBeNull();
  });
});

describe('V-667.E POST /v1/admin/oauth/clients/:id/rotate-secret — route layer', () => {
  it('200 + new client_secret', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const app = await buildHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/oauth/clients/${reg.client_id}/rotate-secret`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ client_secret: string }>();
    expect(body.client_secret).toMatch(/^oas_/);
    expect(body.client_secret).not.toBe(reg.client_secret);
    await app.close();
  });

  it('401 on unknown client_id (invalid_client → UnauthorizedError)', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const app = await buildHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/oauth/clients/oac_unknown/rotate-secret',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401 on revoked client_id', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    await svc.revokeClient(reg.client_id);
    const app = await buildHarness(svc);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/oauth/clients/${reg.client_id}/rotate-secret`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
