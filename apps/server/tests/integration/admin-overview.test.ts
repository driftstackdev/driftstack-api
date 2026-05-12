// V-190 — integration tests for GET /v1/admin/overview.

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

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface OverviewResponse {
  accounts: { active: number; suspended: number; deleted: number; total: number };
  webhooks: { dlq_depth: number };
}

describe('GET /v1/admin/overview', () => {
  it('V-666.BT — sets Cache-Control: no-store, private', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('returns 200 with accounts + webhooks aggregate counts', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'second@driftstack.local',
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OverviewResponse>();
    expect(body.accounts.active).toBeGreaterThanOrEqual(2);
    expect(body.accounts.suspended).toBe(0);
    expect(body.webhooks.dlq_depth).toBe(0);
  });

  it('reflects suspended count after suspend mutation', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const targetId = '00000000-0000-4000-8000-0000000000b1';
    await seedAdditionalAccount(fx, {
      accountId: targetId,
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'tobesuspended@driftstack.local',
    });

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${targetId}/suspend`,
      headers: auth(fx),
      payload: { reason: 'overview test' },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OverviewResponse>();
    expect(body.accounts.suspended).toBe(1);
  });

  // V-515 — total + deleted counts.
  it('V-515 — exposes deleted count and computed total', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000c1',
      apiKeyId: '00000000-0000-4000-8000-0000000000c2',
      tier: 'team_manual',
      email: 'count-test@driftstack.local',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OverviewResponse>();
    expect(body.accounts.deleted).toBeGreaterThanOrEqual(0);
    expect(body.accounts.total).toBe(
      body.accounts.active + body.accounts.suspended + body.accounts.deleted,
    );
  });

  it('rejects without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});
