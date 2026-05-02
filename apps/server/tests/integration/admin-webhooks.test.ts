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
