// End-to-end integration test: every response carries a request-id
// that correlates server logs with customer-visible error responses.
// The request-id appears in the problem+json `instance` field on
// errors (per RFC 7807) so operators can trace a customer's report
// back to the specific log line.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('request-id correlation end-to-end', () => {
  it('error responses carry an `instance` field (request-id) for log correlation', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/no-such-route',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ instance?: string }>();
    expect(body.instance).toBeDefined();
    expect(typeof body.instance).toBe('string');
    expect((body.instance ?? '').length).toBeGreaterThan(0);
  });

  it('different requests get different instance values (request-id is unique per request)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/no-such-route',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const res2 = await fx.app.inject({
      method: 'GET',
      url: '/v1/another-no-such-route',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const id1 = res1.json<{ instance?: string }>().instance;
    const id2 = res2.json<{ instance?: string }>().instance;
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it('correlation passthrough is BOUNDED (CWE-113) — a client-supplied x-request-id is reflected for tracing, but only up to 128 chars; an over-long inbound value is replaced by a fresh UUID, so a client cannot pin an unbounded value into the response header / logs', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // (a) a normal inbound id is reflected verbatim — the proxy/CDN trace
    // passthrough the genReqId contract is designed for.
    const corr = 'corr-abc-123';
    const ok = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'x-request-id': corr },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-request-id']).toBe(corr);
    // (b) an over-long (>128) inbound id is NOT reflected — genReqId falls
    // back to a fresh UUID, so an unbounded client-controlled value never
    // lands in the response header (or the correlated log field).
    const tooLong = 'x'.repeat(200);
    const capped = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'x-request-id': tooLong },
    });
    expect(capped.statusCode).toBe(200);
    const reflected = capped.headers['x-request-id'];
    expect(typeof reflected).toBe('string');
    expect(reflected).not.toBe(tooLong);
    expect((reflected as string).length).toBeLessThanOrEqual(128);
  });

  it('a 2xx with NO inbound id still exposes a generated x-request-id (operators can correlate even on success)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` }, // deliberately NO x-request-id
    });
    expect(res.statusCode).toBe(200);
    // The response MUST carry a request-id even when the client sent none — the
    // server generates one (genReqId) and exposes it, so a 2xx is correlatable to
    // its log line. This was previously vacuous: both branches of an `if (!has)`
    // asserted `true`, so it passed whether or not the header existed. Assert the
    // header (the canonical `x-request-id` the sibling arms above use) is present
    // and non-empty; the ONLY uncaught regression was exactly this — a generated
    // id dropped from a 2xx that carried no inbound id.
    const requestId = res.headers['x-request-id'];
    expect(typeof requestId).toBe('string');
    expect((requestId as string).length).toBeGreaterThan(0);
  });
});
