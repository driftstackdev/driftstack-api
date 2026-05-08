// V-237 — integration tests for GET /v1/account/me.
//
// Customer self-profile endpoint powering the GUI client's tier-aware
// enforcement display. Returns identity + tier + concurrent + profile
// usage/cap. The cap values come from in-memory tier constants; the
// usage values come from live repo counts so they reflect mid-flight
// resource state.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

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

  it('400 when timezone is not an IANA name', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { timezone: 'PST' },
    });
    expect(res.statusCode).toBe(400);
  });
});
