// V-667.C — integration tests for the OAuth-client routes, on the real app
// wiring (buildTestApp: the routes + the problem+json error handler + the
// in-memory flow store + the injected IDP fetch seam + a real
// OAuthClientService over in-memory repos).
//
//   POST /v1/auth/oauth-client/start           — authorize URL; binding_hash
//                                                REQUIRED
//   GET  /v1/auth/oauth/:provider/callback     — the IDP's top-level return:
//                                                state verification, the
//                                                single-use verifier, token
//                                                exchange + userinfo (injected)
//                                                and the fragment hand-off
//   POST /v1/auth/oauth-client/redeem          — flow-secret proof → session
//   POST /v1/auth/oauth-client/confirm-merge   — Verdict-1 completion
//
// The v1 cookie path — GET /v1/auth/oauth-client/callback and the PKCE
// cookie /start used to set — was retired 2026-09-14, after its 24-hour
// old-bundle window closed with zero legacy-cookie callbacks on prod. Its
// arms here became the stale-page 400, the 404 and the no-Set-Cookie arms;
// the state-verification arms moved to the top-level route, where the check
// now runs.
//
// The fixture registers the routes only when `opts.oauthClient` is
// passed; this test exercises the registered-route surface. Tests that
// pass nothing should continue to see 404 (route absent), matching
// prod-pre-env-wire posture.
import { createHash, randomBytes } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
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

const STALE_DETAIL = 'This sign-in page is out of date. Reload the sign-in page and try again.';

// ─── IDP seams ────────────────────────────────────────────────────────────
//
// INJECTED rather than stubbed. `vi.stubGlobal('fetch', …)` never took
// effect here: `lib/oauth-client-exchange.ts` captures `globalThis.fetch` at
// module load, so a later stub is a different reference, and the arms that
// "refused the exchange" were passing because a REAL request to the provider
// failed (a POST to GitHub's token endpoint answers 404 in ~250ms). Passed
// through `buildTestApp({ oauthClient: { …, fetch } })`, these arms control
// the IDP interaction they claim to, and the suite never talks to github.com.

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** Refuses the token exchange. */
const REJECTING_FETCH: typeof fetch = () => jsonResponse(400, { error: 'invalid_grant' });

/** Answers the token exchange and userinfo for both providers; records every URL. */
function okFetch(seen: string[]): typeof fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (/\/token$|\/access_token$/.test(url)) {
      return jsonResponse(200, {
        access_token: 'at_live',
        token_type: 'bearer',
        scope: 'read:user',
      });
    }
    if (url.includes('api.github.com/user')) {
      return jsonResponse(200, {
        id: 4242,
        login: 'octo',
        name: 'Octo Cat',
        avatar_url: 'https://avatars.test/octo',
        email: 'octo@example.test',
      });
    }
    return jsonResponse(200, {
      sub: 'google-sub-1',
      email: 'person@example.test',
      email_verified: true,
      name: 'Person Example',
      picture: 'https://avatars.test/person',
    });
  };
}

/** Answers the token exchange, fails ONLY userinfo; records every URL. */
function userinfoFailsFetch(seen: string[]): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const isUserinfo = url.includes('api.github.com/user') || url.includes('openidconnect');
    return isUserinfo
      ? jsonResponse(401, { message: 'Bad credentials' })
      : jsonResponse(200, { access_token: 'at_live', scope: 'read:user' });
  };
}

const callbackFor = (p: 'google' | 'github') => `${OAUTH.callbackUrlBase}/${p}/callback`;

// ─── flow helpers ─────────────────────────────────────────────────────────

/** What login.astro does before /start: a random secret, and its digest. */
function mintBinding(): { secret: string; bindingHash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, bindingHash: createHash('sha256').update(secret).digest('base64url') };
}

interface Flow {
  res: LightMyRequestResponse;
  state: string;
  flowId: string;
  secret: string;
  bindingHash: string;
}

