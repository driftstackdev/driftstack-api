// Integration tests for GET /v1/egress/echo (proxy-probe exit-IP echo).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('GET /v1/egress/echo', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 unauthenticated — returns the caller ip; country null without a CF header', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/egress/echo' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ip: string; country: string | null }>();
    expect(typeof body.ip).toBe('string');
    expect(body.ip.length).toBeGreaterThan(0);
    expect(body.country).toBeNull();
  });

  it('country comes from cf-ipcountry; XX/T1/garbage sentinel values surface as null', async () => {
    fx = await buildTestApp();
    const cases: Array<[string, string | null]> = [
      ['NL', 'NL'],
      ['US', 'US'],
      ['XX', null],
      ['T1', null], // Tor sentinel — lowercase '1' fails the A-Z pattern
      ['nonsense', null],
    ];
    for (const [header, expected] of cases) {
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/egress/echo',
        headers: { 'cf-ipcountry': header },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ country: string | null }>().country).toBe(expected);
    }
  });

  it('#128 exit geo — region/city/timezone from CF location headers; absent ⇒ null (never invented)', async () => {
    fx = await buildTestApp();
    const withGeo = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      headers: {
        'cf-region': 'North Holland',
        'cf-ipcity': 'Amsterdam',
        'cf-timezone': 'Europe/Amsterdam',
      },
    });
    expect(withGeo.statusCode).toBe(200);
    const g = withGeo.json<{
      region: string | null;
      city: string | null;
      timezone: string | null;
    }>();
    expect(g.region).toBe('North Holland');
    expect(g.city).toBe('Amsterdam');
    expect(g.timezone).toBe('Europe/Amsterdam');
    // blank header trims to empty ⇒ null
    const blank = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      headers: { 'cf-region': '   ' },
    });
    expect(blank.json<{ region: string | null }>().region).toBeNull();
    // absent (transform off) ⇒ null
    const noGeo = await fx.app.inject({ method: 'GET', url: '/v1/egress/echo' });
    const n = noGeo.json<{ region: string | null; city: string | null; timezone: string | null }>();
    expect(n.region).toBeNull();
    expect(n.city).toBeNull();
    expect(n.timezone).toBeNull();
  });

  it('429 after the IP bucket drains (capacity 12)', async () => {
    fx = await buildTestApp();
    let last = 0;
    for (let i = 0; i < 14; i++) {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/egress/echo' });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});
