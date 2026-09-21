// S12/§8.6 — a MOVED account whose plan runs AI on credits only (Personal)
// keeps a stored BYOK key on file but never reads it: PUT and POST /test are
// refused, and GET/DELETE stay open so the customer can still see or clear
// what is there.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AiCreditsRuntime,
  CreditAccountRecord,
} from '../../src/services/ai-credits-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

type MovedAccountState = Pick<CreditAccountRecord, 'billingMode' | 'aiSource'>;

function creditsRuntime(account: MovedAccountState): AiCreditsRuntime {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('this test never sends an AI turn'));
  return {
    mode: 'enforce',
    bootId: 'boot-byok-gate-test',
    reservations: {
      reserve: unreachable,
      settle: unreachable,
      planCall: unreachable,
      admitCall: unreachable,
      markSent: unreachable,
      settleCall: unreachable,
    },
    leaseKeeper: { add: () => undefined, remove: () => undefined, liveCount: () => 0 },
    report: { shadowReport: unreachable, census: unreachable },
    accounts: {
      ensureAccount: (accountId: string) =>
        Promise.resolve({
          accountId,
          aiSourceSetBy: null,
          aiSourceSetAt: null,
          debtMicro: 0,
          autoTopUpEnabled: false,
          ...account,
        }),
    },
  };
}

describe('a moved Personal account cannot set or test its own key', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL PUT is refused with own_key_not_on_plan for a moved Personal account', async () => {
    fx = await buildTestApp({
      tier: 'solo_manual',
      enableByokAnthropic: true,
      aiCredits: creditsRuntime({ billingMode: 'credits', aiSource: 'credits' }),
    });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: 'sk-ant-api03-personal-tries-anyway-aaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ own_key_not_on_plan?: boolean }>();
    expect(body.own_key_not_on_plan).toBe(true);
    // Refused before anything was written.
    expect((await fx.byokAnthropicRepo.findByAccount(fx.accountId))?.ciphertext ?? null).toBeNull();
  });

  it('CRITICAL POST /test is refused with own_key_not_on_plan for a moved Personal account', async () => {
    fx = await buildTestApp({
      tier: 'solo_manual',
      enableByokAnthropic: true,
      aiCredits: creditsRuntime({ billingMode: 'credits', aiSource: 'credits' }),
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ own_key_not_on_plan?: boolean }>().own_key_not_on_plan).toBe(true);
  });

  it('GET stays open on a moved Personal account', async () => {
    fx = await buildTestApp({
      tier: 'solo_manual',
      enableByokAnthropic: true,
      aiCredits: creditsRuntime({ billingMode: 'credits', aiSource: 'credits' }),
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE stays open on a moved Personal account', async () => {
    fx = await buildTestApp({
      tier: 'solo_manual',
      enableByokAnthropic: true,
      aiCredits: creditsRuntime({ billingMode: 'credits', aiSource: 'credits' }),
    });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('a moved account on a plan that DOES allow an own key (Team) may still PUT and test', async () => {
    fx = await buildTestApp({
      tier: 'team_manual',
      enableByokAnthropic: true,
      aiCredits: creditsRuntime({ billingMode: 'credits', aiSource: 'own_key' }),
    });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: 'sk-ant-api03-team-may-set-one-aaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a LEGACY Personal account (not yet moved) is unaffected — PUT still works exactly as before', async () => {
    fx = await buildTestApp({
      tier: 'solo_manual',
      enableByokAnthropic: true,
      aiCredits: creditsRuntime({ billingMode: 'legacy', aiSource: null }),
    });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: 'sk-ant-api03-legacy-personal-aaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('with AI credits off entirely (no aiCredits member), PUT is unaffected on every tier', async () => {
    fx = await buildTestApp({ tier: 'solo_manual', enableByokAnthropic: true });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: 'sk-ant-api03-credits-off-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(200);
  });
});
