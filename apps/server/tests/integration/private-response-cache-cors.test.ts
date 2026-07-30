// Real-listener proof for caller-private cache and raw-SSE CORS boundaries.
// Hijacked SSE replies bypass Fastify's normal onSend/CORS hooks, so inject-only
// tests cannot prove the headers that a browser actually receives on the wire.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

// Deliberately absent from cors-allow.ts's built-in product origins. This makes
// buildApp's configured CORS authority → raw-SSE route handoff load-bearing:
// dropping that handoff must turn both allowed-origin assertions red.
const ALLOWED_ORIGIN = 'https://configured-console.example.test';
const DISALLOWED_ORIGIN = 'https://cross-account.invalid';
const PRIVATE_SSE_CACHE = 'no-cache, no-store, private, no-transform';

let fx: TestAppFixture | undefined;
const closeStreams: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closeStreams.splice(0).map((close) => close()));
  if (fx !== undefined) await fx.cleanup();
  fx = undefined;
});

async function openStream(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  let closed = false;
  closeStreams.push(async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await Promise.allSettled([response.body?.cancel() ?? Promise.resolve()]);
  });
  return response;
}

async function createAgentSession(fixture: TestAppFixture): Promise<string> {
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

function expectAllowedPrivateStream(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe(PRIVATE_SSE_CACHE);
  expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  expect(response.headers.get('vary')).toBe('Origin');
}

function expectDisallowedPrivateStream(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe(PRIVATE_SSE_CACHE);
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  expect(response.headers.get('vary')).toBeNull();
}

describe('private response cache and CORS wire policy', () => {
  it('serves transcript and notification SSE only with origin-specific allowed CORS', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      corsStrict: { dashboardOrigin: ALLOWED_ORIGIN },
    });
    const agentSessionId = await createAgentSession(fx);
    const address = await fx.app.listen({ host: '127.0.0.1', port: 0 });
    const authorization = `Bearer ${fx.plaintext}`;

    const transcript = await openStream(
      `${address}/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/transcript`,
      { authorization, origin: ALLOWED_ORIGIN },
    );
    expectAllowedPrivateStream(transcript);

    const notifications = await openStream(`${address}/v1/account/me/notifications`, {
      authorization,
      origin: ALLOWED_ORIGIN,
    });
    expectAllowedPrivateStream(notifications);
  });

  it('keeps private stream cache protection while omitting CORS for a disallowed origin', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      corsStrict: { dashboardOrigin: ALLOWED_ORIGIN },
    });
    const agentSessionId = await createAgentSession(fx);
    const address = await fx.app.listen({ host: '127.0.0.1', port: 0 });
    const authorization = `Bearer ${fx.plaintext}`;

    const transcript = await openStream(
      `${address}/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/transcript`,
      { authorization, origin: DISALLOWED_ORIGIN },
    );
    expectDisallowedPrivateStream(transcript);

    const notifications = await openStream(`${address}/v1/account/me/notifications`, {
      authorization,
      origin: DISALLOWED_ORIGIN,
    });
    expectDisallowedPrivateStream(notifications);
  });

  it('keeps subscribe, confirm, and unsubscribe private while preserving public status caching', async () => {
    fx = await buildTestApp({ corsStrict: { dashboardOrigin: ALLOWED_ORIGIN } });

    const subscribe = await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json' },
      payload: { email: 'cache-cors@example.test' },
    });
    expect(subscribe.statusCode).toBe(202);
    expect(subscribe.headers['cache-control']).toBe('no-store, private');
    expect(subscribe.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(subscribe.headers['vary']).toContain('Origin');

    const confirmLink = fx.emailSends.at(-1)?.vars['confirmLink'];
    expect(typeof confirmLink).toBe('string');
    const confirmToken = new URL(confirmLink as string).searchParams.get('token');
    expect(confirmToken).not.toBeNull();
    const confirm = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/confirm?token=${encodeURIComponent(confirmToken!)}`,
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.headers['cache-control']).toBe('no-store, private');
    expect(confirm.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(confirm.headers['vary']).toContain('Origin');

    const unsubscribeLink = fx.emailSends.at(-1)?.vars['unsubscribeLink'];
    expect(typeof unsubscribeLink).toBe('string');
    const unsubscribeToken = new URL(unsubscribeLink as string).searchParams.get('token');
    expect(unsubscribeToken).not.toBeNull();
    const unsubscribe = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/unsubscribe?token=${encodeURIComponent(unsubscribeToken!)}`,
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(unsubscribe.statusCode).toBe(200);
    expect(unsubscribe.headers['cache-control']).toBe('no-store, private');
    expect(unsubscribe.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(unsubscribe.headers['vary']).toContain('Origin');

    const publicStatus = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(publicStatus.statusCode).toBe(200);
    expect(publicStatus.headers['cache-control']).toBe('public, max-age=30');

    const address = await fx.app.listen({ host: '127.0.0.1', port: 0 });
    const publicStream = await openStream(`${address}/v1/status/stream`, {
      origin: ALLOWED_ORIGIN,
    });
    expect(publicStream.status).toBe(200);
    expect(publicStream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(publicStream.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(publicStream.headers.get('vary')).toBe('Origin');
  });

  it('omits CORS on a disallowed status mailbox origin without weakening private caching', async () => {
    fx = await buildTestApp({ corsStrict: { dashboardOrigin: ALLOWED_ORIGIN } });
    const disallowed = await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      headers: { origin: DISALLOWED_ORIGIN, 'content-type': 'application/json' },
      payload: { email: 'disallowed-origin@example.test' },
    });

    expect(disallowed.statusCode).toBe(202);
    expect(disallowed.headers['cache-control']).toBe('no-store, private');
    expect(disallowed.headers['access-control-allow-origin']).toBeUndefined();
  });
});
