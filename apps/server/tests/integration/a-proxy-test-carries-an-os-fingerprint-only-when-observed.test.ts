// N-2 — the Test route's half of the passive OS fingerprint.
//
// The probe decides whether a SYN was observed; the route decides what the
// customer sees. These arms pin the wire contract: `os_fingerprint` is present
// exactly when the probe observed one, and a miss leaves the field ABSENT —
// not null, not a placeholder OS — so no client can colour a cell on it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

async function makeProxy(host: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: { label: 'p', host, port: 1080 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const probeWith = (observeOs: () => Promise<unknown>): never =>
  ({ probe: () => Promise.resolve({ ok: true }), observeOs }) as unknown as never;

describe('POST /v1/account/me/proxies/:id/test — os_fingerprint', () => {
  it('carries the fingerprint when the probe observed one', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({
          observed: true,
          observedIp: '198.51.100.7',
          via: 'proxy_host',
          signature: {},
          os: 'windows',
          confidence: 'medium',
          reason: 'initial TTL 128 with a Windows option layout',
        }),
      ),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeProxy('fp-windows.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; os_fingerprint?: Record<string, unknown> }>();
    expect(body.ok).toBe(true);
    expect(body.os_fingerprint).toEqual({
      os: 'windows',
      confidence: 'medium',
      reason: 'initial TTL 128 with a Windows option layout',
      observed_ip: '198.51.100.7',
      observed_via: 'proxy_host',
    });
  });

  it('omits the field entirely when nothing was observed — a miss is not an OS', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({ observed: false, reason: 'no SYN recorded' }),
      ),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeProxy('fp-miss.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(true);
    expect(typeof body.latency_ms).toBe('number');
    expect('os_fingerprint' in body).toBe(false);
  });
});
