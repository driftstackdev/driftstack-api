// V-204 — integration tests for /v1/account/email-preferences.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface PrefsRow {
  event_type: string;
  opted_in: boolean;
}
interface ListResponse {
  data: PrefsRow[];
}

describe('GET /v1/account/email-preferences', () => {
  it('200 returns all opt-outable events with default opted_in=true', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBe(8);
    expect(body.data.every((p) => p.opted_in)).toBe(true);
    const types = body.data.map((p) => p.event_type).sort();
    expect(types).toEqual([
      'billing-receipt',
      'billing-renewal-reminder',
      'session-failed-first',
      'session-success-first',
      'signup-welcome',
      'tier-changed',
      'trial-pack-expired',
      'trial-pack-purchased',
    ]);
  });
});

describe('PUT /v1/account/email-preferences', () => {
  it('204 setting opted_in=false persists + reflects in subsequent GET', async () => {
    fx = await buildTestApp();
    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
      payload: { event_type: 'tier-changed', opted_in: false },
    });
    expect(put.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    const tierChanged = body.data.find((p) => p.event_type === 'tier-changed');
    expect(tierChanged?.opted_in).toBe(false);
    // Other events unaffected.
    const others = body.data.filter((p) => p.event_type !== 'tier-changed');
    expect(others.every((p) => p.opted_in)).toBe(true);
  });

  it('204 re-opting in (true) clears the explicit opt-out row', async () => {
    fx = await buildTestApp();
    // Opt out first.
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
      payload: { event_type: 'trial-pack-purchased', opted_in: false },
    });
    // Re-opt in.
    const reopen = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
      payload: { event_type: 'trial-pack-purchased', opted_in: true },
    });
    expect(reopen.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.every((p) => p.opted_in)).toBe(true);
  });

  it('400 on unknown event_type', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
      payload: { event_type: 'signup-verification', opted_in: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on missing fields', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: auth(fx),
      payload: { event_type: 'tier-changed' },
    });
    expect(res.statusCode).toBe(400);
  });
});
