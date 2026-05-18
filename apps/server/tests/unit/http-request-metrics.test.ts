// Arc 7 obs.15 — `driftstack_http_request_total{method,route,status_class}`
// counter wired via the onResponse hook in lib/app.ts. End-to-end
// verification against a real Fastify instance exercises the
// Fastify-internal route-template resolution path (routeOptions.url)
// rather than mocking it.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.httpRequestTotal, 'HTTP requests.', [
    'method',
    'route',
    'status_class',
  ]);
  return m;
}

/** Wire the same onResponse hook the app uses (lib/app.ts). Kept
 *  in-test as a faithful copy so the test exercises the same
 *  cardinality / fallback behaviour. */
function wireOnResponseHook(app: FastifyInstance, registry: MetricsRegistry): void {
  app.addHook('onResponse', (req, reply, done) => {
    const method = req.method.toUpperCase();
    const ro = (req as { routeOptions?: { url?: string } }).routeOptions;
    const route = ro?.url ?? (req as { routerPath?: string }).routerPath ?? '__unrouted__';
    const status = reply.statusCode;
    const statusClass =
      status >= 500
        ? '5xx'
        : status >= 400
          ? '4xx'
          : status >= 300
            ? '3xx'
            : status >= 200
              ? '2xx'
              : '1xx';
    try {
      registry.inc(METRIC_NAMES.httpRequestTotal, {
        method,
        route,
        status_class: statusClass,
      });
    } catch {
      // Swallow.
    }
    done();
  });
}

async function buildApp(metrics: MetricsRegistry) {
  const app = Fastify();
  wireOnResponseHook(app, metrics);
  app.get('/v1/ping', () => ({ ok: true }));
  app.get<{ Params: { id: string } }>('/v1/items/:id', (req) => ({ id: req.params.id }));
  app.post('/v1/items', () => ({ created: true }));
  app.get('/v1/explode', () => {
    throw new Error('boom');
  });
  await app.ready();
  return app;
}

describe('Arc 7 obs.15 — http_request_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('emits method=GET, route=/v1/ping, status_class=2xx on a happy path', async () => {
    app = await buildApp(metrics);
    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    expect(res.statusCode).toBe(200);
    expect(
      metrics.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '/v1/ping',
        status_class: '2xx',
      }),
    ).toBe(1);
    await app.close();
  });

  it('emits the route TEMPLATE (not the URL) for parameterized routes — cardinality bound', async () => {
    app = await buildApp(metrics);
    await app.inject({ method: 'GET', url: '/v1/items/abc' });
    await app.inject({ method: 'GET', url: '/v1/items/xyz' });
    // Both requests collapse to the same counter cell — route is the
    // template, not the URL.
    expect(
      metrics.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '/v1/items/:id',
        status_class: '2xx',
      }),
    ).toBe(2);
    // No counter cell with the raw URL.
    expect(
      metrics.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '/v1/items/abc',
        status_class: '2xx',
      }),
    ).toBe(0);
    await app.close();
  });

  it('emits method=POST distinct from GET for the same route', async () => {
    app = await buildApp(metrics);
    await app.inject({ method: 'POST', url: '/v1/items', payload: {} });
    expect(
      metrics.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'POST',
        route: '/v1/items',
        status_class: '2xx',
      }),
    ).toBe(1);
  });

  it('emits status_class="4xx" on 404 (unrouted) with the synthetic __unrouted__ route bucket', async () => {
    app = await buildApp(metrics);
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(
      metrics.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '__unrouted__',
        status_class: '4xx',
      }),
    ).toBe(1);
    await app.close();
  });

  it('emits status_class="5xx" on a thrown handler', async () => {
    app = await buildApp(metrics);
    const res = await app.inject({ method: 'GET', url: '/v1/explode' });
    expect(res.statusCode).toBe(500);
    expect(
      metrics.getValue(METRIC_NAMES.httpRequestTotal, {
        method: 'GET',
        route: '/v1/explode',
        status_class: '5xx',
      }),
    ).toBe(1);
    await app.close();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    app = await buildApp(metrics);
    await app.inject({ method: 'GET', url: '/v1/ping' });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_http_request_total counter');
    expect(rendered).toMatch(
      /driftstack_http_request_total\{method="GET",route="\/v1\/ping",status_class="2xx"\} 1/,
    );
    await app.close();
  });
});
