// Integration tests for /v1/admin/webhook-deliveries/:id and
// /v1/admin/webhook-dlq routes. Covers happy path, audit row presence,
// scope enforcement, and the replay-vs-requeue distinction.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

async function seedDelivery(
  fixture: TestAppFixture,
  overrides: { status?: 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dlq' } = {},
): Promise<{ id: string; webhookId: string }> {
  // Create endpoint via the API.
  const sub = await fixture.app.inject({
    method: 'POST',
    url: '/v1/webhooks',
    headers: auth(fixture),
    payload: { url: 'https://x.test/h', events: ['session.completed'] },
  });
  const created = sub.json<{ id: string }>();
  const webhookId = created.id.replace(/^whk_/, '');

  // Enqueue a delivery via the in-memory repo.
  await fixture.webhooksRepo.enqueueDelivery({
    webhookId,
    eventId: '11111111-2222-3333-4444-555555555555',
    eventType: 'session.completed',
    payload: { id: 'evt-1', type: 'session.completed', data: {} },
  });
  // Pick the most recently enqueued row — multiple seedDelivery calls
  // in one test would otherwise all clobber the first delivery.
  const all = fixture.webhooksRepo.getAllDeliveries();
  const row = all[all.length - 1];
  if (!row) throw new Error('seeded delivery not found');

  // Optionally mutate status (simulating worker outcome).
  if (overrides.status && overrides.status !== 'pending') {
    // V-1274c — CLAIM first. The outcome writers are fenced on `in_flight` in both
    // implementations now, because the worker only ever writes for a row it claimed; a write for
    // an unclaimed row is a no-op in production, so simulating an outcome without the claim
    // arranged a state the real repo refuses and this helper silently produced a pending row.
    await fixture.webhooksRepo.claim({ batchSize: 64, now: new Date() });
    if (overrides.status === 'dlq') {
      await fixture.webhooksRepo.recordDlq(row.id, {
        responseStatus: 500,
        lastError: 'simulated',
        at: new Date(),
      });
    } else if (overrides.status === 'delivered') {
      await fixture.webhooksRepo.recordDelivered(row.id, {
        responseStatus: 200,
        at: new Date(),
      });
    }
  }
  return { id: row.id, webhookId };
}

describe('GET /v1/admin/webhook-deliveries/:id', () => {
  it('200 returns the delivery', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/webhook-deliveries/wdl_${id}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.id).toBe(`wdl_${id}`);
    expect(body.event_type).toBe('session.completed');
  });

  it('404 unknown delivery id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-deliveries/wdl_00000000-0000-4000-8000-000000000999',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-deliveries/wdl_00000000-0000-4000-8000-000000000001',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 with driftstack_internal_admin scope (V-174 — staff SSO sessions carry driftstack_internal_admin, NOT legacy admin)', async () => {
    // The route gates on driftstack_internal_admin; the service must
    // accept the same scope. Pre-fix the service required literal
    // 'admin', which driftstack_internal_admin does NOT satisfy, so
    // staff sessions got 403 here even though the route let them in.
    fx = await buildTestApp({
      scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    });
    const { id } = await seedDelivery(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/webhook-deliveries/wdl_${id}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /v1/admin/webhook-deliveries/:id/replay', () => {
  it('200 replays a delivered delivery (sets pending, attempts=0)', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx, { status: 'delivered' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-deliveries/wdl_${id}/replay`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.status).toBe('pending');
    expect(body.attempts).toBe(0);
    expect(body.delivered_at).toBeNull();
  });

  it('200 replays a dlq delivery', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx, { status: 'dlq' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-deliveries/wdl_${id}/replay`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>().status).toBe('pending');
  });

  it('writes audit row with action=webhook_delivery.replayed', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx);
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-deliveries/wdl_${id}/replay`,
      headers: auth(fx),
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('webhook_delivery.replayed');
    expect(all[0]?.targetResourceId).toBe(`wdl_${id}`);
    expect(all[0]?.result).toBe('success');
  });

  it('404 + audit row for unknown delivery', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-deliveries/wdl_00000000-0000-4000-8000-000000000099/replay',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.result).toMatch(/^error: notfound/);
  });
});

describe('GET /v1/admin/webhook-dlq', () => {
  it('returns dlq deliveries paginated', async () => {
    fx = await buildTestApp();
    const { id: a } = await seedDelivery(fx, { status: 'dlq' });
    const { id: b } = await seedDelivery(fx, { status: 'dlq' });
    const { id: c } = await seedDelivery(fx, { status: 'delivered' }); // not dlq

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-dlq',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; status: string }>;
      next_cursor: string | null;
    }>();
    expect(body.data).toHaveLength(2);
    for (const d of body.data) expect(d.status).toBe('dlq');
    const ids = body.data.map((d) => d.id);
    expect(ids).toContain(`wdl_${a}`);
    expect(ids).toContain(`wdl_${b}`);
    expect(ids).not.toContain(`wdl_${c}`);
  });

  it('respects limit + cursor', async () => {
    fx = await buildTestApp();
    await seedDelivery(fx, { status: 'dlq' });
    await new Promise((r) => setTimeout(r, 5));
    await seedDelivery(fx, { status: 'dlq' });

    const r1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-dlq?limit=1',
      headers: auth(fx),
    });
    const p1 = r1.json<{ data: unknown[]; next_cursor: string | null }>();
    expect(p1.data).toHaveLength(1);
    expect(p1.next_cursor).not.toBeNull();

    const r2 = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/webhook-dlq?limit=1&cursor=${encodeURIComponent(p1.next_cursor ?? '')}`,
      headers: auth(fx),
    });
    const p2 = r2.json<{ data: unknown[]; next_cursor: string | null }>();
    expect(p2.data).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-dlq',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  // V-512 — drill-down filter by endpoint id. Customer-support
  // workflow: a customer reports "endpoint X is missing events";
  // admin pulls just that endpoint's DLQ rows.
  it('V-512 — endpoint_id filter returns only the named endpoint', async () => {
    fx = await buildTestApp();
    // Seed 2 DLQ deliveries for endpoint A + 1 DLQ delivery for endpoint B.
    const a1 = await seedDelivery(fx, { status: 'dlq' });
    // seedDelivery creates a fresh endpoint each call; reuse webhookId by
    // enqueuing directly through the in-memory repo.
    await fx.webhooksRepo.enqueueDelivery({
      webhookId: a1.webhookId,
      eventId: '22222222-3333-4444-5555-666666666666',
      eventType: 'session.completed',
      payload: { id: 'evt-2', type: 'session.completed', data: {} },
    });
    const all = fx.webhooksRepo.getAllDeliveries();
    const a2Row = all[all.length - 1];
    if (!a2Row) throw new Error('seed a2 missing');
    await fx.webhooksRepo.claim({ batchSize: 64, now: new Date() });
    await fx.webhooksRepo.recordDlq(a2Row.id, {
      responseStatus: 500,
      lastError: 'simulated',
      at: new Date(),
    });

    const b1 = await seedDelivery(fx, { status: 'dlq' });
    expect(a1.webhookId).not.toBe(b1.webhookId);

    // No filter — all 3 DLQ rows.
    const allRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-dlq',
      headers: auth(fx),
    });
    expect(allRes.statusCode).toBe(200);
    const allBody = allRes.json<{ data: Array<{ id: string }> }>();
    expect(allBody.data).toHaveLength(3);

    // Filter to endpoint A — should get exactly 2 rows (a1 + a2).
    const filteredRes = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/webhook-dlq?endpoint_id=webhook_endpoint_${a1.webhookId}`,
      headers: auth(fx),
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredBody = filteredRes.json<{ data: Array<{ id: string }> }>();
    expect(filteredBody.data).toHaveLength(2);
    const filteredIds = filteredBody.data.map((d) => d.id);
    expect(filteredIds).toContain(`wdl_${a1.id}`);
    expect(filteredIds).toContain(`wdl_${a2Row.id}`);
    expect(filteredIds).not.toContain(`wdl_${b1.id}`);

    // Filter accepts the bare uuid form too (without the prefix).
    const bareRes = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/webhook-dlq?endpoint_id=${a1.webhookId}`,
      headers: auth(fx),
    });
    expect(bareRes.statusCode).toBe(200);
    expect(bareRes.json<{ data: unknown[] }>().data).toHaveLength(2);
  });
});

describe('POST /v1/admin/webhook-dlq/:id/requeue', () => {
  it('200 requeues a DLQ delivery (sets pending, attempts=0)', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx, { status: 'dlq' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-dlq/wdl_${id}/requeue`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.status).toBe('pending');
  });

  it('writes audit row with action=webhook_delivery.requeued (distinct from replayed)', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx, { status: 'dlq' });
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-dlq/wdl_${id}/requeue`,
      headers: auth(fx),
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('webhook_delivery.requeued');
  });

  it('409 if the delivery is not in DLQ (use /replay for non-DLQ)', async () => {
    fx = await buildTestApp();
    const { id } = await seedDelivery(fx, { status: 'delivered' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-dlq/wdl_${id}/requeue`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(409);
    // Audit row still recorded (the attempt is auditable).
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('webhook_delivery.requeued');
    expect(all[0]?.result).toMatch(/^error: conflict/);
  });

  it('404 unknown delivery id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-dlq/wdl_00000000-0000-4000-8000-000000000099/requeue',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });
});
