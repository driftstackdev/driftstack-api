// V-326 — Team RBAC auth path integration tests.
//
// Asserts that a member's AccountContext carries teams[] (loaded by the
// auth repo) + that the routes that surface teams to the client return
// the populated data.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000a01';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000a02';

async function seedTeamOwnerSession(
  role: 'admin' | 'member',
  driverSessionId: string,
  label: string,
) {
  fx = await buildTestApp();
  fx.authRepo.upsertAccount({
    id: OWNER_ACCOUNT_ID,
    email: 'owner@example.test',
    name: null,
    tier: 'api_scale',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  fx.authRepo.setTeamMemberships(fx.accountId, [
    {
      membershipId: MEMBERSHIP_ID,
      ownerAccountId: OWNER_ACCOUNT_ID,
      role,
    },
  ]);
  const owner = await fx.sessionsRepo.insertSession({
    accountId: OWNER_ACCOUNT_ID,
    apiKeyId: '00000000-0000-4000-8000-000000000bff',
    driverSessionId,
    archetype: 'iphone-16-pro-ios-26-4-1',
    purpose: 'production_customer',
    label,
    metadata: { classification: 'persisted-metadata' },
  });
  await fx.sessionsRepo.updateSessionStatus(owner.id, 'ready');
  return owner;
}

describe('V-326 — auth path loads teams[] into AccountContext', () => {
  it('GET /v1/account/me returns empty teams[] for an account on no teams', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ teams: unknown[] }>();
    expect(body.teams).toEqual([]);
  });

  it('GET /v1/account/me surfaces teams[] for an account that is a team member', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      teams: {
        owner_account_id: string;
        owner_email: string;
        owner_name: string | null;
        role: string;
        membership_id: string;
      }[];
    }>();
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toEqual({
      owner_account_id: `acc_${OWNER_ACCOUNT_ID}`,
      // Owner identity (sweep-3) — the in-memory auth repo fills a synthetic
      // email when the owner account isn't seeded into its accounts map; the
      // real Drizzle path joins the actual accounts.email/.name.
      owner_email: `${OWNER_ACCOUNT_ID}@example.test`,
      owner_name: null,
      role: 'admin',
      membership_id: `mem_${MEMBERSHIP_ID}`,
    });
  });

  it('GET /v1/team/owners returns the same data', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/team/owners',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        owner_account_id: string;
        owner_email: string;
        owner_name: string | null;
        role: string;
        membership_id: string;
      }[];
    }>();
    expect(body.data).toEqual([
      {
        owner_account_id: `acc_${OWNER_ACCOUNT_ID}`,
        owner_email: `${OWNER_ACCOUNT_ID}@example.test`,
        owner_name: null,
        role: 'member',
        membership_id: `mem_${MEMBERSHIP_ID}`,
      },
    ]);
  });

  it('GET /v1/team/owners returns empty data[] for an account on no teams', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/team/owners',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data).toEqual([]);
  });
});

