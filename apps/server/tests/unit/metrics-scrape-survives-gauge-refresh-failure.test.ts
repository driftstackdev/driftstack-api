// A scrape must survive a failing gauge refresh.
//
// `/metrics` optionally refreshes gauges before rendering. That refresh reads
// live state (queue depths, active sessions) and can fail on its own, so it is
// wrapped: the scrape then serves counters only. Nothing proved that. Making
// the catch rethrow leaves all 150 metrics tests green.
//
// The consequence is the kind that hides other consequences: a 500 here makes
// Prometheus mark the instance DOWN, so every alert that would have fired on
// the underlying problem goes blind at the same moment.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMetricsRoutes } from '../../src/routes/metrics.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MetricsRegistry } from '../../src/services/metrics-registry.js';

const TOKEN = 'metrics-scrape-token-for-the-refresh-arms';

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

async function build(refreshGauges?: () => Promise<void>): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  registerErrorHandler(instance);
  const registry = new MetricsRegistry();
  registry.registerCounter('ds_test_total', 'a counter that must survive a failed refresh');
  registry.inc('ds_test_total');
  registerMetricsRoutes(instance, {
    registry,
    scrapeToken: TOKEN,
    ...(refreshGauges === undefined ? {} : { refreshGauges }),
  });
  await instance.ready();
  return instance;
}

const scrape = (instance: FastifyInstance) =>
  instance.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${TOKEN}` },
  });

describe('metrics scrape survives a failing gauge refresh', () => {
  it('CRITICAL a throwing refreshGauges still serves the counters with 200', async () => {
    const refreshGauges = vi.fn().mockRejectedValue(new Error('gauge source unavailable'));
    app = await build(refreshGauges);

    const res = await scrape(app);

    expect(
      refreshGauges,
      'the refresh must actually be attempted, or this proves nothing about the swallow',
    ).toHaveBeenCalledTimes(1);
    expect(res.statusCode, 'a 500 here makes Prometheus mark the instance down').toBe(200);
    expect(res.body, 'the counters are still served').toContain('ds_test_total');
  });

  it('a successful refresh is awaited before rendering (positive control)', async () => {
    // Without this, the arm above would pass against a route that stopped
    // calling refreshGauges at all — which is a different regression with the
    // same green.
    const order: string[] = [];
    const refreshGauges = vi.fn(async () => {
      order.push('refresh');
      await Promise.resolve();
    });
    app = await build(refreshGauges);

    const res = await scrape(app);
    order.push('render');

    expect(res.statusCode).toBe(200);
    expect(order).toEqual(['refresh', 'render']);
  });
});