/** A real /start, as the dashboard performs it. */
async function startFlow(
  f: TestAppFixture,
  provider: 'google' | 'github',
  redirectTo = 'https://app.driftstack.test/dashboard',
): Promise<Flow> {
  const binding = mintBinding();
  const res = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/oauth-client/start',
    headers,
    payload: { provider, redirect_to: redirectTo, binding_hash: binding.bindingHash },
  });
  const body = res.json<{ authorize_url?: string; flow_id?: string }>();
  const state = body.authorize_url
    ? (new URL(body.authorize_url).searchParams.get('state') ?? '')
    : '';
  return { res, state, flowId: body.flow_id ?? '', ...binding };
}

function topLevel(
  f: TestAppFixture,
  provider: 'google' | 'github',
  query: Record<string, string>,
): Promise<LightMyRequestResponse> {
  const qs = new URLSearchParams(query).toString();
  return f.app.inject({
    method: 'GET',
    url: `/v1/auth/oauth/${provider}/callback${qs.length > 0 ? `?${qs}` : ''}`,
  });
}

function redeem(f: TestAppFixture, code: string, flowSecret: string) {
  return f.app.inject({
    method: 'POST',
    url: '/v1/auth/oauth-client/redeem',
    headers,
    payload: { code, flow_secret: flowSecret },
  });
}

function locationOf(res: LightMyRequestResponse): URL {
  const loc = res.headers.location;
  if (typeof loc !== 'string') throw new Error(`no Location (status ${String(res.statusCode)})`);
  return new URL(loc);
}

