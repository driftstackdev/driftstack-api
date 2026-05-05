// V-193 — integration tests for GET /v1/admin/api-keys cross-account list.

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

interface AdminKeyRow {
  id: string;
  account_id: string;
  revoked_at: string | null;
}

interface ListResponse {
  data: AdminKeyRow[];
  next_cursor: string | null;
}

describe('GET /v1/admin/api-keys', () => {
  it('200 lists keys across all accounts when called by admin', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'second@driftstack.local',
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/api-keys',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    const accountIds = new Set(body.data.map((r) => r.account_id));
    expect(accountIds.size).toBeGreaterThanOrEqual(2);
  });

  it('filters by revoked=false to exclude revoked keys', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/api-keys?revoked=false',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.every((k) => k.revoked_at === null)).toBe(true);
  });

  it('rejects without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/api-keys',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});
