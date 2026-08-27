// V-192 — integration tests for GET /v1/admin/sessions cross-account list.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture, plaintext?: string): { authorization: string } => ({
  authorization: `Bearer ${plaintext ?? fixture.plaintext}`,
});

interface AdminSessionRow {
  id: string;
  account_id: string;
  status: string;
}

interface ListResponse {
  data: AdminSessionRow[];
  next_cursor: string | null;
}

async function createSession(fixture: TestAppFixture, plaintext: string): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: auth(fixture, plaintext),
    payload: {
      archetype: 'iphone16pro_ios18_7_safari26_4',
      purpose: 'production_customer',
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('GET /v1/admin/sessions', () => {
  it('200 lists sessions across all accounts when called by admin', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const second = await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'second@driftstack.local',
    });

    await createSession(fx, fx.plaintext);
    await createSession(fx, second.plaintext);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/sessions',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    const accountIds = new Set(body.data.map((s) => s.account_id));
    expect(accountIds.size).toBeGreaterThanOrEqual(2);
  });

  it('filters by account_id (prefixed)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const second = await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'second@driftstack.local',
    });
    await createSession(fx, fx.plaintext);
    await createSession(fx, second.plaintext);

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/sessions?account_id=acc_${second.accountId}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.account_id).toBe(`acc_${second.accountId}`);
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
      url: '/v1/admin/sessions?account_id=not-an-id',
      headers: auth(fx),
    });
    expect(malformed.statusCode, 'a malformed account_id is a bad request').toBe(400);

    const wrongPrefix = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/sessions?account_id=key_00000000-0000-4000-8000-0000000000c1',
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
      url: '/v1/admin/sessions',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

interface SessionStatsResponse {
  by_status: Record<string, number>;
  active: number;
  total: number;
}

describe('GET /v1/admin/sessions/stats', () => {
  it('returns counts by status (every status present) + active + total', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await createSession(fx, fx.plaintext);
    await createSession(fx, fx.plaintext);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/sessions/stats',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionStatsResponse>();
    // Every canonical status key is present (zero-filled).
    for (const status of ['creating', 'ready', 'busy', 'destroyed', 'errored']) {
      expect(typeof body.by_status[status]).toBe('number');
    }
    // The two freshly-created sessions are counted as active + total.
    expect(body.active).toBeGreaterThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(body.active);
    const sum = Object.values(body.by_status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(body.total);
  });

  it('rejects without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/sessions/stats',
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
        url: `/v1/admin/sessions?account_id=${bad}`,
        headers: auth(fx),
      });
      expect(res.statusCode, `36-char non-uuid "${bad}" must be a bad request, not a 500`).toBe(
        400,
      );
    }
  });
});
