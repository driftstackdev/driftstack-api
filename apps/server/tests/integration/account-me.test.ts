// V-237 — integration tests for GET /v1/account/me.
//
// Customer self-profile endpoint powering the GUI client's tier-aware
// enforcement display. Returns identity + tier + concurrent + profile
// usage/cap. The cap values come from in-memory tier constants; the
// usage values come from live repo counts so they reflect mid-flight
// resource state.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { UploadAvatarRequestSchema } from '@driftstack/api-types';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface AccountMeResponse {
  id: string;
  email: string;
  name: string | null;
  tier: string;
  status: string;
  timezone: string | null;
  avatar_url: string | null;
  avatar_source: 'user' | 'idp' | 'none';
  /** V-353h — true when the calling account has MFA enrolled. */
  mfa_enrolled: boolean;
  concurrent_session_cap: number;
  concurrent_session_active: number;
  profile_cap: number | null;
  profile_count: number;
  teams: Array<{ owner_account_id: string; role: 'member' | 'admin'; membership_id: string }>;
}

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

describe('GET /v1/account/me', () => {
  it('V-666.BS — sets Cache-Control: no-store, private', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('200 returns identity + tier + zero usage on a freshly-seeded account', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AccountMeResponse>();
    expect(body.id).toBe(`acc_${fx.accountId}`);
    expect(body.tier).toBe('api_builder');
    expect(body.status).toBe('active');
    expect(typeof body.concurrent_session_cap).toBe('number');
    expect(body.concurrent_session_cap).toBeGreaterThan(0);
    expect(body.concurrent_session_active).toBe(0);
    expect(typeof body.profile_cap).toBe('number');
    expect(body.profile_count).toBe(0);
    expect(body.avatar_url).toBeNull();
    expect(body.avatar_source).toBe('none');
    // V-353h — MFA flag present, false on a fresh account.
    expect(body.mfa_enrolled).toBe(false);
  });

  it('reflects active session count after a session is created', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
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

    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<AccountMeResponse>().concurrent_session_active).toBe(1);
  });

  it('reflects profile count after a profile is created', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fx),
      payload: { name: 'one' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fx),
      payload: { name: 'two' },
    });

    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(me.json<AccountMeResponse>().profile_count).toBe(2);
  });

  it('returns null profile_cap on enterprise tier', async () => {
    // PROFILES_PER_TIER returns 'custom' for enterprise; the route
    // surfaces that as null to mean "no fixed cap; see your contract".
    fx = await buildTestApp({ tier: 'enterprise' });
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<AccountMeResponse>().profile_cap).toBeNull();
  });

  it('401 without an Authorization header', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /v1/account/me (V-352)', () => {
  it('403 when the key lacks account_owner scope (read/write key)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('account_owner');
  });

  // Item 6 — the structural invariant proves a report is wired next to this
  // parse; this proves the wiring actually produces the header, with the keys of
  // THIS schema. A report block copy-pasted from a neighbouring route would
  // satisfy the structural check and tag the wrong things here.
  it('CRITICAL a mistyped settings field is reported rather than silently ignored', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'Updated', timezonee: 'Europe/Amsterdam' },
    });
    expect(res.statusCode, 'reporting, not rejecting').toBe(200);
    expect(
      res.headers['x-driftstack-unknown-fields'],
      'the setting the customer meant to change was dropped and the call reported success',
    ).toBe('timezonee');
    // And the real update still applied, so reporting did not become rejecting.
    expect(res.json<{ name: string }>().name).toBe('Updated');
  });

  it('CRITICAL a well-formed settings update is not tagged', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'Updated', timezone: 'Europe/Amsterdam' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-driftstack-unknown-fields']).toBeUndefined();
  });

  it('200 updates name + timezone', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'Updated', timezone: 'Europe/Amsterdam' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string; timezone: string }>();
    expect(body.name).toBe('Updated');
    expect(body.timezone).toBe('Europe/Amsterdam');
    // Read-back via GET shows the new values.
    const me = await fx.app.inject({ method: 'GET', url: '/v1/account/me', headers: auth(fx) });
    const meBody = me.json<AccountMeResponse>();
    expect(meBody.name).toBe('Updated');
    expect(meBody.timezone).toBe('Europe/Amsterdam');
  });

  it('200 clears name to null + clears timezone to null', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: null, timezone: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string | null; timezone: string | null }>();
    expect(body.name).toBeNull();
    expect(body.timezone).toBeNull();
  });

  // 2026-06-03 — IANA timezone validation is Intl-based, not a regex. The
  // prior regex (`^[A-Za-z]+(?:/[A-Za-z0-9_+-]+)+$`) wrongly REJECTED valid
  // single-segment zones (UTC / GMT / Japan) — so a UTC-based customer
  // couldn't save their own timezone — and wrongly ACCEPTED non-zones that
  // merely matched "Area/City" (e.g. "Foo/Bar"). These two cases pin the fix.
  it('200 accepts a single-segment IANA zone (UTC) — regression: the old regex rejected it', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ timezone: string }>().timezone).toBe('UTC');
  });

  it('400 rejects a non-IANA timezone that merely looks like Area/City (Foo/Bar) — regression: the old regex accepted it', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { timezone: 'Foo/Bar' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── End-to-end shape pin: PATCH 200 returns the FULL AccountMeResponse,
  // matching GET /me + the OpenAPI claim + every SDK type. Previously the
  // route returned only the 8 written/persisted fields, leaving the other
  // 8 (avatar_url / avatar_source / mfa_enrolled / concurrent_session_* / profile_* /
  // teams) undefined on the SDK consumer — a type-vs-runtime mismatch
  // that all three SDK type checkers happily compiled. Test pins the
  // full shape so a future "trim the PATCH response" optimisation can't
  // silently break SDK consumers again.
  it('200 returns the full 16-field AccountMeResponse shape — matches GET /me', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'Shape Pin' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();

    // Identity + persisted-update fields (the 8 fields the previous
    // implementation returned).
    expect(body.id).toBe(`acc_${fx.accountId}`);
    expect(typeof body.email).toBe('string');
    expect(body.name).toBe('Shape Pin');
    expect(body.tier).toBe('api_builder');
    expect(body.status).toBe('active');
    // timezone may be string or null on a fresh account; just assert
    // the field is present (not undefined) on the response.
    expect(body).toHaveProperty('timezone');
    expect(body).toHaveProperty('slug');
    expect(body).toHaveProperty('region');

    // The 7 derived fields that were missing before the fix.
    expect(body).toHaveProperty('avatar_url'); // string | null
    expect(body.avatar_source).toBe('none');
    expect(typeof body.mfa_enrolled).toBe('boolean');
    expect(typeof body.concurrent_session_cap).toBe('number');
    expect(body.concurrent_session_cap as number).toBeGreaterThan(0);
    expect(typeof body.concurrent_session_active).toBe('number');
    expect(body).toHaveProperty('profile_cap'); // number | null
    expect(typeof body.profile_count).toBe('number');
    expect(Array.isArray(body.teams)).toBe(true);

    // Shape parity with GET /me — fetch and assert every key appears
    // in both responses. This is the load-bearing assertion: if the
    // PATCH handler ever trims a field back out, this check fails.
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<Record<string, unknown>>();
    const patchKeys = Object.keys(body).sort();
    const getKeys = Object.keys(meBody).sort();
    expect(patchKeys).toEqual(getKeys);
  });

  it('400 when body has no fields', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when timezone is not a renderable IANA zone', async () => {
    // 2026-06-03 — validation is now Intl-renderability (was a regex). A
    // value Intl.DateTimeFormat can't resolve → 400. (Renderable
    // abbreviations like "PST" are now ACCEPTED — they resolve to a real
    // offset; the prior regex rejected them only as a side-effect of
    // requiring an "Area/City" slash form, which also wrongly rejected
    // "UTC". See the UTC-accepted + Foo/Bar-rejected cases above.)
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { timezone: 'NotAZone' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── V-298a — account slug ────────────────────────────────────────────

describe('PATCH /v1/account/me — slug (V-298a)', () => {
  it('200 sets a valid slug + GET surfaces it', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { slug: 'acme-corp' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ slug: string }>().slug).toBe('acme-corp');

    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(me.json<AccountMeResponse & { slug: string | null }>().slug).toBe('acme-corp');
  });

  it('200 clears slug to null', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { slug: 'foo-bar' },
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { slug: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ slug: string | null }>().slug).toBeNull();
  });

  it.each([
    'AB', // too short
    'a', // too short
    'aa', // too short
    '-leadhyphen', // leading hyphen
    'trailhyphen-', // trailing hyphen
    'double--hyphen',
    'UPPER', // uppercase
    'has_underscore',
    'has space',
    'a'.repeat(33), // too long
    'has.dot',
  ])('400 rejects invalid slug %p', async (slug) => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { slug },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409 when slug is already taken by another account', async () => {
    fx = await buildTestApp();
    // First account claims the slug.
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { slug: 'taken-slug' },
    });

    // Second account on the same fixture tries to claim the same slug.
    const second = await import('./_helpers/build-test-app.js').then((m) =>
      m.seedAdditionalAccount(fx, {
        accountId: '00000000-0000-4000-8000-000000000099',
        apiKeyId: '00000000-0000-4000-8000-000000000a99',
        email: 'second@driftstack.local',
      }),
    );
    const conflict = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: {
        authorization: `Bearer ${second.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { slug: 'taken-slug' },
    });
    expect(conflict.statusCode).toBe(409);
  });
});

// Smallest valid PNG: 1x1 transparent. Hand-built byte sequence.
// Source: pngsuite-derived; bytes match what node-canvas et al emit for
// a 1x1 RGBA image.
const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

describe('POST /v1/account/me/avatar (V-352b)', () => {
  it('200 uploads avatar, surfaces avatar_url on subsequent GET /me', async () => {
    fx = await buildTestApp();
    const upload = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        content_type: 'image/png',
        data_base64: ONE_BY_ONE_PNG_BASE64,
      },
    });
    expect(upload.statusCode).toBe(200);
    const body = upload.json<{ avatar_url: string | null; bytes: number }>();
    expect(body.avatar_url).toMatch(/^https:\/\/r2-fake\.test\//);
    expect(body.bytes).toBeGreaterThan(0);

    // R2 store recorded the put.
    expect(fx.r2PublicStore.putCalls).toHaveLength(1);
    expect(fx.r2PublicStore.putCalls[0]?.contentType).toBe('image/png');
    expect(fx.r2PublicStore.putCalls[0]?.key).toBe(`avatars/${fx.accountId}.png`);

    // GET /me surfaces the same presigned URL pattern.
    const me = await fx.app.inject({ method: 'GET', url: '/v1/account/me', headers: auth(fx) });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<AccountMeResponse & { avatar_url: string | null }>();
    expect(meBody.avatar_url).toMatch(/^https:\/\/r2-fake\.test\//);
    expect(meBody.avatar_source).toBe('user');
  });

  it('400 when content_type is not in the allow-list', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        content_type: 'image/gif',
        data_base64: ONE_BY_ONE_PNG_BASE64,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(fx.r2PublicStore.putCalls).toHaveLength(0);
  });

  it('400 when data_base64 decodes to over 2 MiB', async () => {
    fx = await buildTestApp();
    // 2 MiB + 1 of decoded bytes → just over the cap. Encode a buffer
    // of all zeros at that size — Zod's max wire-size cap allows it
    // through, the route's byte-cap check rejects it. Stays under the
    // route's 3.5 MiB Fastify bodyLimit so we exercise our own 400.
    const tooBigBuf = Buffer.alloc(2 * 1024 * 1024 + 1, 0);
    const tooBigB64 = tooBigBuf.toString('base64');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        content_type: 'image/png',
        data_base64: tooBigB64,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(fx.r2PublicStore.putCalls).toHaveLength(0);
  });

  it('413 when payload exceeds Fastify bodyLimit', async () => {
    fx = await buildTestApp();
    // 4 MiB raw → ~5.5 MiB base64, well over the 3.5 MiB route limit.
    const wayTooBig = Buffer.alloc(4 * 1024 * 1024, 0).toString('base64');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { content_type: 'image/png', data_base64: wayTooBig },
    });
    expect(res.statusCode).toBe(413);
    expect(fx.r2PublicStore.putCalls).toHaveLength(0);
  });

  it('400 on empty data_base64 (Zod min)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { content_type: 'image/png', data_base64: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 without an Authorization header', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { 'content-type': 'application/json' },
      payload: {
        content_type: 'image/png',
        data_base64: ONE_BY_ONE_PNG_BASE64,
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /v1/account/me/avatar (V-352b)', () => {
  it('204 clears avatar pointer; subsequent GET /me has avatar_url null', async () => {
    fx = await buildTestApp();
    // Upload first.
    const up = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        content_type: 'image/png',
        data_base64: ONE_BY_ONE_PNG_BASE64,
      },
    });
    expect(up.statusCode).toBe(200);

    // Delete.
    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    // GET /me should show avatar_url null again.
    const me = await fx.app.inject({ method: 'GET', url: '/v1/account/me', headers: auth(fx) });
    expect(me.json<{ avatar_url: string | null }>().avatar_url).toBeNull();
  });

  it('204 on delete when no avatar was previously set (idempotent)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(204);
  });

  it('restores the OAuth fallback and exposes it as non-removable after clearing an upload', async () => {
    fx = await buildTestApp({
      oauthClient: {
        signingSecret: '0123456789abcdef0123456789abcdef',
        callbackUrlBase: 'https://api.test/oauth',
        dashboardOrigin: 'https://app.test',
        google: { clientId: 'google-client', clientSecret: 'google-secret' },
      },
    });
    await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'google',
      providerSub: 'google-avatar-user',
      providerEmail: 'avatar@example.test',
      providerName: 'Avatar User',
      providerAvatarUrl: 'https://images.example.test/idp-avatar.png',
    });

    const beforeUpload = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(beforeUpload.json<AccountMeResponse>()).toMatchObject({
      avatar_url: 'https://images.example.test/idp-avatar.png',
      avatar_source: 'idp',
    });

    const upload = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { content_type: 'image/png', data_base64: ONE_BY_ONE_PNG_BASE64 },
    });
    expect(upload.statusCode).toBe(200);
    const uploaded = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(uploaded.json<AccountMeResponse>().avatar_source).toBe('user');

    const remove = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
      headers: auth(fx),
    });
    expect(remove.statusCode).toBe(204);
    const restored = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(restored.json<AccountMeResponse>()).toMatchObject({
      avatar_url: 'https://images.example.test/idp-avatar.png',
      avatar_source: 'idp',
    });
  });

  it('401 without an Authorization header', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/avatar',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── V-298b — account region ──────────────────────────────────────────

describe('PATCH /v1/account/me — region (V-298b)', () => {
  it('200 sets a valid region + GET surfaces it', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { region: 'eu' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ region: string }>().region).toBe('eu');

    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: auth(fx),
    });
    expect(me.json<AccountMeResponse & { region: string | null }>().region).toBe('eu');
  });

  it('200 clears region to null', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { region: 'us' },
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { region: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ region: string | null }>().region).toBeNull();
  });

  it.each(['us', 'eu', 'apac'] as const)('accepts region %s', async (region) => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { region },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ region: string }>().region).toBe(region);
  });

  it.each(['EU', 'us-east', 'unknown', 'global', '', 'eu1'])(
    '400 rejects invalid region %p',
    async (region) => {
      fx = await buildTestApp();
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { region },
      });
      expect(res.statusCode).toBe(400);
    },
  );
});

describe('GET/PUT /v1/account/me/organization (per-account org-sync phase 3)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET returns an empty taxonomy on a fresh account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/organization',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ folders: [], tags: [] });
  });

  it('PUT persists the taxonomy; GET reads it back', async () => {
    fx = await buildTestApp();
    const payload = {
      folders: [{ name: 'Sales', icon: '🛒' }, { name: 'QA' }],
      tags: ['aged', 'warmup'],
    };
    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/organization',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload,
    });
    expect(put.statusCode).toBe(200);
    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/organization',
      headers: auth(fx),
    });
    expect(get.json()).toEqual(payload);
  });

  it('PUT 403 without granular or broad profile-write authority', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write:sessions'] });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/organization',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { folders: [], tags: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT 400 on a duplicate folder name', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/organization',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { folders: [{ name: 'Dup' }, { name: 'Dup' }], tags: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── avatar upload: the emptiness check ─────────────────────────────────────
//
// Added 2026-08-15. `POST /v1/account/me/avatar` had no arms; its
// `'Avatar image is empty.'` refusal had never executed.
//
// Reaching it takes a specific payload, and finding that out corrected a
// finding I had half-written. The schema already carries
// `.regex(/^[A-Za-z0-9+/=]+$/)`, so ordinary junk ('!!!!', 'not base64') is a
// Zod 400 long before the route runs. What slips through is a string of pure
// PADDING: '====' satisfies both `.min(4)` and the regex, and decodes to zero
// bytes. That is the only way in.
//
// The sibling branch at account-me.ts:776, `'data_base64 is not valid base64.'`,
// is DEAD CODE for two independent reasons and is deliberately not covered:
// `Buffer.from(x, 'base64')` never throws — verified, it silently drops
// non-alphabet characters — and the schema regex has already rejected anything
// that would make it throw. It is left in place because it costs nothing.
//
// V-957 corrects the rest of what this note used to say. It claimed a change to
// EITHER the regex or the decode call would make the branch live again. Only the
// decode call would. Removing the regex leaves the branch just as dead, because
// reason one does not depend on reason two — measured: with nothing but the
// decode in the way, `'!!!!'` yields 0 bytes, `'!!ABCD!!'` yields 3 and
// `'not base64 at all'` yields 10, and none of them throws.
//
// The distinction is not pedantry. As written, the note told a maintainer that
// weakening the schema was safe because a backstop would take over. There is no
// backstop: drop the regex and `'!!ABCD!!'` decodes to three bytes and is stored
// as somebody's avatar, silently. What actually protects the regex is that two
// guards pin it — `avatar-policy-cross-source-invariant` and
// `api-types-accounts-content-parity` — so its removal fails the suite. The
// `catch` contributes nothing to that and never did.

describe('POST /v1/account/me/avatar — emptiness', () => {
  it('CRITICAL the base64 regex is the only thing keeping non-base64 out, and the catch in the route is not a second line of defence. Asserted because the note above used to claim otherwise: a maintainer told the catch reactivates when the schema is weakened would drop the regex believing something still refuses the payload. Nothing does — the decode returns bytes and the upload proceeds.', () => {
    for (const [input, expectedBytes] of [
      ['!!!!', 0],
      ['!!ABCD!!', 3],
      ['not base64 at all', 10],
    ] as const) {
      // The route wraps exactly this call in the `catch` that is claimed to fire.
      expect(
        () => Buffer.from(input, 'base64'),
        `Buffer.from(${JSON.stringify(input)}, 'base64') must not throw — if it ever does, the route's catch is live and this note needs rewriting again`,
      ).not.toThrow();
      expect(
        Buffer.from(input, 'base64').length,
        `${JSON.stringify(input)} decodes silently rather than being refused`,
      ).toBe(expectedBytes);
    }
    // And the thing that DOES refuse it is the schema, so a caller never gets here.
    expect(
      UploadAvatarRequestSchema.safeParse({ content_type: 'image/png', data_base64: '!!ABCD!!' })
        .success,
      'the schema regex refuses non-base64 before the route runs — this is the real control',
    ).toBe(false);
  });

  it('CRITICAL a payload that decodes to zero bytes is refused. Pure base64 padding passes both the length floor and the character-class regex, so the schema cannot catch it; without this check a customer would get an "avatar" that is a zero-byte object in the public bucket, and every surface rendering it would show a broken image rather than the initials fallback.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { content_type: 'image/png', data_base64: '====' },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/empty/i);
  });

  it('CRITICAL a real payload still uploads, so the arm above is about emptiness rather than avatar upload being broken. Asserted because a route that refused every upload would satisfy the refusal arm and look correct.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/avatar',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      // A few real bytes — the route stores what it is given; format validation
      // is the content_type enum's job, not this branch's.
      payload: { content_type: 'image/png', data_base64: Buffer.from('hello').toString('base64') },
    });
    expect(res.statusCode, 'accepted').toBe(200);
    expect(res.json<{ avatar_url: string | null }>().avatar_url, 'and a URL comes back').toEqual(
      expect.any(String),
    );
  });
});