function fragmentOf(res: LightMyRequestResponse): URLSearchParams {
  const hash = locationOf(res).hash;
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** The one refusal an unverifiable, bind-less or off-list state gets; only
 *  the bounded code varies (state_replayed for a state that is ours but
 *  expired, state_invalid for everything else). */
function expectRefusalOnConfiguredOrigin(
  res: LightMyRequestResponse,
  code: 'state_invalid' | 'state_replayed' = 'state_invalid',
): void {
  expect(res.statusCode).toBe(302);
  expect(res.headers['cache-control']).toBe('no-store');
  const loc = locationOf(res);
  expect(loc.origin).toBe(OAUTH.dashboardOrigin);
  expect(loc.pathname).toBe('/auth/oauth-client/callback/');
  expect(loc.search, 'nothing from the query is forwarded').toBe('');
  expect(fragmentOf(res).get('oauth_error')).toBe(code);
  expect(res.headers['set-cookie']).toBeUndefined();
}

describe('POST /v1/auth/oauth-client/start (V-667.C)', () => {
  it('returns 200 + authorize_url with all PKCE + state params + flow_id, and NO Set-Cookie, when google is configured', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const flow = await startFlow(fx, 'google', 'https://app.driftstack.test/');
    expect(flow.res.statusCode).toBe(200);
    expect(flow.res.headers['cache-control']).toBe('no-store');
    expect(flow.res.headers['set-cookie'], 'the cookie path is gone').toBeUndefined();
    const url = new URL(flow.res.json<{ authorize_url: string }>().authorize_url);
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
    expect(flow.flowId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("CRITICAL a /start without binding_hash — what a sign-in page from before the cookie-free flow sends — is a 400 naming the fix in the customer's words, with a stable reason, no cookie and no authorize_url", async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: { provider: 'github', redirect_to: 'https://app.driftstack.test/dashboard' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string; reason?: string; authorize_url?: string }>();
    expect(body.detail).toBe(STALE_DETAIL);
    expect(body.reason).toBe('stale_sign_in_page');
    expect(body.authorize_url).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a PRESENT but malformed binding_hash is the generic validation 400, not the stale-page message', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: {
        provider: 'github',
        redirect_to: 'https://app.driftstack.test/',
        binding_hash: 'x',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).not.toContain('Reload the sign-in page');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('an ARRAY body is the generic validation 400 too: `typeof [] === "object"` and it has no binding_hash, but it is a caller bug, not a stale page', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: '[]',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string; reason?: string }>();
    expect(body.detail).not.toContain('Reload the sign-in page');
    expect(body.reason).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 400 when the request body fails schema validation (bad provider)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers,
      payload: {
        provider: 'facebook',
        redirect_to: 'https://app.driftstack.test/',
        binding_hash: mintBinding().bindingHash,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when redirect_to is off the dashboard origin (open-redirect guard)', async () => {
    // A forged /start with an off-origin redirect_to must be rejected at the
    // source — otherwise /redeem echoes it back and the SPA bounces a
    // just-signed-in user off-site. dashboardOrigin is https://app.driftstack.test.
    fx = await buildTestApp({ oauthClient: OAUTH });
    const flow = await startFlow(fx, 'google', 'https://evil.example/phish');
    expect(flow.res.statusCode).toBe(400);
    // No authorize_url is minted for an off-origin target.
    expect(flow.res.json<{ authorize_url?: string }>().authorize_url).toBeUndefined();
  });

  it('accepts a same-origin redirect_to with a deep path (legit deep-link round-trip)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const flow = await startFlow(
      fx,
      'google',
      'https://app.driftstack.test/cli/authorize?session=abc',
    );
    expect(flow.res.statusCode).toBe(200);
    expect(flow.state.length).toBeGreaterThan(20);
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
    const flow = await startFlow(fx, 'google', 'https://app.driftstack.test/');
    expect(flow.res.statusCode).toBe(400);
    expect(String(flow.res.json<{ detail?: string }>().detail ?? '')).toMatch(/not configured/);
  });

  it('returns 404 when oauthClient was never wired (matches prod-pre-env-wire posture)', async () => {
    fx = await buildTestApp(); // no oauthClient
    const flow = await startFlow(fx, 'google', 'https://app.driftstack.test/');
    expect(flow.res.statusCode).toBe(404);
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
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe("GET /v1/auth/oauth/:provider/callback — the IDP's top-level return, unverifiable states", () => {
  // Path A (2026-05-16): the IDP redirects the browser to the API per-provider
  // path. Nothing in an unverifiable state can be trusted, so every such
  // return is the same bounded refusal on the CONFIGURED origin — never the
  // verbatim query forward the retired XHR route used to consume.

  it('google: garbage code+state → #oauth_error=state_invalid on the configured origin; neither value is echoed', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await topLevel(fx, 'google', { code: 'abc123', state: 'xyz789' });
    expectRefusalOnConfiguredOrigin(res);
    const raw = String(res.headers.location);
    expect(raw).not.toContain('abc123');
    expect(raw).not.toContain('xyz789');
  });

  it('github: extra IDP keys (scope) are not forwarded either', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await topLevel(fx, 'github', { code: 'g0d', state: 's7t', scope: 'read:user' });
    expectRefusalOnConfiguredOrigin(res);
    expect(String(res.headers.location)).not.toContain('read');
  });

  it('?error=access_denied with no state: state_invalid, and the raw IDP strings never reach the Location', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await topLevel(fx, 'google', {
      error: 'access_denied',
      error_description: 'User denied',
    });
    expectRefusalOnConfiguredOrigin(res);
    expect(String(res.headers.location)).not.toContain('denied');
  });

  it('returns 404 for an unsupported provider segment (only google + github registered)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/facebook/callback?code=x&state=y',
    });
    expect(res.statusCode).toBe(404);
  });

  it('HEAD is not a route here: 404 with no Location, the live state is NOT consumed by it, and the GET that follows completes — the automatic HEAD twin used to run the whole handler', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    const flow = await startFlow(fx, 'google');
    const head = await fx.app.inject({
      method: 'HEAD',
      url: `/v1/auth/oauth/google/callback?code=dummycode&state=${encodeURIComponent(flow.state)}`,
    });
    expect(head.statusCode).toBe(404);
    expect(head.headers.location).toBeUndefined();
    expect(head.headers['set-cookie']).toBeUndefined();
    expect(seen, 'HEAD must not reach the IDP').toEqual([]);
    const get = await topLevel(fx, 'google', { code: 'dummycode', state: flow.state });
    expect(get.statusCode).toBe(302);
    expect(fragmentOf(get).get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(seen.length, 'the GET is the first and only use').toBe(2);
  });
});

