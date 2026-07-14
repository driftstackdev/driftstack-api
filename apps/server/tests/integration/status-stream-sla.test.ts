// V-295e — SSE event-bus + SLA reporting integration tests.
//
// SSE wire testing is doable but expensive (would need a streaming
// fetch client). The bus is tested in-process via direct subscribe.
// SLA endpoint is HTTP-tested with seeded probe history.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { IncidentEvent } from '../../src/services/incident-event-bus.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

describe('IncidentEventBus — published on lifecycle', () => {
  it('emits incident.created when public incident is posted', async () => {
    fx = await buildTestApp();
    const events: IncidentEvent[] = [];
    const unsubscribe = fx.incidentEventBus.subscribe((e) => events.push(e));

    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'API 5xx', description: 'd', severity: 'major' },
    });
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('incident.created');
    expect(events[0]!.incident.title).toBe('API 5xx');
    expect(events[0]!.incident.id).toMatch(/^inc_/);
    expect(events[0]!.update.id).toMatch(/^incu_/);
  });

  it('does NOT emit on private incidents', async () => {
    fx = await buildTestApp();
    const events: IncidentEvent[] = [];
    const unsubscribe = fx.incidentEventBus.subscribe((e) => events.push(e));

    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {
        title: 'Internal',
        description: 'd',
        severity: 'minor',
        public: false,
      },
    });
    unsubscribe();
    expect(events).toHaveLength(0);
  });

  it('emits incident.resolved when public incident is resolved', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'x', description: 'd', severity: 'major' },
    });
    const incidentId = create.json<{ incident: { id: string } }>().incident.id;

    const events: IncidentEvent[] = [];
    const unsubscribe = fx.incidentEventBus.subscribe((e) => events.push(e));

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'Done.' },
    });
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('incident.resolved');
  });

  it('multiple subscribers all receive each event', async () => {
    fx = await buildTestApp();
    const eventsA: IncidentEvent[] = [];
    const eventsB: IncidentEvent[] = [];
    const unsubA = fx.incidentEventBus.subscribe((e) => eventsA.push(e));
    const unsubB = fx.incidentEventBus.subscribe((e) => eventsB.push(e));

    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'x', description: 'd', severity: 'minor' },
    });
    unsubA();
    unsubB();

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
  });

  it('one listener throwing does not block others', async () => {
    fx = await buildTestApp();
    const eventsB: IncidentEvent[] = [];
    fx.incidentEventBus.subscribe(() => {
      throw new Error('listener boom');
    });
    fx.incidentEventBus.subscribe((e) => eventsB.push(e));

    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'x', description: 'd', severity: 'minor' },
    });

    expect(eventsB).toHaveLength(1);
  });
});

