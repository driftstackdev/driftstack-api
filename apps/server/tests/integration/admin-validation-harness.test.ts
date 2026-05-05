// V-218 — integration tests for /v1/admin/validation-schedules.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface ScheduleRow {
  archetype_id: string;
  cadence_seconds: number;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
}

interface ListResponse {
  data: ScheduleRow[];
}

describe('GET /v1/admin/validation-schedules', () => {
  it('200 empty for fresh fixture', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data).toEqual([]);
  });

  it('rejects without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /v1/admin/validation-schedules', () => {
  it('200 upserts a new schedule with reasonable next_run_at', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: {
        archetype_id: 'iphone16pro_ios18_7_safari26_4',
        cadence_seconds: 3600,
        reason: 'hourly drift check',
      },
    });
    expect(res.statusCode).toBe(200);
    const sched = res.json<ScheduleRow>();
    expect(sched.archetype_id).toBe('iphone16pro_ios18_7_safari26_4');
    expect(sched.cadence_seconds).toBe(3600);
    expect(sched.enabled).toBe(true);
    expect(new Date(sched.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('400 on cadence < 60 seconds', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: {
        archetype_id: 'arch1',
        cadence_seconds: 30,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates an existing schedule on second upsert', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: { archetype_id: 'arch1', cadence_seconds: 3600 },
    });
    const second = await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: {
        archetype_id: 'arch1',
        cadence_seconds: 7200,
        enabled: false,
      },
    });
    expect(second.statusCode).toBe(200);
    const sched = second.json<ScheduleRow>();
    expect(sched.cadence_seconds).toBe(7200);
    expect(sched.enabled).toBe(false);
  });
});

describe('DELETE /v1/admin/validation-schedules/:archetype', () => {
  it('204 removes an existing schedule', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: { archetype_id: 'arch1', cadence_seconds: 3600 },
    });
    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/validation-schedules/arch1',
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
    });
    expect(list.json<ListResponse>().data).toEqual([]);
  });

  it('404 on unknown archetype', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/validation-schedules/bogus',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/admin/validation-schedules/:archetype/trigger', () => {
  it('200 returns a run_id from the recapture bridge', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/validation-schedules/iphone16pro_ios18_7_safari26_4/trigger',
      headers: auth(fx),
      payload: { reason: 'manual sanity check' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ run_id: string }>();
    expect(body.run_id).toMatch(/^run_/);
  });
});
