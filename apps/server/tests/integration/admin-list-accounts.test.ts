// V-083: integration tests for the new GET /v1/admin/accounts list +
// GET /v1/admin/accounts/:id detail endpoints.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface AdminAccount {
  id: string;
  email: string;
  tier: string;
  status: string;
}

interface ListResponse {
  data: AdminAccount[];
  has_more: boolean;
  next_cursor: string | null;
}

describe('GET /v1/admin/accounts', () => {
  it('200 lists all accounts (paginated, default limit)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'second@driftstack.local',
    });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000c1',
      apiKeyId: '00000000-0000-4000-8000-0000000000c2',
      tier: 'api_scale',
      email: 'third@driftstack.local',
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('filters by tier', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'manual@driftstack.local',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts?tier=team_manual',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.every((a) => a.tier === 'team_manual')).toBe(true);
    expect(body.data.length).toBe(1);
  });

  it('filters by status', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      accountStatus: 'suspended',
      email: 'suspended@driftstack.local',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts?status=suspended',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.every((a) => a.status === 'suspended')).toBe(true);
    expect(body.data.length).toBe(1);
  });

  it('filters by email substring (case-insensitive)', async () => {
    fx = await buildTestApp({ email: 'matchme@driftstack.local' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      email: 'no-overlap@driftstack.local',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts?email_contains=MATCHME',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.email).toBe('matchme@driftstack.local');
  });

  it('paginates with cursor (limit=1, two accounts)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      email: 'second@driftstack.local',
    });

    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts?limit=1',
      headers: auth(fx),
    });
    const firstBody = first.json<ListResponse>();
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.has_more).toBe(true);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts?limit=1&cursor=${firstBody.next_cursor!}`,
      headers: auth(fx),
    });
    const secondBody = second.json<ListResponse>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.data[0]?.id).not.toBe(firstBody.data[0]?.id);
  });

  it('403 Forbidden without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Forbidden);
  });
});

describe('GET /v1/admin/accounts/:id', () => {
  it('200 returns the account detail', async () => {
    fx = await buildTestApp({ email: 'detail@driftstack.local', tier: 'api_starter' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${fx.accountId}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminAccount>();
    expect(body.id).toBe(`acc_${fx.accountId}`);
    expect(body.email).toBe('detail@driftstack.local');
    expect(body.tier).toBe('api_starter');
  });

  it('404 NotFound on unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000099',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 BadRequest on malformed id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts/not-a-prefixed-id',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 Forbidden without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${fx.accountId}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});
