// V-689 — integration tests for GET /v1/admin/usage/accounts/:id.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface UsageResponse {
  account_id: string;
  tier: string;
  period_start: string;
  period_end: string;
  totals: Record<string, number>;
  quotas: Record<string, number | null>;
}

describe('V-689 GET /v1/admin/usage/accounts/:id', () => {
  it('403 for a customer key without internal-admin', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/usage/accounts/${fx.accountId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('200 with synthetic-zero usage for an account with no records', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/usage/accounts/${fx.accountId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<UsageResponse>();
    expect(body.account_id).toBe(fx.accountId);
    expect(body.totals.session_minute).toBe(0);
    expect(body.totals.navigate).toBe(0);
    expect(body.quotas.session_minute).toBeNull(); // tiers are all unmetered today
  });

  it('404 when the account does not exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/usage/accounts/acc_does_not_exist',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
