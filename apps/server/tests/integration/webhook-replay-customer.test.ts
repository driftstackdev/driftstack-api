// V-307 — customer self-service webhook delivery replay.

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

const headers = { 'content-type': 'application/json' };

async function createEndpoint(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/webhooks',
    headers: { ...headers, authorization: `Bearer ${fixture.plaintext}` },
    payload: {
      url: 'https://example.test/webhook',
      events: ['session.completed'],
      description: 'test',
    },
  });
  return res.json<{ id: string }>().id.replace(/^whk_/, '');
}

async function enqueueDelivery(fixture: TestAppFixture): Promise<string> {
  const endpointId = await createEndpoint(fixture);
  // Trigger one delivery via the service-level enqueueEvent.
  const count = await fixture.webhooksService.enqueueEvent(fixture.accountId, 'session.completed', {
    id: 'ses_test',
    status: 'completed',
  });
  if (count === 0) throw new Error('no delivery enqueued');
  // Read back via the GET /v1/webhooks/:id/deliveries endpoint.
  const res = await fixture.app.inject({
    method: 'GET',
    url: `/v1/webhooks/whk_${endpointId}/deliveries`,
    headers: { authorization: `Bearer ${fixture.plaintext}` },
  });
  const body = res.json<{ data: { id: string }[] }>();
  if (body.data.length === 0) throw new Error('no delivery rows');
  return body.data[0]!.id;
}

