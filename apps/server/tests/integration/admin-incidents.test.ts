// V-295a — integration tests for status-page incident management.
//
//   POST   /v1/admin/incidents                  — create
//   GET    /v1/admin/incidents                  — list
//   GET    /v1/admin/incidents/:id              — detail
//   POST   /v1/admin/incidents/:id/updates      — append timeline
//   POST   /v1/admin/incidents/:id/resolve      — mark resolved
//   GET    /v1/status/incidents                 — public, no-auth
//   GET    /v1/status/incidents/:id             — public detail w/ updates
//
// Each mutation writes an admin_audit_log row (V-281 dual-write).
// Public endpoint surfaces only public=true incidents.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

const headers = { 'content-type': 'application/json' };

interface IncidentResp {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  affected_components: string[];
  public: boolean;
  started_at: string;
  resolved_at: string | null;
}

interface CreateResponse {
  incident: IncidentResp;
  updates: { id: string; message: string; status: string }[];
}

describe('POST /v1/admin/incidents', () => {
  it('201 creates incident + initial update + audit row', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'API server intermittent 500s',
        description: 'Investigating high error rate on /v1/sessions/create.',
        severity: 'major',
        affected_components: ['api'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CreateResponse>();
    expect(body.incident.title).toBe('API server intermittent 500s');
    expect(body.incident.severity).toBe('major');
    expect(body.incident.status).toBe('investigating');
    expect(body.incident.public).toBe(true);
    expect(body.incident.affected_components).toEqual(['api']);
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0]?.message).toBe('Investigating high error rate on /v1/sessions/create.');

    const adminRows = fx.adminAuditRepo.getAll();
    expect(adminRows.some((r) => r.action === 'incident.created')).toBe(true);
  });

  it('400 when title is empty', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: '', description: 'x', severity: 'minor' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when severity is invalid', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'x', description: 'x', severity: 'critical' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'x', description: 'x', severity: 'minor' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('honors public=false flag (admin-only triage)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'Internal triage — possible Stripe webhook lag',
        description: 'Pre-confirmation; do not surface publicly yet.',
        severity: 'minor',
        public: false,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<CreateResponse>().incident.public).toBe(false);
  });
});

describe('GET /v1/admin/incidents', () => {
  it('returns all incidents (default scope)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'public', description: 'x', severity: 'minor' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'private', description: 'x', severity: 'minor', public: false },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/incidents',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: IncidentResp[] }>();
    expect(body.data).toHaveLength(2);
  });
});

describe('POST /v1/admin/incidents/:id/updates', () => {
  it('201 appends timeline update + bumps incident status', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'x', description: 'investigating', severity: 'major' },
    });
    const incidentId = create.json<CreateResponse>().incident.id;

    const update = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/updates`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'Cause identified — rate-limiter regression.', status: 'identified' },
    });
    expect(update.statusCode).toBe(201);

    const detail = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: auth(fx),
    });
    const body = detail.json<{ incident: IncidentResp; updates: { message: string }[] }>();
    expect(body.incident.status).toBe('identified');
    expect(body.updates).toHaveLength(2); // initial + this update
  });
});

describe('POST /v1/admin/incidents/:id/resolve', () => {
  it('200 marks resolved + sets resolved_at + writes final update', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'x', description: 'x', severity: 'major' },
    });
    const incidentId = create.json<CreateResponse>().incident.id;

    const resolve = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'Rolled back the bad deploy. Monitoring complete.' },
    });
    expect(resolve.statusCode).toBe(200);
    const body = resolve.json<{ incident: IncidentResp }>();
    expect(body.incident.status).toBe('resolved');
    expect(body.incident.resolved_at).not.toBeNull();
  });
});

describe('GET /v1/status/incidents (public, no-auth)', () => {
  it('returns only public=true incidents', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'public-x', description: 'x', severity: 'minor' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'private-y', description: 'y', severity: 'minor', public: false },
    });

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents' });
    expect(res.statusCode).toBe(200);
    // V-295a perf — cache-control 30s for CDN coalescing of concurrent
    // status-site viewers. Asserted here so a future drop of the
    // header (or change in TTL) breaks loudly.
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const body = res.json<{ data: IncidentResp[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.title).toBe('public-x');
  });

  it('limits to last 30 days by default', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'old-incident',
        description: 'x',
        severity: 'minor',
        // 60 days ago — should be excluded by the public default-since.
        started_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'recent-incident', description: 'x', severity: 'minor' },
    });

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents' });
    const body = res.json<{ data: IncidentResp[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.title).toBe('recent-incident');
  });

  it('does not require auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /v1/status/incidents/:id (V-545.A — public detail w/ timeline)', () => {
  it('returns incident + update timeline for a public incident, no auth', async () => {
    fx = await buildTestApp();
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'API slow',
        description: 'investigating',
        severity: 'minor',
      },
    });
    const created = createRes.json<CreateResponse>();
    const incidentId = created.incident.id;

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/updates`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'scope expanded to dashboard', status: 'identified' },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/incidents/${incidentId}`,
    });
    expect(res.statusCode).toBe(200);
    // V-545.A perf — cache-control 30s on the detail endpoint too.
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const body = res.json<{
      incident: IncidentResp;
      updates: { id: string; message: string; status: string }[];
    }>();
    expect(body.incident.id).toBe(incidentId);
    expect(body.incident.title).toBe('API slow');
    // initial creation already lays down 1 update; plus the 1 we posted = 2.
    expect(body.updates.length).toBeGreaterThanOrEqual(2);
    expect(body.updates.some((u) => u.message === 'scope expanded to dashboard')).toBe(true);
  });

  it('returns 404 for a private incident (no enumeration of admin-only data)', async () => {
    fx = await buildTestApp();
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'internal triage',
        description: 'admin-only',
        severity: 'minor',
        public: false,
      },
    });
    const created = createRes.json<CreateResponse>();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/incidents/${created.incident.id}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for an id that does not match the inc_<uuid> prefix shape', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/status/incidents/not-an-id',
    });
    expect(res.statusCode).toBe(400);
  });
});
