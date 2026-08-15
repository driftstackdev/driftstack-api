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
import { signOauthClientState } from '../../src/lib/oauth-client-state.js';

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

// ─── the state token's OWN verification, at the route ───────────────────────
//
// Added 2026-08-15. The D2 block above is a careful set on the nonce-scoped PKCE
// cookie binding — but every one of its arms supplies a token minted by /start,
// i.e. a VALID state, and then varies the COOKIE. `verifyOauthClientState`
// returning anything other than `ok` is what `routes/auth-oauth-client.ts:201`
// refuses, and that refusal had never executed: the function is covered in
// isolation by `lib-oauth-client-state`, and the route's use of it was not.
//
// This is the CSRF defence for social login. The state token is what ties the
// callback the browser presents back to a flow this server started; without the
// check, a callback carrying an attacker-chosen `state` — and therefore an
// attacker-chosen `provider` and `redirectTo` — is processed as if we had issued
// it. The verifier is a tagged union precisely so the route can distinguish the
// failure modes, and all three non-ok kinds are driven here.
//
// The state check runs BEFORE the PKCE cookie is read, so these arms send no
// cookie at all: reaching a cookie error would mean the state check let the
// request through.
//
// MUTATION-PROVED against routes/auth-oauth-client.ts and
// lib/oauth-client-state.ts — controls 25/25 here, 11/11 on the verifier's own
// unit test:
//
//                                                    here    state-lib pin
//   the route ignores the verifier's verdict        3 red        GREEN
//   the route refuses only a MALFORMED state        2 red        GREEN
//   the signature comparison always succeeds        1 red        2 red
//   the TTL check is removed                        1 red        2 red
//
// The first two are route-WIRING failures and the verifier cannot see either:
// it still classifies every token correctly, and all 11 of its arms pass, while
// the route acts on a verdict it no longer reads. The second is the sharper of
// the pair — refusing only `malformed` still rejects hand-written junk, so the
// endpoint looks defended, while a FORGED token (correctly shaped, wrong
// signature) sails through. That is the login-CSRF bypass, and it is the exact
// shape a reviewer skims past.
//
// The last two are CLASSIFICATION failures and both layers catch them, which is
// the division of labour working: the verifier owns "is this token valid", the
// route owns "do we act on that answer".

describe('the OAuth callback verifies the state token itself', () => {
  const CALLBACK = '/v1/auth/oauth-client/callback';

  /** A real /start flow: the state and its nonce-scoped PKCE cookie. */
  async function startFlowFor(
    f: TestAppFixture,
    provider: 'google' | 'github',
  ): Promise<{ state: string; cookie: string }> {
    const res = await f.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider, redirect_to: 'https://app.driftstack.test/dashboard' },
    });
    const state =
      new URL(res.json<{ authorize_url: string }>().authorize_url).searchParams.get('state') ?? '';
    const setCookie = res.headers['set-cookie'];
    const cookie = String(
      (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).find((c) =>
        String(c).startsWith('ds_oauth_pkce_'),
      ),
    ).split(';')[0];
    return { state, cookie: cookie ?? '' };
  }

  it('CRITICAL a MALFORMED state is refused. The token is `payload.signature`; anything without that shape cannot have been minted by us, and the refusal is what stops a hand-written state from reaching the exchange.', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=dummycode&state=not-a-token`,
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/state token invalid: malformed/i);
  });

  it('CRITICAL a FORGED state — correctly shaped, signed with a different secret — is refused. This is the login-CSRF case: the signature is the only thing distinguishing a flow this server started from one an attacker composed, and a forged state carries an attacker-chosen provider and redirect target into the rest of the handler.', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const forged = signOauthClientState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: 'z'.repeat(32), // NOT the server's secret
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=dummycode&state=${encodeURIComponent(forged)}`,
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/state token invalid: bad-signature/i);
  });

  it('CRITICAL an EXPIRED state is refused even though its signature is ours. The TTL is 5 minutes; without the expiry check a state captured from a browser history, a referrer header or a shared link stays replayable indefinitely, which is the difference between a bounded window and a permanent one.', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const stale = signOauthClientState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: OAUTH.signingSecret, // genuinely ours
      nowMs: Date.now() - 10 * 60 * 1000, // minted 10 minutes ago, TTL is 5
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=dummycode&state=${encodeURIComponent(stale)}`,
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/state token invalid: expired/i);
  });

  it('CRITICAL a provider de-configured BETWEEN mint and callback fails closed. /start already refuses an unconfigured provider, so a state can only be minted for one that WAS wired — this branch exists for the deploy where creds are pulled while a customer is mid-flow. Modelled by replaying a real google flow against a server that now has only github, with the same signing secret so both the state and the PKCE cookie still verify: the refusal has to come from the provider lookup, and nothing earlier.', async () => {
    // App A: both providers wired — mint a genuine google flow.
    const wired = await buildTestApp({ oauthClient: OAUTH });
    const { state, cookie } = await startFlowFor(wired, 'google');
    await wired.cleanup();

    // App B: google's creds are gone; same signing secret, so state + cookie
    // both still verify and only the provider lookup can fail.
    fx = await buildTestApp({
      oauthClient: {
        signingSecret: OAUTH.signingSecret,
        callbackUrlBase: OAUTH.callbackUrlBase,
        dashboardOrigin: OAUTH.dashboardOrigin,
        github: OAUTH.github,
      },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=dummycode&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/provider "google" is not configured/i);
  });

  // MUTATION-PROVED for the provider check — control 26/26:
  //   the unconfigured-provider check removed        1 red
  //   the check narrowed to `creds === null`         1 red
  //
  // The second matters because `providers` is a Partial record: a missing key
  // is `undefined`, not `null`, so narrowing the test to `=== null` reads as
  // equivalent and disables the guard entirely.
  //
  // ⚠️ `Userinfo fetch failed:` (routes/auth-oauth-client.ts:253) is NOT covered
  // here, and the reason is worth writing down rather than leaving as a silent
  // gap. Driving it needs the token exchange to SUCCEED and only the userinfo
  // call to fail, which means controlling `fetch` — and that is not possible
  // from a test:
  //
  //     lib/oauth-client-exchange.ts:51
  //     const DEFAULT_FETCH: typeof fetch = globalThis.fetch;
  //
  // captured once at module load. `vi.stubGlobal('fetch', …)` replaces
  // `globalThis.fetch` afterwards, so `DEFAULT_FETCH` still points at the
  // original. Verified rather than assumed: a module-scope capture compared
  // against a later stub is not the same reference.
  //
  // The same applies to `rejectTokenExchange()` in the D2 block above — its stub
  // cannot take effect either. Those arms pass because the exchange fails
  // anyway, not because the helper made it fail.
  //
  // `exchangeCodeForTokens`/`fetchUserInfo` both accept an `opts.fetch`
  // override; the route does not thread one through. Closing this means adding
  // that seam to the route deps, the same shape as the `agentDecomposerKind`
  // harness gap (assessment item 5f).

  it('CRITICAL a state we genuinely minted gets PAST this check. Every arm above asserts a 400, and a callback that refused all states would satisfy all three while breaking social login entirely — so this asserts the failure moves ON, to the cookie binding rather than the state.', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const fresh = signOauthClientState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: OAUTH.signingSecret,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${CALLBACK}?code=dummycode&state=${encodeURIComponent(fresh)}`,
    });
    // No cookie sent, so it still fails — but on the NEXT check, not this one.
    expect(
      res.json<{ detail?: string }>().detail ?? '',
      'the state itself was accepted',
    ).not.toMatch(/state token invalid/i);
  });
});
