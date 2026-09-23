// S14 audit fix #9 — act-as (`X-Driftstack-Account`) across the S14 customer
// routes.
//
// Only `GET /v1/account/me/ai` honoured it. So a free-tier member acting as a
// Team owner read `available_on_your_plan: false` for every model while the
// turns they started ran on the owner's plan; the ledger showed the MEMBER's
// account; and the PATCH silently wrote the member's own account.
//
// Now: `GET /v1/account/me/ai/ledger` and `GET /v1/ai/models` resolve the
// effective account through the SAME resolver and membership check as
// `GET /v1/account/me/ai` (`resolveEffectiveAccount`), and
// `PATCH /v1/account/me/ai-settings` REFUSES a header naming any account but
// the caller's own, with the 400 the codebase already uses for a
// self-workspace-only route (`routes/billing-crypto.ts`), before it reads the
// body or writes anything.

import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { fakeAccountAiRuntime } from './_helpers/fake-account-ai-runtime.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const STRANGER_ID = '00000000-0000-4000-8000-0000000000f2';

async function memberOfTeamOwner(opts: {
  memberTier: AccountTier;
  ownerTier: AccountTier;
  runtime: AiCreditsRuntime;
  scopes?: ('read' | 'write' | 'account_owner')[];
}): Promise<TestAppFixture> {
  const fx = await buildTestApp({
    tier: opts.memberTier,
    aiCredits: opts.runtime,
    ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
  });
  fx.authRepo.upsertAccount({
    id: OWNER_ID,
    email: 'owner-f1@driftstack.local',
    name: 'Owner',
    tier: opts.ownerTier,
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  fx.authRepo.setTeamMemberships(fx.accountId, [
    { membershipId: 'membership-f1', ownerAccountId: OWNER_ID, role: 'member' },
  ]);
  return fx;
}

interface CatalogueEntry {
  id: string;
  available_on_your_plan: boolean;
}

describe('GET /v1/ai/models honours act-as', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  it('CRITICAL a Personal-plan member acting as a Team owner reads the OWNER’s plan: an own-key-only model is available', async () => {
    const { runtime } = fakeAccountAiRuntime();
    fx = await memberOfTeamOwner({ memberTier: 'solo_manual', ownerTier: 'team_manual', runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const opus = res.json<{ data: CatalogueEntry[] }>().data.find((m) => m.id === 'claude-opus-5');
    expect(opus?.available_on_your_plan).toBe(true);
  });

  it('without the header the same member reads their own Personal plan: the own-key-only model is not available', async () => {
    const { runtime } = fakeAccountAiRuntime();
    fx = await memberOfTeamOwner({ memberTier: 'solo_manual', ownerTier: 'team_manual', runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const opus = res.json<{ data: CatalogueEntry[] }>().data.find((m) => m.id === 'claude-opus-5');
    expect(opus?.available_on_your_plan).toBe(false);
  });

  it('CRITICAL acting as an account the caller is not a member of is refused 403', async () => {
    const { runtime } = fakeAccountAiRuntime();
    fx = await memberOfTeamOwner({ memberTier: 'solo_manual', ownerTier: 'team_manual', runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${STRANGER_ID}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/account/me/ai/ledger honours act-as', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  it('CRITICAL a member acting as the owner reads the OWNER’s ledger, not their own', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await memberOfTeamOwner({ memberTier: 'team_manual', ownerTier: 'team_manual', runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai/ledger',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.ledgerPage).toEqual([OWNER_ID]);
  });

  it('without the header the caller reads their own ledger', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await memberOfTeamOwner({ memberTier: 'team_manual', ownerTier: 'team_manual', runtime });
    await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai/ledger',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(calls.ledgerPage).toEqual([fx.accountId]);
  });

  it('CRITICAL acting as a non-member is refused 403 and reads no ledger at all', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await memberOfTeamOwner({ memberTier: 'team_manual', ownerTier: 'team_manual', runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai/ledger',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${STRANGER_ID}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.ledgerPage).toEqual([]);
  });
});

describe('PATCH /v1/account/me/ai-settings refuses act-as', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  it('CRITICAL a member naming the owner is refused 400 and NOTHING is written to either account', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await memberOfTeamOwner({
      memberTier: 'team_manual',
      ownerTier: 'team_manual',
      runtime,
      scopes: ['read', 'write', 'account_owner'],
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
      payload: { ai_source: 'own_key' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toMatch(/only in the Self workspace/);
    expect(calls.setAiSource).toEqual([]);
    expect(calls.ensureAccount).toEqual([]);
  });

  it('CRITICAL naming an account the caller is not a member of is refused too, and nothing is written', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await memberOfTeamOwner({
      memberTier: 'team_manual',
      ownerTier: 'team_manual',
      runtime,
      scopes: ['read', 'write', 'account_owner'],
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${STRANGER_ID}`,
      },
      payload: { ai_source: 'own_key' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls.setAiSource).toEqual([]);
  });

  it('naming the caller’s OWN account is the same as no header, and the change goes through', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await memberOfTeamOwner({
      memberTier: 'team_manual',
      ownerTier: 'team_manual',
      runtime,
      scopes: ['read', 'write', 'account_owner'],
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${fx.accountId}`,
      },
      payload: { ai_source: 'own_key' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.setAiSource).toEqual([fx.accountId]);
  });
});
