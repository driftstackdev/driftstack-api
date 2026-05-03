// Cross-account suspend → blocked → unsuspend → restored round-trip.
//
// V-017 had to drop this test because the buildTestApp seeded both
// fixtures with the same hardcoded accountId — admin A and target B
// were the same account, so once A suspended itself, A couldn't call
// unsuspend. M1 (accountId option) + M2 (seedAdditionalAccount) close
// that gap; this file is the test that motivated the fixture work.

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

describe('admin: suspend → blocked → unsuspend → restored', () => {
  it('admin A can suspend account B; B is blocked; A can unsuspend; B works again', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const target = await seedAdditionalAccount(fx, { tier: 'api_builder' });

    const adminAuth = { authorization: `Bearer ${fx.plaintext}` };
    const targetAuth = { authorization: `Bearer ${target.plaintext}` };

    // 1. Sanity: B can use the API.
    const before = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(before.statusCode).toBe(200);

    // 2. Admin A suspends B.
    const suspend = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${target.accountId}/suspend`,
      headers: adminAuth,
      payload: { reason: 'cross-account suspend test' },
    });
    expect(suspend.statusCode).toBe(200);
    const suspendBody = suspend.json<Record<string, unknown>>();
    expect(suspendBody.status).toBe('suspended');

    // 3. B is now blocked at the auth boundary — every request 403s.
    const blockedSessions = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(blockedSessions.statusCode).toBe(403);

    const blockedAdminCall = await fx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: targetAuth,
    });
    expect(blockedAdminCall.statusCode).toBe(403);

    // 4. Admin A's keys still work — A is a different account.
    const adminCheck = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: adminAuth,
    });
    expect(adminCheck.statusCode).toBe(200);

    // 5. Admin A unsuspends B.
    const unsuspend = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${target.accountId}/unsuspend`,
      headers: adminAuth,
      payload: {},
    });
    expect(unsuspend.statusCode).toBe(200);
    expect(unsuspend.json<Record<string, unknown>>().status).toBe('active');

    // 6. B's keys work again on the next request.
    const afterRestore = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(afterRestore.statusCode).toBe(200);

    // 7. Audit log records both actions targeting B.
    const all = fx.adminAuditRepo.getAll();
    const targetingB = all.filter((r) => r.targetAccountId === target.accountId);
    expect(targetingB.map((r) => r.action).sort()).toEqual([
      'account.suspended',
      'account.unsuspended',
    ]);
    // Admin identity recorded — every audit row references account A.
    for (const r of targetingB) {
      expect(r.adminAccountId).toBe(fx.accountId);
      expect(r.adminKeyId).toBe(fx.apiKeyId);
      expect(r.result).toBe('success');
    }
  });

  it('cache invalidation propagates: B is blocked even if its context was warm-cached pre-suspend', async () => {
    fx = await buildTestApp();
    const target = await seedAdditionalAccount(fx);
    const adminAuth = { authorization: `Bearer ${fx.plaintext}` };
    const targetAuth = { authorization: `Bearer ${target.plaintext}` };

    // Warm B's cache via a real authenticated request.
    const warmup = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(warmup.statusCode).toBe(200);
    expect(fx.authCache.size()).toBeGreaterThan(0);

    // Admin suspends B. Should invalidate B's cached entry.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${target.accountId}/suspend`,
      headers: adminAuth,
      payload: {},
    });

    // Next request from B should miss the cached (now invalid) entry,
    // re-load fresh ctx, and 403 because status='suspended' in the
    // re-loaded account.
    const afterSuspend = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(afterSuspend.statusCode).toBe(403);
  });

  it('cross-account: tier change on B doesn’t affect A’s tier', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    const target = await seedAdditionalAccount(fx, { tier: 'trial_pack' });
    const adminAuth = { authorization: `Bearer ${fx.plaintext}` };

    // Admin changes B's tier to scale.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${target.accountId}/tier`,
      headers: adminAuth,
      payload: { tier: 'api_scale' },
    });

    // A's tier is unchanged.
    const aWhoami = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: adminAuth,
    });
    expect(aWhoami.statusCode).toBe(200);
    expect(aWhoami.json<{ tier: string }>().tier).toBe('trial_pack');

    // B sees the new tier on the next request (cache invalidation
    // forces a re-load).
    const bWhoami = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${target.plaintext}` },
    });
    expect(bWhoami.statusCode).toBe(200);
    expect(bWhoami.json<{ tier: string }>().tier).toBe('api_scale');
  });
});
