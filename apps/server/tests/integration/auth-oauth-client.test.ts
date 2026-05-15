// V-667.C — integration tests for the OAuth-client routes.
//
//   POST /v1/auth/oauth-client/start          — issue authorize URL
//   GET  /v1/auth/oauth-client/callback       — IDP redirect target
//                                                (not exercised here —
//                                                the IDP-side token-
//                                                exchange would need a
//                                                live IDP or a stub,
//                                                covered separately by
//                                                lib-oauth-client-
//                                                exchange unit tests)
//   POST /v1/auth/oauth-client/confirm-merge  — Verdict-1 completion
//
// The fixture registers the routes only when `opts.oauthClient` is
// passed; this test exercises the registered-route surface. Tests that
// pass nothing should continue to see 404 (route absent), matching
// prod-pre-env-wire posture.
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

const OAUTH = {
  signingSecret: 'a'.repeat(32),
  callbackUrl: 'https://app.driftstack.test/auth/oauth-client/callback',
  google: { clientId: 'google-test-id', clientSecret: 'google-test-secret' },
  github: { clientId: 'github-test-id', clientSecret: 'github-test-secret' },
};

describe('POST /v1/auth/oauth-client/start (V-667.C)', () => {
  it('returns 200 + authorize_url with all PKCE + state params when google is configured', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'google', redirect_to: 'https://app.driftstack.test/' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ authorize_url: string }>();
    const url = new URL(body.authorize_url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('google-test-id');
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH.callbackUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')?.length ?? 0).toBeGreaterThan(20);
    expect(url.searchParams.get('state')?.length ?? 0).toBeGreaterThan(20);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    // V-667.C — google-specific consent + offline-access prompts so
    // the IDP returns a fresh email (matters for Verdict-1 trust
    // contract).
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('sets the HMAC-signed HTTP-only PKCE cookie on the start response', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'github', redirect_to: 'https://app.driftstack.test/dashboard' },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    const pkce = cookies.find((c) => typeof c === 'string' && c.startsWith('ds_oauth_pkce='));
    expect(pkce).toBeDefined();
    expect(pkce).toMatch(/HttpOnly/i);
    expect(pkce).toMatch(/Path=\/v1\/auth\/oauth-client/);
    // Cookie body is "<verifier>.<base64url(hmac)>" — both halves non-empty.
    const body = String(pkce).split(';')[0]?.split('=')[1] ?? '';
    const [verifier, sig] = body.split('.');
    expect(verifier?.length ?? 0).toBeGreaterThan(40);
    expect(sig?.length ?? 0).toBeGreaterThan(20);
  });

  it('returns 400 when the request body fails schema validation (bad provider)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'facebook', redirect_to: 'https://app.driftstack.test/' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the configured server lacks creds for the requested provider', async () => {
    // Only github configured — asking for google → 400.
    fx = await buildTestApp({
      oauthClient: {
        signingSecret: OAUTH.signingSecret,
        callbackUrl: OAUTH.callbackUrl,
        github: OAUTH.github,
      },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'google', redirect_to: 'https://app.driftstack.test/' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string }>();
    expect(String(body.detail ?? '')).toMatch(/not configured/);
  });

  it('returns 404 when oauthClient was never wired (matches prod-pre-env-wire posture)', async () => {
    fx = await buildTestApp(); // no oauthClient
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'google', redirect_to: 'https://app.driftstack.test/' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/auth/oauth-client/confirm-merge (V-667.C)', () => {
  it('returns 400 on a malformed token (rejected before any service call)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/confirm-merge',
      headers,
      payload: { token: 'too-short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on a well-formed but unknown plaintext token — surface treats invalid/expired/consumed as one bucket so caller cannot enumerate', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const fakeToken = 'a'.repeat(64);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/confirm-merge',
      headers,
      payload: { token: fakeToken },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string }>();
    expect(String(body.detail ?? '')).toMatch(/invalid, expired, or already used/);
  });
});
