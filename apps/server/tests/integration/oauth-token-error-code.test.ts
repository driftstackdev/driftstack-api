// V-737 — the OAuth error code must reach the client as a machine-readable
// field, not merely select an HTTP status.
//
// `oauthErrorToHttp` mapped the code to a status class and then discarded it,
// and the messages never contained it either — `new OAuthError('invalid_client',
// 'unknown or revoked client_id')` produces the detail "unknown or revoked
// client_id", with the code nowhere in it. So every 400 arrived as
// `type: bad-request` with only free-text prose to tell `invalid_grant` (restart
// the authorization flow) apart from `invalid_request` (fix the request).
//
// The page told integrators the code "appears in the title/detail", which was not
// a weak promise but a false one: it appeared nowhere at all.
//
// `error` is the field name RFC 6749 §5.2 gives this, so a standard OAuth client
// reads it without Driftstack-specific handling. These tests drive the real route
// and assert the wire body, because the contract IS the wire body.

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { OAuthError, type OAuthService } from '../../src/services/oauth.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

/** A service whose exchangeCode always fails with the given OAuth code. */
function appThrowing(code: ConstructorParameters<typeof OAuthError>[0], message: string) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The provider surface registers account-authenticated routes alongside the
  // unauthenticated token endpoint; stub the decorators they need. Only
  // /v1/oauth/token is exercised here.
  app.decorateRequest('account', null);
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  const service = {
    exchangeCode: () => Promise.reject(new OAuthError(code, message)),
  } as unknown as OAuthService;
  registerOAuthRoutes(app, { service, rateLimitStore: new MemoryRateLimitStore() });
  return app;
}

const BODY = {
  grant_type: 'authorization_code',
  code: 'code_x',
  code_verifier: 'v'.repeat(43),
  client_id: 'client_x',
  client_secret: 'secret_x',
  redirect_uri: 'https://app.test/cb',
};

describe('V-737 POST /v1/oauth/token surfaces the OAuth error code', () => {
  it('carries invalid_grant as a top-level `error` field on the 400', async () => {
    const app = appThrowing('invalid_grant', 'authorization code is invalid or expired');
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: BODY });
    await app.close();

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error?: string; detail?: string; type?: string }>();
    expect(body.error).toBe('invalid_grant');
    // The pre-existing contract is untouched: same status, same type, and the
    // human-readable detail still present.
    expect(body.type).toMatch(/bad-request$/);
    expect(body.detail).toBe('authorization code is invalid or expired');
    // The point of the field: the code was NOT recoverable from the prose.
    expect(body.detail).not.toContain('invalid_grant');
  });

  it('distinguishes invalid_request from invalid_grant, which share one type and status', async () => {
    // This is the case the field exists for — without it these two responses are
    // identical apart from prose, and they call for opposite client behaviour.
    const app = appThrowing('invalid_request', 'redirect_uri rejected');
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: BODY });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error?: string }>().error).toBe('invalid_request');
  });

  it('carries invalid_client on the 401 too', async () => {
    const app = appThrowing('invalid_client', 'unknown or revoked client_id');
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: BODY });
    await app.close();

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error?: string; type?: string }>();
    expect(body.error).toBe('invalid_client');
    expect(body.type).toMatch(/unauthorized$/);
  });
});
