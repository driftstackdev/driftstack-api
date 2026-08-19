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

  it('CRITICAL reopening an incident that is not resolved is refused, and the incident is untouched. This route guard is the ONLY control: incidentsService.reopen delegates straight to repo.reopen, whose UPDATE carries no status predicate — `.set({ status: investigating, resolvedAt: null }).where(eq(incidents.id, id))` reopens whatever id it is given. Coverage showed the refusal executed by no test while the body parse seven lines above it is executed, so the handler reads as exercised.', async () => {
    fx = await buildTestApp();
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'Live one', description: 'still going', severity: 'minor' },
    });
    expect(created.statusCode, 'the incident was created active').toBe(201);
    const incidentId = created.json<{ incident: { id: string; status: string } }>().incident.id;

    const before = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: { ...headers, ...auth(fx) },
    });
    const timelineBefore = before.json<{ updates: unknown[] }>().updates.length;

    const reopen = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/reopen`,
      headers: { ...headers, ...auth(fx) },
      payload: { message: 'clicked the wrong button' },
    });
    expect(reopen.statusCode, 'an active incident cannot be reopened').toBe(400);
    expect(
      JSON.stringify(reopen.json()),
      'the refusal names the status it refused, so the operator can see what they hit',
    ).toContain('only resolved incidents can be reopened');

    // The effect half: status is not the property that matters on its own — a
    // handler that churned the row and only then refused would satisfy the
    // assertions above and still have posted a customer-visible timeline entry.
    const after = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/incidents/${incidentId}`,
      headers: { ...headers, ...auth(fx) },
    });
    const body = after.json<{ incident: { status: string }; updates: unknown[] }>();
    expect(body.incident.status, 'the incident kept its status').not.toBe('resolved');
    expect(
      body.updates.length,
      'and the refused reopen posted no timeline entry — a created incident already carries one, so ' +
        'this compares against the count taken before rather than assuming it starts empty',
    ).toBe(timelineBefore);
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
  it('CRITICAL a malformed query on the PUBLIC feed is refused as a validation failure. Coverage showed this refusal executed by no test while the cursor/state rejection two lines below it is executed — so the handler reads as exercised, and removing the parse would drop an anonymous caller onto whatever the unvalidated values do next. This endpoint takes no credential, so its query string is the only thing a stranger controls.', async () => {
    fx = await buildTestApp();
    for (const [label, qs] of [
      ['a window outside the closed enum', '?window=bogus'],
      ['a limit past the bound', '?limit=999'],
      ['a limit below the floor', '?limit=0'],
      ['a non-timestamp since', '?since=not-a-date'],
    ] as const) {
      const res = await fx.app.inject({ method: 'GET', url: `/v1/status/incidents${qs}` });
      expect(res.statusCode, `${label} is refused`).toBe(400);
      expect(
        res.json<{ type: string }>().type,
        `${label} is a validation failure, not the cursor/state rejection that happens to be covered`,
      ).toContain('validation-failed');
    }
  });

  it('CRITICAL a well-formed query is still served, so the arm above is refusing malformed input rather than everything. Without this a parse that rejected every query would satisfy it.', async () => {
    fx = await buildTestApp();
    const ok = await fx.app.inject({
      method: 'GET',
      url: '/v1/status/incidents?window=90d&limit=5',
    });
    expect(ok.statusCode, 'a valid window and limit are accepted').toBe(200);
  });

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

