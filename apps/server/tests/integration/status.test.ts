// V-176 — /v1/status endpoint integration tests.

import { afterEach, describe, expect, it } from 'vitest';
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
    }>();
    expect(body.overall_status).toBe('operational');
    expect(body.components).toEqual([]);
    expect(body.recent_incidents).toEqual([]);
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

  it('V-545.A — recent_incidents surfaces public incidents (up to 5, last 30d)', async () => {
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
      recent_incidents: Array<{ id: string; title: string; severity: string }>;
    }>();
    expect(body.recent_incidents).toHaveLength(1);
    expect(body.recent_incidents[0]?.title).toBe('visible');
    expect(body.recent_incidents[0]?.id).toMatch(/^inc_/);
  });
});
