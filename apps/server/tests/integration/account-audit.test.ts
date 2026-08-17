// V-216 — integration tests for /v1/account/audit-log + emit wiring.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // V-553.B-21 — list() used to hard-require the literal `account_owner`
  // scope, so a key minted with just the docs-recommended `read:audit`
  // scope (the "Backup automation: read + read:audit" recipe in
  // apps/docs/src/pages/reference/scopes.md) got a permanent 403. Now
  // widened to the granular `read:audit` scope (account_owner still
  // satisfies it via broad-satisfies-granular).
  it('403 when the key lacks read:audit (or a satisfying broad scope)', async () => {
    fx = await buildTestApp({ scopes: ['gui_control'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('read:audit');
  });

  it('200 with a granular read:audit key — the docs\' "read + read:audit" backup-automation recipe now actually works', async () => {
    fx = await buildTestApp({ scopes: ['read', 'read:audit'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
  });

  // #122 — complete the 3-way scope contract: a DIFFERENT-resource
  // granular scope must NOT satisfy read:audit (narrow keys stay narrow).
  it('403 for a cross-resource granular key (read:sessions does NOT satisfy read:audit)', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:audit');
  });

  it('200 for a broad read key and an account_owner key (V-481)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const readRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(readRes.statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['account_owner'] });
    const ownerRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: auth(fx),
    });
    expect(ownerRes.statusCode).toBe(200);
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

  // V-735 — under a team-scoped write the audit row belongs to the OWNER, not
  // the acting member.
  //
  // The shared emit helper hardcoded `accountId: ctx.account.id`, so a team
  // admin creating, updating, deleting or ROTATING THE SECRET of one of the
  // owner's webhook endpoints wrote the row into their own log and left the
  // owner's empty. The owner could not see changes to their own webhook
  // configuration — and a secret rotation they did not perform is exactly the
  // thing an audit log exists to show them.
  //
  // `replayDeliveryAsCustomer` already had the right shape (row on the effective
  // account, actor on the caller); this pins that the helper matches it.
  it('attributes a team-scoped webhook create to the OWNER log, with the member as actor', async () => {
    const WEBHOOK_OWNER_ID = '00000000-0000-4000-8000-000000000c03';
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: WEBHOOK_OWNER_ID,
      email: 'owner-webhooks@driftstack.local',
      name: 'Owner',
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-000000000c02',
        ownerAccountId: WEBHOOK_OWNER_ID,
        role: 'admin',
      },
    ]);
    const teamHeaders = {
      ...auth(fx),
      'x-driftstack-account': `acc_${WEBHOOK_OWNER_ID}`,
    };

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: teamHeaders,
      payload: { url: 'https://owner.test/hook', events: ['session.completed'] },
    });
    expect(create.statusCode).toBe(201);

    // The OWNER's log has the row (read it team-scoped, as the owner's).
    const ownerLog = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=webhook_endpoint.created',
      headers: teamHeaders,
    });
    const ownerEntries = ownerLog.json<ListResponse>();
    expect(ownerEntries.data.length).toBe(1);
    expect((ownerEntries.data[0]!.payload as { url?: string } | null)?.url).toBe(
      'https://owner.test/hook',
    );

    // ...and the MEMBER's own log does not: the row is not theirs, they are only
    // the actor on it.
    const memberLog = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=webhook_endpoint.created',
      headers: auth(fx),
    });
    expect(memberLog.json<ListResponse>().data.length).toBe(0);
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

  // The arm above names two of the five scrubbed keys. The other three —
  // source_ip, issued_user_agent, ip_address — are equally real: source_ip and
  // issued_user_agent are the MFA-challenge payload shape emitted by
  // auth-flows.ts, so an owner's IP rides in a payload under THOSE names too.
  // Drop any one of them from ACTOR_PRIVACY_PAYLOAD_KEYS and a team member
  // reading the owner's log sees the owner's network identity, with the whole
  // suite still green.
  //
  // So the set is read from source and every member asserted, which also covers
  // a key added later without anyone remembering this file. Each key gets a
  // distinct value so a failure names which one leaked rather than just that
  // something did.
  // The scrub set is enforced whole, not two-of-five.
  //
  // The cross-view arm above names `issued_from_ip` and `user_agent`, and those
  // are the only two members any audit payload actually carries today: a sweep
  // of all 26 audit-emission sites finds that pair in auth-flows.ts and finds no
  // site emitting `source_ip`, `issued_user_agent` or `ip_address`. (The MFA
  // challenge does build `source_ip`/`issued_user_agent`, but that is the Redis
  // challenge envelope — by the time the login is audited at auth-flows.ts:1056
  // the keys have been renamed to the two already covered.)
  //
  // So the other three members are DEFENSIVE spellings, and one is not
  // hypothetical: `ip_address` is what the rest of this codebase calls this data
  // — the column at schema.ts:1522 and the response field this very route emits
  // at line 88. A future emission site reaching for the house spelling is the
  // realistic way an owner IP starts flowing through a payload, and this arm is
  // what makes the scrub cover it on arrival instead of two-fifths of the way.
  //
  // Two separate things are pinned, because they fail differently:
  //
  //   honoured   every key the set declares is actually stripped. Derived from
  //              the set literal, so a member added later is covered the moment
  //              it is added.
  //   declared   the set still contains the members it has. The assertions below
  //              CANNOT see this, which was measured rather than assumed: relax
  //              the population check, delete a member, and this file still
  //              passes 30/30 — the fixture is built FROM the set, so a removed
  //              key is never seeded and never looked for. Naming the members is
  //              what makes a deletion fail, and fail saying which one went.
  it('CRITICAL every key in the actor-privacy set is scrubbed on a cross-actor read', async () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/routes/account-audit.ts'),
      'utf8',
    );
    const block = /ACTOR_PRIVACY_PAYLOAD_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block, 'the actor-privacy key set could not be located').not.toBeNull();
    const keys = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const declared = [
      'issued_from_ip',
      'source_ip',
      'ip_address',
      'user_agent',
      'issued_user_agent',
    ];
    expect(
      declared.filter((k) => !keys.includes(k)),
      'a key was dropped from the actor-privacy set. Nothing else in this file can see that — the ' +
        'arms below seed their fixture from the set itself — so the scrub would silently stop ' +
        'covering that spelling while every test stayed green. Removing one is a deliberate act; ' +
        'if that is the intent, remove it here too',
    ).toEqual([]);

    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    // One row carrying every scrubbed key, each with its own traceable value.
    const values = Object.fromEntries(keys.map((k, i) => [k, `203.0.113.${String(i + 10)}`]));
    await fx.accountAuditRepo.insert({
      accountId: TEAM_OWNER_ID,
      actorType: 'customer',
      action: 'account.login',
      payload: { method: 'password', ...values },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=account.login',
      headers: { ...auth(fx), 'x-driftstack-account': `acc_${TEAM_OWNER_ID}` },
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json<ListResponse>().data[0]!;

    const leaked = keys.filter((k) => Object.hasOwn(entry.payload ?? {}, k));
    expect(
      leaked,
      'a key in the actor-privacy set survived a team member’s cross-account read. That is the ' +
        'owner’s network identity — the exact disclosure this scrub exists to prevent, and the ' +
        'reader is not the data subject',
    ).toEqual([]);
    const leakedValues = keys.filter((k) => res.body.includes(values[k]!));
    expect(leakedValues, 'a scrubbed value still appeared somewhere in the response body').toEqual(
      [],
    );
    // Not scrubbing everything: the non-sensitive field is still there.
    expect(
      entry.payload?.method,
      'the scrub removed a non-sensitive field, so the arms above would pass against a payload ' +
        'that was simply emptied',
    ).toBe('password');
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
    fx = await buildTestApp({ trustProxy: 1 });
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

  // TD-audit-email-prefs-actor-leak — PUT /v1/account/email-preferences
  // computed `auditedAccountId` (the owner) correctly for the
  // team-admin-acting-on-owner case, but never passed `actorAccountId`
  // on the `accountAudit.record(...)` call, so it defaulted to `null`.
  // A null `actorAccountId` is indistinguishable from a genuine
  // self-caused row to `rowNeedsActorPrivacyRedaction` (which only
  // redacts when `actorAccountId !== null && actorAccountId !==
  // accountId`) — so the admin's real IP still leaked verbatim into
  // the OWNER's own audit-log self-view/export. This drives the real
  // PUT route end-to-end (not a direct repo insert) so it would have
  // caught the gap the direct-insert-based tests above could not.
  it('REAL end-to-end: a team-admin changing the owner email preferences no longer leaks the admin IP on the owner self-view', async () => {
    fx = await buildTestApp({ trustProxy: 1 });
    const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000c21';
    const owner = await seedAdditionalAccount(fx, {
      accountId: OWNER_ACCOUNT_ID,
      apiKeyId: '00000000-0000-4000-8000-000000000c22',
      email: 'owner@driftstack.local',
    });
    // The default fixture account (fx) is an admin member of the
    // owner's team — same shape the earlier cross-view test uses.
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-000000000c23',
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);

    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: {
        ...auth(fx),
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
        'x-forwarded-for': '203.0.113.77',
      },
      payload: { event_type: 'tier-changed', opted_in: false },
    });
    expect(put.statusCode).toBe(204);

    // Sanity: the row really is cross-actor (accountId = owner,
    // actorAccountId = the admin who acted) before asserting redaction.
    const raw = fx.accountAuditRepo
      .getAll()
      .find(
        (r) => r.action === 'account.email_preferences_changed' && r.accountId === OWNER_ACCOUNT_ID,
      )!;
    expect(raw.actorAccountId).toBe(fx.accountId);
    expect(raw.actorAccountId).not.toBe(raw.accountId);
    expect(raw.ipAddress).toBe('203.0.113.77');

    // The OWNER self-reads their OWN audit log — no team header, no
    // cross-account relationship. Prior to the fix this returned the
    // acting admin's real IP verbatim (actorAccountId was null on the
    // row, so the per-row redaction check never fired).
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=account.email_preferences_changed',
      headers: { authorization: `Bearer ${owner.plaintext}` },
    });
    expect(list.statusCode).toBe(200);
    const entry = list.json<ListResponse>().data[0]!;
    expect(entry.ip_address).toBeNull();
    expect(entry.user_agent).toBeNull();
    expect(list.body).not.toContain('203.0.113.77');
  });
});
