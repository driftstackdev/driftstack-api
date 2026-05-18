// Arc 7 obs.15 — end-to-end verification of the
// driftstack_http_request_total counter through the full lib/app.ts
// builder + the integration test fixture (not the mocked Fastify
// instance from unit tests). Asserts the onResponse hook actually
// fires under buildTestApp.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

describe('Arc 7 obs.15 — http_request_total counter (integration)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('ticks {method=GET, route=/v1/whoami, status_class=2xx} on a happy-path whoami', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
      method: 'GET',
      route: '/v1/whoami',
      status_class: '2xx',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);

    const after = fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
      method: 'GET',
      route: '/v1/whoami',
      status_class: '2xx',
    });
    expect(after).toBe(before + 1);
  });

  it('ticks status_class=4xx on a missing-bearer request (same route bucket)', async () => {
    fx = await buildTestApp();
    const before4xx = fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
      method: 'GET',
      route: '/v1/whoami',
      status_class: '4xx',
    });
    const before2xx = fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
      method: 'GET',
      route: '/v1/whoami',
      status_class: '2xx',
    });
    const res = await fx.app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(res.statusCode).toBe(401);

    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '/v1/whoami',
        status_class: '4xx',
      }),
    ).toBe(before4xx + 1);
    // 2xx counter unchanged.
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '/v1/whoami',
        status_class: '2xx',
      }),
    ).toBe(before2xx);
  });

  it('parameterized routes collapse to one cell — two different sessions, one route label', async () => {
    fx = await buildTestApp();
    // Two distinct (invalid) session ids hit the same /v1/sessions/:id
    // route template. The counter should accumulate against the
    // template, not the URL — proving the cardinality bound holds
    // through the real lib/app.ts hook.
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
      method: 'GET',
      route: '/v1/sessions/:id/state',
      status_class: '4xx',
    });
    await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_11111111-2222-3333-4444-555555555555/state',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_22222222-3333-4444-5555-666666666666/state',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const after = fx.metricsRegistry.getValue(METRIC_NAMES.httpRequestTotal, {
      method: 'GET',
      route: '/v1/sessions/:id/state',
      status_class: '4xx',
    });
    expect(after).toBe(before + 2);
  });

  it('exposition rendering (registry.render()) includes the new metric', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const rendered = fx.metricsRegistry.render();
    expect(rendered).toContain('# TYPE driftstack_http_request_total counter');
    expect(rendered).toMatch(
      /driftstack_http_request_total\{method="GET",route="\/v1\/whoami",status_class="2xx"\} \d+/,
    );
  });
});
