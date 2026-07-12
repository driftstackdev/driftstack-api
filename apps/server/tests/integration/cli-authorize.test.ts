// V-266 — Integration tests for the browser-OAuth CLI / GUI activation
// flow.
//
// Walks the full happy path (initiate → bind via session → exchange)
// plus the security/edge cases:
//   - exchange while pending returns status: 'pending'
//   - state mismatch on bind / exchange returns 400
//   - exchange after one successful exchange returns status: 'expired'
//   - bind by an unauthenticated caller returns 401
//   - bind on an unknown code returns 404
//   - exchange on an unknown code returns status: 'expired'
//
// The bind path requires a real web-session bearer; we obtain one
// via the V-079 signup → verify-email flow that the test fixture
// already wires.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

interface InitiateResponse {
  code: string;
  browser_url: string;
  expires_at: string;
}

interface ExchangeBoundResponse {
  status: 'bound';
  api_key: string;
  account_id: string;
}

interface ExchangePendingResponse {
  status: 'pending';
}

interface ExchangeExpiredResponse {
  status: 'expired';
}

interface SessionResponse {
  session: { token: string; account_id: string };
}

interface SignupResponse {
  debug_token: string;
}

async function freshSessionToken(
  fxArg: TestAppFixture,
): Promise<{ token: string; accountId: string }> {
  const email = `cli-${Date.now().toString()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'correct horse battery staple';

  const signup = await fxArg.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers,
    payload: { email, password },
  });
  const { debug_token } = signup.json<SignupResponse>();

  const verify = await fxArg.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    headers,
    payload: { token: debug_token },
  });
  const { session } = verify.json<SessionResponse>();
  return { token: session.token, accountId: session.account_id };
}

async function acceptAllLegal(fxArg: TestAppFixture, sessionToken: string): Promise<void> {
  const docs = await fxArg.app.inject({
    method: 'GET',
    url: '/v1/legal/documents',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const body = docs.json<{
    data: Array<{ document_key: string; version: string; content_hash: string }>;
  }>();
  for (const doc of body.data) {
    await fxArg.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: {
        document_key: doc.document_key,
        version: doc.version,
        content_hash: doc.content_hash,
      },
    });
  }
}

const STATE = 'test-state-1234567890abcdef'; // 28 chars, satisfies min(16)

describe('V-266 — POST /v1/auth/cli-authorize/initiate', () => {
  it('returns code + browser_url + expires_at', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE, client_label: 'Driftstack desktop on test machine' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<InitiateResponse>();
    expect(body.code).toBeTruthy();
    expect(body.code.length).toBeGreaterThanOrEqual(40);
    expect(body.browser_url).toMatch(/^http:\/\/localhost:5173\/cli\/authorize\?/);
    expect(body.browser_url).toContain(`code=${body.code.replace(/=/g, '%3D')}`);
    expect(body.browser_url).toContain('state=');
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('400 when state is too short', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('V-266 — exchange while pending', () => {
  it('returns status: pending before bind', async () => {
    fx = await buildTestApp();
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();

    const exchange = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/exchange',
      headers,
      payload: { code, state: STATE },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json<ExchangePendingResponse>().status).toBe('pending');
  });
});

describe('V-266 — full happy path: initiate → bind → exchange', () => {
  it('GUI receives the API key after dashboard binds', async () => {
    fx = await buildTestApp();
    const { token: sessionToken, accountId } = await freshSessionToken(fx);
    await acceptAllLegal(fx, sessionToken);

    // 1. CLI/GUI initiates
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE, client_label: 'Test desktop' },
    });
    const { code } = initiate.json<InitiateResponse>();

    // 2. Dashboard binds (with web-session bearer auth)
    const bind = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: { code, state: STATE },
    });
    expect(bind.statusCode).toBe(200);
    expect(bind.json<{ ok: true; account_id: string }>().account_id).toBe(accountId);

    // 3. CLI/GUI polls exchange — gets the key
    const exchange = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/exchange',
      headers,
      payload: { code, state: STATE },
    });
    expect(exchange.statusCode).toBe(200);
    const body = exchange.json<ExchangeBoundResponse>();
    expect(body.status).toBe('bound');
    expect(body.api_key).toMatch(/^ds_(live|test)_/);
    expect(body.account_id).toBe(accountId);

    // 4. The issued key actually authenticates against the API
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${body.api_key}` },
    });
    expect(me.statusCode).toBe(200);
  });
});

