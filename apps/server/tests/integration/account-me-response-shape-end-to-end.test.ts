// End-to-end integration test: GET /v1/account/me response shape.
// The customer SDK + dashboard both depend on a stable field set
// (id + email + tier + status + at-minimum). Drift on shape would
// break customer integrations + dashboard renders.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('GET /v1/account/me response shape end-to-end', () => {
  it('returns 200 with required fields (id + email + tier + status)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', email: 'me-test@driftstack.local' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id?: string; email?: string; tier?: string; status?: string }>();
    expect(body.id).toBeDefined();
    expect(body.email).toBe('me-test@driftstack.local');
    expect(body.tier).toBe('api_builder');
    expect(body.status).toBe('active');
  });

  it('id is acc_-prefixed UUID', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ id?: string }>();
    expect(body.id).toMatch(/^acc_/);
  });

  it('NEVER leaks the api_key hash or other sensitive auth-state in the response', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.payload;
    expect(body).not.toMatch(/keyHash/);
    expect(body).not.toMatch(/api_key.*hash/);
    expect(body).not.toMatch(/totp_secret/);
    expect(body).not.toMatch(/totpSecret/);
  });

  it('response Content-Type is application/json (NOT problem+json on 200)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-type']).not.toMatch(/problem\+json/);
  });
});
