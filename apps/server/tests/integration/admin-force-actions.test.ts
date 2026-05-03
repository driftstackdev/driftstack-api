// V-100: integration tests for admin force-action routes.
//
//   POST /v1/admin/sessions/:id/destroy   — admin force-destroy a session
//   POST /v1/admin/api-keys/:id/revoke    — admin force-revoke an API key

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

describe('POST /v1/admin/sessions/:id/destroy', () => {
  it('200 force-destroys an active session and writes audit row', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Customer creates a session.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { archetype: 'iphone16pro_ios26_4_1' },
    });
    const sessionId = create.json<{ id: string }>().id;

    // Admin force-destroys.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/sessions/${sessionId}/destroy`,
      headers: auth(fx),
      payload: { reason: 'abuse pattern detected' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string; destroyed_at: string }>();
    expect(body.status).toBe('destroyed');
    expect(body.destroyed_at).toBeTruthy();

    // Audit row exists.
    const auditRows = fx.adminAuditRepo.getAll();
    const adminDestroyEvent = auditRows.find((r) => r.action === 'session.destroyed_by_admin');
    expect(adminDestroyEvent).toBeDefined();
    expect(adminDestroyEvent?.result).toBe('success');
    expect((adminDestroyEvent?.inputPayload as { reason?: string })?.reason).toBe(
      'abuse pattern detected',
    );
  });

  it('200 idempotent on already-destroyed session', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { archetype: 'iphone16pro_ios26_4_1' },
    });
    const sessionId = create.json<{ id: string }>().id;

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/sessions/${sessionId}/destroy`,
      headers: auth(fx),
    });

    const second = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/sessions/${sessionId}/destroy`,
      headers: auth(fx),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ status: string }>().status).toBe('destroyed');
  });

  it('404 NotFound on unknown session id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/sessions/ses_00000000-0000-4000-8000-000000000099/destroy',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 BadRequest on malformed id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/sessions/not-a-prefixed-id/destroy',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 Forbidden without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { archetype: 'iphone16pro_ios26_4_1' },
    });
    const sessionId = create.json<{ id: string }>().id;

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/sessions/${sessionId}/destroy`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Forbidden);
  });

  it('targets a session owned by a different account; admin can act cross-account', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Seed a second account; admin (the fixture's primary account, has admin scope) acts on it.
    const second = await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000d1',
      apiKeyId: '00000000-0000-4000-8000-0000000000d2',
      scopes: ['read', 'write'],
    });

    // Second account creates a session.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${second.plaintext}` },
      payload: { archetype: 'iphone16pro_ios26_4_1' },
    });
    const sessionId = create.json<{ id: string }>().id;

    // Admin (fx's primary key, scopes include 'admin') destroys it.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/sessions/${sessionId}/destroy`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const auditRows = fx.adminAuditRepo.getAll();
    const event = auditRows.find((r) => r.action === 'session.destroyed_by_admin');
    expect(event?.targetAccountId).toBe(second.accountId);
  });
});

describe('POST /v1/admin/api-keys/:id/revoke', () => {
  it('200 force-revokes an active API key and writes audit row', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Customer creates a second API key for themselves.
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'doomed-key', scopes: ['read'] },
    });
    const keyId = created.json<{ id: string }>().id;

    // Admin force-revokes.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/api-keys/${keyId}/revoke`,
      headers: auth(fx),
      payload: { reason: 'security incident' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ revoked_at: string }>().revoked_at).toBeTruthy();

    const auditRows = fx.adminAuditRepo.getAll();
    const event = auditRows.find((r) => r.action === 'api_key.revoked_by_admin');
    expect(event?.result).toBe('success');
    expect((event?.inputPayload as { reason?: string })?.reason).toBe('security incident');
  });

  it('200 idempotent on already-revoked key', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'twice', scopes: ['read'] },
    });
    const keyId = created.json<{ id: string }>().id;

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/api-keys/${keyId}/revoke`,
      headers: auth(fx),
    });
    const second = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/api-keys/${keyId}/revoke`,
      headers: auth(fx),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ revoked_at: string }>().revoked_at).toBeTruthy();
  });

  it('404 NotFound on unknown key id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/api-keys/key_00000000-0000-4000-8000-000000000099/revoke',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('403 Forbidden without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    // Create a target key first (requires admin scope, so use a parallel admin fixture isn't easy).
    // Instead just hit a non-existent key — the scope check fires before the lookup.
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/api-keys/key_00000000-0000-4000-8000-000000000099/revoke',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});
