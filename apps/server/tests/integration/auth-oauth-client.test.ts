// V-667.C — integration tests for the OAuth-client routes.
//
//   POST /v1/auth/oauth-client/start          — issue authorize URL
//   GET  /v1/auth/oauth-client/callback       — state/cookie boundary
//                                                exercised with a stubbed
//                                                token exchange; provider
//                                                protocol behavior is covered
//                                                by the exchange unit tests
//   POST /v1/auth/oauth-client/confirm-merge  — Verdict-1 completion
//
// The fixture registers the routes only when `opts.oauthClient` is
// passed; this test exercises the registered-route surface. Tests that
// pass nothing should continue to see 404 (route absent), matching
// prod-pre-env-wire posture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
  vi.unstubAllGlobals();
});

const headers = { 'content-type': 'application/json' };

const OAUTH = {
  signingSecret: 'a'.repeat(32),
  callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
  dashboardOrigin: 'https://app.driftstack.test',
  google: { clientId: 'google-test-id', clientSecret: 'google-test-secret' },
  github: { clientId: 'github-test-id', clientSecret: 'github-test-secret' },
};

// Per-provider URL derivation — must equal what auth-oauth-client.ts
// computes for the IDP redirect_uri parameter.
const callbackFor = (p: 'google' | 'github') => `${OAUTH.callbackUrlBase}/${p}/callback`;

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
    expect(url.searchParams.get('redirect_uri')).toBe(callbackFor('google'));
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
    const pkce = cookies.find((c) => typeof c === 'string' && c.startsWith('ds_oauth_pkce_'));
    expect(pkce).toBeDefined();
    expect(String(pkce).split('=')[0]).toMatch(/^ds_oauth_pkce_[A-Za-z0-9_-]{43}$/);
    expect(pkce).toMatch(/HttpOnly/i);
    expect(pkce).toMatch(/Path=\/v1\/auth\/oauth-client/);
    // D2 — cookie body is "<verifier>.<nonce>.<base64url(hmac)>"; all three non-empty.
    const body = String(pkce).split(';')[0]?.split('=')[1] ?? '';
    const [verifier, nonce, sig] = body.split('.');
    expect(verifier?.length ?? 0).toBeGreaterThan(40);
    expect(nonce?.length ?? 0).toBeGreaterThan(20);
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

  it('returns 400 when redirect_to is off the dashboard origin (open-redirect guard)', async () => {
    // A forged /start with an off-origin redirect_to must be rejected at the
    // source — otherwise the callback echoes it back and the SPA bounces a
    // just-signed-in user off-site. dashboardOrigin is https://app.driftstack.test.
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'google', redirect_to: 'https://evil.example/phish' },
    });
    expect(res.statusCode).toBe(400);
    // No authorize_url is minted for an off-origin target.
    expect(res.json<{ authorize_url?: string }>().authorize_url).toBeUndefined();
  });

  it('accepts a same-origin redirect_to with a deep path (legit deep-link round-trip)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: {
        provider: 'google',
        redirect_to: 'https://app.driftstack.test/cli/authorize?session=abc',
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json<{ authorize_url: string }>().authorize_url ?? '').length).toBeGreaterThan(20);
  });

  it('returns 400 when the configured server lacks creds for the requested provider', async () => {
    // Only github configured — asking for google → 400.
    fx = await buildTestApp({
      oauthClient: {
        signingSecret: OAUTH.signingSecret,
        callbackUrlBase: OAUTH.callbackUrlBase,
        dashboardOrigin: OAUTH.dashboardOrigin,
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

describe('GET /v1/auth/oauth/:provider/callback — Path A IDP-direct redirect', () => {
  // Path A (2026-05-16): IDP redirects browser to the API per-provider
  // path; API 302s to the SPA exchange page preserving the query
  // string. This proves the bounce works for both providers and
  // forwards arbitrary query keys (code, state, error, scope, etc.).

  it('google: 302 to dashboard SPA callback preserving code + state', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google/callback?code=abc123&state=xyz789',
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location;
    expect(typeof loc).toBe('string');
    const url = new URL(String(loc));
    expect(url.origin).toBe(OAUTH.dashboardOrigin);
    expect(url.pathname).toBe('/auth/oauth-client/callback');
    expect(url.searchParams.get('code')).toBe('abc123');
    expect(url.searchParams.get('state')).toBe('xyz789');
  });

  it('github: 302 to dashboard SPA callback preserving forwarded query string', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/github/callback?code=g0d&state=s7t&scope=read%3Auser',
    });
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers.location));
    expect(url.searchParams.get('code')).toBe('g0d');
    expect(url.searchParams.get('state')).toBe('s7t');
    expect(url.searchParams.get('scope')).toBe('read:user');
  });

  it('forwards an error-denial query param verbatim (?error=access_denied)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google/callback?error=access_denied&error_description=User+denied',
    });
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers.location));
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toBe('User denied');
  });

  it('returns 404 for an unsupported provider segment (only google + github registered)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/facebook/callback?code=x&state=y',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/auth/oauth-client/callback — Path B SPA exchange', () => {
  it('IDP error param: short OAuth-spec code lands in 400 detail verbatim', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth-client/callback?error=access_denied',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string }>();
    expect(body.detail).toContain('IDP returned error: access_denied');
  });

  it('IDP error param: huge crafted error string is capped at 128 chars before interpolation (prevents problem+json body bloat)', async () => {
    // OAuth spec error codes are short tokens like 'access_denied'
    // / 'invalid_scope' — a 10kb error string is either a misconfigured
    // IDP or an attacker probing for response-bloat. Slice 115 caps
    // the interpolated portion at 128 chars.
    fx = await buildTestApp({ oauthClient: OAUTH });
    const huge = 'A'.repeat(10_000);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback?error=${huge}`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string }>();
    // The detail carries the 128-char slice, NOT the full 10k string.
    expect(body.detail).toBe(`IDP returned error: ${'A'.repeat(128)}`);
    // Defensive bound on the entire detail length so a future
    // refactor that re-introduces the full-string interpolation
    // trips the test.
    expect((body.detail ?? '').length).toBeLessThan(200);
  });

  it('missing code+state: 400 with explicit "Missing code or state" detail', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth-client/callback',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toContain('Missing code or state');
  });
});

describe('D2 — state↔cookie nonce binding (login-CSRF defense)', () => {
  async function startFlow(
    f: TestAppFixture,
    provider: 'google' | 'github' = 'github',
  ): Promise<{ state: string; cookie: string; cookieName: string; cookieValue: string }> {
    const res = await f.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider, redirect_to: 'https://app.driftstack.test/dashboard' },
    });
    const state = new URL(res.json<{ authorize_url: string }>().authorize_url).searchParams.get(
      'state',
    );
    const setCookie = res.headers['set-cookie'];
    const raw = (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).find((c) =>
      String(c).startsWith('ds_oauth_pkce_'),
    );
    const cookie = String(raw).split(';')[0] ?? '';
    const separator = cookie.indexOf('=');
    return {
      state: state ?? '',
      cookie,
      cookieName: cookie.slice(0, separator),
      cookieValue: cookie.slice(separator + 1),
    };
  }

  function rejectTokenExchange(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  it("rejects a valid state when only a DIFFERENT flow's scoped cookie is present", async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const a = await startFlow(fx);
    const b = await startFlow(fx);
    // Flow B selects only B's nonce-scoped cookie; A's valid cookie is unrelated.
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(b.state)}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toContain(
      'PKCE verifier cookie missing or invalid',
    );
  });

  it("rejects another flow's valid signed value forged under the expected cookie name", async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const a = await startFlow(fx);
    const b = await startFlow(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(b.state)}`,
      headers: { cookie: `${b.cookieName}=${a.cookieValue}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toContain('State/cookie binding mismatch');
  });

  it('rejects a tampered value under the correct nonce-scoped cookie name', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const flow = await startFlow(fx);
    // Tamper the FIRST signature character, never the last.
    //
    // The cookie is `verifier.nonce.sig`, and `sig` is a 32-byte HMAC in
    // base64url: 43 chars x 6 bits = 258 bits carrying 256, so the FINAL char
    // has 2 slack bits and four distinct characters decode to the same byte
    // ('A','B','C','D' all decode alike, and so on in groups of four).
    // Verification does Buffer.from(sig,'base64url') + timingSafeEqual, which
    // compares the decoded BYTES — so flipping the last char left the signature
    // valid whenever it fell in the same group, and this test failed to reject
    // and went red. Measured over 20,000 real signatures: 6.16% of runs, which
    // is exactly the predicted 4/64. That is the intermittent failure A2 had
    // been carrying as an unexplained flake; it was never load-related.
    //
    // A leading char carries all 6 of its bits inside byte 0, so changing it
    // always changes the decoded signature.
    const [verifier, nonce, sig] = flow.cookieValue.split('.');
    const tamperedSig = `${sig?.startsWith('A') === true ? 'B' : 'A'}${(sig ?? '').slice(1)}`;
    const tampered = `${verifier}.${nonce}.${tamperedSig}`;
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(flow.state)}`,
      headers: { cookie: `${flow.cookieName}=${tampered}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toContain(
      'PKCE verifier cookie missing or invalid',
    );
  });

  it('a state+cookie from the SAME flow passes the binding check (fails later, not on the binding)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const a = await startFlow(fx);
    rejectTokenExchange();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(a.state)}`,
      headers: { cookie: a.cookie },
    });
    // The nonce binding matches, so we get PAST it (the flow then fails at the
    // IDP token exchange, which is not exercised here) — never the mismatch 400.
    expect(res.json<{ detail?: string }>().detail ?? '').not.toContain('State/cookie binding');
  });

  it('keeps two browser-tab flows independent and clears only the callback flow', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const google = await startFlow(fx, 'google');
    const github = await startFlow(fx, 'github');
    expect(google.cookieName).not.toBe(github.cookieName);
    rejectTokenExchange();
    const cookieJar = `${google.cookie}; ${github.cookie}`;

    for (const flow of [google, github]) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(flow.state)}`,
        headers: { cookie: cookieJar },
      });
      expect(res.statusCode).toBe(400);
      const detail = res.json<{ detail?: string }>().detail ?? '';
      expect(detail).not.toContain('PKCE verifier cookie');
      expect(detail).not.toContain('State/cookie binding');
      const cleared = String(res.headers['set-cookie'] ?? '');
      expect(cleared).toContain(`${flow.cookieName}=;`);
      const other = flow === google ? github : google;
      expect(cleared).not.toContain(`${other.cookieName}=;`);
    }
  });
});
