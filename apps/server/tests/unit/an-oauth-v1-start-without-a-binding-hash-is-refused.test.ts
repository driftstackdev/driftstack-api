// OAuth v1 (cookie) path retired 2026-09-14. The 24-hour old-bundle window
// that kept it alive after cookie-free v2 went live (2026-09-11) closed with
// ZERO legacy-cookie callbacks measured on prod (48 h to 2026-09-14: the
// "PKCE verifier cookie" failure line 0, v2 /redeem 3, v2 /start 3). What an
// old bundle sends can no longer be finished by anything, so it is refused
// honestly rather than half-served:
//   • POST /start without binding_hash → 400 whose detail tells the customer
//     to reload the sign-in page (plus a stable `reason` for whoever reads
//     the raw problem body — no live page renders either field, since the
//     only client that sends this body is an old cached bundle whose error
//     rendering is frozen), no Set-Cookie, no store write, no authorize_url;
//   • the top-level callback with a verified but bind-less state → the same
//     error redirect a forged state gets (#oauth_error=state_invalid on the
//     CONFIGURED origin), never a verbatim forward, never an exchange;
//   • GET /v1/auth/oauth-client/callback (the legacy XHR exchange) → 404;
//   • no OAuth route answers with Set-Cookie, on any path.
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts `binding_hash: z.string().regex(…)` in
//     StartBodySchema and the `bindingHashIsAbsent(req.body)` →
//     `BadRequestError(STALE_SIGN_IN_PAGE_DETAIL, { reason })` arm — making
//     the field optional again, or answering the bare ValidationError, reds
//     the /start arms.
//   • the top-level route `const bind = payload.bind; if (bind === undefined
//     || !BASE64URL_256_BIT_RE.test(bind)) return refuse();` — forwarding a
//     bind-less state (or letting it choose its own origin) reds the
//     callback arm.
//   • the legacy `app.get('/v1/auth/oauth-client/callback', …)` staying
//     deleted — re-registering it reds the 404 arm.

import Fastify, { type LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  IDP_CODE,
  fragmentOf,
  locationOf,
  mountOauthHarness,
  payloadOf,
  redeem,
  signState,
  startV2,
  topLevel,
} from './an-oauth-v2-harness.js';

const STALE_DETAIL = 'This sign-in page is out of date. Reload the sign-in page and try again.';
const STALE_REASON = 'stale_sign_in_page';

