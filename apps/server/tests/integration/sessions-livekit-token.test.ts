// V-531.B — integration tests for POST /v1/sessions/:id/livekit-token.
//
// Three scenarios:
//   1. config.livekit absent → route unregistered → 404.
//   2. config.livekit present + session owned + role 'subscriber' →
//      200 with token + ws_url + room + role + ttl_seconds.
//   3. config.livekit present + session owned + role 'publisher' →
//      200 with publisher token (canPublish=true).
//   4. cross-account session lookup → 404 (anti-enumeration).
//   5. malformed session id → 404 (shape-check rejects).
//   6. invalid role → 400 (ValidationError).
//
// The minted token is decoded as a JWT and the payload claims are
// checked against the expected shape (iss = apiKey, sub = sessionId,
// room = sessionId, canPublish/canSubscribe matching role).

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  type TestAppFixture,
  seedAdditionalAccount,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface DriverSessionResponse {
  id: string;
  status: string;
  archetype: string;
}

interface LivekitTokenResponse {
  token: string;
  ws_url: string;
  room: string;
  role: 'publisher' | 'subscriber';
  ttl_seconds: number;
}

function decodeJwtPart(part: string): unknown {
  const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
  const buf = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return JSON.parse(buf.toString('utf8'));
}

const LIVEKIT = {
  apiKey: 'APItest123',
  apiSecret: 'secrettest456',
  wsUrl: 'wss://test.livekit.cloud',
};

async function createSession(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { label: 'livekit-token-test' },
  });
  expect(res.statusCode).toBe(201);
  return res.json<DriverSessionResponse>().id;
}

describe('POST /v1/sessions/:id/livekit-token (V-531.B)', () => {
  it('route unregistered when config.livekit is absent → 404', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const sessionId = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/livekit-token`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { role: 'subscriber' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('subscriber role → 200 with subscriber JWT claims', async () => {
    fx = await buildTestApp({ tier: 'api_builder', livekit: LIVEKIT });
    const sessionId = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/livekit-token`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { role: 'subscriber' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LivekitTokenResponse>();
    expect(body.ws_url).toBe(LIVEKIT.wsUrl);
    expect(body.room).toBe(sessionId);
    expect(body.role).toBe('subscriber');
    expect(body.ttl_seconds).toBe(600);

    // Decode the JWT and verify the claim shape.
    const parts = body.token.split('.');
    expect(parts.length).toBe(3);
    const payload = decodeJwtPart(parts[1] as string) as {
      iss: string;
      sub: string;
      video: { room: string; canPublish: boolean; canSubscribe: boolean; roomJoin: true };
    };
    expect(payload.iss).toBe(LIVEKIT.apiKey);
    // 2026-06-05 launch-hardening: identity is per-account (customer-<id>),
    // not sessionId (fixed the LiveKit duplicate-identity collision).
    expect(payload.sub).toBe(`customer-${fx.accountId}`);
    expect(payload.video.room).toBe(sessionId);
    expect(payload.video.roomJoin).toBe(true);
    expect(payload.video.canPublish).toBe(false);
    expect(payload.video.canSubscribe).toBe(true);
  });

  it('publisher role is DOWNGRADED to subscribe-only (customer-authed route never grants publish)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', livekit: LIVEKIT });
    const sessionId = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/livekit-token`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { role: 'publisher' },
    });
    expect(res.statusCode).toBe(200);
    const payload = decodeJwtPart(
      res.json<LivekitTokenResponse>().token.split('.')[1] as string,
    ) as {
      sub: string;
      video: { canPublish: boolean; canSubscribe: boolean };
    };
    // 2026-06-05 launch-hardening: even when the caller asks for 'publisher',
    // the grant is subscribe-only — a customer must not be able to inject
    // media into the session room (the capture/harness publishes host-side).
    expect(payload.video.canPublish).toBe(false);
    expect(payload.video.canSubscribe).toBe(true);
    expect(payload.sub).toBe(`customer-${fx.accountId}`);
  });

  it('cross-account session id → 404 (anti-enumeration)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', livekit: LIVEKIT });
    // Create a session owned by account A.
    const sessionId = await createSession(fx);
    // Now seed a second account and call from it.
    const other = await seedAdditionalAccount(fx, {
      email: 'other-acc@livekit.test',
      tier: 'api_builder',
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/livekit-token`,
      headers: { authorization: `Bearer ${other.plaintext}` },
      payload: { role: 'subscriber' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('malformed session id shape → 404', async () => {
    fx = await buildTestApp({ tier: 'api_builder', livekit: LIVEKIT });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions/notasession/livekit-token',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { role: 'subscriber' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('invalid role → 400', async () => {
    fx = await buildTestApp({ tier: 'api_builder', livekit: LIVEKIT });
    const sessionId = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/livekit-token`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { role: 'admin' as 'publisher' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unauthenticated → 401', async () => {
    fx = await buildTestApp({ tier: 'api_builder', livekit: LIVEKIT });
    const sessionId = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/livekit-token`,
      payload: { role: 'subscriber' },
    });
    expect(res.statusCode).toBe(401);
  });
});
