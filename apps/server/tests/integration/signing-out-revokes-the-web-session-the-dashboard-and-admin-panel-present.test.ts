// Security sweep 2026-09-24, finding #8 — sign-out never revoked the web session.
//
// Both sign-out buttons (the customer dashboard's and the admin panel's) sent
// `POST /v1/auth/logout` with the token in `Authorization: Bearer …` and no body.
// The route read only the JSON body (`{ token }`), so every sign-out answered 400,
// the buttons swallowed it on purpose (fire-and-forget), and the 30-day session
// stayed live: a copy of the token held anywhere else — the admin origin the
// dashboard hands it to, browser history — kept working after "Sign out".
//
// Now the route revokes the session the caller actually presents, from the body
// OR the bearer header, and both layouts send the body as well. The layouts'
// requests are not re-typed here: each arm lifts the fetch options out of the
// layout's own sign-out handler and replays them against the real route.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUTS = {
  dashboard: resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro'),
  admin: resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro'),
} as const;

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

async function signedInToken(email: string): Promise<string> {
  const signup = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct horse battery staple' },
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const verify = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: {
      token: signup.json<{ debug_token: string }>().debug_token,
      password: 'correct horse battery staple',
    },
  });
  expect(verify.statusCode, verify.body).toBe(200);
  return verify.json<{ session: { token: string } }>().session.token;
}

async function meStatus(token: string): Promise<number> {
  const res = await fx.app.inject({
    method: 'GET',
    url: '/v1/account/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.statusCode;
}

/**
 * The options object a layout's sign-out handler passes to
 * `fetch(... '/v1/auth/logout', { ... })`, evaluated with the stored token bound to
 * whatever name the handler reads it into.
 */
function layoutLogoutInit(
  file: string,
  token: string,
): { method: string; headers: Record<string, string>; body?: string } {
  const source = readFileSync(file, 'utf8');
  // The dashboard writes `apiBaseUrl + '/v1/auth/logout'`, the admin panel the
  // full URL in one literal; both end the string at the path.
  const at = source.indexOf("/v1/auth/logout'");
  expect(at, `${file} still calls /v1/auth/logout`).toBeGreaterThan(-1);
  const open = source.indexOf('{', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, `${file}: the logout fetch options could not be read`).toBeGreaterThan(open);
  const literal = source.slice(open, close + 1);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function('t', 'token', `return (${literal});`) as (
    t: string,
    token: string,
  ) => { method: string; headers: Record<string, string>; body?: string };
  return build(token, token);
}

describe('signing out revokes the web session the dashboard and admin panel present', () => {
  it('CRITICAL the request the dashboard sends at Sign out revokes the session: the same token then gets 401', async () => {
    fx = await buildTestApp();
    const token = await signedInToken('dash-signout@driftstack.local');
    expect(await meStatus(token)).toBe(200);
    const init = layoutLogoutInit(LAYOUTS.dashboard, token);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: init.headers,
      ...(init.body !== undefined ? { payload: init.body } : {}),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await meStatus(token), 'the signed-out token still works').toBe(401);
  });

  it('CRITICAL the request the admin panel sends at Sign out revokes the session too', async () => {
    fx = await buildTestApp();
    const token = await signedInToken('admin-signout@driftstack.local');
    const init = layoutLogoutInit(LAYOUTS.admin, token);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: init.headers,
      ...(init.body !== undefined ? { payload: init.body } : {}),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await meStatus(token), 'the signed-out token still works').toBe(401);
  });

  it('CRITICAL the route revokes a session presented only as the bearer header, with no body — the shape both buttons sent until now', async () => {
    fx = await buildTestApp();
    const token = await signedInToken('bearer-only@driftstack.local');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await meStatus(token)).toBe(401);
  });

  it('both layouts put the token in the JSON body, where the published contract says the route reads it', () => {
    for (const file of Object.values(LAYOUTS)) {
      const init = layoutLogoutInit(file, 'tok_example_0123456789abcdef0123456789');
      expect(init.body, file).toBe(
        JSON.stringify({ token: 'tok_example_0123456789abcdef0123456789' }),
      );
      const contentType = Object.entries(init.headers).find(
        ([k]) => k.toLowerCase() === 'content-type',
      )?.[1];
      expect(contentType, file).toBe('application/json');
    }
  });

  it('control: the body-shaped request still revokes, a sign-out with neither body nor bearer is still refused 400, and an unknown bearer is a no-op 200', async () => {
    fx = await buildTestApp();
    const token = await signedInToken('body-shaped@driftstack.local');
    const byBody = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { token },
    });
    expect(byBody.statusCode).toBe(200);
    expect(await meStatus(token)).toBe(401);

    const empty = await fx.app.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect(empty.statusCode).toBe(400);

    const unknown = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${'x'.repeat(48)}` },
    });
    expect(unknown.statusCode, unknown.body).toBe(200);
  });

  it('a sign-out presenting two different sessions — one in the body, one as the bearer — revokes both', async () => {
    fx = await buildTestApp();
    const first = await signedInToken('two-sessions-a@driftstack.local');
    const second = await signedInToken('two-sessions-b@driftstack.local');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${second}` },
      payload: { token: first },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await meStatus(first)).toBe(401);
    expect(await meStatus(second)).toBe(401);
  });
});