describe('GET /v1/auth/oauth-client/callback — the retired v1 XHR exchange', () => {
  it('CRITICAL answers 404 for every legacy shape (cookie + code + state, a live v2 state, ?error, bare) while the live routes on the same app answer — the route is absent, not broken', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const flow = await startFlow(fx, 'google');
    expect(flow.res.statusCode, 'positive control: the route family is registered').toBe(200);
    const legacyState = signOauthClientState({
      provider: 'google',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: OAUTH.signingSecret,
    });
    for (const [url, extra] of [
      [
        `/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(legacyState)}`,
        { cookie: 'ds_oauth_pkce_abc=verifier.nonce.sig' },
      ],
      [`/v1/auth/oauth-client/callback?code=dummycode&state=${encodeURIComponent(flow.state)}`, {}],
      ['/v1/auth/oauth-client/callback?error=access_denied', {}],
      ['/v1/auth/oauth-client/callback', {}],
    ] as const) {
      const res = await fx.app.inject({ method: 'GET', url, headers: extra });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['set-cookie'], url).toBeUndefined();
    }
  });
});

// ─── the state token's OWN verification, at the top-level route ────────────
//
// This is the CSRF defence for social login. The state token is what ties the
// callback the browser presents back to a flow this server started; without the
// check, a callback carrying an attacker-chosen `state` — and therefore an
// attacker-chosen `provider` and `redirectTo` — is processed as if we had issued
// it. The verifier is a tagged union precisely so the route can distinguish the
// failure modes, and all three non-ok kinds are driven here, plus the fourth
// shape only this route knows: a genuine signature with no `bind`.
//
// The state check runs BEFORE the verifier lookup, so a refusal here shows as
// state_invalid (state_replayed for one that is ours but expired) with NO IDP
// call and NO store consume; a state that passes moves on to the exchange,
// which is the positive control at the end.

