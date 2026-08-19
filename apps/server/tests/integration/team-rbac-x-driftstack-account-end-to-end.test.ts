// End-to-end integration test: X-Driftstack-Account team-RBAC
// header behavior. When a team member calls with the OWNER's
// account-id in the header, READ endpoints route to the owner's
// resources. Drift on the routing would either fail-open (any user
// reads any account) or fail-closed (legitimate team-reads break).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('X-Driftstack-Account team-RBAC header end-to-end', () => {
  it('X-Driftstack-Account pointing at a non-existent account → 403 or 404 (NOT 200 — fail-closed)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_99999999-9999-4999-8999-999999999999',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('CRITICAL X-Driftstack-Account pointing at a non-member account → 403. V-1043: this asserted only `statusCode < 500`, with no lower bound, so a 200 satisfied it — the arm written to prove the header fails closed would have passed a server that granted the impersonation. Its sibling above carries both bounds; this one lost the lower half. `resolveEffectiveAccount` refuses a non-membership with ForbiddenError, so the exact answer is assertable.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // We don't seed a team-member relationship, so any
    // X-Driftstack-Account header that's not the caller's own
    // account must fail-closed.
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-000000000002',
      },
    });
    expect(res.statusCode, 'acting as an account you are not a member of').toBe(403);
    expect(res.json<{ type?: string }>().type, 'the RFC 7807 type for a refusal').toBe(
      'https://errors.driftstack.dev/forbidden',
    );
  });

  it('X-Driftstack-Account with malformed acc_-prefixed UUID → 4xx (NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'not-a-valid-acc-id',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("X-Driftstack-Account with caller's OWN account-id → 200 (self-scope is valid)", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // First GET /v1/account/me to learn our own account_id
    const meRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const meBody = meRes.json<{ id?: string }>();
    expect(meBody.id).toBeDefined();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': meBody.id ?? '',
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