// ─── one schema, two feeds, different allowed parameters ────────────────────
//
// Added 2026-08-15. `ListIncidentsQuerySchema` serves BOTH `/v1/admin/incidents`
// and the public `/v1/status/incidents`, so it accepts the union of what either
// feed understands: `window` for the public one, `state` and `cursor` for the
// admin one. Nothing in the schema can express "this half belongs to that
// endpoint" — the two route-level refusals are the whole enforcement, and
// neither had ever executed (assessment item 5f population).
//
// What their absence costs is not an error, which is what makes it easy to miss:
// an operator passing `window` to the admin feed would have it silently ignored
// and read the resulting page as filtered when it is not. A parameter that
// appears to work and does nothing is worse than one that is rejected.
//
// Each refusal is paired with the SAME parameter succeeding on the feed that
// owns it. Without that pair the arms would also pass against a build where
// `window`, `state` and `cursor` simply did not work anywhere.
//
// MUTATION-PROVED against routes/admin-incidents.ts — control 26/26 here, 16/16
// on routes-admin-incidents-content-parity:
//
//                                                    here    parity pin
//   the admin feed stops refusing `window`          1 red      GREEN
//   the public feed stops refusing state/cursor     2 red      GREEN
//   the public feed refuses cursor but not state    1 red      GREEN
//   a malformed cursor becomes a 500                1 red      GREEN
//   idempotent create no longer needs started_at    1 red      GREEN
//
// The pin is green on all five, which is the same result this surface has
// produced everywhere it has been measured: the text is intact and the behaviour
// is not. The third mutation is the reason `state` and `cursor` get separate
// arms rather than one — the refusal is a single `||`, and dropping either side
// leaves the other still refusing, so a combined arm would pass at half strength.

describe('incident feed parameters stay on the feed that owns them', () => {
  it('CRITICAL the admin feed REFUSES `window`, which belongs to the public feed. Both feeds parse the same schema, so nothing but this check stops an operator from passing a window that is silently dropped — and reading an unfiltered page as if it were filtered.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/incidents?window=30d',
      headers: { ...headers, ...auth(fx) },
    });
    expect(res.statusCode, 'refused rather than silently ignored').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/public incident feed/i);
  });

  it('CRITICAL the public feed ACCEPTS `window` — the arm above is about scope, not about the parameter being broken. Asserted so a build where `window` stopped working everywhere could not pass the refusal arm and look correct.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents?window=30d' });
    expect(res.statusCode, 'window is valid on the feed that owns it').toBe(200);
  });

  it('CRITICAL the public feed REFUSES `state`. Lifecycle state is an operator concept; letting it through would hand an anonymous caller a filter over incident triage states that the public page never exposes.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents?state=open' });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/public status feed/i);
  });

  it('CRITICAL the public feed REFUSES `cursor`. The public feed is a windowed view, not a keyset walk; accepting a cursor would let an anonymous caller page backwards past the window the feed is supposed to bound.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status/incidents?cursor=abc' });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/public status feed/i);
  });

  it('CRITICAL the admin feed ACCEPTS `state`, so the refusal above is a scope rule rather than a broken parameter.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/incidents?state=open',
      headers: { ...headers, ...auth(fx) },
    });
    expect(res.statusCode, 'state is valid on the feed that owns it').toBe(200);
  });

  it('CRITICAL a malformed pagination cursor is a 400, not a 500. The cursor is customer-supplied base64 that is decoded, JSON-parsed and round-trip checked against its own ISO timestamp; every one of those can fail on a hand-edited value, and without the wrapper an operator pasting a truncated cursor gets a server error and an alert instead of a message telling them the cursor is bad.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/incidents?cursor=not-a-valid-cursor',
      headers: { ...headers, ...auth(fx) },
    });
    expect(res.statusCode, 'a client error, not a server fault').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/invalid incident cursor/i);
  });

  it("CRITICAL idempotent create by id REFUSES a body with no `started_at`. The replayable PUT is keyed on the caller supplying the incident's own start time; without it a retry could mint a row whose start is the moment of the retry rather than of the incident, which is exactly the field an incident timeline is ordered and measured by.", async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/incidents/inc_${randomUUID()}`,
      headers: { ...headers, ...auth(fx) },
      payload: { title: 'no-start', description: 'x', severity: 'minor' },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/started_at is required/i);
  });
});
