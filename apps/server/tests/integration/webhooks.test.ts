import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { seedWebhookEndpoints } from './_helpers/scenarios.js';

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

  it('201 with account_owner scope (V-174 — dashboard web sessions carry account_owner, not admin)', async () => {
    // Web-session synthetic keys (auth.ts V-174) carry
    // ['read','write','account_owner'] with NO 'admin'. Webhook
    // management is account-owner-level — same posture as the rest
    // of /v1/account/* and replayDeliveryAsCustomer.
    fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://owner.test/h', events: ['session.completed'] },
    });
    expect(res.statusCode).toBe(201);
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

  it('400 (SSRF guard) when URL targets a private / loopback / metadata address', async () => {
    fx = await buildTestApp();
    for (const url of [
      'https://169.254.169.254/h', // cloud metadata
      'https://10.0.0.5/h', // RFC1918 private
      'https://127.0.0.1/h', // loopback
      'https://localhost/h',
      'https://[::1]/h', // IPv6 loopback
    ]) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/webhooks',
        headers: auth(fx),
        payload: { url, events: ['session.completed'] },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('400 when URL contains userinfo credentials (never stored)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: {
        url: 'https://user:plaintext-password@hooks.example.test/h',
        events: ['session.completed'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Record<string, unknown>>().detail).toMatch(/username or password credentials/);
    await expect(fx.webhooksRepo.listEndpoints(fx.accountId)).resolves.toEqual([]);
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
    await seedWebhookEndpoints(fx, 2, { urls: ['https://x.test/h1', 'https://x.test/h2'] });

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

  // #122 — read:webhooks floor. WebhooksService.listWithCounts()/get()/
  // listDeliveries() gate read:webhooks (V-553.B-21). The 3-way contract:
  // (a) broad `read` passes, (b) granular read:webhooks passes, (c) a
  // DIFFERENT-resource granular scope (read:sessions) is blocked 403.
  const listWebhooks = (fxArg: TestAppFixture) =>
    fxArg.app.inject({ method: 'GET', url: '/v1/webhooks', headers: auth(fxArg) });

  it('403 for a cross-resource granular key (read:sessions does NOT satisfy read:webhooks)', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    const res = await listWebhooks(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string; detail: string }>().type).toBe(PROBLEM_TYPES.Forbidden);
    expect(res.json<{ detail: string }>().detail).toContain('read:webhooks');
  });

  it('200 for a granular read:webhooks key', async () => {
    fx = await buildTestApp({ scopes: ['read:webhooks'] });
    expect((await listWebhooks(fx)).statusCode).toBe(200);
  });

  it('200 for a broad read key and an account_owner key (V-481)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    expect((await listWebhooks(fx)).statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['account_owner'] });
    expect((await listWebhooks(fx)).statusCode).toBe(200);
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

describe('PATCH /v1/webhooks/:id (V-351)', () => {
  it('200 updates url + events + description + active', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: {
        url: 'https://x.test/v1',
        events: ['session.completed'],
        description: 'old desc',
      },
    });
    const created = create.json<{ id: string }>();

    const patch = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        url: 'https://x.test/v2',
        events: ['session.completed', 'session.failed'],
        description: 'new desc',
        active: false,
      },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json<Record<string, unknown>>();
    expect(body.url).toBe('https://x.test/v2');
    expect(body.events).toEqual(['session.completed', 'session.failed']);
    expect(body.description).toBe('new desc');
    expect(body.active).toBe(false);
  });

  it('400 when body has no fields', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const created = create.json<{ id: string }>();

    const patch = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {},
    });
    expect(patch.statusCode).toBe(400);
  });

  it('400 when changed URL contains userinfo credentials and preserves the prior target', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/original', events: ['session.completed'] },
    });
    const created = create.json<{ id: string }>();

    const patch = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { url: 'https://user:plaintext-password@x.test/replacement' },
    });

    expect(patch.statusCode).toBe(400);
    const get = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${created.id}`,
      headers: auth(fx),
    });
    expect(get.json<Record<string, unknown>>().url).toBe('https://x.test/original');
  });

  it('409 when targeting a soft-deleted endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const created = create.json<{ id: string }>();

    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${created.id}`,
      headers: auth(fx),
    });

    const patch = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { description: 'late edit' },
    });
    expect(patch.statusCode).toBe(409);
  });

  it('404 when endpoint id is unknown', async () => {
    fx = await buildTestApp();
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-deadbeef0000',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { active: false },
    });
    expect(patch.statusCode).toBe(404);
  });
});

// ── V-356 — POST /v1/webhooks/:id/test ───────────────────────────

