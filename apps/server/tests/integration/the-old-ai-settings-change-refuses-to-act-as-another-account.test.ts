// S13–S16 re-audit, round 1, finding 3 — the sibling of S14 audit #9 on the OLD
// settings route.
//
// `PATCH /v1/account/me/bundled-llm-settings` ignored `X-Driftstack-Account`,
// and the dashboard sends that header on every request it makes from a team
// workspace. So a team member saving the AI form in the team workspace changed
// their OWN account — its legacy consent and cap, or for a moved account its
// `ai_source` — while the page said it was saving the team's.
//
// It now refuses a header naming any account but the caller's own with the
// same self-workspace 400 `PATCH /v1/account/me/ai-settings` answers, BEFORE it
// reads the body or anything else, and writes nothing. A header naming the
// caller's own account is the same as no header; one naming an account the
// caller is not a member of is refused by the shared resolver (403).

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { fakeAccountAiRuntime } from './_helpers/fake-account-ai-runtime.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000e1';
const STRANGER_ID = '00000000-0000-4000-8000-0000000000e2';
const SELF_WORKSPACE_ONLY =
  'AI settings can be changed only in the Self workspace. Remove X-Driftstack-Account and retry.';

/** A member of `OWNER_ID`'s team, whose own legacy settings are consent off, cap $20. */
async function member(opts: { runtime?: AiCreditsRuntime } = {}): Promise<TestAppFixture> {
  const fx = await buildTestApp({
    tier: 'api_builder',
    scopes: ['read', 'write', 'account_owner'],
    enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
    ...(opts.runtime !== undefined ? { aiCredits: opts.runtime } : {}),
  });
  fx.authRepo.upsertAccount({
    id: OWNER_ID,
    email: 'owner-e1@driftstack.local',
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
    { membershipId: 'membership-e1', ownerAccountId: OWNER_ID, role: 'admin' },
  ]);
  return fx;
}

function patch(
  fx: TestAppFixture,
  actingAs: string | null,
  payload: unknown,
): Promise<LightMyRequestResponse> {
  return fx.app.inject({
    method: 'PATCH',
    url: '/v1/account/me/bundled-llm-settings',
    headers: {
      authorization: `Bearer ${fx.plaintext}`,
      ...(actingAs !== null ? { 'x-driftstack-account': `acc_${actingAs}` } : {}),
    },
    payload: payload as Record<string, unknown>,
  });
}

let fx: TestAppFixture | null = null;
afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

describe('PATCH /v1/account/me/bundled-llm-settings refuses act-as', () => {
  it('CRITICAL a legacy account: a member naming the team owner is refused 400, and neither account’s settings change', async () => {
    fx = await member();
    const res = await patch(fx, OWNER_ID, { consent: false, monthly_cap_usd_cents: 3_000 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe(SELF_WORKSPACE_ONLY);
    expect(await fx.bundledLlmRepo.findSettings(fx.accountId), 'the member’s own row').toEqual({
      consent: false,
      monthlyCapUsdCents: 2_000,
    });
    expect(await fx.bundledLlmRepo.findSettings(OWNER_ID), 'the owner’s row').toBeNull();
  });

  it('CRITICAL a moved account: a member naming the owner is refused 400 before any credits read, and no ai_source is written', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await member({ runtime });
    const res = await patch(fx, OWNER_ID, { consent: false });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe(SELF_WORKSPACE_ONLY);
    expect(calls.setAiSource).toEqual([]);
    expect(calls.ensureAccount).toEqual([]);
  });

  it('CRITICAL the refusal comes before the body is read: an invalid body with the header is the self-workspace 400, not a validation error', async () => {
    fx = await member();
    const res = await patch(fx, OWNER_ID, { monthly_cap_usd_cents: 'lots' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe(SELF_WORKSPACE_ONLY);
  });

  it('it is the same refusal PATCH /v1/account/me/ai-settings gives for the same header', async () => {
    const { runtime } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'credits' });
    fx = await member({ runtime });
    const oldRoute = await patch(fx, OWNER_ID, { consent: false });
    const newRoute = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
      payload: { ai_source: 'own_key' },
    });
    expect(oldRoute.statusCode).toBe(newRoute.statusCode);
    expect(oldRoute.json<{ detail?: string }>().detail).toBe(
      newRoute.json<{ detail?: string }>().detail,
    );
  });

  it('CRITICAL naming an account the caller is not a member of is refused 403, and nothing is written', async () => {
    fx = await member();
    const res = await patch(fx, STRANGER_ID, { consent: false, monthly_cap_usd_cents: 3_000 });
    expect(res.statusCode, res.body).toBe(403);
    expect(await fx.bundledLlmRepo.findSettings(fx.accountId)).toEqual({
      consent: false,
      monthlyCapUsdCents: 2_000,
    });
  });

  it('naming the caller’s OWN account is the same as no header: the save goes through', async () => {
    fx = await member();
    const res = await patch(fx, fx.accountId, { consent: false, monthly_cap_usd_cents: 3_000 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ consent: false, monthly_cap_usd_cents: 3_000 });
    expect(await fx.bundledLlmRepo.findSettings(fx.accountId)).toEqual({
      consent: false,
      monthlyCapUsdCents: 3_000,
    });
  });

  it('no header: the save goes through (control)', async () => {
    fx = await member();
    const res = await patch(fx, null, { consent: false, monthly_cap_usd_cents: 3_000 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await fx.bundledLlmRepo.findSettings(fx.accountId)).toEqual({
      consent: false,
      monthlyCapUsdCents: 3_000,
    });
  });
});
