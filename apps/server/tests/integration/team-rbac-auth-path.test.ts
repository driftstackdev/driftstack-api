// V-326 — Team RBAC auth path integration tests.
//
// Asserts that a member's AccountContext carries teams[] (loaded by the
// auth repo) + that the routes that surface teams to the client return
// the populated data.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000a01';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000a02';

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
      teams: { owner_account_id: string; role: string; membership_id: string }[];
    }>();
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toEqual({
      owner_account_id: `acc_${OWNER_ACCOUNT_ID}`,
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
      data: { owner_account_id: string; role: string; membership_id: string }[];
    }>();
    expect(body.data).toEqual([
      {
        owner_account_id: `acc_${OWNER_ACCOUNT_ID}`,
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
    };
    const eff = resolveEffectiveAccount(ctx, 'acc_self-acc');
    expect(eff).toEqual({ kind: 'self', accountId: 'self-acc' });
  });
});
