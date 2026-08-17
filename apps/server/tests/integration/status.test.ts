// V-176 — /v1/status endpoint integration tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerStatusRoutes } from '../../src/routes/status.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import type { ReadinessCheck } from '../../src/lib/app.js';
import type { IncidentsService } from '../../src/services/incidents.js';
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

  // ── Degradation paths ───────────────────────────────────────────────────
  // These need an incidents service that FAILS and readiness checks that
  // misbehave, so the routes are registered directly rather than through the
  // fully-wired fixture. The arm above covers storage that was never wired;
  // storage that is wired and THEN throws is a different branch, and the one
  // the handler's own comment is about: "never convert an incident storage
  // failure into an operational/all-clear claim."

  interface StatusBody {
    overall_status: string;
    components: Array<{ name: string; status: string }>;
    open_incidents: number | null;
    incident_data_complete: boolean;
  }

  /** /v1/status only ever calls publicFeed, so that is all the stub provides. */
  async function getStatus(opts: {
    readinessChecks?: ReadinessCheck[];
    publicFeed?: () => Promise<{ rows: []; openCount: number; openOutageCount: number }>;
  }): Promise<{ statusCode: number; body: StatusBody }> {
    const app = Fastify();
    registerStatusRoutes(app, {
      readinessChecks: opts.readinessChecks ?? [],
      rateLimitStore: new MemoryRateLimitStore(),
      ...(opts.publicFeed
        ? { incidentsService: { publicFeed: opts.publicFeed } as unknown as IncidentsService }
        : {}),
    });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/status' });
      return { statusCode: res.statusCode, body: res.json<StatusBody>() };
    } finally {
      await app.close();
    }
  }

  it('CRITICAL incident storage that FAILS never reports an all-clear', async () => {
    const { statusCode, body } = await getStatus({
      publicFeed: () => Promise.reject(new Error('incident storage unavailable')),
    });
    // Still answers — a status page that 500s during an incident is useless.
    expect(statusCode, 'the endpoint went down with its incident storage').toBe(200);
    expect(
      body.overall_status,
      'incident storage failed and the status page announced everything was operational — the one ' +
        'claim it must never make on data it does not have',
    ).toBe('degraded');
    expect(
      body.incident_data_complete,
      'the response claimed complete incident data after the read threw',
    ).toBe(false);
    expect(
      body.open_incidents,
      'an unknown open-incident count was reported as a number',
    ).toBeNull();
  });

  it('CRITICAL open incidents degrade the aggregate even when every component is up', async () => {
    const { body } = await getStatus({
      publicFeed: () => Promise.resolve({ rows: [], openCount: 2, openOutageCount: 0 }),
    });
    expect(
      body.overall_status,
      'two incidents were open and the status page still read operational',
    ).toBe('degraded');
    expect(body.open_incidents).toBe(2);
    expect(body.incident_data_complete).toBe(true);
  });

  it('CRITICAL a readiness check that throws marks that component degraded', async () => {
    const { body } = await getStatus({
      readinessChecks: [
        { name: 'postgres', fn: () => Promise.reject(new Error('down')), timeoutMs: 50 },
        { name: 'redis', fn: () => Promise.resolve('ok'), timeoutMs: 50 },
      ],
      publicFeed: () => Promise.resolve({ rows: [], openCount: 0, openOutageCount: 0 }),
    });
    expect(
      body.components.find((c) => c.name === 'postgres')?.status,
      'a failing dependency probe was reported as operational',
    ).toBe('degraded');
    expect(
      body.components.find((c) => c.name === 'redis')?.status,
      'one failing probe dragged down a healthy one — each component is reported independently',
    ).toBe('operational');
    expect(body.overall_status, 'a degraded component did not degrade the aggregate').toBe(
      'degraded',
    );
  });

  it('CRITICAL a completed status request leaves no timer of its own behind', async () => {
    // The timeout race arms a timer per readiness check. When the probe wins,
    // that timer is the loser and must be cancelled — otherwise every request
    // to this public, monitor-polled endpoint leaves one live timer per check
    // for the full 1500ms, keeping the event loop awake and delaying shutdown.
    // Measured as a DELTA around the request so Fastify's own timers (and any
    // the runtime keeps) are excluded rather than assumed absent.
    // Measured as the DIFFERENCE between an app with checks and one without,
    // rather than as an absolute count: the request path arms a timer of its
    // own regardless (light-my-request), and that one is not this code's to
    // clear. Only the per-check contribution is under test.
    async function timersLeftByOneRequest(checks: ReadinessCheck[]): Promise<number> {
      const app = Fastify();
      registerStatusRoutes(app, {
        readinessChecks: checks,
        rateLimitStore: new MemoryRateLimitStore(),
      });
      await app.ready();
      try {
        const before = vi.getTimerCount();
        const res = await app.inject({ method: 'GET', url: '/v1/status' });
        expect(res.statusCode).toBe(200);
        return vi.getTimerCount() - before;
      } finally {
        await app.close();
      }
    }

    vi.useFakeTimers();
    try {
      const baseline = await timersLeftByOneRequest([]);
      const withChecks = await timersLeftByOneRequest([
        { name: 'postgres', fn: () => Promise.resolve('ok') },
        { name: 'redis', fn: () => Promise.resolve('ok') },
      ]);
      expect(
        withChecks - baseline,
        'each readiness check left its timeout timer pending after the probe had already answered — ' +
          'one live timer per check per request, each for the full COMPONENT_TIMEOUT_MS',
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a readiness check that hangs is degraded rather than hanging the endpoint', async () => {
    const { statusCode, body } = await getStatus({
      // Never settles: only the timeout in the race can resolve this.
      readinessChecks: [{ name: 'r2', fn: () => new Promise(() => {}), timeoutMs: 25 }],
      publicFeed: () => Promise.resolve({ rows: [], openCount: 0, openOutageCount: 0 }),
    });
    expect(statusCode).toBe(200);
    expect(
      body.components.find((c) => c.name === 'r2')?.status,
      'a probe that never returned was reported operational — without the timeout race the whole ' +
        'status request hangs on one wedged dependency',
    ).toBe('degraded');
  });
});
