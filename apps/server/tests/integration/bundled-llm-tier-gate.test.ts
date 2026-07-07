// S42 2026-07-07 (founder-approved) — bundled-LLM consent tier gate on
// PATCH /v1/account/me/bundled-llm-settings.
//
// TIER_FEATURES.llmBilling grants bundled billing ('byok_or_bundled' /
// 'byok_or_bundled_custom') only to api_builder / api_scale / enterprise;
// every other aiAgent tier is BYOK-only. Before S42 the PATCH had no tier
// check, so a BYOK-only (or even free) account could flip consent=true and
// arm Driftstack-pays-Anthropic billing its tier doesn't offer.
//
// Contract under test:
//   - consent=true on a byok_only / null-llmBilling tier → 403 Forbidden
//     tier error (requireBundledLlmTier, lib/errors-helpers.ts).
//   - consent=true on api_builder / api_scale / enterprise → 200.
//   - consent=false (opting OUT) and cap-only PATCHes stay open on every
//     tier — a downgraded account can always switch bundled billing off.
//   - GET settings/status stay open (read-only) — unchanged.
//   - BYOK settings live on routes/account-byok-anthropic.ts and are NOT
//     gated by this change.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('S42 bundled-LLM consent tier gate — PATCH /v1/account/me/bundled-llm-settings', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('team_manual (BYOK-only tier): consent=true → 403 tier error; state unchanged', async () => {
    fx = await buildTestApp({
      tier: 'team_manual',
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
    });
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { consent: true },
    });
    expect(patch.statusCode).toBe(403);
    const body = patch.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('Bundled-LLM billing');
    expect(body.detail).toContain('"team_manual" tier');
    // The refused flip must not have persisted.
    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.json()).toEqual({ consent: false, monthly_cap_usd_cents: 2000 });
  });

  it('free tier: consent=true → 403 tier error', async () => {
    fx = await buildTestApp({
      tier: 'free',
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
    });
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { consent: true },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json<{ detail: string }>().detail).toContain('"free" tier');
  });

  it('team_manual: cap-only PATCH → 200 (cap changes are not gated)', async () => {
    fx = await buildTestApp({
      tier: 'team_manual',
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
    });
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { monthly_cap_usd_cents: 1500 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ consent: false, monthly_cap_usd_cents: 1500 });
  });

  it('team_manual with consent already true (downgrade scenario): consent=false → 200 (opt-out always allowed)', async () => {
    fx = await buildTestApp({
      tier: 'team_manual',
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
    });
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { consent: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ consent: false, monthly_cap_usd_cents: 2000 });
  });

  it.each(['api_builder', 'api_scale', 'enterprise'] as const)(
    '%s: consent=true → 200 (bundled tiers unaffected)',
    async (tier) => {
      fx = await buildTestApp({
        tier,
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
      });
      const patch = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
        payload: { consent: true },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toEqual({ consent: true, monthly_cap_usd_cents: 2000 });
    },
  );
});