describe('GET /v1/status/sla', () => {
  it('200 returns 100% uptime when all probes ok', async () => {
    fx = await buildTestApp();
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await fx.probesRepo.recordProbe({
        target: 'api',
        ok: true,
        latencyMs: 5,
        httpStatus: 200,
        errorMessage: null,
        probedAt: new Date(now.getTime() - i * 60_000),
      });
    }

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        target: string;
        uptimePct: number;
        totalProbes: number;
        lastProbeAt: string;
        lastFailureAt: string | null;
      }[];
    }>();
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.target).toBe('api');
    expect(body.data[0]!.uptimePct).toBe(100);
    expect(body.data[0]!.totalProbes).toBe(10);
    expect(body.data[0]!.lastFailureAt).toBeNull();
  });

  it('returns proportional uptime when some probes failed', async () => {
    fx = await buildTestApp();
    const now = new Date();
    // 8 ok + 2 fail = 80% uptime
    for (let i = 0; i < 8; i++) {
      await fx.probesRepo.recordProbe({
        target: 'api',
        ok: true,
        latencyMs: 5,
        httpStatus: 200,
        errorMessage: null,
        probedAt: new Date(now.getTime() - i * 60_000),
      });
    }
    for (let i = 0; i < 2; i++) {
      await fx.probesRepo.recordProbe({
        target: 'api',
        ok: false,
        latencyMs: 5,
        httpStatus: 500,
        errorMessage: 'HTTP 500',
        probedAt: new Date(now.getTime() - (8 + i) * 60_000),
      });
    }

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
    const body = res.json<{ data: { uptimePct: number; lastFailureAt: string | null }[] }>();
    expect(body.data[0]!.uptimePct).toBe(80);
    expect(body.data[0]!.lastFailureAt).not.toBeNull();
  });

  it('reports per-target separately', async () => {
    fx = await buildTestApp();
    const now = new Date();
    await fx.probesRepo.recordProbe({
      target: 'api',
      ok: true,
      latencyMs: 5,
      httpStatus: 200,
      errorMessage: null,
      probedAt: now,
    });
    await fx.probesRepo.recordProbe({
      target: 'gui-distribution',
      ok: false,
      latencyMs: 5,
      httpStatus: 500,
      errorMessage: 'HTTP 500',
      probedAt: now,
    });

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
    const body = res.json<{ data: { target: string; uptimePct: number }[] }>();
    expect(body.data).toHaveLength(2);
    const byTarget = Object.fromEntries(body.data.map((d) => [d.target, d.uptimePct]));
    expect(byTarget['api']).toBe(100);
    expect(byTarget['gui-distribution']).toBe(0);
  });

  it('excludes probes outside the 30d window', async () => {
    fx = await buildTestApp();
    const now = new Date();
    // 60d ago — out of window.
    await fx.probesRepo.recordProbe({
      target: 'api',
      ok: false,
      latencyMs: 5,
      httpStatus: 500,
      errorMessage: 'HTTP 500',
      probedAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
    });
    // Recent — in window.
    await fx.probesRepo.recordProbe({
      target: 'api',
      ok: true,
      latencyMs: 5,
      httpStatus: 200,
      errorMessage: null,
      probedAt: now,
    });

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
    const body = res.json<{ data: { totalProbes: number; uptimePct: number }[] }>();
    expect(body.data[0]!.totalProbes).toBe(1);
    expect(body.data[0]!.uptimePct).toBe(100);
  });

  it('returns empty data when no probes recorded', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it('allows 60 direct requests per IP and rejects request 61 before running the aggregate', async () => {
    fx = await buildTestApp();

    for (let i = 0; i < 60; i++) {
      const allowed = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
      expect(allowed.statusCode).toBe(200);
    }

    const denied = await fx.app.inject({ method: 'GET', url: '/v1/status/sla' });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBe('1');
    expect(denied.headers['x-ratelimit-bucket']).toBe('status_sla');
  });
});

describe('GET /v1/status/stream capacity', () => {
  it('rejects the 11th live connection from one IP and releases capacity on disconnect', async () => {
    fx = await buildTestApp();
    const address = await fx.app.listen({ host: '127.0.0.1', port: 0 });
    const controllers: AbortController[] = [];
    const streamResponses: Response[] = [];

    try {
      for (let i = 0; i < 10; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${address}/v1/status/stream`, {
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        streamResponses.push(response);
      }

      const denied = await fetch(`${address}/v1/status/stream`, {
        headers: { connection: 'close' },
      });
      expect(denied.status).toBe(503);
      expect(denied.headers.get('retry-after')).toBe('30');
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      const problem = (await denied.json()) as Record<string, unknown>;
      expect(problem).toMatchObject({
        type: 'https://errors.driftstack.dev/feature-unavailable',
        title: 'Feature unavailable',
        status: 503,
        detail: 'Status stream at capacity; retry shortly.',
      });
      expect(problem['instance']).toBe(denied.headers.get('x-request-id'));

      controllers.shift()!.abort();

      let replacementAccepted = false;
      for (let attempt = 0; attempt < 20 && !replacementAccepted; attempt++) {
        const controller = new AbortController();
        const replacement = await fetch(`${address}/v1/status/stream`, {
          headers: { connection: 'close' },
          signal: controller.signal,
        });
        if (replacement.status === 200) {
          controllers.push(controller);
          streamResponses.push(replacement);
          replacementAccepted = true;
        } else {
          controller.abort();
          await replacement.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(replacementAccepted).toBe(true);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(
        streamResponses.map(async (response) => {
          await response.body?.cancel();
        }),
      );
    }
  });
});