describe('the top-level callback verifies the state token itself', () => {
  it('CRITICAL a MALFORMED state is refused. The token is `payload.signature`; anything without that shape cannot have been minted by us, and the refusal is what stops a hand-written state from reaching the exchange.', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    const res = await topLevel(fx, 'google', { code: 'dummycode', state: 'not-a-token' });
    expectRefusalOnConfiguredOrigin(res);
    expect(seen, 'no IDP call').toEqual([]);
  });

  it('CRITICAL a FORGED state — correctly shaped, signed with a different secret — is refused. This is the login-CSRF case: the signature is the only thing distinguishing a flow this server started from one an attacker composed, and a forged state carries an attacker-chosen provider and redirect target into the rest of the handler.', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    const forged = signOauthClientState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: 'z'.repeat(32), // NOT the server's secret
      bind: mintBinding().bindingHash,
    });
    const res = await topLevel(fx, 'github', { code: 'dummycode', state: forged });
    expectRefusalOnConfiguredOrigin(res);
    expect(seen).toEqual([]);
  });

  it('CRITICAL an EXPIRED state is refused even though its signature is ours. The TTL is 5 minutes; without the expiry check a state captured from a browser history, a referrer header or a shared link stays replayable indefinitely, which is the difference between a bounded window and a permanent one.', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    const stale = signOauthClientState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: OAUTH.signingSecret, // genuinely ours
      bind: mintBinding().bindingHash,
      nowMs: Date.now() - 10 * 60 * 1000, // minted 10 minutes ago, TTL is 5
    });
    const res = await topLevel(fx, 'github', { code: 'dummycode', state: stale });
    // Ours, just too old: the code is state_replayed, whose dashboard copy
    // says "has expired" — not state_invalid's "not valid for this dashboard".
    expectRefusalOnConfiguredOrigin(res, 'state_replayed');
    expect(seen).toEqual([]);
  });

  it('CRITICAL a BIND-LESS state — genuinely ours, exactly the shape the retired /start minted — is refused the same way, never forwarded: no browser holds a flow secret for it, so nothing can finish it.', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    const legacy = signOauthClientState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.test/dashboard',
      signingSecret: OAUTH.signingSecret,
    });
    const res = await topLevel(fx, 'github', {
      code: 'dummycode',
      state: legacy,
      scope: 'read:user',
    });
    expectRefusalOnConfiguredOrigin(res);
    expect(String(res.headers.location)).not.toContain('dummycode');
    expect(seen).toEqual([]);
  });

  it('a state whose `bind` is PRESENT but not a 256-bit base64url digest — which /start never signs — is refused like a bind-less one: state_invalid, no IDP call', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    for (const bind of ['', 'abc', 'A'.repeat(42)]) {
      const state = signOauthClientState({
        provider: 'github',
        redirectTo: 'https://app.driftstack.test/dashboard',
        signingSecret: OAUTH.signingSecret,
        bind,
      });
      const res = await topLevel(fx, 'github', { code: 'dummycode', state });
      expectRefusalOnConfiguredOrigin(res);
    }
    expect(seen).toEqual([]);
  });

  it('CRITICAL a state we genuinely minted gets PAST this check. Every arm above asserts state_invalid, and a callback that refused all states would satisfy them all while breaking social login entirely — so this asserts the failure moves ON, to the exchange (refused by the injected IDP → exchange_failed on the STATE origin), never state_invalid.', async () => {
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: REJECTING_FETCH } });
    const flow = await startFlow(fx, 'github');
    const res = await topLevel(fx, 'github', { code: 'dummycode', state: flow.state });
    expect(res.statusCode).toBe(302);
    expect(fragmentOf(res).get('oauth_error')).toBe('exchange_failed');
    expect(fragmentOf(res).get('oauth_error')).not.toBe('state_invalid');
  });

  it('CRITICAL a userinfo fetch that fails AFTER a successful token exchange is refused, rather than the flow continuing with an unverified identity. By this point we hold a real access token, so the tempting failure mode is to carry on with whatever is at hand — and what follows is link-or-create, which would attach or mint an account from an identity the IDP never confirmed.', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: userinfoFailsFetch(seen) } });
    const flow = await startFlow(fx, 'github');
    const res = await topLevel(fx, 'github', { code: 'dummycode', state: flow.state });
    expect(res.statusCode, 'refused').toBe(302);
    expect(fragmentOf(res).get('oauth_error')).toBe('userinfo_failed');
    // The refusal alone does not prove the INJECTED client was used: with the
    // seam removed the helper falls back to the global fetch, really calls
    // api.github.com, really gets a 401, and produces this same refusal.
    // Asserting the injected client actually saw the userinfo URL is what pins
    // both the seam and the promise that this suite makes no outbound request.
    expect(
      seen.some((u) => u.includes('api.github.com/user')),
      'the userinfo call went through the injected client, not the network',
    ).toBe(true);
    // Nothing was linked or minted: a fresh /redeem attempt has no code to use.
    const res2 = await redeem(fx, 'A'.repeat(43), flow.secret);
    expect(res2.statusCode).toBe(400);
  });

  it('CRITICAL the token exchange failing is reported as its OWN refusal, distinct from the userinfo one, and burns the verifier: the same callback replayed is state_replayed, with no second IDP call.', async () => {
    const seen: string[] = [];
    const rejecting: typeof fetch = (input) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return REJECTING_FETCH(input);
    };
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: rejecting } });
    const flow = await startFlow(fx, 'github');
    const res = await topLevel(fx, 'github', { code: 'dummycode', state: flow.state });
    expect(fragmentOf(res).get('oauth_error')).toBe('exchange_failed');
    expect(seen).toHaveLength(1);
    const replay = await topLevel(fx, 'github', { code: 'dummycode', state: flow.state });
    expect(fragmentOf(replay).get('oauth_error')).toBe('state_replayed');
    expect(seen, 'a replay must not reach the IDP').toHaveLength(1);
  });
});

