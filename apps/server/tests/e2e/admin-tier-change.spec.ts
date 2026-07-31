// E2E: full admin tier-change flow against real Postgres + Redis.
//
// Picked tier-change as the OT9 e2e because it exercises the full
// stack in one shot: auth (admin scope), cache (invalidateAccount),
// rate-limit (tier defaults read at consume time), audit (row before
// response). Verifies the cross-account flow that the integration
// tests model (admin A acts on B; A's keys keep working; B's tier
// changes propagate via cache invalidation).

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

test('admin tier-change: full stack — auth, cache, rate-limit, audit', async ({ request }) => {
  // Two distinct accounts: A (admin) and B (target).
  const admin = await seedAccount(server.client, {
    tier: 'api_builder',
    // The staff scope, explicitly. seedAccount defaults to the legacy `admin`
    // customer alias, which by design NEVER satisfies a staff gate — so
    // without this the ADMIN's own call 403s and the dual-write under test is
    // never reached.
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  // Free is a DESKTOP tier, so B needs a device-provenance credential to reach
  // the API at all; an ordinary free key is refused 403 `apiAccess` at auth.
  const target = await seedAccount(server.client, {
    tier: 'free',
    provenance: 'cli_device',
  });

  // 1. Sanity: B is on free tier. Read through /v1/account/me rather than
  // /v1/whoami: whoami has zero consumers anywhere in the product and is not on
  // the free-desktop allowlist, while account/me is, returns the same `tier`,
  // and passes through the same requireAuth cache this test is asserting on.
  const beforeWhoami = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(target.plaintext),
  });
  expect(beforeWhoami.status()).toBe(200);
  const beforeBody = (await beforeWhoami.json()) as { tier: string };
  expect(beforeBody.tier).toBe('free');

  // 2. Admin A changes B's tier to scale.
  const tierChange = await request.post(
    `${server.baseUrl}/v1/admin/accounts/acc_${target.accountId}/tier`,
    {
      headers: authHeader(admin.plaintext),
      data: { tier: 'api_scale', reason: 'enterprise pilot' },
    },
  );
  expect(tierChange.status()).toBe(200);
  const tierBody = (await tierChange.json()) as { id: string; tier: string };
  expect(tierBody.tier).toBe('api_scale');
  expect(tierBody.id).toBe(`acc_${target.accountId}`);

  // 3. Cache invalidation propagated: B's next request sees new tier.
  // (D-020 invalidateAccount bumped the version; B's cached ctx misses
  // and re-loads with tier='scale'.)
  const afterWhoami = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(target.plaintext),
  });
  expect(afterWhoami.status()).toBe(200);
  const afterBody = (await afterWhoami.json()) as { tier: string };
  expect(afterBody.tier).toBe('api_scale');

  // 4. Admin A's tier is unchanged (cross-account isolation).
  const adminWhoami = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(admin.plaintext),
  });
  expect(adminWhoami.status()).toBe(200);
  expect(((await adminWhoami.json()) as { tier: string }).tier).toBe('api_builder');

  // 5. DB-level audit row: one entry with action=account.tier_changed,
  //    target=B's account, admin=A's account+key, success.
  const auditRows = await server.client<
    Array<{
      action: string;
      target_account_id: string;
      admin_account_id: string;
      admin_key_id: string;
      result: string;
      input_payload: Record<string, unknown> | null;
    }>
  >`
    SELECT action, target_account_id, admin_account_id, admin_key_id, result, input_payload
    FROM admin_audit_log
    WHERE target_account_id = ${target.accountId}
  `;
  expect(auditRows).toHaveLength(1);
  const row = auditRows[0];
  expect(row?.action).toBe('account.tier_changed');
  expect(row?.admin_account_id).toBe(admin.accountId);
  expect(row?.admin_key_id).toBe(admin.apiKeyId);
  expect(row?.result).toBe('success');
  expect(row?.input_payload).toMatchObject({ tier: 'api_scale', reason: 'enterprise pilot' });

  // 6. The /v1/admin/audit-log read endpoint also surfaces the row.
  const auditList = await request.get(
    `${server.baseUrl}/v1/admin/audit-log?target_id=acc_${target.accountId}`,
    { headers: authHeader(admin.plaintext) },
  );
  expect(auditList.status()).toBe(200);
  const listBody = (await auditList.json()) as {
    data: Array<{ action: string; target_account_id: string }>;
  };
  expect(listBody.data).toHaveLength(1);
  expect(listBody.data[0]?.action).toBe('account.tier_changed');
  expect(listBody.data[0]?.target_account_id).toBe(`acc_${target.accountId}`);
});
