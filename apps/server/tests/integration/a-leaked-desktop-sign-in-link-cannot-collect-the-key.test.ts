// GUI audit #9 — the desktop browser sign-in is bound to a secret that never
// leaves the app (RFC 7636 PKCE, S256).
//
// Before this, the sign-in link (`browser_url`) and the `driftstack://` hand-off
// carried `code` and `state`, and `/exchange` needed nothing else. Anyone who read
// either URL during the two minutes after approval — another program registered
// for `driftstack://`, a synced browser history, an extension reading the tab —
// could call `/exchange` first and walk away with the account key.
//
// Now the app sends `code_challenge = BASE64URL(SHA-256(code_verifier))` at
// initiate and the verifier at exchange. The server stores the challenge and
// refuses an exchange without the matching verifier for every flow that started
// with one. Flows started without a challenge — already-installed apps — keep
// working exactly as before until the stated removal date, and every flow is
// counted by which kind it was.
//
// Everything here runs through the real routes: the dashboard's approval is a
// real web-session bind, and the "leak" is exactly what the two URLs carry.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

const headers = { 'content-type': 'application/json' };
const STATE = 'pkce-state-1234567890abcdef';
const FLOW_METRIC = 'driftstack_cli_authorize_flow_total';

interface InitiateResponse {
  code: string;
  user_code: string;
  browser_url: string;
  expires_at: string;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function signedInDashboard(app: TestAppFixture): Promise<string> {
  const email = `pkce-${Date.now().toString()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'correct horse battery staple';
  const signup = await app.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers,
    payload: { email, password },
  });
  const { debug_token } = signup.json<{ debug_token: string }>();
  const verify = await app.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    headers,
    payload: { token: debug_token, password },
  });
  const token = verify.json<{ session: { token: string } }>().session.token;
  const docs = await app.app.inject({
    method: 'GET',
    url: '/v1/legal/documents',
    headers: { authorization: `Bearer ${token}` },
  });
  for (const doc of docs.json<{
    data: Array<{ document_key: string; version: string; content_hash: string }>;
  }>().data) {
    await app.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: {
        document_key: doc.document_key,
        version: doc.version,
        content_hash: doc.content_hash,
      },
    });
  }
  return token;
}

/** What the dashboard's /cli/authorize page does after the user approves. */
async function dashboardApproves(
  app: TestAppFixture,
  sessionToken: string,
  browserUrl: string,
  userCode: string,
): Promise<string> {
  const page = new URL(browserUrl);
  const bind = await app.app.inject({
    method: 'POST',
    url: '/v1/auth/cli-authorize/bind-device-code',
    headers: { ...headers, authorization: `Bearer ${sessionToken}` },
    payload: {
      code: page.searchParams.get('code'),
      state: page.searchParams.get('state'),
      user_code: userCode,
    },
  });
  expect(bind.statusCode).toBe(200);
  // The hand-off the page then fires, built exactly as the page builds it.
  return (
    'driftstack://auth/callback?code=' +
    encodeURIComponent(page.searchParams.get('code') ?? '') +
    '&state=' +
    encodeURIComponent(page.searchParams.get('state') ?? '')
  );
}

async function exchange(app: TestAppFixture, payload: Record<string, unknown>) {
  return app.app.inject({
    method: 'POST',
    url: '/v1/auth/cli-authorize/exchange',
    headers,
    payload,
  });
}

/** Reads the scrape text, so it checks what an operator actually sees. */
function flowCount(app: TestAppFixture, step: string, flow: string, outcome: string): number {
  const wanted = [`step="${step}"`, `flow="${flow}"`, `outcome="${outcome}"`];
  const line = app.metricsRegistry
    .render()
    .split('\n')
    .find((l) => {
      const labels = /^(\w+)\{([^}]*)\} /.exec(l);
      if (labels?.[1] !== FLOW_METRIC) return false;
      const pairs = (labels[2] ?? '').split(',');
      return pairs.length === wanted.length && wanted.every((w) => pairs.includes(w));
    });
  return line === undefined ? 0 : Number(line.split(' ').pop());
}

describe('GUI audit #9 — a leaked sign-in link or hand-off cannot collect the key', () => {
  it('CRITICAL the browser_url and the driftstack:// hand-off alone are refused at exchange; only the app holding the verifier collects the key', async () => {
    fx = await buildTestApp();
    const sessionToken = await signedInDashboard(fx);
    const { verifier, challenge } = pkcePair();

    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: {
        state: STATE,
        client_label: 'Driftstack desktop on test machine',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
    });
    expect(initiate.statusCode).toBe(200);
    const started = initiate.json<InitiateResponse>();
    // Neither half of the pair reaches the browser.
    expect(started.browser_url).not.toContain(verifier);
    expect(started.browser_url).not.toContain(challenge);

    const deepLink = await dashboardApproves(
      fx,
      sessionToken,
      started.browser_url,
      started.user_code,
    );

    // Everything a third party can read from the two URLs.
    const fromLink = new URL(started.browser_url).searchParams;
    const fromHandOff = new URL(deepLink).searchParams;
    for (const leaked of [fromLink, fromHandOff]) {
      const stolen = await exchange(fx, {
        code: leaked.get('code'),
        state: leaked.get('state'),
      });
      expect(stolen.statusCode).toBe(400);
      expect(stolen.body).not.toMatch(/ds_(test|live)_/);
    }
    expect(flowCount(fx, 'exchange', 'pkce', 'refused')).toBe(2);

    // The refusals consumed nothing: the app that holds the verifier still
    // collects the key the user approved, and it works.
    const collected = await exchange(fx, {
      code: started.code,
      state: STATE,
      code_verifier: verifier,
    });
    expect(collected.statusCode).toBe(200);
    const body = collected.json<{ status: string; api_key: string }>();
    expect(body.status).toBe('bound');
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${body.api_key}` },
    });
    expect(me.statusCode).toBe(200);
    expect(flowCount(fx, 'initiate', 'pkce', 'ok')).toBe(1);
    expect(flowCount(fx, 'exchange', 'pkce', 'ok')).toBe(1);
  });

  it('a wrong verifier is refused before and after approval, and the right one still collects the key', async () => {
    fx = await buildTestApp();
    const sessionToken = await signedInDashboard(fx);
    const { verifier, challenge } = pkcePair();
    const other = pkcePair().verifier;

    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE, code_challenge: challenge, code_challenge_method: 'S256' },
    });
    const started = initiate.json<InitiateResponse>();

    // Pending: a wrong verifier learns nothing, not even "pending".
    const early = await exchange(fx, { code: started.code, state: STATE, code_verifier: other });
    expect(early.statusCode).toBe(400);
    expect(early.body).not.toMatch(/pending/);

    await dashboardApproves(fx, sessionToken, started.browser_url, started.user_code);

    const wrong = await exchange(fx, { code: started.code, state: STATE, code_verifier: other });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).not.toMatch(/ds_(test|live)_/);
    // Sending the challenge back as if it were the verifier is also wrong.
    const replayed = await exchange(fx, {
      code: started.code,
      state: STATE,
      code_verifier: challenge,
    });
    expect(replayed.statusCode).toBe(400);

    const right = await exchange(fx, { code: started.code, state: STATE, code_verifier: verifier });
    expect(right.statusCode).toBe(200);
    expect(right.json<{ status: string }>().status).toBe('bound');
  });

  it('a challenge is accepted only as S256 and only together with its method', async () => {
    fx = await buildTestApp();
    const { verifier, challenge } = pkcePair();
    const refused: Array<Record<string, unknown>> = [
      { state: STATE, code_challenge: verifier, code_challenge_method: 'plain' },
      { state: STATE, code_challenge: challenge },
      { state: STATE, code_challenge_method: 'S256' },
      { state: STATE, code_challenge: challenge.slice(1), code_challenge_method: 'S256' },
    ];
    for (const payload of refused) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/cli-authorize/initiate',
        headers,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('GUI audit #9 — transition: an app that sends no challenge', () => {
  it('still signs in exactly as before, is told the removal date, and the server records that the old flow was used', async () => {
    fx = await buildTestApp();
    const sessionToken = await signedInDashboard(fx);

    // The request an already-installed app sends today.
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE, client_label: 'Driftstack desktop on test machine' },
    });
    expect(initiate.statusCode).toBe(200);
    expect(initiate.headers['sunset']).toBe('Sun, 31 Jan 2027 00:00:00 GMT');
    expect(initiate.headers['deprecation']).toMatch(/^@\d+$/);
    const started = initiate.json<InitiateResponse>();
    expect(Object.keys(started).sort()).toEqual(['browser_url', 'code', 'expires_at', 'user_code']);

    await dashboardApproves(fx, sessionToken, started.browser_url, started.user_code);

    const pending = await exchange(fx, { code: started.code, state: STATE });
    expect(pending.statusCode).toBe(200);
    const body = pending.json<{ status: string; api_key: string; account_id: string }>();
    expect(body.status).toBe('bound');
    expect(Object.keys(body).sort()).toEqual(['account_id', 'api_key', 'status']);

    expect(flowCount(fx, 'initiate', 'legacy', 'ok')).toBe(1);
    expect(flowCount(fx, 'exchange', 'legacy', 'ok')).toBe(1);
    expect(flowCount(fx, 'initiate', 'pkce', 'ok')).toBe(0);
  });

  it('a flow that started with a challenge carries no removal notice', async () => {
    fx = await buildTestApp();
    const { challenge } = pkcePair();
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE, code_challenge: challenge, code_challenge_method: 'S256' },
    });
    expect(initiate.statusCode).toBe(200);
    expect(initiate.headers['sunset']).toBeUndefined();
    expect(initiate.headers['deprecation']).toBeUndefined();
  });
});
