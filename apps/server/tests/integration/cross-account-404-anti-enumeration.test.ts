// End-to-end integration test: every customer-facing route that
// scopes to the calling account MUST 404 (NOT 403) on cross-account
// reference attempts. Drift to 403 would leak resource existence
// to attackers performing enumeration.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  type TestAppFixture,
  seedAdditionalAccount,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('cross-account 404 anti-enumeration end-to-end', () => {
  it("GET /v1/sessions/:id of an account-A session via account-B's key → 404 (not 403)", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // Create a session owned by account A.
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'a-session' },
    });
    expect(createRes.statusCode).toBe(201);
    const sessionId = createRes.json<{ id: string }>().id;

    // Seed account B and try to read account A's session.
    const other = await seedAdditionalAccount(fx, {
      email: 'b@anti-enum.test',
      tier: 'api_builder',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ type?: string }>();
    expect(body.type).toMatch(/not-found/);
  });

  it('GET /v1/sessions/:id of a NONEXISTENT session also 404s with the same shape (indistinguishable from cross-account)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_99999999-9999-4999-8999-999999999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ type?: string }>();
    expect(body.type).toMatch(/not-found/);
  });

  it("DELETE on account-A session via account-B's key → 404 (not 403)", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'a-session' },
    });
    const sessionId = createRes.json<{ id: string }>().id;

    const other = await seedAdditionalAccount(fx, {
      email: 'b2@anti-enum.test',
      tier: 'api_builder',
    });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
