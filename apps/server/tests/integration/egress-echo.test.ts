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

  // T-11 (exit lat/lon — A2 half of live geolocation spoofing): "even live
  // geolocation API spoofing matching our IP … exactly like a real location". The
  // echo SHIPS the exit coordinates the fork answers navigator.geolocation from.
  // MEASURED mechanism: the same "Add visitor location headers" managed transform
  // that delivers cf-region/cf-ipcity/cf-timezone also delivers cf-iplatitude /
  // cf-iplongitude, which this route reads back THROUGH the proxy. The N-2/N-5 rule
  // governs a miss: an absent or out-of-range coordinate is OMITTED entirely, never
  // shipped as 0,0, so a missing measurement stays distinguishable from a real one.
  it('T-11 exit coordinates — lat/lon come from CF coordinate headers; a valid pair survives (vacuity control)', async () => {
    fx = await buildTestApp();
    // VACUITY CONTROL: a genuine, in-range Amsterdam pair must ARRIVE — otherwise
    // every "field absent" arm below would pass even if the route never emitted a
    // coordinate at all.
    const withCoords = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      headers: {
        'cf-iplatitude': '52.37',
        'cf-iplongitude': '4.90',
        'cf-ipcity': 'Amsterdam',
      },
    });
    expect(withCoords.statusCode).toBe(200);
    const c = withCoords.json<{ lat?: number; lon?: number; accuracy_hint?: string }>();
    expect(c.lat).toBe(52.37);
    expect(c.lon).toBe(4.9);
    // accuracy_hint rides along only when a coordinate AND a city both resolved.
    expect(c.accuracy_hint).toBe('city');
  });

  it('T-11 exit coordinates — absent coordinate headers ⇒ the fields are OMITTED (never 0,0)', async () => {
    fx = await buildTestApp();
    // No cf-iplatitude/-longitude header (transform off / edge unresolved). The
    // KEY must be absent — 0,0 (the Gulf of Guinea) is a real coordinate and must
    // not be manufactured from a miss.
    const noCoords = await fx.app.inject({ method: 'GET', url: '/v1/egress/echo' });
    const n = noCoords.json<Record<string, unknown>>();
    expect('lat' in n).toBe(false);
    expect('lon' in n).toBe(false);
    // and with no coordinate there is no granularity to hint at.
    expect('accuracy_hint' in n).toBe(false);
  });

  it('T-11 exit coordinates — an out-of-range latitude (999) is DROPPED, not clamped or shipped', async () => {
    fx = await buildTestApp();
    // A latitude of 999 is impossible (max 90). Dropping it — rather than clamping
    // to 90 or shipping it raw — keeps a corrupt/MITM'd header out of the fork's
    // geolocation answer. The valid longitude beside it still survives.
    const badLat = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      headers: { 'cf-iplatitude': '999', 'cf-iplongitude': '4.90' },
    });
    const b = badLat.json<Record<string, unknown>>();
    expect('lat' in b).toBe(false);
    expect(b.lon).toBe(4.9);
    // an out-of-range longitude (999 > 180) drops the same way
    const badLon = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      headers: { 'cf-iplatitude': '52.37', 'cf-iplongitude': '999' },
    });
    const b2 = badLon.json<Record<string, unknown>>();
    expect(b2.lat).toBe(52.37);
    expect('lon' in b2).toBe(false);
    // a non-numeric header is a miss too (blank / garbage ⇒ omitted)
    const garbage = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      headers: { 'cf-iplatitude': 'north', 'cf-iplongitude': '   ' },
    });
    const g = garbage.json<Record<string, unknown>>();
    expect('lat' in g).toBe(false);
    expect('lon' in g).toBe(false);
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
