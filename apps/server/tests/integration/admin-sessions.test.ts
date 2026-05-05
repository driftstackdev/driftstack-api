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
