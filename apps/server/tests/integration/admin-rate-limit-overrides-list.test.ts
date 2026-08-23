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

  // V-1342 — the id-format refusal, which coverage showed had never executed in
  // either of the two route files carrying its own copy of `uuidFromPrefixedId`.
  //
  // The second half is the one the regex cannot do. `PUBLIC_ID_RE` accepts ANY
  // three-letter prefix, so a well-formed id belonging to a different resource
  // matches it and only the `startsWith` check refuses — without that, an id for
  // one resource is silently accepted where another is expected and the uuid is
  // looked up against the wrong table.
  it('CRITICAL refuses a malformed account_id, and refuses a WELL-FORMED id carrying another resource prefix. The second is the case the shared regex passes: it matches any three-letter prefix, so `key_<uuid>` is a valid-looking id here and only the prefix check separates it from `acc_<uuid>`.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    const malformed = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/rate-limit-overrides?account_id=not-an-id',
      headers: auth(fx),
    });
    expect(malformed.statusCode, 'a malformed account_id is a bad request').toBe(400);

    const wrongPrefix = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/rate-limit-overrides?account_id=key_00000000-0000-4000-8000-0000000000c1',
      headers: auth(fx),
    });
    expect(
      wrongPrefix.statusCode,
      'an api-key id where an account id is expected must not be accepted',
    ).toBe(400);
    expect(
      wrongPrefix.json<{ detail?: string }>().detail,
      'and the refusal names the id shape it wanted',
    ).toContain('acc_<uuid>');
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
