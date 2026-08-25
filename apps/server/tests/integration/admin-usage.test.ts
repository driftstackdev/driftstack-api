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
    // V-1580 — this sent `acc_does_not_exist` and expected 404. That number came
    // from the in-memory repo, where a garbage id is simply a miss. Against the
    // real `uuid` column it was an invalid cast and the route answered 500, so
    // the assertion was pinning a fixture artefact rather than the contract. A
    // malformed id is now refused at the boundary with 400, matching
    // admin-accounts.ts for the same shape. The well-formed-but-absent case is
    // asserted separately below, so 404 keeps its own coverage.
    const malformed = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/usage/accounts/acc_does_not_exist',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(malformed.statusCode, 'a malformed id is refused, not looked up').toBe(400);

    const absent = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/usage/accounts/acc_11111111-2222-3333-4444-555555555555',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(absent.statusCode, 'a well-formed id for no account is still 404').toBe(404);
  });
});