describe('V-266 — security + edge cases', () => {
  it('exchange after one successful exchange returns expired (one-shot)', async () => {
    fx = await buildTestApp();
    const { token: sessionToken } = await freshSessionToken(fx);
    await acceptAllLegal(fx, sessionToken);

    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();

    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: { code, state: STATE },
    });

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/exchange',
      headers,
      payload: { code, state: STATE },
    });
    expect(first.json<ExchangeBoundResponse>().status).toBe('bound');

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/exchange',
      headers,
      payload: { code, state: STATE },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<ExchangeExpiredResponse>().status).toBe('expired');
  });

  it('bind with mismatched state returns 400', async () => {
    fx = await buildTestApp();
    const { token: sessionToken } = await freshSessionToken(fx);
    await acceptAllLegal(fx, sessionToken);

    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();

    const bind = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: { code, state: 'different-state-1234567890' },
    });
    expect(bind.statusCode).toBe(400);
  });

  it('exchange with mismatched state returns 400', async () => {
    fx = await buildTestApp();
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();

    const exchange = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/exchange',
      headers,
      payload: { code, state: 'different-state-1234567890' },
    });
    expect(exchange.statusCode).toBe(400);
  });

  it('bind without auth returns 401', async () => {
    fx = await buildTestApp();
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();

    const bind = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers,
      payload: { code, state: STATE },
    });
    expect(bind.statusCode).toBe(401);
  });

  it('bind on an unknown code returns 404', async () => {
    fx = await buildTestApp();
    const { token: sessionToken } = await freshSessionToken(fx);
    await acceptAllLegal(fx, sessionToken);

    const bind = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: { code: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: STATE },
    });
    expect(bind.statusCode).toBe(404);
  });

  it('exchange on an unknown code returns expired (does not leak existence)', async () => {
    fx = await buildTestApp();
    const exchange = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/exchange',
      headers,
      payload: { code: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', state: STATE },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json<ExchangeExpiredResponse>().status).toBe('expired');
  });

  it('binding twice returns 400 already_bound on the second bind', async () => {
    fx = await buildTestApp();
    const { token: sessionToken } = await freshSessionToken(fx);
    await acceptAllLegal(fx, sessionToken);

    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: { code, state: STATE },
    });
    expect(first.statusCode).toBe(200);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      payload: { code, state: STATE },
    });
    expect(second.statusCode).toBe(400);
  });

  it('concurrent binds leave exactly one active device key', async () => {
    fx = await buildTestApp();
    const { token: sessionToken } = await freshSessionToken(fx);
    await acceptAllLegal(fx, sessionToken);

    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      payload: { state: STATE },
    });
    const { code } = initiate.json<InitiateResponse>();
    const bindRequest = () =>
      fx.app.inject({
        method: 'POST',
        url: '/v1/auth/cli-authorize/bind',
        headers: { ...headers, authorization: `Bearer ${sessionToken}` },
        payload: { code, state: STATE },
      });

    const [first, second] = await Promise.all([bindRequest(), bindRequest()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);

    const deviceKeys = (await fx.apiKeysRepo.listAllApiKeys({ limit: 100 })).items.filter(
      (key) => key.provenance === 'cli_device',
    );
    expect(deviceKeys).toHaveLength(2);
    expect(deviceKeys.filter((key) => key.revokedAt === null)).toHaveLength(1);
    expect(deviceKeys.filter((key) => key.revokedAt !== null)).toHaveLength(1);
  });
});
