// Webhooks audit #1 (HIGH, 2026-09-24) — every webhook WRITE skipped the
// `account_owner` scope check whenever the request acted in a teammate's workspace
// (`X-Driftstack-Account`), leaving the team role as the only gate. A team admin's
// key scoped to `read:sessions` alone could therefore create an endpoint on the
// owner (receiving the plaintext secret and the owner's event stream), rotate the
// owner's secret, or delete the owner's endpoint — while the same key was refused
// on its own account, on the owner's webhook LIST, and on the owner's API keys.
// webhooks/endpoints.md says writes need `account_owner`; the team role decides
// WHOSE resources a caller may touch, the key's scope decides WHAT it may do.

import type { ApiKeyScope } from '@driftstack/api-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type AdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000b01';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000b002';
const json = { 'content-type': 'application/json' };

async function ownerEndpoint(owner: AdditionalAccount): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks',
    headers: { ...json, authorization: `Bearer ${owner.plaintext}` },
    payload: { url: 'https://example.test/owner-hook', events: ['session.completed'] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function asTeamAdminWith(
  scopes: ApiKeyScope[],
): Promise<{ owner: AdditionalAccount; actAs: Record<string, string> }> {
  fx = await buildTestApp({ scopes });
  const owner = await seedAdditionalAccount(fx, {
    accountId: OWNER_ACCOUNT_ID,
    apiKeyId: '00000000-0000-4000-8000-000000000b03',
  });
  fx.authRepo.setTeamMemberships(fx.accountId, [
    { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ACCOUNT_ID, role: 'admin' },
  ]);
  return { owner, actAs: { 'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}` } };
}

describe("a team admin's key without account_owner cannot write the owner's webhooks", () => {
  it('CRITICAL create, update, rotate, test, delete and replay on the owner are all refused 403, and nothing changes', async () => {
    const { owner, actAs } = await asTeamAdminWith(['read:sessions']);
    const endpointId = await ownerEndpoint(owner);
    const count = await fx.webhooksService.enqueueEvent(OWNER_ACCOUNT_ID, 'session.completed', {
      id: 'ses_owner',
      status: 'completed',
    });
    expect(count).toBeGreaterThan(0);
    const deliveries = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${owner.plaintext}` },
    });
    expect(deliveries.statusCode).toBe(200);
    const deliveryId = deliveries.json<{ data: { id: string }[] }>().data[0]!.id;

    const member = { authorization: `Bearer ${fx.plaintext}`, ...actAs };
    const attempts = [
      {
        method: 'POST' as const,
        url: '/v1/webhooks',
        payload: { url: 'https://attacker.test/hook', events: ['session.completed'] },
      },
      {
        method: 'PATCH' as const,
        url: `/v1/webhooks/${endpointId}`,
        payload: { url: 'https://attacker.test/hook' },
      },
      { method: 'POST' as const, url: `/v1/webhooks/${endpointId}/rotate-secret`, payload: {} },
      { method: 'POST' as const, url: `/v1/webhooks/${endpointId}/test`, payload: {} },
      { method: 'DELETE' as const, url: `/v1/webhooks/${endpointId}` },
      { method: 'POST' as const, url: `/v1/webhook-deliveries/${deliveryId}/replay`, payload: {} },
    ];
    for (const attempt of attempts) {
      const res = await fx.app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: 'payload' in attempt ? { ...json, ...member } : member,
        ...('payload' in attempt ? { payload: attempt.payload } : {}),
      });
      expect(res.statusCode, `${attempt.method} ${attempt.url}: ${res.body}`).toBe(403);
      expect(res.body).not.toMatch(/whsec_|"secret"/);
    }

    // The owner's endpoint is exactly as the owner left it: one endpoint, same URL.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: { authorization: `Bearer ${owner.plaintext}` },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json<{ data: { id: string; url: string }[] }>().data;
    expect(rows.map((r) => [r.id, r.url])).toEqual([
      [endpointId, 'https://example.test/owner-hook'],
    ]);
  });

  it("a team admin's write key without account_owner is refused too — the scope, not the verb, is what counts", async () => {
    const { owner, actAs } = await asTeamAdminWith(['read', 'write']);
    await ownerEndpoint(owner);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { ...json, authorization: `Bearer ${fx.plaintext}`, ...actAs },
      payload: { url: 'https://attacker.test/hook', events: ['session.completed'] },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it("a team admin whose key carries account_owner (the dashboard's session does) still writes the owner's webhooks", async () => {
    const { owner, actAs } = await asTeamAdminWith(['read', 'write', 'account_owner']);
    const endpointId = await ownerEndpoint(owner);
    const rotated = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${endpointId}/rotate-secret`,
      headers: { ...json, authorization: `Bearer ${fx.plaintext}`, ...actAs },
      payload: {},
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { ...json, authorization: `Bearer ${fx.plaintext}`, ...actAs },
      payload: { url: 'https://example.test/second-hook', events: ['session.completed'] },
    });
    expect(created.statusCode, created.body).toBe(201);
  });
});
