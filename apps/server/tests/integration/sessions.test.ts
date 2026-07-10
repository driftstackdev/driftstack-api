// End-to-end integration tests for the eight session endpoints.
// Uses the in-memory test fixture; verifies HTTP shapes, error mapping,
// ownership scoping, and concurrency limits.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES, TIER_STORAGE_BYTES_CAP } from '@driftstack/api-types';
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
    expect(body.archetype).toBe('iphone17_ios18_7_safari26_4');
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

  it('201 accepts a bounded metadata blob (under the 8 KiB cap)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { metadata: { tag: 'a'.repeat(1000) } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('400 rejects an over-cap metadata blob (> 8 KiB serialized)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      // ~9 KiB serialized — past SESSION_METADATA_MAX_BYTES.
      payload: { metadata: { blob: 'x'.repeat(9000) } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('403 when the key lacks write:sessions scope (read-only key)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { label: 'demo' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('write:sessions');
  });

  it('201 with a granular write:sessions key (granular satisfies the route)', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions', 'write:sessions'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { label: 'demo' },
    });
    expect(res.statusCode).toBe(201);
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
    fx = await buildTestApp({ tier: 'api_builder' });
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

  // V-553.B-21 — SessionsService.list() had ZERO scope check (any
  // authenticated key, regardless of scope, could enumerate every
  // session on the account). 'gui_control' is a real, narrow scope
  // that satisfies neither bare 'read' nor the broad-satisfies-granular
  // rule.
  it('403 when the key lacks read:sessions (or a satisfying broad scope)', async () => {
    fx = await buildTestApp({ scopes: ['gui_control'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('read:sessions');
  });

  it('200 with a granular read:sessions key (granular satisfies the route)', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
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

  it('504 with session-timeout problem when interact hits the #hangs trigger', async () => {
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/interact`,
      headers: auth(fx),
      payload: { action: { kind: 'tap', selector: '#hangs' }, timeout_ms: 5000 },
    });
    expect(res.statusCode).toBe(504);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe('https://errors.driftstack.dev/session-timeout');
    expect(body.timeout_ms).toBe(5000);
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

  it('403 when the key lacks write:sessions scope (read-only key) — wait is a driver write, not a read', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_00000000-0000-0000-0000-000000000000/wait',
      headers: auth(fx),
      payload: { condition: { kind: 'time', ms: 0 } },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('write:sessions');
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

// #122 — read:sessions floor on the SINGLE-session reads (GET /:id +
// GET /:id/state). The list route already gated read:sessions in
// SessionsService.list() (V-553.B-21), but describe()/getState() only
// enforced ownership — so a narrow write:sessions-only or gui_control
// key could read one session's full record + live state (url / cookies /
// localStorage) it could never list. These prove the 3-way contract:
// (a) broad `read` passes, (b) granular `read:sessions` passes, (c) a
// DIFFERENT-resource granular scope (read:webhooks) is blocked with 403.
// The scope check runs in the preHandler BEFORE the ownership lookup, so
// a passing scope on a non-existent session surfaces as 404 (NOT 403) —
// that's the signal the gate let the request through.
describe('#122 — read:sessions floor on GET /v1/sessions/:id (describe)', () => {
  const SYNTHETIC_ID = 'ses_00000000-0000-4000-8000-0000000000ff';
  const get = (fxArg: TestAppFixture) =>
    fxArg.app.inject({
      method: 'GET',
      url: `/v1/sessions/${SYNTHETIC_ID}`,
      headers: auth(fxArg),
    });

  it('403 for a write:sessions-only key, naming the required scope', async () => {
    fx = await buildTestApp({ scopes: ['write:sessions'] });
    const res = await get(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
  });

  it('403 for a cross-resource granular key (read:webhooks does NOT satisfy read:sessions)', async () => {
    fx = await buildTestApp({ scopes: ['read:webhooks'] });
    const res = await get(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
  });

  it('past the gate (404, not 403) for a granular read:sessions key', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    expect((await get(fx)).statusCode).toBe(404);
  });

  it('past the gate (404, not 403) for a broad read key and an account_owner key (V-481)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    expect((await get(fx)).statusCode).toBe(404);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['account_owner'] });
    expect((await get(fx)).statusCode).toBe(404);
  });
});

describe('#122 — read:sessions floor on GET /v1/sessions/:id/state (getState)', () => {
  const SYNTHETIC_ID = 'ses_00000000-0000-4000-8000-0000000000fe';
  const get = (fxArg: TestAppFixture) =>
    fxArg.app.inject({
      method: 'GET',
      url: `/v1/sessions/${SYNTHETIC_ID}/state`,
      headers: auth(fxArg),
    });

  it('403 for a write:sessions-only key, naming the required scope', async () => {
    fx = await buildTestApp({ scopes: ['write:sessions'] });
    const res = await get(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
  });

  it('403 for a cross-resource granular key (read:webhooks)', async () => {
    fx = await buildTestApp({ scopes: ['read:webhooks'] });
    expect((await get(fx)).statusCode).toBe(403);
  });

  it('past the gate (404, not 403) for read:sessions / broad read / account_owner keys', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    expect((await get(fx)).statusCode).toBe(404);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['read'] });
    expect((await get(fx)).statusCode).toBe(404);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['account_owner'] });
    expect((await get(fx)).statusCode).toBe(404);
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

// doc-150 item 6 — per-account storage quota is enforced HARD at
// session-launch when the create is profile-backed. The enforced quota is the
// SUM of the account's live profiles' size_bytes vs TIER_STORAGE_BYTES_CAP.
describe('POST /v1/sessions storage quota (doc-150 item 6)', () => {
  // Create a profile via the API, then seed its sealed-store size directly on
  // the repo (the harness emits size_bytes post-save; recordSave is that path).
  async function createProfileWithSize(
    fixture: TestAppFixture,
    name: string,
    sizeBytes: number,
  ): Promise<string> {
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fixture),
      payload: { name },
    });
    if (res.statusCode !== 200)
      throw new Error(`profile create failed ${String(res.statusCode)}: ${res.body}`);
    const prefixed = res.json<{ id: string }>().id; // prof_<uuid>
    const bareId = prefixed.replace(/^prof_/, '');
    await fixture.profilesRepo.recordSave({
      id: bareId,
      accountId: fixture.accountId,
      at: new Date(),
      sizeBytes,
    });
    return prefixed;
  }

  it('409 storage_quota_exceeded when the account is at its hard cap + a profile is bound', async () => {
    fx = await buildTestApp({ tier: 'solo_manual' });
    const profileId = await createProfileWithSize(
      fx,
      'fat-profile',
      TIER_STORAGE_BYTES_CAP.solo_manual, // exactly at the cap → hard
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { profile_id: profileId },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.StorageQuotaExceeded);
    expect(body.used_bytes).toBe(TIER_STORAGE_BYTES_CAP.solo_manual);
    expect(body.cap_bytes).toBe(TIER_STORAGE_BYTES_CAP.solo_manual);
  });

  it('201 when the account is UNDER the cap + a profile is bound', async () => {
    fx = await buildTestApp({ tier: 'solo_manual' });
    const profileId = await createProfileWithSize(fx, 'lean-profile', 1024);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { profile_id: profileId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('201 when an account WITHOUT a profile is over what would be its cap — no-profile is never blocked', async () => {
    fx = await buildTestApp({ tier: 'solo_manual' });
    // Even with a fat profile on the account, a session that binds NO profile
    // is never gated (the quota only applies to profile-backed launches).
    await createProfileWithSize(fx, 'fat-profile', TIER_STORAGE_BYTES_CAP.solo_manual);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });

  it('201 for enterprise over its cap — enterprise is soft-only (no hard block)', async () => {
    fx = await buildTestApp({ tier: 'enterprise' });
    const profileId = await createProfileWithSize(
      fx,
      'huge-profile',
      TIER_STORAGE_BYTES_CAP.enterprise + 1, // over the soft floor
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { profile_id: profileId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('409 on POST /v1/profiles/:id/launch when over the hard cap', async () => {
    fx = await buildTestApp({ tier: 'solo_manual' });
    const profileId = await createProfileWithSize(
      fx,
      'fat-profile',
      TIER_STORAGE_BYTES_CAP.solo_manual,
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<Record<string, unknown>>().type).toBe(PROBLEM_TYPES.StorageQuotaExceeded);
  });
});

describe('account scoping', () => {
  it('a session created by one account is invisible to another', async () => {
    const a = await buildTestApp({ tier: 'api_builder' });
    const b = await buildTestApp({ tier: 'api_builder' });
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
