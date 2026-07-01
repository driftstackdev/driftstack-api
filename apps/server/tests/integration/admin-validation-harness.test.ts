// V-218 — integration tests for /v1/admin/validation-schedules.

import { afterEach, describe, expect, it, vi } from 'vitest';
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

  // D-025 audit-gap fix — upsert had zero audit wiring; these prove the
  // new validation_schedule.upserted audit row on both the success and
  // failure path.
  it('D-025 writes a validation_schedule.upserted audit row on success', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: {
        archetype_id: 'arch_audit_ok',
        cadence_seconds: 3600,
        reason: 'hourly drift check',
      },
    });
    expect(res.statusCode).toBe(200);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('validation_schedule.upserted');
    expect(all[0]?.adminAccountId).toBe(fx.accountId);
    expect(all[0]?.adminKeyId).toBe(fx.apiKeyId);
    expect(all[0]?.targetResourceId).toBe('arch_audit_ok');
    expect(all[0]?.result).toBe('success');
    expect(all[0]?.inputPayload).toEqual({
      cadence_seconds: 3600,
      enabled: true,
      reason: 'hourly drift check',
    });
  });

  it('D-025 writes a validation_schedule.upserted audit row with an error: result when the repo throws', async () => {
    fx = await buildTestApp();
    vi.spyOn(fx.validationSchedulesRepo, 'upsert').mockRejectedValueOnce(new Error('boom'));
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: { archetype_id: 'arch_audit_fail', cadence_seconds: 3600 },
    });
    expect(res.statusCode).toBe(500);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('validation_schedule.upserted');
    expect(all[0]?.targetResourceId).toBe('arch_audit_fail');
    expect(all[0]?.result).toMatch(/^error:/);
  });

  it('rejects without admin scope, writing no audit row (preHandler rejection, before the handler runs)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: { archetype_id: 'arch_no_scope', cadence_seconds: 3600 },
    });
    expect(res.statusCode).toBe(403);
    expect(fx.adminAuditRepo.getAll()).toHaveLength(0);
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

  // D-025 audit-gap fix — remove had zero audit wiring; these prove the
  // new validation_schedule.removed audit row on both the success and
  // 404-not-found path.
  it('D-025 writes a validation_schedule.removed audit row on success', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/admin/validation-schedules',
      headers: auth(fx),
      payload: { archetype_id: 'arch_del_ok', cadence_seconds: 3600 },
    });
    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/validation-schedules/arch_del_ok',
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);
    // 2 rows: the upsert above + this delete.
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(2);
    const removeRow = all.find((r) => r.action === 'validation_schedule.removed');
    expect(removeRow?.adminAccountId).toBe(fx.accountId);
    expect(removeRow?.adminKeyId).toBe(fx.apiKeyId);
    expect(removeRow?.targetResourceId).toBe('arch_del_ok');
    expect(removeRow?.result).toBe('success');
    expect(removeRow?.inputPayload).toEqual({});
  });

  it('D-025 writes a validation_schedule.removed audit row with an error: notfound result when the archetype does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/validation-schedules/arch_del_missing',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('validation_schedule.removed');
    expect(all[0]?.targetResourceId).toBe('arch_del_missing');
    expect(all[0]?.result).toMatch(/^error: notfound/);
  });

  it('403 without admin scope writes no audit row (preHandler rejection, before the handler runs)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/admin/validation-schedules/arch_del_no_scope',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
    expect(fx.adminAuditRepo.getAll()).toHaveLength(0);
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

  it('400 on an over-long reason (capped at 500 chars, not read off an unchecked cast)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/validation-schedules/iphone16pro_ios18_7_safari26_4/trigger',
      headers: auth(fx),
      payload: { reason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on a non-string reason (zod rejects the wrong type instead of the `as` cast passing it through)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/validation-schedules/iphone16pro_ios18_7_safari26_4/trigger',
      headers: auth(fx),
      payload: { reason: { nested: 'object' } },
    });
    expect(res.statusCode).toBe(400);
  });

  // D-025 audit-gap fix — trigger had zero audit wiring; these prove the
  // new validation_schedule.triggered audit row on both the success and
  // failure path.
  it('D-025 writes a validation_schedule.triggered audit row on success', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/validation-schedules/arch_trigger_ok/trigger',
      headers: auth(fx),
      payload: { reason: 'manual sanity check' },
    });
    expect(res.statusCode).toBe(200);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('validation_schedule.triggered');
    expect(all[0]?.adminAccountId).toBe(fx.accountId);
    expect(all[0]?.adminKeyId).toBe(fx.apiKeyId);
    expect(all[0]?.targetResourceId).toBe('arch_trigger_ok');
    expect(all[0]?.result).toBe('success');
    expect(all[0]?.inputPayload).toEqual({ reason: 'manual sanity check' });
  });

  it('D-025 writes a validation_schedule.triggered audit row with an error: result when the recapture bridge throws', async () => {
    fx = await buildTestApp();
    vi.spyOn(fx.recaptureBridge, 'triggerRecapture').mockRejectedValueOnce(new Error('boom'));
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/validation-schedules/arch_trigger_fail/trigger',
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('validation_schedule.triggered');
    expect(all[0]?.targetResourceId).toBe('arch_trigger_fail');
    expect(all[0]?.result).toMatch(/^error:/);
  });

  it('403 without admin scope writes no audit row (preHandler rejection, before the handler runs)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/validation-schedules/arch_trigger_no_scope/trigger',
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(fx.adminAuditRepo.getAll()).toHaveLength(0);
  });
});