describe('cookie-free sign-in end to end', () => {
  it('CRITICAL start → top-level (injected IDP) → fragment hand-off → /redeem mints the session for the browser that proved the flow secret; no Set-Cookie on any hop', async () => {
    const seen: string[] = [];
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch(seen) } });
    const flow = await startFlow(fx, 'google', 'https://app.driftstack.test/usage?tab=1');
    expect(flow.res.statusCode).toBe(200);

    const top = await topLevel(fx, 'google', { code: 'idp-code-1', state: flow.state });
    expect(top.statusCode).toBe(302);
    expect(top.headers['set-cookie']).toBeUndefined();
    expect(seen).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://openidconnect.googleapis.com/v1/userinfo',
    ]);
    const loc = locationOf(top);
    expect(loc.origin).toBe(OAUTH.dashboardOrigin);
    expect(loc.pathname).toBe('/auth/oauth-client/callback/');
    expect(loc.search).toBe('');
    const frag = fragmentOf(top);
    expect(frag.get('flow')).toBe(flow.flowId);
    const code = frag.get('code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const word of ['session_token', 'account_id', 'usage']) {
      expect(String(top.headers.location)).not.toContain(word);
    }

    const res = await redeem(fx, code, flow.secret);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{
      outcome: string;
      provider: string;
      account_id?: string;
      redirect_to?: string;
      session_token?: string;
    }>();
    expect(body.outcome).toBe('created-new-account');
    expect(body.provider).toBe('google');
    expect(typeof body.account_id).toBe('string');
    expect(body.redirect_to).toBe('https://app.driftstack.test/usage?tab=1');
    expect(typeof body.session_token, 'a 30-day web session was minted at /redeem').toBe('string');
  });

  it('CRITICAL D2 — a wrong flow secret is refused BEFORE any account exists, and it burns the code so the right secret is refused afterwards too', async () => {
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch([]) } });
    const flow = await startFlow(fx, 'github');
    const top = await topLevel(fx, 'github', { code: 'idp-code-1', state: flow.state });
    const code = fragmentOf(top).get('code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const wrong = await redeem(fx, code, mintBinding().secret);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ detail?: string }>().detail).toBe(
      'Sign-in was not started by this browser.',
    );

    const right = await redeem(fx, code, flow.secret);
    expect(right.statusCode).toBe(400);
    expect(right.json<{ detail?: string }>().detail).toMatch(/invalid, expired, or already used/);

    // No account was created for the identity: a fresh, correctly-redeemed
    // flow for the same IDP identity is a CREATE, not a sign-in.
    const again = await startFlow(fx, 'github');
    const top2 = await topLevel(fx, 'github', { code: 'idp-code-2', state: again.state });
    const ok = await redeem(fx, fragmentOf(top2).get('code') ?? '', again.secret);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ outcome: string }>().outcome).toBe('created-new-account');
  });

  it('/redeem is single-use: the identical second request is refused and the first session stands', async () => {
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: okFetch([]) } });
    const flow = await startFlow(fx, 'google');
    const top = await topLevel(fx, 'google', { code: 'idp-code-1', state: flow.state });
    const code = fragmentOf(top).get('code') ?? '';
    const first = await redeem(fx, code, flow.secret);
    expect(first.statusCode).toBe(200);
    const second = await redeem(fx, code, flow.secret);
    expect(second.statusCode).toBe(400);
    expect(second.json<{ detail?: string }>().detail).toMatch(/invalid, expired, or already used/);
  });
});
