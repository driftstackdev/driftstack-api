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

import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('a TURN re-checks the tier, so stored consent on a downgraded account cannot draw on the deployment key', async () => {
    // The PATCH gate above only runs when consent is SET. Nothing clears stored
    // consent when the tier later falls — the Stripe past_due/unpaid/paused/
    // canceled handlers move accounts.tier and emit an audit row, and no
    // downgrade path resets bundled_llm_consent. Trusting the stored flag at
    // turn time therefore let a downgraded (or lapsed-payment) account keep
    // spending Driftstack's DEPLOYMENT Anthropic key indefinitely. Consent is
    // the customer's permission; the tier is the entitlement.
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 200000 },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string }>().id;

    // Downgrade the plan the way a failed payment does — consent stays true.
    const live = await fx.authRepo.getAccount(fx.accountId);
    fx.authRepo.upsertAccount({ ...live!, tier: 'team_manual' });

    // The soft-cap lookup lives INSIDE the bundled leg, so it is called only
    // when a turn actually intends to spend the deployment key. Asserting on it
    // is a direct read of "did this turn take the bundled path", rather than on
    // a status code — a turn can still succeed through the separate generic
    // decomposer fallback, and what this fix guarantees is precisely that a
    // downgraded account stops drawing on the bundled DEPLOYMENT key.
    const capLookup = vi.spyOn(fx.bundledLlmRepo, 'sumMonthlySpendCents');
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(capLookup).not.toHaveBeenCalled();

    // Control: restore the entitled tier and the same turn DOES take it, so the
    // assertion above is about the downgrade and not about some unrelated skip.
    const downgraded = await fx.authRepo.getAccount(fx.accountId);
    fx.authRepo.upsertAccount({ ...downgraded!, tier: 'api_builder' });
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(capLookup).toHaveBeenCalled();
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

  // ─── the tier-ineligible REFUSAL, on a Claude-wired deployment ───────────
  //
  // Added 2026-08-15. The arm above proves a downgraded account stops DRAWING on
  // the deployment key — via a spy, because on a deterministic deployment the
  // turn then succeeds through the generic decomposer and there is no refusal to
  // assert. That left `routes/agent-sessions.ts:4632`, the refusal itself, never
  // executed (assessment item 5f).
  //
  // It needs three conditions at once: no resolvable key,
  // `bundledLlmTierIneligible`, and `agentDecomposerKind === 'claude'`. The third
  // was unreachable — `buildTestApp` never passed it and `buildApp` defaults to
  // `'deterministic'` — so the harness gained an `agentDecomposerKind` option in
  // this commit. That flag changes only what the ROUTE believes is wired; the
  // runtime's decomposer stays deterministic, which is faithful because this
  // branch refuses before any decomposer call.
  //
  // What the refusal is FOR: consent is already on, so the blocker is the plan.
  // Sending this customer the consent error would point them at a toggle that is
  // already ticked, and sending them the generic ByokAnthropicRequired 502 would
  // suggest supplying a key when upgrading is the simpler fix. It is the
  // difference between an actionable answer and a wrong one.
  //
  // MUTATION-PROVED against routes/agent-sessions.ts — control 9/9:
  //
  //   the refusal collapses into the CONSENT error            1 red
  //   `bundledLlmTierIneligible` is never set                 1 red
  //   the gate stops requiring a Claude-wired deployment      1 red
  //
  // The third is the one that shows the harness option is load-bearing rather
  // than cosmetic: flip the condition to `'deterministic'` and this arm reds,
  // because it is reaching the branch through exactly the flag that was
  // previously unreachable.

  it('CRITICAL a consented-but-downgraded account gets the TIER refusal, not the consent error and not the generic 502. Consent is on, so the blocker is the plan: naming the wrong one sends the customer to a toggle that is already ticked, or tells them to supply an API key when an upgrade is the simpler fix.', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 200000 },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode, 'session created while still entitled').toBe(201);
    const id = create.json<{ id: string }>().id;

    // Downgrade the way a failed payment does — consent stays true, and nothing
    // in the downgrade path clears it.
    const live = await fx.authRepo.getAccount(fx.accountId);
    fx.authRepo.upsertAccount({ ...live!, tier: 'team_manual' });

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { user_message: 'open https://example.com and capture' },
    });

    expect(res.statusCode, 'refused as a plan problem, not a server fault').toBe(403);
    const detail = res.json<{ detail: string }>().detail;
    expect(detail, 'names the plan as the blocker').toMatch(/not available on this account/i);
    expect(detail, 'and points at the two real ways out').toMatch(
      /Upgrade to a tier|byok-anthropic-key/i,
    );
    expect(detail, 'never mentions consent, which is already on').not.toMatch(/consent/i);
  });
});
