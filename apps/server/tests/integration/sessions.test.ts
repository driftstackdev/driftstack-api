// End-to-end integration tests for the eight session endpoints.
// Uses the in-memory test fixture; verifies HTTP shapes, error mapping,
// ownership scoping, and concurrency limits.

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

interface CreatedSession {
  id: string;
  status: string;
  archetype: string;
  account_id: string;
  api_key_id: string;
}

async function createSession(
  fixture: TestAppFixture,
  body: Record<string, unknown> = {},
): Promise<CreatedSession> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: auth(fixture),
    payload: body,
  });
  if (res.statusCode !== 201)
    throw new Error(`unexpected status ${String(res.statusCode)}: ${res.body}`);
  return res.json<CreatedSession>();
}

describe('POST /v1/sessions', () => {
  it('201 with full session shape', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { label: 'demo' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^ses_[0-9a-f-]{36}$/);
    expect(body.status).toBe('ready');
    expect(body.archetype).toBe('iphone16pro_ios26_4_1');
    expect(body.label).toBe('demo');
  });

  it('records a "created" session event', async () => {
    fx = await buildTestApp();
    await createSession(fx);
    const events = fx.sessionsRepo.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('created');
  });

  it('429 ConcurrencyLimit when free-tier already at limit', async () => {
    fx = await buildTestApp({ tier: 'free' });
    await createSession(fx); // free tier limit = 1

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(429);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ConcurrencyLimit);
    expect(body.current_sessions).toBe(1);
    expect(body.limit).toBe(1);
  });

  it('400 with bad archetype slug', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { archetype: 'iPhone16Pro' }, // uppercase rejected
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
  });
});

describe('GET /v1/sessions', () => {
  it('returns paginated list (initially empty)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; has_more: boolean; next_cursor: string | null }>();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('lists created sessions in reverse-chrono order', async () => {
    fx = await buildTestApp({ tier: 'builder' });
    // Cache-amortised auth makes session creation fast enough that the three
    // creates can land in the same millisecond, breaking the reverse-chrono
    // sort. Sleep between each so timestamps are strictly distinct.
    await createSession(fx, { label: 'a' });
    await new Promise((r) => setTimeout(r, 3));
    await createSession(fx, { label: 'b' });
    await new Promise((r) => setTimeout(r, 3));
    await createSession(fx, { label: 'c' });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    const body = res.json<{ data: Array<{ label: string }> }>();
    expect(body.data).toHaveLength(3);
    expect(body.data.map((s) => s.label)).toEqual(['c', 'b', 'a']);
  });
});

describe('POST /v1/sessions/:id/navigate', () => {
  it('200 with navigate result for happy path', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/navigate`,
      headers: auth(fx),
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.url).toBe('https://example.com');
    expect(body.final_url).toBe('https://example.com');
    expect(body.status).toBe(200);
    expect(typeof body.duration_ms).toBe('number');
  });

  it('502 DriverError for trigger error host', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/navigate`,
      headers: auth(fx),
      payload: { url: 'https://error.driftstack-mock.test' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.DriverError);
  });

  it('404 when session not found', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_00000000-0000-4000-8000-000000000999/navigate',
      headers: auth(fx),
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.NotFound);
  });

  it('400 when id has wrong prefix', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions/key_00000000-0000-4000-8000-000000000001/navigate',
      headers: auth(fx),
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/sessions/:id/interact', () => {
  it('200 happy path', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/interact`,
      headers: auth(fx),
      payload: { action: { kind: 'tap', selector: '#go' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(true);
  });

  it('502 for selector trigger #nonexistent', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/interact`,
      headers: auth(fx),
      payload: { action: { kind: 'tap', selector: '#nonexistent' } },
    });
    expect(res.statusCode).toBe(502);
  });

  it('400 when /interact rejects coordinate primitives (L-001 — gui plane only)', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/interact`,
      headers: auth(fx),
      payload: { action: { kind: 'tap_at', x: 120, y: 240 } },
    });
    // The Zod discriminated union has no `tap_at` variant, so parse fails.
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/sessions/:id/gui-input (gui_control plane)', () => {
  it('200 for tap_at when key has gui_control scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'gui_control'] });
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/gui-input`,
      headers: auth(fx),
      payload: { action: { kind: 'tap_at', x: 120, y: 240 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>().ok).toBe(true);
  });

  it('200 for type_focused when key has gui_control scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'gui_control'] });
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/gui-input`,
      headers: auth(fx),
      payload: { action: { kind: 'type_focused', text: 'hello' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>().ok).toBe(true);
  });

  it('403 when key lacks gui_control scope (default customer key)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/gui-input`,
      headers: auth(fx),
      payload: { action: { kind: 'tap_at', x: 100, y: 100 } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 when tap_at coordinates are negative', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'gui_control'] });
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/gui-input`,
      headers: auth(fx),
      payload: { action: { kind: 'tap_at', x: -1, y: 0 } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/sessions/:id/wait', () => {
  it('200 with satisfied=true for time condition', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/wait`,
      headers: auth(fx),
      payload: { condition: { kind: 'time', ms: 0 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.satisfied).toBe(true);
  });
});

describe('GET /v1/sessions/:id/state', () => {
  it('200 with state shape after navigation', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/navigate`,
      headers: auth(fx),
      payload: { url: 'https://example.com' },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}/state`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.url).toBe('https://example.com');
    expect(body.cookies).toEqual([]);
    expect(body.local_storage).toEqual({});
  });
});

describe('POST /v1/sessions/:id/capture', () => {
  it('returns base64 screenshot data', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/capture`,
      headers: auth(fx),
      payload: { kind: 'screenshot' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.kind).toBe('screenshot');
    expect(body.encoding).toBe('base64');
    expect(typeof body.data).toBe('string');
    expect(typeof body.byte_size).toBe('number');
  });
});

describe('DELETE /v1/sessions/:id', () => {
  it('204 on first call, 410 SessionDestroyed on subsequent ops', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${session.id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const navigate = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/navigate`,
      headers: auth(fx),
      payload: { url: 'https://example.com' },
    });
    expect(navigate.statusCode).toBe(410);
    const body = navigate.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.SessionDestroyed);
  });
});

describe('account scoping', () => {
  it('a session created by one account is invisible to another', async () => {
    const a = await buildTestApp({ tier: 'builder' });
    const b = await buildTestApp({ tier: 'builder' });
    try {
      const sessionA = await createSession(a);
      // B tries to navigate A's session id — should 404 (not 403, to avoid
      // leaking that the id exists at all).
      const res = await b.app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionA.id}/navigate`,
        headers: auth(b),
        payload: { url: 'https://example.com' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
