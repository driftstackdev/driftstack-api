// End-to-end integration tests for the eight session endpoints.
// Uses the in-memory test fixture; verifies HTTP shapes, error mapping,
// ownership scoping, and concurrency limits.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROBLEM_TYPES,
  SESSION_METADATA_MAX_BYTES,
  TIER_STORAGE_BYTES_CAP,
} from '@driftstack/api-types';
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

// V-732 — the single-live-session-per-profile guard must key on the profile
// binding the ROUTE validated, never on `metadata`.
//
// `metadata` is documented as "an arbitrary JSON object for the customer's own
// bookkeeping" and its schema is `z.record(z.unknown())`. The service used to
// lift `metadata.profile_id` back out and hand it to the atomic reserve, so a
// customer who never touched Driftstack profiles but happened to keep their own
// `profile_id` key got a hard `409 profile-in-use` on every session create
// after the first — a control-plane decision made from customer-controlled
// input.
// Item 6, on the route the item's own comment describes.
//
// `archetype` is optional on session create, so a mistyped key is stripped by
// zod and the session is built against the default device instead. The customer
// gets 201 and a session that appears as something other than what they asked
// for — in a product whose value is which device you appear to be, the whole
// configuration, silently substituted and reported as success.
//
// The decision recorded with this mechanism is to REPORT rather than reject:
// making the schema strict would fix the silence and break every client already
// sending an extra field. So the arms below pin both halves — the request still
// succeeds exactly as before, and the ignored key stops being invisible.
describe('POST /v1/sessions reports fields it ignored', () => {
  it('CRITICAL a mistyped archetype is reported rather than silently defaulted', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { archetypeee: 'iphone16pro_ios18_7_safari26_4', label: 'typo' },
    });
    expect(res.statusCode, 'reporting, not rejecting — an existing client must not break').toBe(
      201,
    );
    expect(
      res.headers['x-driftstack-unknown-fields'],
      'the session was created against a device the customer did not ask for, and nothing said so',
    ).toBe('archetypeee');
  });

  it('CRITICAL a well-formed create is not tagged', async () => {
    // Without this, tagging every request would satisfy the arm above while
    // making the header meaningless.
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { label: 'clean' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-driftstack-unknown-fields']).toBeUndefined();
  });

  it('a body-less create still succeeds', async () => {
    // The reporter reads the RAW body, which is `undefined` here rather than an
    // object. Pinned because the obvious refactor -- routing this through the
    // parse+report helper -- reads `request.body` directly and would turn this
    // 201 into a 400.
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(fx) });
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /v1/sessions — the profile guard ignores customer metadata', () => {
  it('allows a second session when the customer stores their own profile_id in metadata', async () => {
    fx = await buildTestApp();
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { metadata: { profile_id: 'my-own-crm-id' } },
    });
    expect(first.statusCode).toBe(201);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { metadata: { profile_id: 'my-own-crm-id' } },
    });

    // Never a 409: no Driftstack profile is involved in either create.
    expect(second.statusCode).toBe(201);
  });

  it('still stamps the customer metadata through unchanged', async () => {
    // The guard stops reading it; the field is still the customer's to use.
    fx = await buildTestApp();
    const created = await createSession(fx, { metadata: { profile_id: 'my-own-crm-id' } });
    expect((created as unknown as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      profile_id: 'my-own-crm-id',
    });
  });
});

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
    await vi.waitFor(() => expect(fx.sessionsRepo.getEvents()).toHaveLength(1));
    expect(fx.sessionsRepo.getEvents()[0]).toMatchObject({
      type: 'created',
      payload: {
        archetype: 'iphone17_ios18_7_safari26_4',
        purpose: 'production_customer',
      },
      durationMs: null,
    });
    expect(fx.sessionsRepo.getEvents()[0]?.payload).not.toHaveProperty('driver_session_id');
  });

  it('429 ConcurrencyLimit when an API-enabled single-session tier is already at limit', async () => {
    fx = await buildTestApp({ tier: 'solo_manual' });
    await createSession(fx); // Solo Manual limit = 1

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

  it('400 rejects a well-formed but unknown archetype before creating a session row', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { archetype: 'unknown_ios18_7_safari26_4' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Record<string, unknown>>().type).toBe(PROBLEM_TYPES.ValidationFailed);
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
  });

  it('201 preserves a reference archetype inherited from an existing legacy profile', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = '11111111-1111-4111-8111-111111111111';
    await fx.profilesRepo.insert({
      id: profileId,
      accountId: fx.accountId,
      name: 'legacy-reference',
      archetype: 'iphone15pro_ios17_5_safari17_5',
      description: null,
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { profile_id: `prof_${profileId}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Record<string, unknown>>().archetype).toBe('iphone15pro_ios17_5_safari17_5');
  });

  it('201 accepts metadata at the exact 8 KiB serialized ASCII boundary', async () => {
    fx = await buildTestApp();
    const overheadBytes = new TextEncoder().encode(JSON.stringify({ note: '' })).byteLength;
    const metadata = { note: 'a'.repeat(SESSION_METADATA_MAX_BYTES - overheadBytes) };
    expect(new TextEncoder().encode(JSON.stringify(metadata))).toHaveLength(
      SESSION_METADATA_MAX_BYTES,
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { metadata },
    });
    expect(res.statusCode).toBe(201);
  });

  it('201 accepts metadata at the exact 8 KiB serialized UTF-8 emoji boundary', async () => {
    fx = await buildTestApp();
    const overheadBytes = new TextEncoder().encode(JSON.stringify({ note: '' })).byteLength;
    const metadata = {
      note: `${'a'.repeat(SESSION_METADATA_MAX_BYTES - overheadBytes - 4)}😀`,
    };
    expect(new TextEncoder().encode(JSON.stringify(metadata))).toHaveLength(
      SESSION_METADATA_MAX_BYTES,
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { metadata },
    });
    expect(res.statusCode).toBe(201);
  });

  it('400 rejects metadata one UTF-8 byte over the 8 KiB serialized cap', async () => {
    fx = await buildTestApp();
    const overheadBytes = new TextEncoder().encode(JSON.stringify({ note: '' })).byteLength;
    const metadata = {
      note: `${'a'.repeat(SESSION_METADATA_MAX_BYTES - overheadBytes - 3)}😀`,
    };
    expect(new TextEncoder().encode(JSON.stringify(metadata))).toHaveLength(
      SESSION_METADATA_MAX_BYTES + 1,
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: { metadata },
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
  it('CRITICAL a mistyped action field is reported rather than silently ignored', async () => {
    // The action routes carry the same hazard as create, one layer down: a
    // mistyped option is stripped and the automation runs with the default
    // instead. The request still succeeds, so without the header the customer's
    // only signal is that the browser did something other than what they wrote.
    fx = await buildTestApp();
    const session = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/navigate`,
      headers: auth(fx),
      payload: { url: 'https://example.com', wait_untill: 'load' },
    });
    expect(res.statusCode, 'reporting, not rejecting').toBe(200);
    expect(res.headers['x-driftstack-unknown-fields']).toBe('wait_untill');
  });

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

  // Swept services/sessions.ts — all 19 refusal sites against 212 session tests.
  // Five uncovered; this is the one that is a customer-visible behaviour rather
  // than an internal invariant.
  //
  // ⚠️ `destroy` has THREE copies of the not-found refusal and the other two are
  // covered. This one is the outcome of the serialized destroy itself: the
  // compare-and-set reports the row was never there, as opposed to the earlier
  // reads that look it up. Sixth time today that a rule implemented more than
  // once was tested in only some of its copies.
  //
  // 204-on-repeat is the neighbouring case and is already covered: destroying an
  // ALREADY-DESTROYED session is idempotent, not an error. So the two outcomes
  // must stay distinguishable — a session that never existed is a 404, and one
  // that existed and is gone is a success.
  //
  // LEDGER — control 56/56:
  //
  //   :1071 destroy not_found neutralized           1 red
  //   not_found COLLAPSED into already_terminal     1 red
  //
  // The second row is the realistic regression: someone simplifying "both mean
  // there is nothing to destroy" into one `return` makes every unknown id answer
  // 204. That is not a refusal being removed — it is a 404 becoming a success,
  // so a client deleting the wrong id is told the deletion worked.
  it('CRITICAL 404 destroying a session id that was never created, while a repeat destroy of a REAL session stays idempotent — the two must not collapse', async () => {
    fx = await buildTestApp();
    const unknown = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/sessions/ses_00000000-0000-4000-8000-0000000000ff',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(unknown.statusCode, unknown.body).toBe(404);

    // The contrast that makes the 404 mean something: a real session destroyed
    // twice answers 204 both times. Without this half, a build that 404'd every
    // destroy would satisfy the assertion above.
    const session = await createSession(fx);
    const first = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${session.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(first.statusCode).toBe(204);
    const second = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${session.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(second.statusCode, 'a repeat destroy is idempotent, not a 404').toBe(204);
  });

  it('serializes five concurrent deletes into one driver call, event, and customer audit', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const session = await createSession(fx);
    const bareSessionId = session.id.replace(/^ses_/, '');
    const destroySpy = vi.spyOn(fx.driver, 'destroy');

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fx.app.inject({
          method: 'DELETE',
          url: `/v1/sessions/${session.id}`,
          headers: auth(fx),
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204, 204, 204, 204]);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(
      fx.sessionsRepo
        .getEvents()
        .filter((event) => event.sessionId === bareSessionId && event.type === 'destroyed'),
    ).toHaveLength(1);
    expect(
      fx.accountAuditRepo
        .getAll()
        .filter((row) => row.action === 'session.destroyed' && row.targetResourceId === session.id),
    ).toHaveLength(1);
  });
});

