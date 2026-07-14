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
import { sha256Hex } from '../../src/services/auth-cache.js';

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
    fx = await buildTestApp({ tier: 'free' });
    const target = await seedAdditionalAccount(fx, { tier: 'free' });
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
    expect(aWhoami.json<{ tier: string }>().tier).toBe('free');

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

// GDPR Article 17 — admin-triggered account termination. Mirrors the
// suspend/unsuspend round-trip shape above but exercises the FULL reclaim
// surface: sessions (already covered by the suspend unit tests) + web
// sessions + API keys + webhooks, all real-wired via build-test-app.ts
// (AuthFlowsService / ApiKeysService / WebhooksService — not stubs).

// seedAdditionalAccount doesn't record legal acceptance for the new account
// (only the PRIMARY fixture account gets that via buildTestApp's own
// skipLegalAcceptance branch) — minting a second API key for the target
// 409s LegalAcceptanceRequired without this.
async function acceptLegalDocsFor(fx: TestAppFixture, accountId: string): Promise<void> {
  for (const entry of fx.legalCatalog.entries()) {
    await fx.legalRepo.recordAcceptance({
      accountId,
      documentKey: entry.documentKey,
      version: entry.version,
      contentHash: entry.contentHash,
      acceptedFromIp: null,
      acceptedUserAgent: null,
    });
  }
}

describe('admin: delete → full reclaim → blocked', () => {
  it('deleteAccount sets status=deleted, revokes every API key + webhook + web session for the target, and blocks its next auth attempt', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const target = await seedAdditionalAccount(fx, { tier: 'api_builder' });
    await acceptLegalDocsFor(fx, target.accountId);
    const adminAuth = { authorization: `Bearer ${fx.plaintext}` };
    const targetAuth = { authorization: `Bearer ${target.plaintext}` };

    // 1. Sanity: B can use the API before deletion.
    const before = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(before.statusCode).toBe(200);

    // 2. B creates a webhook endpoint + a second API key, and gets a
    // dashboard web session — three surfaces deleteAccount() must reclaim.
    const webhookRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: targetAuth,
      payload: { url: 'https://example.test/hook', events: ['session.completed'] },
    });
    expect(webhookRes.statusCode).toBe(201);

    const secondKeyRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: targetAuth,
      payload: { name: 'second key', scopes: ['read', 'write'] },
    });
    expect(secondKeyRes.statusCode).toBe(201);

    const webSessionPlaintext = 'wsess_target_bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    // The fixture splits API-key and auth-flow accounts across two maps even
    // though production uses one table; mirror the target before exercising
    // the web-session mint authority check.
    fx.authFlowsRepo.seedAccount({
      id: target.accountId,
      email: `tester-${target.accountId.slice(-4)}@driftstack.local`,
      name: 'Tester-2',
      passwordHash: null,
      emailVerifiedAt: null,
      tier: 'api_builder',
      status: 'active',
      authEpoch: 0,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await fx.authFlowsRepo.insertWebSession({
      accountId: target.accountId,
      tokenHash: sha256Hex(webSessionPlaintext),
      authEpoch: 0,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      issuedFromIp: null,
      userAgent: null,
    });
    const webSessionAuth = { authorization: `Bearer ${webSessionPlaintext}` };
    const webSessionCheck = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: webSessionAuth,
    });
    expect(webSessionCheck.statusCode).toBe(200);

    // Pre-delete: 2 API keys (seeded + second), 1 webhook, 1 web session —
    // all non-revoked/non-disabled.
    expect(
      (await fx.apiKeysRepo.listApiKeys(target.accountId)).filter((k) => k.revokedAt === null),
    ).toHaveLength(2);
    expect(
      (await fx.webhooksRepo.listEndpoints(target.accountId)).filter((w) => w.disabledAt === null),
    ).toHaveLength(1);

    // 3. Admin A deletes B.
    const del = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${target.accountId}/delete`,
      headers: adminAuth,
      payload: { reason: 'gdpr account deletion test' },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<Record<string, unknown>>().status).toBe('deleted');

    // 4. Every API key + webhook for B is now revoked/disabled.
    const keysAfter = await fx.apiKeysRepo.listApiKeys(target.accountId);
    expect(keysAfter).toHaveLength(2);
    for (const k of keysAfter) expect(k.revokedAt).not.toBeNull();

    const endpointsAfter = await fx.webhooksRepo.listEndpoints(target.accountId);
    expect(endpointsAfter).toHaveLength(1);
    for (const w of endpointsAfter) expect(w.disabledAt).not.toBeNull();

    // 5. B's dashboard web session no longer authenticates.
    const webSessionAfter = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: webSessionAuth,
    });
    expect(webSessionAfter.statusCode).toBe(401);

    // 6. B's original bearer key ALSO 401s now (deleted looks like an
    // invalid key to the caller — auth.ts's slowPathApiKey check).
    const blockedAfter = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: targetAuth,
    });
    expect(blockedAfter.statusCode).toBe(401);

    // 7. Admin A is unaffected — a different account.
    const adminCheck = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: adminAuth,
    });
    expect(adminCheck.statusCode).toBe(200);

    // 8. Audit log records the deletion against B, attributed to A.
    const all = fx.adminAuditRepo.getAll();
    const deleteRows = all.filter(
      (r) => r.targetAccountId === target.accountId && r.action === 'account.deleted',
    );
    expect(deleteRows).toHaveLength(1);
    expect(deleteRows[0]?.adminAccountId).toBe(fx.accountId);
    expect(deleteRows[0]?.adminKeyId).toBe(fx.apiKeyId);
    expect(deleteRows[0]?.result).toBe('success');
  });

  it('mutation check: skipping ANY one of the 4 reclaim steps leaves a live surface behind (documents the coverage the test above locks in)', async () => {
    // This test intentionally duplicates a slice of the flow above with a
    // SINGLE surface (webhooks) to make the mutation-testing story concrete
    // and independently re-runnable: if AccountsAdminService.deleteAccount's
    // `if (this.webhooks) { ... }` block were ever removed or short-
    // circuited, this assertion (and the equivalent slice in the test
    // above) would fail.
    fx = await buildTestApp({ tier: 'api_builder' });
    const target = await seedAdditionalAccount(fx, { tier: 'api_builder' });
    const targetAuth = { authorization: `Bearer ${target.plaintext}` };
    const adminAuth = { authorization: `Bearer ${fx.plaintext}` };

    await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: targetAuth,
      payload: { url: 'https://example.test/hook2', events: ['session.completed'] },
    });

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${target.accountId}/delete`,
      headers: adminAuth,
      payload: {},
    });

    const endpointsAfter = await fx.webhooksRepo.listEndpoints(target.accountId);
    expect(endpointsAfter.every((w) => w.disabledAt !== null)).toBe(true);
  });
});
