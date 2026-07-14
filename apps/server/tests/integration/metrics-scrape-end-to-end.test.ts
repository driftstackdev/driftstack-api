// End-to-end integration test: GET /metrics Prometheus scrape
// endpoint enforces METRICS_SCRAPE_TOKEN bearer auth + the
// `text/plain; version=0.0.4; charset=utf-8` exposition-format
// content-type per the scraper-protocol spec. Drift on the token
// would expose internal counters; drift on content-type would have
// Prometheus / VictoriaMetrics scrapers reject the response.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('GET /metrics Prometheus scrape end-to-end', () => {
  it('without auth header → 401 (NOT 200 — internal counters stay private)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    // Test fixture hardcodes metricsScrapeToken='test-scrape-token'
    // → route is registered + auth-gated. Missing Bearer → 401.
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="metrics"');
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://errors.driftstack.dev/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Metrics scrape token missing or invalid.',
      instance: res.headers['x-request-id'],
    });
  });

  it('with the WRONG Bearer → 401 (NOT 200)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer not-the-scrape-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="metrics"');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('without a configured scrape token → typed fail-closed 503', async () => {
    fx = await buildTestApp({ tier: 'api_builder', metricsScrapeToken: null });
    const res = await fx.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://errors.driftstack.dev/feature-unavailable',
      title: 'Feature unavailable',
      status: 503,
      detail: 'Metrics scraping is not configured.',
      instance: res.headers['x-request-id'],
    });
  });

  it('with the correct Bearer → 200 + text/plain version=0.0.4 content-type', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer test-scrape-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);
  });
});
