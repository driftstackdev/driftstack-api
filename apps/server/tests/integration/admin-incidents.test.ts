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

import { randomUUID } from 'node:crypto';
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

interface IncidentListResponse {
  data: IncidentResp[];
  total: number;
  open_count: number;
  has_more: boolean;
  next_cursor: string | null;
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
    const createdRow = adminRows.find((r) => r.action === 'incident.created');
    expect(createdRow).toBeDefined();
    // The audit row must carry the REAL incident id (inc_<uuid>), not the
    // 'inc_pending' placeholder — so the audit log is filterable by the
    // created incident's id (the file-header contract).
    expect(createdRow?.targetResourceId).toBe(body.incident.id);
    expect(createdRow?.targetResourceId).not.toBe('inc_pending');
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

  it('400 when a create attempts to skip the explicit resolution transition', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'Already over',
        description: 'Must be created active and then resolved with a final timeline update.',
        severity: 'minor',
        status: 'resolved',
      },
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

describe('PUT /v1/admin/incidents/:id', () => {
  it('is an atomic, same-id replayable create and rejects body drift', async () => {
    fx = await buildTestApp();
    const incidentId = `inc_${randomUUID()}`;
    const payload = {
      title: 'Idempotent operator incident',
      description: 'Created with one stable client-owned id.',
      severity: 'major',
      started_at: '2026-07-17T12:00:00.000Z',
    };

    const created = await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: { ...headers, ...auth(fx) },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ outcome: string; incident: IncidentResp }>().outcome).toBe('created');
    expect(created.json<{ incident: IncidentResp }>().incident.id).toBe(incidentId);

    const replay = await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: { ...headers, ...auth(fx) },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ outcome: string; incident: IncidentResp }>().outcome).toBe('replayed');
    expect(replay.json<{ incident: IncidentResp }>().incident.id).toBe(incidentId);

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'Resolved after the original create response was lost.' },
    });
    const replayAfterResolve = await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: { ...headers, ...auth(fx) },
      payload,
    });
    expect(replayAfterResolve.statusCode).toBe(200);
    const replayAfterResolveBody = replayAfterResolve.json<{
      outcome: string;
      incident: IncidentResp;
      updates: Array<{ status: string }>;
    }>();
    expect(replayAfterResolveBody.outcome).toBe('replayed');
    expect(replayAfterResolveBody.incident.status).toBe('resolved');
    expect(replayAfterResolveBody.updates).toHaveLength(1);
    expect(replayAfterResolveBody.updates[0]?.status).toBe('investigating');

    const mismatch = await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: { ...headers, ...auth(fx) },
      payload: { ...payload, description: 'A different request must not reuse this id.' },
    });
    expect(mismatch.statusCode).toBe(409);

    const detail = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: auth(fx),
    });
    const persisted = detail.json<CreateResponse>();
    expect(persisted.incident.description).toBe(payload.description);
    expect(persisted.updates).toHaveLength(2);
    expect(
      persisted.updates.filter((update) => update.message === payload.description),
    ).toHaveLength(1);
    expect(
      fx.adminAuditRepo
        .getAll()
        .filter((row) => row.action === 'incident.created' && row.result === 'success'),
    ).toHaveLength(1);
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
    const body = res.json<IncidentListResponse>();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.open_count).toBe(2);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('filters lifecycle state before pagination and returns a stable cursor', async () => {
    fx = await buildTestApp();
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'older-open', description: 'x', severity: 'minor' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'newer-open', description: 'x', severity: 'minor' },
    });
    const firstId = first.json<CreateResponse>().incident.id;
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${firstId}/resolve`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'resolved' },
    });

    const open = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/incidents?state=open&limit=1',
      headers: auth(fx),
    });
    expect(open.statusCode).toBe(200);
    const openBody = open.json<IncidentListResponse>();
    expect(openBody.data.map((row) => row.title)).toEqual(['newer-open']);
    expect(openBody.total).toBe(1);
    expect(openBody.open_count).toBe(1);
    expect(openBody.has_more).toBe(false);

    const futureWindow = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/incidents?state=open&since=${encodeURIComponent('2099-01-01T00:00:00.000Z')}`,
      headers: auth(fx),
    });
    const futureWindowBody = futureWindow.json<IncidentListResponse>();
    expect(futureWindowBody.data).toEqual([]);
    expect(futureWindowBody.total).toBe(0);
    expect(futureWindowBody.open_count).toBe(1);

    const all = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/incidents?state=all&limit=1',
      headers: auth(fx),
    });
    const allBody = all.json<IncidentListResponse>();
    expect(allBody.total).toBe(2);
    expect(allBody.open_count).toBe(1);
    expect(allBody.has_more).toBe(true);
    expect(allBody.next_cursor).not.toBeNull();

    const next = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/incidents?state=all&limit=1&cursor=${encodeURIComponent(
        allBody.next_cursor ?? '',
      )}`,
      headers: auth(fx),
    });
    const nextBody = next.json<IncidentListResponse>();
    expect(nextBody.data).toHaveLength(1);
    expect(nextBody.data[0]?.id).not.toBe(allBody.data[0]?.id);
    expect(nextBody.total).toBe(2);
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

  it('keeps resolved_at in lockstep with status set via /updates (invariant, not just /resolve+/reopen)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'x', description: 'x', severity: 'major' },
    });
    const incidentId = create.json<CreateResponse>().incident.id;

    const detailOf = async (): Promise<IncidentResp> => {
      const d = await fx.app.inject({
        method: 'GET',
        url: `/v1/admin/incidents/${incidentId}`,
        headers: auth(fx),
      });
      return d.json<{ incident: IncidentResp }>().incident;
    };
    const post = (status: string): Promise<{ statusCode: number }> =>
      fx.app.inject({
        method: 'POST',
        url: `/v1/admin/incidents/${incidentId}/updates`,
        headers: { ...headers, ...auth(fx) },
        payload: { message: `now ${status}`, status },
      });

    // Resolve via /updates (NOT /resolve) → resolved_at must be stamped.
    expect((await post('resolved')).statusCode).toBe(201);
    let inc = await detailOf();
    expect(inc.status).toBe('resolved');
    expect(inc.resolved_at).not.toBeNull();

    // Move back to a non-resolved status via /updates → resolved_at must clear
    // (no stale resolution timestamp on an active incident).
    expect((await post('monitoring')).statusCode).toBe(201);
    inc = await detailOf();
    expect(inc.status).toBe('monitoring');
    expect(inc.resolved_at).toBeNull();
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

  it('keeps all-time open truth while windowing resolved history', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'old-open',
        description: 'x',
        severity: 'minor',
        // Open incidents are never hidden by the resolved-history window.
        started_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const oldResolved = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: {
        title: 'old-resolved',
        description: 'x',
        severity: 'minor',
        started_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${oldResolved.json<CreateResponse>().incident.id}/resolve`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'resolved long ago' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'recent-incident', description: 'x', severity: 'minor' },
    });

    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents' });
    const body = res.json<{
      data: IncidentResp[];
      total: number;
      open_count: number;
      open_outage_count: number;
      truncated: boolean;
    }>();
    expect(body.data.map((row) => row.title)).toEqual(['recent-incident', 'old-open']);
    expect(body.total).toBe(2);
    expect(body.open_count).toBe(2);
    expect(body.open_outage_count).toBe(0);
    expect(body.truncated).toBe(false);

    const history = await fx.app.inject({
      method: 'GET',
      url: '/v1/status/incidents?window=90d',
    });
    expect(history.json<{ data: IncidentResp[] }>().data.map((row) => row.title)).toEqual([
      'recent-incident',
      'old-open',
      'old-resolved',
    ]);
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

  it('public detail omits internal-only fields (no admin-ids / auto-probe-target leak)', async () => {
    // publicIncident() is an explicit allow-list mapper; this guards against a
    // future refactor (e.g. a `...row` spread) silently leaking the internal
    // auto-probe target or the creating-admin ids onto the unauthenticated
    // status page. Sibling to the cache-control assertions above — a field
    // leak on this no-auth surface must break loudly, not just a header change.
    fx = await buildTestApp();
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'leak-guard', description: 'x', severity: 'minor' },
    });
    const incidentId = createRes.json<CreateResponse>().incident.id;

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/incidents/${incidentId}`,
    });
    expect(res.statusCode).toBe(200);
    const { incident } = res.json<{ incident: Record<string, unknown> }>();

    // Exact public contract — any extra key (a leaked internal field) fails.
    expect(Object.keys(incident).sort()).toEqual(
      [
        'affected_components',
        'created_at',
        'description',
        'id',
        'public',
        'resolved_at',
        'severity',
        'started_at',
        'status',
        'title',
        'updated_at',
      ].sort(),
    );
    // Explicit intent: the sensitive internal columns must never surface, in
    // either casing (camelCase row field or snake_case response form).
    for (const key of [
      'autoProbeTarget',
      'auto_probe_target',
      'createdByAdminId',
      'created_by_admin_id',
      'createdByAdminKeyId',
      'created_by_admin_key_id',
    ]) {
      expect(incident).not.toHaveProperty(key);
    }
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