describe('an OAuth v1 /start without a binding hash is refused (the cookie path is gone)', () => {
  it('/start without binding_hash → 400 with the customer-facing detail and a stable reason; no Set-Cookie, no authorize_url, no store write', async () => {
    const h = await mountOauthHarness();
    for (const provider of ['google', 'github'] as const) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/oauth-client/start',
        payload: { provider, redirect_to: 'https://app.driftstack.dev/' },
      });
      expect(res.statusCode, provider).toBe(400);
      const body = res.json<{
        detail?: string;
        reason?: string;
        authorize_url?: string;
        flow_id?: string;
      }>();
      expect(body.detail, provider).toBe(STALE_DETAIL);
      expect(body.detail).toContain('Reload the sign-in page and try again');
      expect(body.reason).toBe(STALE_REASON);
      expect(body.authorize_url).toBeUndefined();
      expect(body.flow_id).toBeUndefined();
      expect(res.headers['set-cookie'], 'the cookie path is gone').toBeUndefined();
    }
    expect(h.storeSets, 'a refused start never writes the flow store').toHaveLength(0);
  });

  it('the reload message is for the ABSENT field only: a present but malformed binding_hash, a null body, a string body and an ARRAY body are the generic validation 400', async () => {
    const h = await mountOauthHarness();
    for (const [label, payload] of [
      [
        'malformed digest',
        JSON.stringify({
          provider: 'google',
          redirect_to: 'https://app.driftstack.dev/',
          binding_hash: 'nope',
        }),
      ],
      ['null body', 'null'],
      ['string body', '"provider=google"'],
      // An array is `typeof 'object'` with no binding_hash — a caller bug,
      // not a stale sign-in page.
      ['array body', '[]'],
    ] as const) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/oauth-client/start',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode, label).toBe(400);
      const body = res.json<{ detail?: string; reason?: string }>();
      expect(body.detail, label).not.toContain('Reload the sign-in page');
      expect(body.reason, label).toBeUndefined();
      expect(res.headers['set-cookie'], label).toBeUndefined();
    }
    expect(h.storeSets).toHaveLength(0);
  });

  it('a Cookie header on /start changes nothing: a stale bundle still holding an old PKCE cookie gets the same 400', async () => {
    const h = await mountOauthHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      headers: { cookie: 'ds_oauth_pkce_abc=verifier.nonce.sig' },
      payload: { provider: 'google', redirect_to: 'https://app.driftstack.dev/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe(STALE_DETAIL);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('the top-level callback with a verified but bind-less state → #oauth_error=state_invalid on the CONFIGURED origin, never a verbatim forward, no exchange, store untouched', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    // Exactly what the retired /start minted: signed by us, on-list
    // redirectTo (on the OTHER first-party host, so the origin choice is
    // observable), no `bind`.
    const legacy = signState({
      provider: 'github',
      redirectTo: 'https://app.driftstack.io/dashboard',
    });
    expect(payloadOf(legacy).bind).toBeUndefined();
    const res = await topLevel(h, 'github', { code: IDP_CODE, state: legacy, scope: 'read:user' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    const loc = locationOf(res);
    // The CONFIGURED origin, not the state's own: a state that cannot be
    // finished does not get to choose where it lands.
    expect(loc.origin).toBe('https://app.driftstack.dev');
    expect(loc.pathname).toBe('/auth/oauth-client/callback/');
    expect(loc.search, 'nothing from the query is forwarded').toBe('');
    expect(fragmentOf(res).get('oauth_error')).toBe('state_invalid');
    expect([...fragmentOf(res).keys()]).toEqual(['oauth_error']);
    const raw = String(res.headers.location);
    expect(raw).not.toContain(IDP_CODE);
    expect(raw).not.toContain('read:user');
    expect(raw).not.toContain(legacy);
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes).toHaveLength(0);
    expect(h.storeSets).toHaveLength(0);
    expect(h.linkCalls).toHaveLength(0);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('GET /v1/auth/oauth-client/callback is gone: 404 for every legacy shape (with a cookie, with a v2 code+state, with ?error, bare), and nothing downstream runs', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const legacy = signState({});
    const consumesBefore = h.storeConsumes.length;
    for (const [url, headers] of [
      [
        `/v1/auth/oauth-client/callback?code=${IDP_CODE}&state=${encodeURIComponent(legacy)}`,
        { cookie: 'ds_oauth_pkce_abc=verifier.nonce.sig' },
      ],
      [
        `/v1/auth/oauth-client/callback?code=${IDP_CODE}&state=${encodeURIComponent(start.state)}`,
        {},
      ],
      ['/v1/auth/oauth-client/callback?error=access_denied', {}],
      ['/v1/auth/oauth-client/callback', {}],
    ] as const) {
      const res = await h.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['set-cookie'], url).toBeUndefined();
    }
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes).toHaveLength(consumesBefore);
    // Positive control for the 404s: the same v2 state on the LIVE route
    // does complete, so the 404s are the route being absent, not a broken
    // harness.
    const live = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(live.statusCode).toBe(302);
    expect(fragmentOf(live).get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('no OAuth route answers with Set-Cookie on any path: /start 200 + both 400s, the top-level hand-off and refusal 302s, /redeem 200 + 400, /confirm-merge 400', async () => {
    const h = await mountOauthHarness();
    const answers: [string, LightMyRequestResponse][] = [];
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    answers.push(['start 200', start.res]);
    answers.push([
      'start 400 (no binding_hash)',
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/oauth-client/start',
        payload: { provider: 'google', redirect_to: 'https://app.driftstack.dev/' },
      }),
    ]);
    answers.push([
      'start 400 (malformed binding_hash)',
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/oauth-client/start',
        payload: {
          provider: 'google',
          redirect_to: 'https://app.driftstack.dev/',
          binding_hash: 'nope',
        },
      }),
    ]);
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    answers.push(['top-level 302 hand-off', top]);
    answers.push([
      'top-level 302 refusal',
      await topLevel(h, 'google', { code: 'x', state: 'junk' }),
    ]);
    answers.push(['redeem 200', await redeem(h, fragmentOf(top).get('code') ?? '', start.secret)]);
    answers.push(['redeem 400', await redeem(h, 'A'.repeat(43), start.secret)]);
    answers.push([
      'confirm-merge 400',
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/oauth-client/confirm-merge',
        payload: { token: 'short' },
      }),
    ]);
    // The population is real and mixed — a vacuous loop cannot pass this.
    expect(answers.map(([, r]) => r.statusCode)).toEqual([200, 400, 400, 302, 302, 200, 400, 400]);
    for (const [label, res] of answers) {
      expect(res.headers['set-cookie'], label).toBeUndefined();
      expect(
        Object.keys(res.headers).map((k) => k.toLowerCase()),
        label,
      ).not.toContain('set-cookie');
    }
  });

  it('instrument control: a route that DOES set a cookie is seen by inject under `set-cookie`, so the absences above are measured, not assumed', async () => {
    const app = Fastify();
    app.get('/sets', async (_req, reply) => {
      reply.header('set-cookie', 'probe=1; Path=/; HttpOnly');
      return reply.code(200).send({});
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/sets' });
    expect(res.headers['set-cookie']).toBeDefined();
    expect(String(res.headers['set-cookie'])).toContain('probe=1');
    await app.close();
  });
});
