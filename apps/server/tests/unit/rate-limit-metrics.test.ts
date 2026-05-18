// Arc 7 obs.5 — `driftstack_rate_limit_total{bucket,outcome}`
// counter emitted by the rate-limit Fastify plugin. Tests both
// outcomes (allowed | exceeded) against a real Fastify instance
// with a memory-backed rate-limit store, so the test exercises
// the same code path that runs in production.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import rateLimitPlugin from '../../src/middleware/rate-limit.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

// The rate-limit plugin declares `dependencies: ['auth']` — satisfy
// that with a tiny stub so we can register it directly in unit tests.
const stubAuthPlugin = fp(
  (_app, _opts, done) => {
    done();
  },
  { name: 'auth' },
);

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(
    METRIC_NAMES.rateLimitTotal,
    'Rate-limit consume counter, labelled by bucket + outcome (allowed | exceeded).',
    ['bucket', 'outcome'],
  );
  return m;
}

async function buildApp(args: { metrics?: MetricsRegistry; capacity: number }) {
  const app = Fastify();
  // Stub auth — the plugin reads `request.account`.
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: 'acc_obs5', tier: 'starter' },
      apiKey: { id: 'key_obs5', scopes: ['read', 'write'] },
      rateLimitOverrides: {
        global: {
          capacity: args.capacity,
          refillPerSecond: 0,
          expiresAt: new Date(Date.now() + 60_000),
        },
      },
    };
    done();
  });
  await app.register(stubAuthPlugin);
  await app.register(rateLimitPlugin, {
    store: new MemoryRateLimitStore(),
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  app.get('/test', { preHandler: [app.rateLimit('global')] }, () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('Arc 7 obs.5 — rate_limit_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('outcome="allowed" on a permitted request', async () => {
    app = await buildApp({ metrics, capacity: 10 });
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(
      metrics.getValue(METRIC_NAMES.rateLimitTotal, { bucket: 'global', outcome: 'allowed' }),
    ).toBe(1);
    expect(
      metrics.getValue(METRIC_NAMES.rateLimitTotal, { bucket: 'global', outcome: 'exceeded' }),
    ).toBe(0);
    await app.close();
  });

  it('outcome="exceeded" when the bucket is drained', async () => {
    app = await buildApp({ metrics, capacity: 1 });
    // First request — allowed.
    const ok = await app.inject({ method: 'GET', url: '/test' });
    expect(ok.statusCode).toBe(200);
    // Second request — bucket empty, no refill → 429.
    const limited = await app.inject({ method: 'GET', url: '/test' });
    expect(limited.statusCode).toBe(429);
    expect(
      metrics.getValue(METRIC_NAMES.rateLimitTotal, { bucket: 'global', outcome: 'allowed' }),
    ).toBe(1);
    expect(
      metrics.getValue(METRIC_NAMES.rateLimitTotal, { bucket: 'global', outcome: 'exceeded' }),
    ).toBe(1);
    await app.close();
  });

  it('separate buckets accumulate independently', async () => {
    app = Fastify();
    app.decorateRequest('account', null);
    app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
      (req as { account: unknown }).account = {
        account: { id: 'acc_obs5', tier: 'starter' },
        apiKey: { id: 'key_obs5', scopes: ['read', 'write'] },
        rateLimitOverrides: {
          global: {
            capacity: 10,
            refillPerSecond: 0,
            expiresAt: new Date(Date.now() + 60_000),
          },
          'sessions:create': {
            capacity: 10,
            refillPerSecond: 0,
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      };
      done();
    });
    await app.register(stubAuthPlugin);
    await app.register(rateLimitPlugin, { store: new MemoryRateLimitStore(), metrics });
    app.get('/global', { preHandler: [app.rateLimit('global')] }, () => ({ ok: true }));
    app.get('/sessions', { preHandler: [app.rateLimit('sessions:create')] }, () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: 'GET', url: '/global' });
    await app.inject({ method: 'GET', url: '/sessions' });
    await app.inject({ method: 'GET', url: '/sessions' });
    expect(
      metrics.getValue(METRIC_NAMES.rateLimitTotal, { bucket: 'global', outcome: 'allowed' }),
    ).toBe(1);
    expect(
      metrics.getValue(METRIC_NAMES.rateLimitTotal, {
        bucket: 'sessions:create',
        outcome: 'allowed',
      }),
    ).toBe(2);
    await app.close();
  });

  it('omitting metrics is a silent no-op (does not throw)', async () => {
    app = await buildApp({ capacity: 5 });
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    app = await buildApp({ metrics, capacity: 10 });
    await app.inject({ method: 'GET', url: '/test' });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_rate_limit_total counter');
    expect(rendered).toMatch(/driftstack_rate_limit_total\{bucket="global",outcome="allowed"\} 1/);
    await app.close();
  });
});
