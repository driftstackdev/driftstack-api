// V-216 — integration tests for /v1/account/audit-log + emit wiring.

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

interface AuditEntry {
  id: string;
  account_id: string;
  actor_type: string;
  actor_account_id: string | null;
  action: string;
  target_resource_id: string | null;
  payload: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
}

interface ListResponse {
  data: AuditEntry[];
  next_cursor: string | null;
}

describe('GET /v1/account/audit-log', () => {
  it('200 empty for a freshly-built account with no recorded events yet', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('400 on a malformed cursor (not a uuid) rather than a 500 from the uuid keyset lookup', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?cursor=not-a-uuid',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('records an api_key.minted entry when a customer mints a key', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'second-key', scopes: ['read', 'write'] },
    });
    expect(create.statusCode).toBe(201);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    const entry = body.data[0]!;
    expect(entry.action).toBe('api_key.minted');
    expect(entry.actor_type).toBe('customer');
    expect(entry.target_resource_id).toMatch(/^key_/);
    expect((entry.payload as { name?: string } | null)?.name).toBe('second-key');
  });

  it('records api_key.revoked when a customer revokes a key', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'to-revoke', scopes: ['read'] },
    });
    const created = create.json<{ id: string }>();
    const revoke = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(fx),
    });
    expect(revoke.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    const actions = body.data.map((e) => e.action);
    expect(actions).toContain('api_key.minted');
    expect(actions).toContain('api_key.revoked');
  });

  it('records session.created + session.destroyed across the lifecycle', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(fx),
      payload: {
        archetype: 'iphone16pro_ios18_7_safari26_4',
        purpose: 'production_customer',
      },
    });
    expect(create.statusCode).toBe(201);
    const sess = create.json<{ id: string }>();
    const destroy = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sess.id}`,
      headers: auth(fx),
    });
    expect(destroy.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    const actions = body.data.map((e) => e.action);
    expect(actions).toContain('session.created');
    expect(actions).toContain('session.destroyed');
  });

  it('filters by action query param', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k2', scopes: ['read'] },
    });

    const filtered = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=api_key.minted',
      headers: auth(fx),
    });
    expect(filtered.statusCode).toBe(200);
    const body = filtered.json<ListResponse>();
    expect(body.data.every((e) => e.action === 'api_key.minted')).toBe(true);
    expect(body.data.length).toBe(2);
  });

  it('400 on unknown action enum value', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=bogus.event',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  // V-225 — second batch of deferred V-216 emit wires.

  it('records profile.created when a customer creates a profile', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fx),
      payload: { name: 'main' },
    });
    expect(create.statusCode).toBe(200);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=profile.created',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    const entry = body.data[0]!;
    expect(entry.target_resource_id).toMatch(/^profile_/);
    expect((entry.payload as { name?: string } | null)?.name).toBe('main');
  });

  it('records profile.deleted when a customer deletes a profile', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth(fx),
      payload: { name: 'doomed' },
    });
    const id = create.json<{ id: string }>().id;
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=profile.deleted',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect((body.data[0]!.payload as { name?: string } | null)?.name).toBe('doomed');
  });

  it('records webhook_endpoint.created when a customer creates an endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://example.test/hook', events: ['session.completed'] },
    });
    expect(create.statusCode).toBe(201);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=webhook_endpoint.created',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    const entry = body.data[0]!;
    expect(entry.target_resource_id).toMatch(/^webhook_endpoint_/);
    expect((entry.payload as { url?: string } | null)?.url).toBe('https://example.test/hook');
  });

  it('records webhook_endpoint.deleted when a customer deletes an endpoint', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(fx),
      payload: { url: 'https://example.test/hook2', events: ['session.completed'] },
    });
    const id = create.json<{ id: string }>().id;
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=webhook_endpoint.deleted',
      headers: auth(fx),
    });
    const body = list.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect((body.data[0]!.payload as { url?: string } | null)?.url).toBe(
      'https://example.test/hook2',
    );
  });
});

// V-484 — additional filter parameters: from / to / actor_type /
// target_resource_id. Driven through the Fastify route so we exercise
// the schema parsing + service forwarding + repo predicate end-to-end.
describe('GET /v1/account/audit-log — V-484 filters', () => {
  it('400 on malformed `from` (not an ISO date)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?from=not-a-date',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on unknown actor_type enum value', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?actor_type=bogus',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters by actor_type=customer (smoke)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?actor_type=customer',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((e) => e.actor_type === 'customer')).toBe(true);
  });

  it('returns empty when actor_type=staff but no staff actions yet', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?actor_type=staff',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data).toEqual([]);
  });

  it('filters by target_resource_id (exact match)', async () => {
    fx = await buildTestApp();
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'targeted', scopes: ['read'] },
    });
    expect(created.statusCode).toBe(201);
    // Make a second event we want to exclude.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'unrelated', scopes: ['read'] },
    });

    const all = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=api_key.minted',
      headers: auth(fx),
    });
    const allBody = all.json<ListResponse>();
    expect(allBody.data.length).toBe(2);
    const targetId = allBody.data.find(
      (e) => (e.payload as { name?: string } | null)?.name === 'targeted',
    )!.target_resource_id!;

    const filtered = await fx.app.inject({
      method: 'GET',
      url: `/v1/account/audit-log?target_resource_id=${encodeURIComponent(targetId)}`,
      headers: auth(fx),
    });
    expect(filtered.statusCode).toBe(200);
    const body = filtered.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.target_resource_id).toBe(targetId);
  });

  it('returns empty when `to` is in the past (before any events)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    const longAgo = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/account/audit-log?to=${encodeURIComponent(longAgo)}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data).toEqual([]);
  });

  it('returns events when `from` is in the past (inclusive of now)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    const longAgo = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/account/audit-log?from=${encodeURIComponent(longAgo)}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('combines from + actor_type + action filters', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'k1', scopes: ['read'] },
    });
    const longAgo = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const res = await fx.app.inject({
      method: 'GET',
      url:
        `/v1/account/audit-log?from=${encodeURIComponent(longAgo)}` +
        `&actor_type=customer&action=api_key.minted`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.action).toBe('api_key.minted');
    expect(body.data[0]!.actor_type).toBe('customer');
  });
});

describe('GET /v1/account/audit-log — actor-privacy scrub (TD-audit-payload-scrub)', () => {
  const TEAM_OWNER_ID = '00000000-0000-4000-8000-000000000c01';
  const TEAM_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000c02';

  it('owner self-view KEEPS issued_from_ip/user_agent in an auth-flow payload (GDPR Art-15 access to own data)', async () => {
    fx = await buildTestApp();
    await fx.accountAuditRepo.insert({
      accountId: fx.accountId,
      actorType: 'customer',
      action: 'account.login',
      payload: { method: 'password', issued_from_ip: '203.0.113.7', user_agent: 'Mozilla/5.0' },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=account.login',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json<ListResponse>().data[0]!;
    expect(entry.payload?.issued_from_ip).toBe('203.0.113.7');
    expect(entry.payload?.method).toBe('password');
  });

  it('team-member cross-view SCRUBS the owner IP/UA from the auth-flow payload (keeps non-sensitive fields)', async () => {
    fx = await buildTestApp();
    // The caller is an admin member of TEAM_OWNER_ID's team.
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    // An auth event on the OWNER's log carries the owner's IP/UA in payload.
    await fx.accountAuditRepo.insert({
      accountId: TEAM_OWNER_ID,
      actorType: 'customer',
      action: 'account.login',
      payload: { method: 'password', issued_from_ip: '203.0.113.7', user_agent: 'Mozilla/5.0' },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=account.login',
      headers: { ...auth(fx), 'x-driftstack-account': `acc_${TEAM_OWNER_ID}` },
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json<ListResponse>().data[0]!;
    expect(entry.payload?.method).toBe('password'); // non-sensitive field kept
    expect(entry.payload).not.toHaveProperty('issued_from_ip'); // scrubbed
    expect(entry.payload).not.toHaveProperty('user_agent');
    expect(res.body).not.toContain('203.0.113.7');
  });
});

// GDPR-adjacent fix: `redactActorPrivacy` used to be computed ONLY from
// `effective.kind === 'team'` (the READER's relationship to the account) —
// it never looked at whether the ROW's own recorded actor differs from the
// account being read. A cross-actor row (accountId = the account whose log
// this is, actorAccountId = a DIFFERENT account that actually performed the
// action) leaked that other account's real `ip_address`/`user_agent`
// verbatim to the account owner on an ordinary SELF read/export, because
// self-view always had `redactActorPrivacy = false`.
describe('GET /v1/account/audit-log — per-row actor-privacy redaction (cross-actor rows leak IP on self-view)', () => {
  const TEAM_MEMBER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000c11';

  it('owner self-view REDACTS ip_address/user_agent for a cross-actor row on their OWN account (list + export)', async () => {
    fx = await buildTestApp();
    // Row lives on the default fixture account's own log (accountId =
    // fx.accountId) but was recorded with a DIFFERENT actorAccountId —
    // exactly the shape a cross-actor write produces (see
    // rowNeedsActorPrivacyRedaction in routes/account-audit.ts).
    await fx.accountAuditRepo.insert({
      accountId: fx.accountId,
      actorType: 'customer',
      actorAccountId: TEAM_MEMBER_ACCOUNT_ID,
      action: 'account.email_preferences_changed',
      targetResourceId: `account_${fx.accountId}`,
      payload: { event_type: 'tier-changed', opted_in: false },
      ipAddress: '198.51.100.42',
      userAgent: 'TeamMemberAgent/1.0',
    });

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=account.email_preferences_changed',
      headers: auth(fx),
    });
    expect(list.statusCode).toBe(200);
    const entry = list.json<ListResponse>().data[0]!;
    expect(entry.ip_address).toBeNull();
    expect(entry.user_agent).toBeNull();
    expect(list.body).not.toContain('198.51.100.42');

    const exported = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=json',
      headers: auth(fx),
    });
    expect(exported.statusCode).toBe(200);
    const exportBody = exported.json<{ data: AuditEntry[] }>();
    const exportedEntry = exportBody.data.find(
      (e) => e.action === 'account.email_preferences_changed',
    )!;
    expect(exportedEntry.ip_address).toBeNull();
    expect(exportedEntry.user_agent).toBeNull();
    expect(exported.body).not.toContain('198.51.100.42');

    const csv = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log/export?format=csv',
      headers: auth(fx),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain('198.51.100.42');
  });

  it('REAL end-to-end: a driftstack-staff admin-note on a customer account no longer leaks the staff IP on the customer self-view', async () => {
    fx = await buildTestApp();
    // A distinct account plays the "staff" side of admin.support_note —
    // POST /v1/admin/accounts/:id/audit-note writes accountId = the
    // CUSTOMER (fx.accountId) but actorAccountId = ctx.account.id (the
    // caller, i.e. the staff account below) + the staff caller's real IP.
    const staff = await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-000000000c12',
      apiKeyId: '00000000-0000-4000-8000-000000000c13',
      email: 'staff@driftstack.local',
    });

    const note = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${fx.accountId}/audit-note`,
      headers: {
        authorization: `Bearer ${staff.plaintext}`,
        'x-forwarded-for': '203.0.113.55',
      },
      payload: { note: 'Investigated a billing question.' },
    });
    expect(note.statusCode).toBe(201);

    // Sanity: the row really is cross-actor before we assert redaction.
    const raw = fx.accountAuditRepo
      .getAll()
      .find((r) => r.action === 'admin.support_note' && r.accountId === fx.accountId)!;
    expect(raw.actorAccountId).toBe(staff.accountId);
    expect(raw.actorAccountId).not.toBe(raw.accountId);
    expect(raw.ipAddress).toBe('203.0.113.55');

    // The CUSTOMER (fx, the default fixture account) self-reads their OWN
    // audit log — no team header, no cross-account relationship. Prior to
    // the fix this returned the staff member's real IP verbatim.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=admin.support_note',
      headers: auth(fx),
    });
    expect(list.statusCode).toBe(200);
    const entry = list.json<ListResponse>().data[0]!;
    expect(entry.ip_address).toBeNull();
    expect(list.body).not.toContain('203.0.113.55');
  });
});
