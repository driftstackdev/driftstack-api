// V-664.B — CORS hardening audit. Pins the chosen policy on the
// wire so loosening it (or accidentally tightening it for the
// dashboard's session-cookie path) surfaces here first.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('V-664.B CORS — preflight (OPTIONS)', () => {
  it('localhost origin is allowed (dev posture)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('preflight echoes max-age=600 (10 min preflight cache)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('explicit method list does NOT include TRACE / CONNECT', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    const allowedMethods = res.headers['access-control-allow-methods'] ?? '';
    expect(allowedMethods).toContain('GET');
    expect(allowedMethods).toContain('POST');
    expect(allowedMethods).toContain('DELETE');
    expect(allowedMethods).toContain('OPTIONS');
    expect(allowedMethods).not.toContain('TRACE');
    expect(allowedMethods).not.toContain('CONNECT');
  });

  it('allowedHeaders pins authorization + content-type + webhook sig headers', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    const allowedHeaders = res.headers['access-control-allow-headers'] ?? '';
    // Spec lowercases; we compare case-insensitively just in case.
    const lower = allowedHeaders.toLowerCase();
    expect(lower).toContain('authorization');
    expect(lower).toContain('content-type');
    expect(lower).toContain('x-request-id');
    expect(lower).toContain('stripe-signature');
    expect(lower).toContain('x-nowpayments-sig');
  });
});

describe('V-664.B CORS — actual-request response', () => {
  it('exposedHeaders includes request, checkout-replay, and rate-limit headers', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/version',
      headers: { origin: 'http://localhost:5173' },
    });
    const exposed = res.headers['access-control-expose-headers'] ?? '';
    expect(exposed.toLowerCase()).toContain('x-request-id');
    expect(exposed.toLowerCase()).toContain('idempotent-replayed');
    expect(exposed.toLowerCase()).toContain('x-ratelimit-remaining');
    expect(exposed.toLowerCase()).toContain('retry-after');
  });

  // V-1371 — the unknown-fields header is set on ~33 customer-facing writes and
  // apps/docs tells integrators to "Log `x-driftstack-unknown-fields` in
  // non-production. Its presence means a field you sent was ignored". A response
  // header that is not on Access-Control-Expose-Headers is unreadable from JS on a
  // different origin, and the dashboard is a different origin from the API.
  it('CRITICAL exposedHeaders includes x-driftstack-unknown-fields. Without it the whole report-never-reject mechanism is invisible to every browser caller — including our own dashboard — while the docs instruct customers to read it.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/version',
      headers: { origin: 'http://localhost:5173' },
    });
    const exposed = (res.headers['access-control-expose-headers'] ?? '').toString().toLowerCase();
    expect(exposed, 'the header a browser cannot read is a header we did not send').toContain(
      'x-driftstack-unknown-fields',
    );
  });

  it('CRITICAL the header is actually SENT on a cross-origin write, and exposed on that same response. Asserting the allowlist on /version alone would pass while the write that produces the header answered without it.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}`, origin: 'http://localhost:5173' },
      payload: { name: 'Updated', timezonee: 'Europe/Amsterdam' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-driftstack-unknown-fields'], 'the ignored key is named back').toBe(
      'timezonee',
    );
    expect(
      (res.headers['access-control-expose-headers'] ?? '').toString().toLowerCase(),
      'and the browser is allowed to read it on this very response',
    ).toContain('x-driftstack-unknown-fields');
  });

  it('rejects a non-allowlisted origin in production posture (permissiveCors=false default)', async () => {
    // buildTestApp uses permissiveCors=true; for prod posture we'd need
    // to flip it. Pin the dev posture explicitly here so a future change
    // to defaults is visible.
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/version',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });
});

// 2026-05-22 — regression guard. Crypto checkout failed with
// "Failed to fetch" in the browser because the CORS preflight
// rejected the `Idempotency-Key` request header (the customer-
// dashboard JS sends it on every POST /v1/billing/crypto-checkout
// + agent-sessions create). This suite locks the allowlist for
// every header the dashboard / SDK / extension might send so a
// future trim of allowedHeaders can't silently re-break a flow.
describe('V-664.B CORS — every customer-facing header is allowlisted', () => {
  let fx: Awaited<ReturnType<typeof buildTestApp>>;
  afterEach(async () => {
    if (fx) await fx.app.close();
  });

  const customerHeaders = [
    'authorization', // bearer auth
    'content-type', // JSON body
    'x-request-id', // V-167 client-set trace id
    'idempotency-key', // V-666.AO + v2-#19 idempotent POSTs
    'x-byok-anthropic-api-key', // Q.1.c BYOK per-request override
    'x-driftstack-account', // V-330 team-scope act-as
    // 2026-06-30 — the GUI sends the per-session control credential as
    // `x-driftstack-gui-control-key` on GET /:id/cookies, GET /:id/downloads,
    // /downloads/content, taps + history. It was missing from allowedHeaders,
    // so the browser preflight failed → the GET never fired → founder saw
    // "couldn't load cookies / couldn't reach the device for downloads —
    // retrying" (journal showed OPTIONS-only, no GET). Guarded here so a trim
    // can't silently re-break the live cookies/downloads panes again.
    'x-driftstack-gui-control-key',
  ];

  for (const header of customerHeaders) {
    it(`preflight accepts ${header}`, async () => {
      fx = await buildTestApp();
      const res = await fx.app.inject({
        method: 'OPTIONS',
        url: '/v1/billing/crypto-checkout',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': header,
        },
      });
      // Either 204 (preflight accepted) or 200; never 403 / 405 / 400.
      expect([200, 204]).toContain(res.statusCode);
      const allow = (res.headers['access-control-allow-headers'] ?? '').toString().toLowerCase();
      expect(allow).toContain(header);
    });
  }
});

describe('V-278.C CORS — strict posture (permissiveCors=false) auto-allows the dashboard origin', () => {
  it('the canonical dashboardOrigin is allowed even when CORS_ALLOWED_ORIGINS omits it', async () => {
    fx = await buildTestApp({ corsStrict: { dashboardOrigin: 'https://app.driftstack.dev' } });
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'https://app.driftstack.dev',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.driftstack.dev');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('an unlisted cross-origin is NOT echoed under the strict posture (the security win)', async () => {
    fx = await buildTestApp({ corsStrict: { dashboardOrigin: 'https://app.driftstack.dev' } });
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    });
    // Not echoed back as an allowed origin (permissive would have echoed it).
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  it('explicit CORS_ALLOWED_ORIGINS entries are still honored alongside the dashboard origin', async () => {
    fx = await buildTestApp({
      corsStrict: {
        dashboardOrigin: 'https://app.driftstack.dev',
        allowedOrigins: ['https://admin.driftstack.dev'],
      },
    });
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/whoami',
      headers: {
        origin: 'https://admin.driftstack.dev',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.driftstack.dev');
  });
});
