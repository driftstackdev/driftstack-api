// SSE ?ds_token= leak hardening — proof that the production logger's `req`
// serializer redacts the bearer token Fastify's auto request-logging would
// otherwise write into `req.url` for the EventSource auth path
// (requireAuthEventSource accepts the credential as a `?ds_token=` query
// param because EventSource can't set headers).
//
// redact-url.test.ts proves redactUrlQueryTokens() in isolation; this
// proves the exact serializer that createLogger() wires (redactReqSerializer)
// strips the credential from a logged request — so a refactor that drops it
// fails here. Decision: KEEP ds_token (migrating to a single-purpose ticket
// would break live EventSource clients in the SDK / dashboard / GUI) and
// instead guarantee the app logger + Sentry never surface the credential.
// This locks that guarantee for the log channel.

import { describe, expect, it } from 'vitest';
import { redactReqSerializer } from '../../src/lib/logger.js';

describe('redactReqSerializer redacts the SSE ?ds_token= bearer from req.url', () => {
  it('redacts ds_token on the notifications SSE route, keeping the path', () => {
    const out = redactReqSerializer({
      method: 'GET',
      url: '/v1/account/me/notifications?ds_token=ds_live_SUPERSECRET',
    });
    expect(out.url).not.toContain('SUPERSECRET');
    expect(out.url).toContain('ds_token=');
    expect(out.url).toContain('/v1/account/me/notifications');
  });

  it('redacts ds_token on the agent-sessions transcript SSE route', () => {
    const out = redactReqSerializer({
      method: 'GET',
      url: '/v1/agent-sessions/abc/transcript?ds_token=ds_live_LEAKME',
    });
    expect(out.url).not.toContain('LEAKME');
    expect(out.url).toContain('/v1/agent-sessions/abc/transcript');
  });

  it('leaves a credential-free URL untouched', () => {
    const out = redactReqSerializer({ method: 'GET', url: '/v1/account/me?expand=usage' });
    expect(out.url).toBe('/v1/account/me?expand=usage');
  });

  it('preserves the rest of the Fastify req shape (method/host/remoteAddress/remotePort)', () => {
    const out = redactReqSerializer({
      method: 'GET',
      url: '/v1/account/me/notifications?ds_token=secret',
      host: 'api.driftstack.dev',
      ip: '203.0.113.7',
      socket: { remotePort: 54321 },
    });
    expect(out.method).toBe('GET');
    expect(out.host).toBe('api.driftstack.dev');
    expect(out.remoteAddress).toBe('203.0.113.7');
    expect(out.remotePort).toBe(54321);
  });
});