describe('V-326 — resolveEffectiveAccount via X-Driftstack-Account header', () => {
  // The resolver runs at route-layer call sites that opt in (none yet
  // in V-326c). We exercise it directly via the unit-style helper.
  it('returns kind:self when no header is provided', async () => {
    const { resolveEffectiveAccount } = await import('../../src/services/auth.js');
    const ctx = {
      account: {
        id: 'self-acc',
        email: 'me@example.test',
        name: null,
        tier: 'api_starter' as const,
        status: 'active' as const,
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      apiKey: {
        id: 'k1',
        accountId: 'self-acc',
        name: 'k',
        keyPrefix: 'ds_live_aaaa',
        keyHash: '',
        scopes: ['account_owner' as const],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      rateLimitOverrides: {},
      teams: [],
      webSession: null,
    };
    const eff = resolveEffectiveAccount(ctx, undefined);
    expect(eff).toEqual({ kind: 'self', accountId: 'self-acc' });
  });

  it('returns kind:team when header references an owner the caller is a member of', async () => {
    const { resolveEffectiveAccount } = await import('../../src/services/auth.js');
    const ctx = {
      account: {
        id: 'self-acc',
        email: 'me@example.test',
        name: null,
        tier: 'api_starter' as const,
        status: 'active' as const,
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      apiKey: {
        id: 'k1',
        accountId: 'self-acc',
        name: 'k',
        keyPrefix: 'ds_live_aaaa',
        keyHash: '',
        scopes: ['account_owner' as const],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      rateLimitOverrides: {},
      teams: [
        {
          membershipId: 'mid',
          ownerAccountId: 'owner-acc',
          role: 'admin' as const,
        },
      ],
      webSession: null,
    };
    const eff = resolveEffectiveAccount(ctx, 'acc_owner-acc');
    expect(eff.kind).toBe('team');
    expect(eff.accountId).toBe('owner-acc');
    if (eff.kind === 'team') {
      expect(eff.role).toBe('admin');
    }
  });

  it('throws ForbiddenError when header references an account the caller is NOT a member of', async () => {
    const { resolveEffectiveAccount } = await import('../../src/services/auth.js');
    const ctx = {
      account: {
        id: 'self-acc',
        email: 'me@example.test',
        name: null,
        tier: 'api_starter' as const,
        status: 'active' as const,
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      apiKey: {
        id: 'k1',
        accountId: 'self-acc',
        name: 'k',
        keyPrefix: 'ds_live_aaaa',
        keyHash: '',
        scopes: ['account_owner' as const],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      rateLimitOverrides: {},
      teams: [],
      webSession: null,
    };
    expect(() => resolveEffectiveAccount(ctx, 'acc_some-other')).toThrow(/not a member of/);
  });

  it('throws ForbiddenError on malformed header (missing acc_ prefix)', async () => {
    const { resolveEffectiveAccount } = await import('../../src/services/auth.js');
    const ctx = {
      account: {
        id: 'self-acc',
        email: 'me@example.test',
        name: null,
        tier: 'api_starter' as const,
        status: 'active' as const,
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      apiKey: {
        id: 'k1',
        accountId: 'self-acc',
        name: 'k',
        keyPrefix: 'ds_live_aaaa',
        keyHash: '',
        scopes: ['account_owner' as const],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      rateLimitOverrides: {},
      teams: [],
      webSession: null,
    };
    expect(() => resolveEffectiveAccount(ctx, 'malformed-no-prefix')).toThrow(/Invalid/);
  });

  it('GET /v1/sessions returns owner sessions when caller is a member + sets X-Driftstack-Account', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    // Seed sessions: 1 for caller + 2 for the owner.
    await fx.sessionsRepo.insertSession({
      accountId: fx.accountId,
      apiKeyId: '00000000-0000-4000-8000-000000000b00',
      driverSessionId: 'drv_self',
      archetype: 'iphone-16-pro-ios-26-4-1',
      purpose: 'production_customer',
      label: 'self-session',
      metadata: null,
    });
    await fx.sessionsRepo.insertSession({
      accountId: OWNER_ACCOUNT_ID,
      apiKeyId: '00000000-0000-4000-8000-000000000b01',
      driverSessionId: 'drv_owner_1',
      archetype: 'iphone-16-pro-ios-26-4-1',
      purpose: 'production_customer',
      label: 'owner-session-1',
      metadata: null,
    });
    await fx.sessionsRepo.insertSession({
      accountId: OWNER_ACCOUNT_ID,
      apiKeyId: '00000000-0000-4000-8000-000000000b02',
      driverSessionId: 'drv_owner_2',
      archetype: 'iphone-16-pro-ios-26-4-1',
      purpose: 'production_customer',
      label: 'owner-session-2',
      metadata: null,
    });

    // No header → caller's own session.
    const own = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json<{ data: { account_id: string; label: string }[] }>();
    expect(ownBody.data.map((d) => d.label)).toEqual(['self-session']);

    // With header → owner's sessions.
    const owner = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(owner.statusCode).toBe(200);
    const ownerBody = owner.json<{ data: { account_id: string; label: string }[] }>();
    expect(ownerBody.data.map((d) => d.label).sort()).toEqual([
      'owner-session-1',
      'owner-session-2',
    ]);
    for (const row of ownerBody.data) {
      expect(row.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);
    }
  });

  it('GET /v1/profiles returns owner profiles when caller is a member + sets X-Driftstack-Account', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    // Seed: 1 caller-owned profile + 2 owner-owned.
    await fx.profilesRepo.insert({
      accountId: fx.accountId,
      name: 'self-profile',
      archetype: 'iphone-16-pro-ios-26-4-1',
      description: null,
    });
    await fx.profilesRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      name: 'owner-profile-1',
      archetype: 'iphone-16-pro-ios-26-4-1',
      description: null,
    });
    await fx.profilesRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      name: 'owner-profile-2',
      archetype: 'iphone-16-pro-ios-26-4-1',
      description: null,
    });

    // No header → caller's own profile.
    const own = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json<{ data: { name: string }[] }>();
    expect(ownBody.data.map((d) => d.name)).toEqual(['self-profile']);

    // With header → owner's profiles.
    const owner = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(owner.statusCode).toBe(200);
    const ownerBody = owner.json<{ data: { name: string }[] }>();
    expect(ownerBody.data.map((d) => d.name).sort()).toEqual([
      'owner-profile-1',
      'owner-profile-2',
    ]);
  });

  it('GET /v1/account/audit-log returns owner audit entries when caller is a member + sets X-Driftstack-Account', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    // Seed: 1 caller-owned audit entry + 2 owner-owned.
    await fx.accountAuditRepo.insert({
      accountId: fx.accountId,
      actorType: 'customer',
      actorAccountId: fx.accountId,
      actorKeyId: null,
      action: 'account.login',
      targetResourceId: null,
      payload: { kind: 'self' },
    });
    await fx.accountAuditRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      actorType: 'customer',
      actorAccountId: OWNER_ACCOUNT_ID,
      actorKeyId: null,
      action: 'account.login',
      targetResourceId: null,
      payload: { kind: 'owner-1' },
    });
    await fx.accountAuditRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      actorType: 'customer',
      actorAccountId: OWNER_ACCOUNT_ID,
      actorKeyId: null,
      action: 'api_key.minted',
      targetResourceId: null,
      payload: { kind: 'owner-2' },
    });

    // No header → caller's own audit log.
    const own = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json<{
      data: { account_id: string; payload: Record<string, unknown> | null }[];
    }>();
    expect(ownBody.data).toHaveLength(1);
    expect(ownBody.data[0]!.account_id).toBe(`acc_${fx.accountId}`);

    // With header → owner's audit log.
    const owner = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(owner.statusCode).toBe(200);
    const ownerBody = owner.json<{
      data: { account_id: string; payload: Record<string, unknown> | null }[];
    }>();
    expect(ownerBody.data).toHaveLength(2);
    for (const row of ownerBody.data) {
      expect(row.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);
    }
  });

  // V-509 — audit-log filter parameters (from / to / actor_type /
  // target_resource_id) must be honored when the caller scopes to
  // an owner via X-Driftstack-Account. Catches "filter forwarding
  // works for the caller's own audit log but not for the owner's"
  // regressions.
  it('V-509 — V-484 filters apply to the owner audit log under X-Driftstack-Account', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    // Seed: 3 owner-owned audit entries with distinct actor_type +
    // target_resource_id so each filter axis has a discriminating
    // hit.
    await fx.accountAuditRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      actorType: 'customer',
      actorAccountId: OWNER_ACCOUNT_ID,
      actorKeyId: null,
      action: 'api_key.minted',
      targetResourceId: 'key_owner_target_one',
      payload: { kind: 'owner-1' },
    });
    await fx.accountAuditRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      actorType: 'customer',
      actorAccountId: OWNER_ACCOUNT_ID,
      actorKeyId: null,
      action: 'api_key.minted',
      targetResourceId: 'key_owner_target_two',
      payload: { kind: 'owner-2' },
    });
    await fx.accountAuditRepo.insert({
      accountId: OWNER_ACCOUNT_ID,
      actorType: 'system',
      actorAccountId: null,
      actorKeyId: null,
      action: 'session.destroyed',
      targetResourceId: 'sess_owner_one',
      payload: { kind: 'owner-system' },
    });
    // Caller-owned entry — must be excluded by every owner-scoped query.
    await fx.accountAuditRepo.insert({
      accountId: fx.accountId,
      actorType: 'customer',
      actorAccountId: fx.accountId,
      actorKeyId: null,
      action: 'api_key.minted',
      targetResourceId: 'key_caller_target',
      payload: { kind: 'self' },
    });

    // Filter by action — only owner's two api_key.minted entries.
    const byAction = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=api_key.minted',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(byAction.statusCode).toBe(200);
    const byActionBody = byAction.json<{
      data: { account_id: string; action: string; target_resource_id: string | null }[];
    }>();
    expect(byActionBody.data).toHaveLength(2);
    for (const row of byActionBody.data) {
      expect(row.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);
      expect(row.action).toBe('api_key.minted');
    }

    // Filter by actor_type=system — only owner's destroyed entry.
    const byActor = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?actor_type=system',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(byActor.statusCode).toBe(200);
    const byActorBody = byActor.json<{
      data: { account_id: string; actor_type: string }[];
    }>();
    expect(byActorBody.data).toHaveLength(1);
    expect(byActorBody.data[0]!.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);
    expect(byActorBody.data[0]!.actor_type).toBe('system');

    // Filter by target_resource_id — owner-targeted, exact match.
    const byTarget = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?target_resource_id=' + encodeURIComponent('key_owner_target_one'),
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(byTarget.statusCode).toBe(200);
    const byTargetBody = byTarget.json<{
      data: { account_id: string; target_resource_id: string | null }[];
    }>();
    expect(byTargetBody.data).toHaveLength(1);
    expect(byTargetBody.data[0]!.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);
    expect(byTargetBody.data[0]!.target_resource_id).toBe('key_owner_target_one');

    // Filter by `from` in the past — all 3 owner entries returned;
    // caller's entry still excluded.
    const longAgo = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const byFrom = await fx.app.inject({
      method: 'GET',
      url: `/v1/account/audit-log?from=${encodeURIComponent(longAgo)}`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(byFrom.statusCode).toBe(200);
    const byFromBody = byFrom.json<{ data: { account_id: string }[] }>();
    expect(byFromBody.data).toHaveLength(3);
    for (const row of byFromBody.data) {
      expect(row.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);
    }
  });

  it('GET /v1/profiles returns 403 when X-Driftstack-Account references a non-member owner', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-deadbeef0000',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /v1/account/email-preferences as admin team member updates the OWNER preferences', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { event_type: 'billing-renewal-reminder', opted_in: false },
    });
    expect(res.statusCode).toBe(204);

    // Read back as the same admin → reflects the change on the
    // OWNER's preferences (not the caller's).
    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/email-preferences',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ data: { event_type: string; opted_in: boolean }[] }>();
    const renewal = body.data.find((r) => r.event_type === 'billing-renewal-reminder');
    expect(renewal?.opted_in).toBe(false);

    // Caller's OWN preferences are unchanged (default opted-in).
    const own = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/email-preferences',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const ownBody = own.json<{ data: { event_type: string; opted_in: boolean }[] }>();
    const ownRenewal = ownBody.data.find((r) => r.event_type === 'billing-renewal-reminder');
    expect(ownRenewal?.opted_in).toBe(true);
  });

  it('PUT /v1/account/email-preferences as MEMBER role gets 403 (admin-only writes)', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/email-preferences',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { event_type: 'billing-renewal-reminder', opted_in: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/account/email-preferences as MEMBER role reads OWNER preferences (read is role-agnostic)', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/email-preferences',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { event_type: string; opted_in: boolean }[] }>();
    // Default is opted-in across all event types.
    expect(body.data.every((r) => r.opted_in)).toBe(true);
  });

  it('GET /v1/usage as team member with X-Driftstack-Account returns OWNER tier-aware quotas', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    // Seed the OWNER account row so the route can resolve the owner's tier.
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tier: string; quotas: Record<string, number | null> }>();
    expect(body.tier).toBe('api_scale');

    // Caller's own /v1/usage still reports the caller's tier.
    const own = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(own.json<{ tier: string }>().tier).toBe('api_starter');
  });

  it('GET /v1/webhooks returns OWNER endpoints when caller is a team member + sets X-Driftstack-Account', async () => {
    fx = await buildTestApp();
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    await fx.webhooksRepo.insertEndpoint({
      accountId: fx.accountId,
      url: 'https://self.example.test/hook',
      secret: 'whsec_self_secret_padded_to_32+chars',
      secretPrefix: 'whsec_self',
      events: ['session.completed'],
      description: 'self-hook',
    });
    await fx.webhooksRepo.insertEndpoint({
      accountId: OWNER_ACCOUNT_ID,
      url: 'https://owner.example.test/hook-1',
      secret: 'whsec_owner1_secret_padded_to_32+chars',
      secretPrefix: 'whsec_o1',
      events: ['session.completed'],
      description: 'owner-hook-1',
    });
    await fx.webhooksRepo.insertEndpoint({
      accountId: OWNER_ACCOUNT_ID,
      url: 'https://owner.example.test/hook-2',
      secret: 'whsec_owner2_secret_padded_to_32+chars',
      secretPrefix: 'whsec_o2',
      events: ['session.completed'],
      description: 'owner-hook-2',
    });

    // No header → caller's own.
    const own = await fx.app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const ownBody = own.json<{ data: { url: string }[] }>();
    expect(ownBody.data.map((d) => d.url)).toEqual(['https://self.example.test/hook']);

    // With header → owner's.
    const owner = await fx.app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    const ownerBody = owner.json<{ data: { url: string }[] }>();
    expect(ownerBody.data.map((d) => d.url).sort()).toEqual([
      'https://owner.example.test/hook-1',
      'https://owner.example.test/hook-2',
    ]);
  });

  it('POST /v1/sessions as admin team member creates session on the OWNER account', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ account_id: string }>();
    expect(body.account_id).toBe(`acc_${OWNER_ACCOUNT_ID}`);

    // Audit row should exist on the OWNER's account (accountId = owner;
    // actor = caller).
    const ownerAuditRows = fx.accountAuditRepo
      .getAll()
      .filter((r) => r.accountId === OWNER_ACCOUNT_ID && r.action === 'session.created');
    expect(ownerAuditRows).toHaveLength(1);
    expect(ownerAuditRows[0]!.actorAccountId).toBe(fx.accountId);
  });

  it('POST /v1/sessions as MEMBER role gets 403 (admin-only writes per Q1)', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /v1/sessions/:id as admin team member destroys an owner session', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    // Create a session via the admin POST path so it's owned by OWNER.
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sessionId}`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(del.statusCode).toBe(204);

    // Audit row on the OWNER's log; actor = caller.
    const ownerDestroyAudits = fx.accountAuditRepo
      .getAll()
      .filter((r) => r.accountId === OWNER_ACCOUNT_ID && r.action === 'session.destroyed');
    expect(ownerDestroyAudits).toHaveLength(1);
    expect(ownerDestroyAudits[0]!.actorAccountId).toBe(fx.accountId);
  });

  it('DELETE /v1/sessions/:id as MEMBER role gets 403 (admin-only writes)', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    // Seed an owner session directly.
    const owner = await fx.sessionsRepo.insertSession({
      accountId: OWNER_ACCOUNT_ID,
      apiKeyId: '00000000-0000-4000-8000-000000000bff',
      driverSessionId: 'drv_owner',
      archetype: 'iphone-16-pro-ios-26-4-1',
      purpose: 'production_customer',
      label: null,
      metadata: null,
    });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/ses_${owner.id}`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/sessions/:id/navigate as MEMBER role gets 403 (admin-only writes per Q1)', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const owner = await fx.sessionsRepo.insertSession({
      accountId: OWNER_ACCOUNT_ID,
      apiKeyId: '00000000-0000-4000-8000-000000000bff',
      driverSessionId: 'drv_owner',
      archetype: 'iphone-16-pro-ios-26-4-1',
      purpose: 'production_customer',
      label: null,
      metadata: null,
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/ses_${owner.id}/navigate`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { url: 'https://example.test' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('team member reads owner list/detail metadata but state is 403 before every session/driver mutation', async () => {
    const owner = await seedTeamOwnerSession('member', 'drv_owner_member', 'owner-metadata');
    const before = fx.sessionsRepo.getSession(owner.id);
    const claim = vi.spyOn(fx.sessionsRepo, 'claimSessionOperation');
    const settle = vi.spyOn(fx.sessionsRepo, 'settleSessionOperation');
    const fail = vi.spyOn(fx.sessionsRepo, 'failSessionOperation');
    const touch = vi.spyOn(fx.sessionsRepo, 'touchSessionLastStateAt');
    const record = vi.spyOn(fx.sessionsRepo, 'recordEvent');
    const getState = vi.spyOn(fx.driver, 'getState');
    const destroy = vi.spyOn(fx.driver, 'destroy');
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
    };

    const list = await fx.app.inject({ method: 'GET', url: '/v1/sessions', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: Array<{ id: string; label: string }> }>().data).toEqual([
      expect.objectContaining({ id: `ses_${owner.id}`, label: 'owner-metadata' }),
    ]);

    const detail = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/ses_${owner.id}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ id: string; account_id: string; metadata: unknown }>()).toMatchObject({
      id: `ses_${owner.id}`,
      account_id: `acc_${OWNER_ACCOUNT_ID}`,
      metadata: { classification: 'persisted-metadata' },
    });

    const state = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/ses_${owner.id}/state`,
      headers,
    });
    expect(state.statusCode).toBe(403);
    expect(state.json<{ detail: string }>().detail).toMatch(
      /Live session operations on a team owner require admin role/,
    );
    expect(claim).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(fx.sessionsRepo.getSession(owner.id)).toEqual(before);
    expect(fx.sessionsRepo.getEvents()).toEqual([]);
  });

  it('team admin receives exact owner cookies/localStorage from the owner driver', async () => {
    const owner = await seedTeamOwnerSession('admin', 'drv_owner_admin', 'owner-live');
    const capturedAt = new Date('2026-07-17T20:00:00.000Z');
    const getState = vi.spyOn(fx.driver, 'getState').mockResolvedValue({
      url: 'https://owner.example.test/private',
      title: 'Owner portal',
      cookies: [{ name: 'owner-session', value: 'cookie-value', httpOnly: true }],
      localStorage: { owner_token: 'storage-value' },
      pageState: { state: 'loaded' },
      capturedAt,
    });

    const state = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/ses_${owner.id}/state`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({
      url: 'https://owner.example.test/private',
      title: 'Owner portal',
      cookies: [{ name: 'owner-session', value: 'cookie-value', httpOnly: true }],
      local_storage: { owner_token: 'storage-value' },
      page_state: { state: 'loaded' },
      captured_at: capturedAt.toISOString(),
    });
    expect(getState).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledWith('drv_owner_admin');
    expect(fx.sessionsRepo.getSession(owner.id)?.status).toBe('ready');
  });

  it('self read:sessions access still receives exact live state without a team header', async () => {
    fx = await buildTestApp({ scopes: ['read:sessions'] });
    const self = await fx.sessionsRepo.insertSession({
      accountId: fx.accountId,
      apiKeyId: fx.apiKeyId,
      driverSessionId: 'drv_self_state',
      archetype: 'iphone-16-pro-ios-26-4-1',
      purpose: 'production_customer',
      label: 'self-live',
      metadata: null,
    });
    await fx.sessionsRepo.updateSessionStatus(self.id, 'ready');
    const capturedAt = new Date('2026-07-17T20:01:00.000Z');
    const getState = vi.spyOn(fx.driver, 'getState').mockResolvedValue({
      url: 'https://self.example.test',
      title: 'Self portal',
      cookies: [{ name: 'self-session', value: 'self-cookie' }],
      localStorage: { self_token: 'self-storage' },
      pageState: null,
      capturedAt,
    });

    const state = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/ses_${self.id}/state`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({
      url: 'https://self.example.test',
      title: 'Self portal',
      cookies: [{ name: 'self-session', value: 'self-cookie' }],
      local_storage: { self_token: 'self-storage' },
      page_state: null,
      captured_at: capturedAt.toISOString(),
    });
    expect(getState).toHaveBeenCalledWith('drv_self_state');
  });

  it('POST /v1/profiles as admin team member creates profile on the OWNER account', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { name: 'team-profile' },
    });
    expect(res.statusCode).toBe(200);

    // Profile lives on the OWNER's account.
    const ownerProfiles = await fx.profilesRepo.list({
      accountId: OWNER_ACCOUNT_ID,
      limit: 10,
    });
    expect(ownerProfiles.data.map((p) => p.name)).toContain('team-profile');
  });

  it('POST /v1/profiles as MEMBER role gets 403 (admin-only writes)', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { name: 'should-403' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/webhooks as admin team member creates webhook on the OWNER account', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: {
        url: 'https://owner.example.test/wh',
        events: ['session.completed'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string }>();
    // Endpoint should live on the OWNER's account.
    const ownerEndpoints = await fx.webhooksRepo.listEndpoints(OWNER_ACCOUNT_ID);
    expect(ownerEndpoints.map((e) => e.url)).toContain('https://owner.example.test/wh');
    expect(body.id).toBeTruthy();
  });

  it('POST /v1/webhooks as MEMBER role gets 403 (admin-only writes)', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: {
        url: 'https://blocked.example.test/wh',
        events: ['session.completed'],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/api-keys as admin team member mints key on the OWNER account', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'admin',
      },
    ]);
    // Seed legal acceptances for the OWNER (mirrors the buildTestApp
    // pattern that seeds the calling account, but for the team
    // owner's id). V-049 + V-326e6: api-key issuance is gated on
    // OWNER's pending acceptances when team-scoped.
    for (const entry of fx.legalCatalog.entries()) {
      await fx.legalRepo.recordAcceptance({
        accountId: OWNER_ACCOUNT_ID,
        documentKey: entry.documentKey,
        version: entry.version,
        contentHash: entry.contentHash,
        acceptedFromIp: null,
        acceptedUserAgent: null,
      });
    }
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { name: 'team-key', scopes: ['account_owner'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; key_prefix: string }>();
    // Plaintext should be ds_live_… because OWNER's tier is api_scale.
    expect(body.key_prefix.startsWith('ds_live_')).toBe(true);

    // Key lives on the OWNER's account.
    const ownerKeys = await fx.apiKeysRepo.listApiKeys(OWNER_ACCOUNT_ID);
    expect(ownerKeys.map((k) => k.name)).toContain('team-key');
  });

  it('POST /v1/api-keys as MEMBER role gets 403 (admin-only writes)', async () => {
    fx = await buildTestApp();
    fx.authRepo.upsertAccount({
      id: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: MEMBERSHIP_ID,
        ownerAccountId: OWNER_ACCOUNT_ID,
        role: 'member',
      },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
        'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}`,
      },
      payload: { name: 'should-403', scopes: ['account_owner'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/sessions returns 403 when X-Driftstack-Account references a non-member owner', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-deadbeef0000',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns kind:self when header references the caller’s own account', async () => {
    const { resolveEffectiveAccount } = await import('../../src/services/auth.js');
    const ctx = {
      account: {
        id: 'self-acc',
        email: 'me@example.test',
        name: null,
        tier: 'api_starter' as const,
        status: 'active' as const,
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      apiKey: {
        id: 'k1',
        accountId: 'self-acc',
        name: 'k',
        keyPrefix: 'ds_live_aaaa',
        keyHash: '',
        scopes: ['account_owner' as const],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      rateLimitOverrides: {},
      teams: [],
      webSession: null,
    };
    const eff = resolveEffectiveAccount(ctx, 'acc_self-acc');
    expect(eff).toEqual({ kind: 'self', accountId: 'self-acc' });
  });
});
