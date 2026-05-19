// End-to-end integration test: GET /version exposes the build
// version metadata. Operational ops needs this to verify deploys
// rolled correctly; customer SDKs may include it in support
// reports. Response is public (no auth) + small fixed shape.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('GET /version end-to-end', () => {
  it('GET /version → 200 without auth', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('Response carries at least one identifying field (sha, version, or build_id)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    const body = res.json<Record<string, unknown>>();
    const hasIdentifyingField =
      'sha' in body ||
      'version' in body ||
      'build_id' in body ||
      'commit' in body ||
      'commit_sha' in body;
    expect(hasIdentifyingField).toBe(true);
  });

  it('Response does NOT leak internal env vars or secrets', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    const body = res.payload;
    expect(body).not.toMatch(/STRIPE_/);
    expect(body).not.toMatch(/MFA_ENCRYPTION_KEY/);
    expect(body).not.toMatch(/POSTMARK_/);
    expect(body).not.toMatch(/sk_live_/);
    expect(body).not.toMatch(/sk_test_/);
  });

  it('GET /version with auth header still succeeds (auth is optional, not gated)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/version',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
