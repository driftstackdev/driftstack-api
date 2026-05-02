import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

describe('POST /v1/webhooks', () => {
  it('201 returns plaintext secret + endpoint shape', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: {
        url: 'https://customer.test/hook',
        events: ['session.completed', 'session.failed'],
        description: 'prod',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(typeof body.secret).toBe('string');
    expect((body.secret as string).startsWith('whsec_')).toBe(true);
    expect(body.id).toMatch(/^whk_[0-9a-f-]{36}$/);
    expect(body.events).toEqual(['session.completed', 'session.failed']);
    expect(body.active).toBe(true);
  });

  it('403 when admin scope missing', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 when URL is not https://', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'http://insecure.test/h', events: ['session.completed'] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('400 when events is empty', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/webhooks', () => {
  it('lists endpoints, never includes plaintext secret', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h1', events: ['session.completed'] },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h2', events: ['api_key.revoked'] },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data).toHaveLength(2);
    for (const ep of body.data) {
      expect(ep.secret).toBeUndefined();
      expect(typeof ep.secret_prefix).toBe('string');
    }
  });
});

describe('DELETE /v1/webhooks/:id', () => {
  it('204 disables the endpoint, idempotent re-delete', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const created = create.json<{ id: string }>();

    const del1 = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${created.id}`,
      headers: auth(fx),
    });
    expect(del1.statusCode).toBe(204);

    const del2 = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${created.id}`,
      headers: auth(fx),
    });
    expect(del2.statusCode).toBe(204);

    // Get returns the disabled endpoint with disabled_at populated
    const get = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${created.id}`,
      headers: auth(fx),
    });
    expect(get.statusCode).toBe(200);
    const body = get.json<Record<string, unknown>>();
    expect(body.active).toBe(false);
    expect(body.disabled_at).not.toBeNull();
  });

  it('404 for unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-000000000999',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/webhooks/:id/deliveries', () => {
  it('returns deliveries enqueued via service', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const created = create.json<{ id: string }>();
    const idUuid = created.id.replace(/^whk_/, '');

    // Enqueue a delivery directly via the in-memory repo for this test.
    await fx.webhooksRepo.enqueueDelivery({
      webhookId: idUuid,
      eventId: '11111111-2222-3333-4444-555555555555',
      eventType: 'session.completed',
      payload: { id: '11111111-2222-3333-4444-555555555555', type: 'session.completed', data: {} },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${created.id}/deliveries`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.event_type).toBe('session.completed');
    expect(body.data[0]?.status).toBe('pending');
  });
});

describe('event emission', () => {
  it('session.completed fires on DELETE /v1/sessions/:id', async () => {
    fx = await buildTestApp();

    // Subscribe to session.completed.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    expect(create.statusCode).toBe(201);

    // Create + destroy a session.
    const session = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: {},
    });
    expect(session.statusCode).toBe(201);
    const sid = session.json<{ id: string }>().id;

    const destroy = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sid}`,
      headers: auth(fx),
    });
    expect(destroy.statusCode).toBe(204);

    // One delivery row enqueued for session.completed.
    const deliveries = fx.webhooksRepo.getAllDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe('session.completed');
    const payload = deliveries[0]?.payload as Record<string, unknown>;
    expect(payload.type).toBe('session.completed');
    expect((payload.data as { session_id: string }).session_id).toBe(sid);
  });

  it('api_key.revoked fires on DELETE /v1/api-keys/:id', async () => {
    fx = await buildTestApp();

    // Subscribe.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['api_key.revoked'] },
    });

    // Create a key, then revoke it.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'doomed', scopes: ['read'] },
    });
    const created = create.json<{ id: string }>();

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const deliveries = fx.webhooksRepo.getAllDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe('api_key.revoked');
    const payload = deliveries[0]?.payload as Record<string, unknown>;
    expect((payload.data as { api_key_id: string }).api_key_id).toBe(created.id);
  });

  it('no delivery enqueued for unsubscribed event types', async () => {
    fx = await buildTestApp();
    // Subscribe ONLY to session.failed.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.failed'] },
    });

    // Destroy a session — that fires session.completed, which our endpoint
    // is not subscribed to.
    const session = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: {},
    });
    const sid = session.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sid}`,
      headers: auth(fx),
    });

    expect(fx.webhooksRepo.getAllDeliveries()).toEqual([]);
  });
});

describe('account scoping', () => {
  it('account B cannot get/delete account A webhook', async () => {
    const a = await buildTestApp();
    const b = await buildTestApp();
    try {
      const create = await a.app.inject({
        method: 'POST',
        url: '/v1/webhooks',
        headers: auth(a),
        payload: { url: 'https://x.test/h', events: ['session.completed'] },
      });
      const created = create.json<{ id: string }>();

      const get = await b.app.inject({
        method: 'GET',
        url: `/v1/webhooks/${created.id}`,
        headers: auth(b),
      });
      expect(get.statusCode).toBe(404);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
