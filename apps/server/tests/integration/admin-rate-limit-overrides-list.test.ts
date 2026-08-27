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
  // V-2005 — the arm above refuses `not-an-id` (9 chars) and `key_<uuid>` (40), so it
  // never reached the branch that accepted a BARE uuid. That branch tested
  // `.length === 36`, and a length is not a shape: 36 dashes are 36 characters and
  // went straight into a Postgres `uuid` column, answering 500 where the boundary
  // owes 400. Both inputs here are EXACTLY 36 characters — that is the whole point
  // of them, and an arm that forgets it stops testing this the moment someone
  // "tidies" the literals.
  it('CRITICAL refuses a 36-character account_id that is not a uuid — the length that used to bypass the shape check', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    const dashes = '------------------------------------';
    const hexNoDashes = '0123456789abcdef0123456789abcdef0123';
    expect(dashes.length, 'the input must be 36 chars or it misses the branch').toBe(36);
    expect(hexNoDashes.length, 'the input must be 36 chars or it misses the branch').toBe(36);

    for (const bad of [dashes, hexNoDashes]) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/admin/rate-limit-overrides?account_id=${bad}`,
        headers: auth(fx),
      });
      expect(res.statusCode, `36-char non-uuid "${bad}" must be a bad request, not a 500`).toBe(
        400,
      );
    }
  });
});
