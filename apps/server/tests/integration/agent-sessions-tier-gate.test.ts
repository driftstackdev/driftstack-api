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

// S42 follow-up 2026-07-07 — the OTHER ordering of the create-edge gate:
// POST /:id/mode must not let a manual session (open on every tier) become
// LLM-driven on a tier without aiAgent. Gate reads the tier of rec.accountId
// (the account the session runs and bills against) on BOTH auth paths; a
// gui_control_key proves session access, never tier. Manual-ward flips stay
// open on every tier — handing back to a human is never tier-refused, even
// after a mid-session downgrade.
describe('S42 aiAgent tier gate — POST /v1/agent-sessions/:id/mode', () => {
  let fx: TestAppFixture;
  const GCK_HEADER = 'x-driftstack-gui-control-key';

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function createManualSession(): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'manual' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  function setFixtureTier(tier: 'free' | 'solo_manual' | 'api_builder'): void {
    fx.authRepo.upsertAccount({
      id: fx.accountId,
      email: 'tester@driftstack.local',
      name: 'Tester',
      tier,
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  }

  it("free tier: manual session flipped to mode:'ai' → 403 tier error (create-gate bypass closed)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'free' });
    const id = await createManualSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'ai' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('"aiAgent"');
    expect(body.detail).toContain('"free" tier');
  });

  it("solo_manual tier: manual session flipped to mode:'pair' → 403 (pair is LLM-driven too)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'solo_manual' });
    const id = await createManualSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('"solo_manual" tier');
  });

  it('free tier: gui_control_key flip manual → ai ALSO 403 (control key proves session access, never tier)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'free' });
    const id = await createManualSession();
    const mint = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(mint.statusCode).toBe(200);
    const key = mint.json<{ gui_control_key: string }>().gui_control_key;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { [GCK_HEADER]: key },
      payload: { mode: 'ai' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('"aiAgent"');
  });

  it('mid-session downgrade: ai session on a now-free account flips ai → manual → 200 (handback never tier-refused)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true }); // api_builder default
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'ai' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string }>().id;
    setFixtureTier('free');
    // Production tier changes invalidate the 30s auth cache (Stripe webhook
    // + crypto activation paths both call invalidateAccount); mirror that
    // here so the request below authenticates with the downgraded tier.
    await fx.authCache.invalidateAccount(fx.accountId);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mode: string }>().mode).toBe('manual');
    // …but the downgraded account cannot flip it BACK to ai.
    const back = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'ai' },
    });
    expect(back.statusCode).toBe(403);
  });

  it("free tier: idempotent same-mode POST { mode: 'manual' } on a manual session stays 200 (no-op precedes the gate)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'free' });
    const id = await createManualSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('api_builder: manual → ai flip stays 200 (aiAgent tiers unaffected)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createManualSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'ai' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mode: string }>().mode).toBe('ai');
  });
});
