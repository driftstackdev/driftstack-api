// V-194 — integration tests for GET /v1/admin/rate-limit-overrides.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface OverrideRow {
  id: string;
  account_id: string;
  bucket_key: string;
  expires_at: string;
}

interface ListResponse {
  data: OverrideRow[];
  next_cursor: string | null;
}

async function setOverride(
  fixture: TestAppFixture,
  bucketKey: string,
  durationSeconds: number,
): Promise<void> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: `/v1/admin/accounts/acc_${fixture.accountId}/quota-override`,
    headers: auth(fixture),
    payload: {
      bucket_key: bucketKey,
      capacity: 100,
      refill_per_second: 5,
      duration_seconds: durationSeconds,
      reason: 'test fixture',
    },
  });
  expect([200, 201]).toContain(res.statusCode);
}

describe('GET /v1/admin/rate-limit-overrides', () => {
  it('200 lists active overrides', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await setOverride(fx, 'global', 3600);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/rate-limit-overrides',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.bucket_key).toBe('global');
  });

  it('excludes expired overrides by default', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // Set with 1s TTL, then read after the deadline.
    await setOverride(fx, 'global', 1);
    await new Promise((r) => setTimeout(r, 1100));

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/rate-limit-overrides',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBe(0);
  });

  it('rejects without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/rate-limit-overrides',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});
