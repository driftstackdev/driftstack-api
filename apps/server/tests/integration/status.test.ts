// V-176 — /v1/status endpoint integration tests.

import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerStatusRoutes } from '../../src/routes/status.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('GET /v1/status', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns operational status with no readiness checks wired', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      overall_status: string;
      components: Array<{ name: string; status: string; last_checked_at: string }>;
      recent_incidents: unknown[];
      open_incidents: number;
      incident_data_complete: boolean;
    }>();
    expect(body.overall_status).toBe('operational');
    expect(body.components).toEqual([]);
    expect(body.recent_incidents).toEqual([]);
    expect(body.open_incidents).toBe(0);
    expect(body.incident_data_complete).toBe(true);
  });

  it('public — no auth required', async () => {
    fx = await buildTestApp();
    // No Authorization header.
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
  });

  it('sets Cache-Control: public, max-age=30', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  it('fails closed when incident storage was not wired', async () => {
    const app = Fastify();
    registerStatusRoutes(app, { readinessChecks: [], rateLimitStore: new MemoryRateLimitStore() });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        overall_status: 'degraded',
        open_incidents: null,
        incident_data_complete: false,
      });
    } finally {
      await app.close();
    }
  });

  it('V-545.A — recent_incidents surfaces public incidents and open truth', async () => {
    fx = await buildTestApp();
    // Seed a public incident + a private one. Only the public one
    // should appear in recent_incidents.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { title: 'visible', description: 'public', severity: 'minor' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { title: 'hidden', description: 'admin', severity: 'minor', public: false },
    });
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      overall_status: string;
      recent_incidents: Array<{ id: string; title: string; severity: string }>;
      open_incidents: number;
      incident_data_complete: boolean;
    }>();
    expect(body.recent_incidents).toHaveLength(1);
    expect(body.recent_incidents[0]?.title).toBe('visible');
    expect(body.recent_incidents[0]?.id).toMatch(/^inc_/);
    expect(body.open_incidents).toBe(1);
    expect(body.incident_data_complete).toBe(true);
    expect(body.overall_status).toBe('degraded');
  });

  it('an all-time open outage makes the aggregate status major_outage', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Long-running outage',
        description: 'Still open beyond the recent-history window.',
        severity: 'outage',
        started_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ overall_status: string; open_incidents: number }>();
    expect(body.overall_status).toBe('major_outage');
    expect(body.open_incidents).toBe(1);
  });
});