describe('POST /v1/webhook-deliveries/:deliveryId/replay', () => {
  it('200 resets the delivery to pending', async () => {
    fx = await buildTestApp();
    const deliveryPublicId = await enqueueDelivery(fx);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryPublicId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string }>();
    expect(body.id).toBe(deliveryPublicId);
    expect(body.status).toBe('pending');
  });

  it('writes account_audit webhook_delivery.replayed entry', async () => {
    fx = await buildTestApp();
    const deliveryPublicId = await enqueueDelivery(fx);

    await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryPublicId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    const replayed = fx.accountAuditRepo
      .getAll()
      .filter((r) => r.action === 'webhook_delivery.replayed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.targetResourceId).toBe(deliveryPublicId);
  });

  // S32 2026-07-07 (fable-frontend-audit) — replay was the only delivery
  // surface ignoring team act-as: the ownership lookup used the member's
  // own account, so replaying a team-visible delivery 404'd. Locks the
  // fix (200 with the header) AND the scoping (404 without it).
  it('honours x-driftstack-account: team admin can replay the owner account delivery', async () => {
    fx = await buildTestApp();
    const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000a01';
    const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000c001';
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ACCOUNT_ID, role: 'admin' },
    ]);
    const actAs = { 'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}` };

    // Member (acting as the owner) creates the OWNER's endpoint.
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}`, ...actAs },
      payload: {
        url: 'https://example.test/owner-webhook',
        events: ['session.completed'],
        description: 'owner endpoint',
      },
    });
    expect(created.statusCode).toBe(201);
    const endpointId = created.json<{ id: string }>().id;

    // A delivery lands on the OWNER account.
    const count = await fx.webhooksService.enqueueEvent(OWNER_ACCOUNT_ID, 'session.completed', {
      id: 'ses_owner',
      status: 'completed',
    });
    expect(count).toBeGreaterThan(0);
    const list = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...actAs },
    });
    expect(list.statusCode).toBe(200);
    const deliveryId = list.json<{ data: { id: string }[] }>().data[0]!.id;

    // WITHOUT the header the member does not own it: 404 (scoping intact).
    const noHeader = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(noHeader.statusCode).toBe(404);

    // WITH the header the replay succeeds.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}`, ...actAs },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('pending');
  });

  // Fable audit-2 2026-07-08 (C5) — replay RE-FIRES the delivery, so it is a
  // WRITE and takes the admin-only-on-team gate (same as create/update/delete/
  // rotate). A non-admin member acting-as the owner must be refused, even
  // though the delivery is team-visible to them for reads.
  it('403 when a NON-ADMIN team member replays the owner account delivery (C5 — replay is admin-only on team)', async () => {
    fx = await buildTestApp();
    const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000a01';
    const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000c001';
    const actAs = { 'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}` };

    // Set up the owner's endpoint + a delivery as an ADMIN member first
    // (create + list are the only way to obtain a real delivery id), then
    // downgrade the caller to a plain member for the replay attempt.
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ACCOUNT_ID, role: 'admin' },
    ]);
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}`, ...actAs },
      payload: {
        url: 'https://example.test/owner-webhook',
        events: ['session.completed'],
        description: 'owner endpoint',
      },
    });
    expect(created.statusCode).toBe(201);
    const endpointId = created.json<{ id: string }>().id;
    await fx.webhooksService.enqueueEvent(OWNER_ACCOUNT_ID, 'session.completed', {
      id: 'ses_owner',
      status: 'completed',
    });
    const list = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...actAs },
    });
    expect(list.statusCode).toBe(200);
    const deliveryId = list.json<{ data: { id: string }[] }>().data[0]!.id;

    // Downgrade the caller to a NON-admin member and invalidate the auth cache
    // (memberships ride the cached AccountContext, like tier).
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ACCOUNT_ID, role: 'member' },
    ]);
    await fx.authCache.invalidateAccount(fx.accountId);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}`, ...actAs },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('admin role');
  });

  it('CRITICAL 404 when an UNRELATED account replays the delivery. This file covered the owner, a team admin acting-as, a non-admin member, a missing id and a malformed id — but never a different account, which is the case the account-scope check exists for. Replay RE-FIRES the delivery, so a gap here lets a stranger resend another customer’s payload.', async () => {
    fx = await buildTestApp();
    const deliveryPublicId = await enqueueDelivery(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@replay-isolation.test',
      tier: 'api_builder',
      scopes: ['read', 'write', 'account_owner'],
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryPublicId}/replay`,
      headers: { ...headers, authorization: `Bearer ${other.plaintext}` },
    });

    expect(res.statusCode).toBe(404);
    // The refusal must be indistinguishable from a delivery that never existed.
    expect(res.body).not.toContain('example.test');
  });

  it('404 when delivery does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhook-deliveries/wdl_00000000-0000-4000-8000-000000000999/replay',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on malformed delivery id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhook-deliveries/not-a-delivery-id/replay',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// V-406 — ?status= filter coverage on the delivery-list endpoint.
// V-403 dashboard surfaced this filter; backend was already capable
// per ListDeliveriesQuerySchema. These tests pin the wire behavior.
describe('GET /v1/webhooks/:id/deliveries — status filter (V-403)', () => {
  it('returns matching status when filter is set; empty list when no rows match', async () => {
    fx = await buildTestApp();
    const endpointId = await createEndpoint(fx);
    await fx.webhooksService.enqueueEvent(fx.accountId, 'session.completed', {
      id: 'ses_a',
      status: 'completed',
    });

    const pending = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/whk_${endpointId}/deliveries?status=pending`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(pending.statusCode).toBe(200);
    const pendingBody = pending.json<{
      data: Array<{ id: string; status: string }>;
      has_more: boolean;
    }>();
    expect(pendingBody.data.length).toBeGreaterThan(0);
    for (const d of pendingBody.data) {
      expect(d.status).toBe('pending');
    }

    // Delivered scope should be empty — nothing has been
    // successfully dispatched in the test fixture.
    const delivered = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/whk_${endpointId}/deliveries?status=delivered`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('400 on a status value outside the enum', async () => {
    fx = await buildTestApp();
    const endpointId = await createEndpoint(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/whk_${endpointId}/deliveries?status=not-a-status`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ignores a malformed cursor — returns the first page, not a 500/empty', async () => {
    fx = await buildTestApp();
    const endpointId = await createEndpoint(fx);
    await fx.webhooksService.enqueueEvent(fx.accountId, 'session.completed', {
      id: 'ses_cur',
      status: 'completed',
    });

    // `?cursor=not-a-valid-cursor` → new Date('not-a-valid-cursor') is an
    // Invalid Date (truthy). Without the repo's guard this would reach the
    // lt(createdAt, …) keyset filter and 500 on serialization (Drizzle) or
    // silently match nothing (in-memory). The guard treats it as absent →
    // the caller gets the first page.
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/webhooks/whk_${endpointId}/deliveries?cursor=not-a-valid-cursor`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data.length).toBeGreaterThan(0);
  });
});
