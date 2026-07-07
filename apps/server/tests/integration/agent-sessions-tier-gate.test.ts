// S42 2026-07-07 (founder-approved) — V-485 aiAgent tier gate on
// POST /v1/agent-sessions (the FIRST requireTierFeature call site; the
// guard had zero call sites since V-485 defined it, so free/personal
// accounts could open AI sessions the tier matrix says they don't have).
//
// Contract under test:
//   - LLM-driven modes ('ai' — also the repo default when `mode` is
//     omitted — and 'pair') require TIER_FEATURES[tier].aiAgent on the
//     OWNER's tier. free + solo_manual → 403 Forbidden tier error.
//   - mode:'manual' stays ungated on EVERY tier: the GUI profile-launch
//     path creates manual sessions (apps/gui-client ProfilesView), and
//     manual driving IS the free/personal product.
//   - team_manual is the lowest aiAgent tier → 201 for mode:'ai'.
//   - gui_control keys are untouched: the CREATE route authenticates via
//     requireAuth + requireScope only (controlKeyOrAccountAuth is wired
//     to the session-scoped control endpoints, never to create).

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('S42 aiAgent tier gate — POST /v1/agent-sessions', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('free tier, mode omitted (server default = ai) → 403 tier error', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'free' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('"aiAgent"');
    expect(body.detail).toContain('"free" tier');
  });

  it("free tier, mode:'pair' → 403 (pair is LLM-driven too)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'free' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'pair' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('"aiAgent"');
  });

  it("solo_manual tier, mode:'ai' → 403 (Personal is manual-only)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'solo_manual' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'ai' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('"solo_manual" tier');
  });

  it("free tier, mode:'manual' → 201 (the GUI manual product stays open)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'free' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'manual' },
    });
    expect(res.statusCode).toBe(201);
  });

  it("team_manual (lowest aiAgent tier), mode:'ai' → 201", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'team_manual' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'ai' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('api_builder (fixture default), mode omitted → 201 (API ladder unaffected)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(201);
  });

  // Team-scoped creates gate on the OWNER's tier — the account the session
  // runs, bills, and counts against — not the calling member's own tier
  // (resolveOwnerTier, mirroring the storage-quota gate's owner-scoping).
  const OWNER_ID = '00000000-0000-4000-8000-00000000c001';
  const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000c002';

  function seedOwner(fixture: TestAppFixture, tier: 'free' | 'team_manual'): void {
    fixture.authRepo.upsertAccount({
      id: OWNER_ID,
      email: 'tier-gate-owner@driftstack.local',
      name: 'Tier Gate Owner',
      tier,
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    fixture.authRepo.setTeamMemberships(fixture.accountId, [
      { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ID, role: 'admin' },
    ]);
  }

  it("team act-as: admin member (api_builder key) launching mode:'ai' under a FREE owner → 403 naming the OWNER's tier", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    seedOwner(fx, 'free');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
      payload: { token_budget: 50_000, mode: 'ai' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('"free" tier');
  });

  it("team act-as: admin member launching mode:'ai' under a team_manual owner → 201", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    seedOwner(fx, 'team_manual');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
      payload: { token_budget: 50_000, mode: 'ai' },
    });
    expect(res.statusCode).toBe(201);
  });
});
