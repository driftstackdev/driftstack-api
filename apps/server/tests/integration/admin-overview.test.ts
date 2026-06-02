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
  accounts: {
    active: number;
    suspended: number;
    deleted: number;
    total: number;
    by_tier: Record<string, number>;
    signups: { today: number; last_7d: number; last_30d: number };
  };
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

  // Tier distribution — every AccountTier key present (zero-filled),
  // the seeded team_manual account shows up, and the distribution sums
  // to the total row count (all statuses).
  it('exposes by_tier distribution covering every tier and summing to total', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000d1',
      apiKeyId: '00000000-0000-4000-8000-0000000000d2',
      tier: 'team_manual',
      email: 'tier-test@driftstack.local',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OverviewResponse>();
    // Canonical AccountTier set is always present, zero-filled.
    for (const tier of [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(body.accounts.by_tier[tier]).toBeGreaterThanOrEqual(0);
    }
    expect(body.accounts.by_tier.team_manual).toBeGreaterThanOrEqual(1);
    expect(body.accounts.by_tier.api_builder).toBeGreaterThanOrEqual(1);
    const tierSum = Object.values(body.accounts.by_tier).reduce((a, b) => a + b, 0);
    expect(tierSum).toBe(body.accounts.total);
  });

  // Signup windows are wired into the response with the right shape. The
  // windows are defined as nested (wider ⊇ narrower), so the counts are
  // monotonically nondecreasing regardless of seed dates. The exact
  // window-bucketing math is asserted deterministically in the service unit
  // test (admin-accounts-service.test.ts), which controls createdAt + now.
  it('exposes a well-formed signups object (today ≤ 7d ≤ 30d) wired into the overview', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const { signups } = res.json<OverviewResponse>().accounts;
    expect(typeof signups.today).toBe('number');
    expect(signups.today).toBeGreaterThanOrEqual(0);
    expect(signups.last_7d).toBeGreaterThanOrEqual(signups.today);
    expect(signups.last_30d).toBeGreaterThanOrEqual(signups.last_7d);
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
