// S14 audit fix #5 — `GET /v1/account/me/ai` refreshes a MOVED account's
// credits before it reads them, the way §6.4 says it does ("lazily … in
// `GET /v1/account/me/ai`") and the way `reserve()` already does under its
// savepoint.
//
// Without it, between a window's end and the boundary job (or the 15-minute
// sweep) the GET showed `monthly: null` and `no_credits` — or a debt the
// refresh would have repaid — while `reserve()` refreshed first and ran the
// task anyway.
//
// Never for a LEGACY account (nothing on the credits ledger governs it), and a
// refresh that FAILS is logged and answered from the stored read: the GET
// never 500s because the refresh did.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { MICRO, fakeAccountAiRuntime, liveMonthly } from './_helpers/fake-account-ai-runtime.js';

interface AiStateBody {
  billing: string;
  balance: {
    available_credits: number;
    monthly: { granted_credits: number; remaining_credits: number } | null;
    debt_credits: number;
  };
  blocked_reason: string | null;
}

describe('GET /v1/account/me/ai refreshes a moved account first', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  function get(app: TestAppFixture) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${app.plaintext}` },
    });
  }

  it('CRITICAL a window that has lapsed but is due again reads as the NEW month — the refresh runs before any read', async () => {
    const { runtime, state, calls } = fakeAccountAiRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      window: null,
      monthlyLot: null,
      spendableMicro: 0,
    });
    // What the grants service would do at the boundary: the new window and its lot.
    state.refresh = () => {
      const next = liveMonthly(5_000);
      state.window = next.window;
      state.monthlyLot = next.monthlyLot;
      state.spendableMicro = 5_000 * MICRO;
      return Promise.resolve();
    };
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await get(fx);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<AiStateBody>();
    expect(calls.refresh).toEqual([fx.accountId]);
    expect(body.balance.monthly?.granted_credits).toBe(5_000);
    expect(body.balance.available_credits).toBe(5_000);
    expect(body.blocked_reason).toBeNull();
  });

  it('CRITICAL debt the refresh repays is not reported — the account row is read AFTER the refresh, not before', async () => {
    const { runtime, state } = fakeAccountAiRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      debtMicro: 5 * MICRO,
      ...liveMonthly(100),
      spendableMicro: 100 * MICRO,
    });
    state.refresh = () => {
      state.debtMicro = 0;
      return Promise.resolve();
    };
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const body = (await get(fx)).json<AiStateBody>();
    expect(body.balance.debt_credits).toBe(0);
    expect(body.blocked_reason).toBeNull();
  });

  it('CRITICAL a refresh that throws is answered from the stored read with a 200, never a 500', async () => {
    const { runtime, state, calls } = fakeAccountAiRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      ...liveMonthly(100),
      spendableMicro: 100 * MICRO,
    });
    state.refresh = () => Promise.reject(new Error('the database blinked'));
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await get(fx);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.refresh).toHaveLength(1);
    expect(res.json<AiStateBody>().balance.available_credits).toBe(100);
  });

  it('CRITICAL a LEGACY account is never refreshed', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'enforce', billingMode: 'legacy' });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await get(fx);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AiStateBody>().billing).toBe('legacy');
    expect(calls.refresh).toEqual([]);
  });

  it('a moved account read under SHADOW mode is legacy for every customer purpose, so it is not refreshed either', async () => {
    const { runtime, calls } = fakeAccountAiRuntime({ mode: 'shadow', billingMode: 'credits' });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await get(fx);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.refresh).toEqual([]);
  });
});
