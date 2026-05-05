// V-216 — integration tests for /v1/account/audit-log + emit wiring.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface AuditEntry {
  id: string;
  account_id: string;
  actor_type: string;
  action: string;
  target_resource_id: string | null;
  payload: Record<string, unknown> | null;
  timestamp: string;
}

interface ListResponse {
  data: AuditEntry[];
  next_cursor: string | null;
}

describe('GET /v1/account/audit-log', () => {
  it('200 empty for a freshly-built account with no recorded events yet', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('records an api_key.minted entry when a customer mints a key', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'second-key', scopes: ['read', 'write'] },
    });
    expect(create.statusCode).toBe(201);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    const entry = body.data[0]!;
    expect(entry.action).toBe('api_key.minted');
    expect(entry.actor_type).toBe('customer');
    expect(entry.target_resource_id).toMatch(/^key_/);
    expect((entry.payload as { name?: string } | null)?.name).toBe('second-key');
  });

  it('records api_key.revoked when a customer revokes a key', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'to-revoke', scopes: ['read'] },
    });
    const created = create.json<{ id: string }>();
    const revoke = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(fx),
    });
    expect(revoke.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    const actions = body.data.map((e) => e.action);
    expect(actions).toContain('api_key.minted');
    expect(actions).toContain('api_key.revoked');
  });

  it('records session.created + session.destroyed across the lifecycle', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: {
        archetype: 'iphone16pro_ios18_7_safari26_4',
        purpose: 'production_customer',
      },
    });
    expect(create.statusCode).toBe(201);
    const sess = create.json<{ id: string }>();
    const destroy = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sess.id}`,
      headers: auth(fx),
    });
    expect(destroy.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    const actions = body.data.map((e) => e.action);
    expect(actions).toContain('session.created');
    expect(actions).toContain('session.destroyed');
  });

  it('filters by action query param', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k2', scopes: ['read'] },
    });

    const filtered = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=api_key.minted',
      headers: auth(fx),
    });
    expect(filtered.statusCode).toBe(200);
    const body = filtered.json<ListResponse>();
    expect(body.data.every((e) => e.action === 'api_key.minted')).toBe(true);
    expect(body.data.length).toBe(2);
  });

  it('400 on unknown action enum value', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=bogus.event',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  // V-225 — second batch of deferred V-216 emit wires.

  it('records profile.created when a customer creates a profile', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fx),
      payload: { name: 'main' },
    });
    expect(create.statusCode).toBe(200);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=profile.created',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    const entry = body.data[0]!;
    expect(entry.target_resource_id).toMatch(/^profile_/);
    expect((entry.payload as { name?: string } | null)?.name).toBe('main');
  });

  it('records profile.deleted when a customer deletes a profile', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fx),
      payload: { name: 'doomed' },
    });
    const id = create.json<{ id: string }>().id;
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=profile.deleted',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect((body.data[0]!.payload as { name?: string } | null)?.name).toBe('doomed');
  });

  it('records webhook_endpoint.created when a customer creates an endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://example.test/hook', events: ['session.completed'] },
    });
    expect(create.statusCode).toBe(201);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=webhook_endpoint.created',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    const entry = body.data[0]!;
    expect(entry.target_resource_id).toMatch(/^webhook_endpoint_/);
    expect((entry.payload as { url?: string } | null)?.url).toBe('https://example.test/hook');
  });

  it('records webhook_endpoint.deleted when a customer deletes an endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://example.test/hook2', events: ['session.completed'] },
    });
    const id = create.json<{ id: string }>().id;
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=webhook_endpoint.deleted',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect((body.data[0]!.payload as { url?: string } | null)?.url).toBe(
      'https://example.test/hook2',
    );
  });
});