describe('POST /v1/profiles/:id/launch request boundary', () => {
  async function createProfile(fixture: TestAppFixture, name: string): Promise<string> {
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fixture),
      payload: { name },
    });
    if (res.statusCode !== 200) {
      throw new Error(`profile create failed ${String(res.statusCode)}: ${res.body}`);
    }
    return res.json<{ id: string }>().id;
  }

  it('accepts a label at the exact 120-character canonical boundary', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfile(fx, 'label-120');
    const label = 'a'.repeat(120);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: auth(fx),
      payload: { label },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ label: string }>().label).toBe(label);
  });

  it('rejects a 121-character label before profile lookup, driver create, or session row', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfile(fx, 'label-121');
    const profileLookup = vi.spyOn(fx.profilesRepo, 'findById');
    const driverCreate = vi.spyOn(fx.driver, 'createSession');
    const sessionInsert = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: auth(fx),
      payload: { label: 'a'.repeat(121) },
    });
    expect(res.statusCode).toBe(400);
    expect(profileLookup).not.toHaveBeenCalled();
    expect(driverCreate).not.toHaveBeenCalled();
    expect(sessionInsert).not.toHaveBeenCalled();
    expect(await fx.sessionsRepo.listActiveByAccount(fx.accountId)).toHaveLength(0);
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
  });

  it('strictly rejects an unknown launch key before profile lookup or session side effects', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfile(fx, 'strict-body');
    const profileLookup = vi.spyOn(fx.profilesRepo, 'findById');
    const driverCreate = vi.spyOn(fx.driver, 'createSession');
    const sessionInsert = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: auth(fx),
      payload: { future_transport: 'silently-stripped' },
    });
    expect(res.statusCode).toBe(400);
    expect(profileLookup).not.toHaveBeenCalled();
    expect(driverCreate).not.toHaveBeenCalled();
    expect(sessionInsert).not.toHaveBeenCalled();
    expect(await fx.sessionsRepo.listActiveByAccount(fx.accountId)).toHaveLength(0);
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
  });

  it('rejects raw proxy before profile lookup and points to saved-proxy agent sessions', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfile(fx, 'raw-proxy');
    const profileLookup = vi.spyOn(fx.profilesRepo, 'findById');
    const driverCreate = vi.spyOn(fx.driver, 'createSession');
    const sessionInsert = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: auth(fx),
      payload: { proxy: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/owned saved proxy_id/);
    expect(profileLookup).not.toHaveBeenCalled();
    expect(driverCreate).not.toHaveBeenCalled();
    expect(sessionInsert).not.toHaveBeenCalled();
    expect(await fx.sessionsRepo.listActiveByAccount(fx.accountId)).toHaveLength(0);
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
  });

  it('required-egress posture disables profile launch even without a raw proxy field', async () => {
    fx = await buildTestApp({ tier: 'api_builder', sessionProxyRequired: true });
    const profileId = await createProfile(fx, 'required-egress');
    const profileLookup = vi.spyOn(fx.profilesRepo, 'findById');
    const driverCreate = vi.spyOn(fx.driver, 'createSession');
    const sessionInsert = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Direct session creation is disabled/);
    expect(profileLookup).not.toHaveBeenCalled();
    expect(driverCreate).not.toHaveBeenCalled();
    expect(sessionInsert).not.toHaveBeenCalled();
    expect(await fx.sessionsRepo.listActiveByAccount(fx.accountId)).toHaveLength(0);
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
  });

  // ─── team-RBAC on launch ────────────────────────────────────────────────
  //
  // Added 2026-08-15. `sessions.ts:345` is the launch half of the admin-role
  // write gate, and it was the LAST of eleven such gates in the codebase with no
  // execution behind it — established per-site against the coverage
  // statementMap, after an earlier enumeration found only five because it
  // grepped `require admin role` and missed the `requires` verb form.
  //
  // Launch is the write with the largest blast radius on this route file: it
  // creates a live session, binds a profile, and meters against the OWNER's tier
  // and storage quota. A member with read access silently gaining it would spend
  // the owner's concurrency and quota without appearing anywhere in the owner's
  // own actions.
  //
  // MUTATION-PROVED against routes/sessions.ts — control 55/55 here, 20/20 on
  // routes-sessions-content-parity:
  //
  //                                                     here    parity pin
  //   the role comparison inverted                     2 red      GREEN
  //   the gate removed entirely                        1 red      GREEN
  //   the gate moved BELOW the owner resolution        1 red      GREEN
  //
  // The third is the one that would be easy to wave through in review, because
  // the gate is still there and still correct — only its POSITION moved. The
  // observed effect: the member no longer receives the role refusal at all. They
  // get a 404 from the owner-scoped profile lookup instead of the 403 that names
  // the reason, and by then `consumeEffectiveOwnerRateLimit` has already charged
  // the owner's bucket for a request that was never allowed. A refusal that
  // arrives after the metering is not the same refusal.
  //
  // The parity pin is green on all three. It matches the `throw` and the message
  // wherever they sit in the file, which is exactly what an ordering change does
  // not disturb.

  const TEAM_OWNER = '00000000-0000-4000-8000-0000000ab001';

  function joinOwnerTeam(fixture: TestAppFixture, role: 'member' | 'admin'): void {
    fixture.authRepo.upsertAccount({
      id: TEAM_OWNER,
      email: 'launch-owner@example.test',
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    fixture.authRepo.setTeamMemberships(fixture.accountId, [
      { membershipId: '00000000-0000-4000-8000-0000000ab002', ownerAccountId: TEAM_OWNER, role },
    ]);
  }

  it('CRITICAL a non-admin team member cannot LAUNCH a profile on the owner, and is refused before any side effect. Launch creates a live session, binds a profile and meters the owner’s concurrency and storage; a member gaining it silently would spend the owner’s quota without appearing in anything the owner did. The spies are the point — a refusal that happens after the driver call has already leaked a session.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfile(fx, 'rbac-launch');
    joinOwnerTeam(fx, 'member');
    const driverCreate = vi.spyOn(fx.driver, 'createSession');
    const sessionInsert = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: { ...auth(fx), 'x-driftstack-account': `acc_${TEAM_OWNER}` },
      payload: { label: 'member-launch' },
    });

    expect(res.statusCode, 'refused with Forbidden').toBe(403);
    expect(res.json<{ detail: string }>().detail, 'and named the reason').toBe(
      'Launching a profile on a team owner requires admin role on that team.',
    );
    expect(driverCreate, 'no browser was started').not.toHaveBeenCalled();
    expect(sessionInsert, 'and no session row was written').not.toHaveBeenCalled();
  });

  it('CRITICAL an ADMIN team member is NOT stopped by the role gate. Every refusal above is satisfied by a gate that refuses all team launches, which would leave a team with no one able to launch on the owner at all — asserted as "not this refusal" rather than a success code, because the request continues into profile binding this fixture has not set up.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfile(fx, 'rbac-launch-admin');
    joinOwnerTeam(fx, 'admin');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/launch`,
      headers: { ...auth(fx), 'x-driftstack-account': `acc_${TEAM_OWNER}` },
      payload: { label: 'admin-launch' },
    });

    expect(
      res.json<{ detail?: string }>().detail ?? '',
      'the admin cleared the gate',
    ).not.toContain('requires admin role');
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