describe('POST /v1/webhooks/:id/test (V-356)', () => {
  it('202 enqueues a test.ping delivery for an active endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const created = create.json<{ id: string }>();

    const test = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${created.id}/test`,
      headers: auth(fx),
    });
    expect(test.statusCode).toBe(202);
    const body = test.json<{ event_type: string; delivery_id: string; event_id: string }>();
    expect(body.event_type).toBe('test.ping');
    expect(body.delivery_id).toMatch(/^wdl_/);
    expect(body.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('403 when admin scope missing on the calling key', async () => {
    // Same admin-only gate as POST/DELETE /v1/webhooks. The scope
    // check fires before the endpoint lookup so a non-existent id is
    // fine here — we only need to confirm the gate, not the lookup.
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const test = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-000000000abc/test',
      headers: auth(fx),
    });
    expect(test.statusCode).toBe(403);
  });

  it('404 when endpoint id is unknown', async () => {
    fx = await buildTestApp();
    const test = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-deadbeef0000/test',
      headers: auth(fx),
    });
    expect(test.statusCode).toBe(404);
  });

  it('400 when endpoint is paused (auto-disabled or active=false)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const id = create.json<{ id: string }>().id;
    // Pause it via PATCH active=false.
    await fx.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { active: false },
    });
    const test = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${id}/test`,
      headers: auth(fx),
    });
    expect(test.statusCode).toBe(400);
  });

  it('400 if customer tries to subscribe to test.ping on create', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['test.ping'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── V-359 — POST /v1/webhooks/:id/rotate-secret ──────────────────

describe('POST /v1/webhooks/:id/rotate-secret (V-359)', () => {
  it('200 returns fresh plaintext + grace metadata; secret_prev preserved via repo state', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const created = create.json<{ id: string; secret: string; secret_prefix: string }>();

    const rotate = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${created.id}/rotate-secret`,
      headers: auth(fx),
    });
    expect(rotate.statusCode).toBe(200);
    const body = rotate.json<{
      id: string;
      secret: string;
      secret_prefix: string;
      prev_secret_prefix: string;
      grace_expires_at: string;
    }>();
    expect(body.id).toBe(created.id);
    expect(body.secret).toMatch(/^whsec_[a-z2-7]{32}$/);
    expect(body.secret).not.toBe(created.secret);
    expect(body.secret_prefix).not.toBe(created.secret_prefix);
    // Prev prefix is the first 12 chars of the OLD plaintext.
    expect(body.prev_secret_prefix).toBe(created.secret.slice(0, 12));
    // Grace is in the future, default 24h.
    const grace = new Date(body.grace_expires_at).getTime();
    expect(grace).toBeGreaterThan(Date.now());
    expect(grace).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
  });

  it('403 when admin scope missing on the calling key', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-000000000abc/rotate-secret',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 when endpoint id is unknown', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-deadbeef0000/rotate-secret',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('409 when targeting a soft-deleted endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://x.test/h', events: ['session.completed'] },
    });
    const id = create.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${id}`,
      headers: auth(fx),
    });
    const rotate = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${id}/rotate-secret`,
      headers: auth(fx),
    });
    expect(rotate.statusCode).toBe(409);
  });
});

// ─── refusals that fire when the row moves between the read and the write ───
//
// Swept `services/webhooks.ts` — all 28 refusal sites, each neutralized against
// 459 webhook tests. Six were uncovered; these are the three worth driving.
//
// ⭐ `:707` is a FIXED BUG with no regression test, and its own comment says so:
// listing deliveries for an endpoint that does not exist used to answer an empty
// list — "indistinguishable from a real endpoint that has never fired, so a
// customer debugging a mistyped id was shown 'no deliveries' instead of 'no such
// webhook'". The fix added the existence check. Nothing pinned it, so the bug
// could return exactly as it left.
//
// `:532` and `:598` are the lost-update pair: the endpoint was found, then the
// conditional UPDATE matched nothing. That is a delete landing between the two
// statements, and the alternative to refusing is returning a success for a row
// that no longer exists — or, for rotate, reporting a new secret that was never
// stored, which is worse than an error because the customer would configure it.
//
// LEDGER — control 35/35:
//
//   :707 endpoint-existence check neutralized   1 red
//   :532 update-vanished refusal neutralized    1 red
//   :598 rotate-vanished refusal neutralized    1 red
//   :707 REVERTED to the original bug shape     1 red
//
// The last row is the one worth having: rather than neutralizing the throw, it
// deletes the existence check entirely and returns the empty list again — the
// exact code that shipped before the fix. A ledger row should reproduce the
// historical bug when one is known, not just disable the guard that fixed it.
describe('webhook refusals for a row that is gone by the time it is written', () => {
  let fx2: TestAppFixture;

  afterEach(async () => {
    if (fx2) await fx2.cleanup();
  });

  async function endpoint(): Promise<string> {
    const res = await fx2.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx2),
      payload: { url: 'https://customer.test/hook', events: ['session.completed'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('CRITICAL 404 listing deliveries for an endpoint that does not exist — not an empty list. The empty list was the bug: it is indistinguishable from a real endpoint that has never fired, so a mistyped id read as "your webhook works, nothing happened yet".', async () => {
    fx2 = await buildTestApp();
    await endpoint(); // a real one exists, so this is not "no webhooks at all"
    const res = await fx2.app.inject({
      method: 'GET',
      url: '/v1/webhooks/whk_00000000-0000-4000-8000-0000000000ff/deliveries',
      headers: auth(fx2),
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });

  it('404 when the endpoint is deleted between the read and the UPDATE', async () => {
    fx2 = await buildTestApp();
    const id = await endpoint();
    // The find succeeds; the conditional update matches nothing. That is a
    // concurrent delete, and the only alternative to refusing is reporting a
    // successful edit of a row that is gone.
    vi.spyOn(fx2.webhooksRepo, 'updateEndpoint').mockResolvedValue(null);

    const res = await fx2.app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${id}`,
      headers: { ...auth(fx2), 'content-type': 'application/json' },
      payload: { description: 'renamed' },
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('CRITICAL 404 when the endpoint disappears mid secret-ROTATION, so no secret is reported that was never stored', async () => {
    fx2 = await buildTestApp();
    const id = await endpoint();
    vi.spyOn(fx2.webhooksRepo, 'rotateSecret').mockResolvedValue(null);

    const res = await fx2.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${id}/rotate-secret`,
      headers: { ...auth(fx2), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(404);
    // The failure mode this prevents is worse than an error: a 200 here hands
    // the customer a signing secret to configure that the server never saved,
    // and every delivery signed with it would then fail verification.
    expect(res.body).not.toContain('whsec_');
  });
});

// ─── a well-formed id with the WRONG prefix is rejected ────────────────────
//
// The guard-condition census found `!match || !match[1] ||
// !value.startsWith(`${expectedPrefix}_`)` at TEN route files — ten independent
// copies of the same prefixed-id parser. Its regex accepts any three-letter
// prefix, so the `startsWith` clause is the ONLY thing tying an id to the
// resource it names.
//
// ⚠️ Measured, and the result is why this arm exists: dropping that clause from
// three copies AT ONCE (admin-api-keys, webhooks, admin-incidents) left the
// entire 2,747-test integration suite green. Every existing arm probes malformed
// junk like "not-an-id", which the REGEX rejects on its own — so none of them can
// see the prefix check at all.
//
// What the clause prevents is resource confusion: `wdl_<uuid>` accepted where
// `whk_<uuid>` is expected means a delivery id is looked up as an endpoint id.
// Both are uuids and both exist in this system, so the wrong one does not fail
// to parse — it addresses a different row.
//
// LEDGER — control 40/40:
//
//   prefix clause dropped                     4 red
//   prefix compared to the value's OWN slice  4 red
//
// The second is the shape a refactor produces: the check is still present, still
// calls startsWith, still reads like a prefix guard — and compares the value to
// itself, so every prefix matches. Dropping the clause outright is the obvious
// mutation; this is the one that would survive review.
describe('the prefixed-id parser checks the prefix, not just the shape', () => {
  let fx3: TestAppFixture;

  afterEach(async () => {
    if (fx3) await fx3.cleanup();
  });

  const UUID = '11111111-1111-4111-8111-111111111111';

  it.each([
    ['GET', ''],
    ['PATCH', ''],
    ['DELETE', ''],
  ])('%s /v1/webhooks/:id refuses a wdl_ id where whk_ is expected', async (method, suffix) => {
    fx3 = await buildTestApp();
    const res = await fx3.app.inject({
      method: method as 'GET' | 'PATCH' | 'DELETE',
      url: `/v1/webhooks/wdl_${UUID}${suffix}`,
      headers: { ...auth(fx3), 'content-type': 'application/json' },
      ...(method === 'PATCH' ? { payload: { description: 'x' } } : {}),
    });
    // 400 for the FORMAT, not 404 for the row: the id never becomes a lookup.
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Expected "whk_<uuid>"/);
  });

  it('CRITICAL the same uuid under the RIGHT prefix reaches the lookup and 404s — so the refusal above is the prefix and not the uuid', async () => {
    fx3 = await buildTestApp();
    const res = await fx3.app.inject({
      method: 'GET',
      url: `/v1/webhooks/whk_${UUID}`,
      headers: auth(fx3),
    });
    // Same uuid, correct prefix: parsed, looked up, not found. That contrast is
    // what makes the 400s above mean "wrong prefix" rather than "bad uuid".
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the delivery-replay route checks its OWN prefix independently — a whk_ id is refused where wdl_ is expected', async () => {
    fx3 = await buildTestApp();
    const res = await fx3.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/whk_${UUID}/replay`,
      headers: { ...auth(fx3), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Expected "wdl_<uuid>"/);
  });
});
