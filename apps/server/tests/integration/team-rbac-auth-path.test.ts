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
