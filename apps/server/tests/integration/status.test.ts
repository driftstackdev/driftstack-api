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
});
