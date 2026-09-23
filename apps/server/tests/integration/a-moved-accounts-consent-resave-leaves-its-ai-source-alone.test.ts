// S13 audit fix #12 — re-saving the old AI settings form leaves a moved
// account's AI source alone, and every source change the old route does make
// is audited.
//
// The dashboard sends `consent: true` on EVERY save of the settings form. For a
// moved account on `ai_source: 'credits'` that used to rewrite the source to
// automatic (NULL) — and for a Team account with a usable stored key, that
// silently moved its turns off included credits and onto the customer's own
// key — with no audit row of any kind, because the true/false consent
// PROJECTION (`ai_source !== 'own_key'`) had not changed.
//
// Now a PATCH whose consent value would not change that projection writes
// nothing to `ai_source`; a PATCH that does change it writes the source and an
// `account.ai_source_changed` audit row (the same action and payload shape
// `PATCH /v1/account/me/ai-settings` writes), beside the existing
// `account.bundled_llm_consent_changed` row.
//
// Same fixture shape as the S13 route file: a credits runtime scripted in
// memory, whose `setAiSource` records every call.

import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTier, AiSource, AiSourceSetBy } from '@driftstack/api-types';
import type {
  AiCreditsRuntime,
  CreditAccountRecord,
  CurrentCreditWindow,
} from '../../src/services/ai-credits-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const MICRO = 1_000_000;

const WINDOW: CurrentCreditWindow = {
  id: 'window-resave-1',
  windowStart: '2026-09-01T00:00:00.000000Z',
  windowEnd: '2026-10-01T00:00:00.000000Z',
  levelMicro: 3_000 * MICRO,
};

interface Scripted {
  readonly runtime: AiCreditsRuntime;
  readonly setAiSourceCalls: Array<{ aiSource: AiSource | null; setBy: AiSourceSetBy }>;
}

function movedRuntime(aiSource: AiSource | null): Scripted {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('this file never sends an AI turn'));
  const setAiSourceCalls: Array<{ aiSource: AiSource | null; setBy: AiSourceSetBy }> = [];
  let record: Omit<CreditAccountRecord, 'accountId'> = {
    billingMode: 'credits',
    aiSource,
    aiSourceSetBy: 'cutover',
    aiSourceSetAt: new Date('2026-09-01T00:00:00Z'),
    debtMicro: 0,
    autoTopUpEnabled: false,
    legacyConsentAtMove: false,
    legacyCapCentsAtMove: 2000,
    hadStoredKeyAtMove: true,
    movedToCreditsAt: new Date('2026-09-01T00:00:00Z'),
    movedBackAt: null,
  };
  const runtime: AiCreditsRuntime = {
    mode: 'enforce',
    bootId: 'boot-resave-test',
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
      ensureAccount: (accountId: string) => Promise.resolve({ ...record, accountId }),
      setAiSource: (
        accountId: string,
        args: { aiSource: AiSource | null; setBy: AiSourceSetBy },
      ) => {
        setAiSourceCalls.push({ ...args });
        record = { ...record, aiSource: args.aiSource, aiSourceSetBy: args.setBy };
        return Promise.resolve({ ...record, accountId });
      },
      spendableMicro: () => Promise.resolve(1_000 * MICRO),
      otherLiveGrantedMicro: () => Promise.resolve(0),
      chargedInWindowMicro: () => Promise.resolve(0),
    },
    windows: { currentWindow: () => Promise.resolve(WINDOW) },
  };
  return { runtime, setAiSourceCalls };
}

describe('a moved account’s consent re-save leaves its AI source alone', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  async function patch(
    tier: AccountTier,
    aiSource: AiSource | null,
    body: Record<string, unknown>,
  ): Promise<{
    status: number;
    body: { consent: boolean; monthly_cap_usd_cents: number };
    calls: Scripted['setAiSourceCalls'];
    audits: Array<{ action: string; payload: unknown }>;
  }> {
    const scripted = movedRuntime(aiSource);
    fx = await buildTestApp({ tier, aiCredits: scripted.runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: body,
    });
    return {
      status: res.statusCode,
      body: res.json(),
      calls: scripted.setAiSourceCalls,
      audits: fx.accountAuditRepo
        .getAll()
        .filter(
          (r) =>
            r.action === 'account.ai_source_changed' ||
            r.action === 'account.bundled_llm_consent_changed',
        )
        .map((r) => ({ action: r.action, payload: r.payload })),
    };
  }

  it("CRITICAL a Team account on 'credits' re-saving consent:true (the dashboard's every save) stays on 'credits' — nothing written, nothing audited", async () => {
    const r = await patch('team_manual', 'credits', { consent: true });
    expect(r.status).toBe(200);
    expect(r.body.consent).toBe(true);
    expect(r.calls, 'ai_source was not rewritten to automatic').toEqual([]);
    expect(r.audits).toEqual([]);
  });

  it("CRITICAL the dashboard's whole-form save — consent:true plus the shown cap — on 'credits' writes nothing", async () => {
    const r = await patch('team_manual', 'credits', {
      consent: true,
      monthly_cap_usd_cents: 3_000,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ consent: true, monthly_cap_usd_cents: 3_000 });
    expect(r.calls).toEqual([]);
  });

  it('an automatic account re-saving consent:true writes nothing either', async () => {
    const r = await patch('team_manual', null, { consent: true });
    expect(r.calls).toEqual([]);
    expect(r.audits).toEqual([]);
  });

  it('an own-key account re-saving consent:false writes nothing', async () => {
    const r = await patch('team_manual', 'own_key', { consent: false });
    expect(r.body.consent).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.audits).toEqual([]);
  });

  it('CRITICAL an actual change — own_key → consent:true — writes automatic AND an account.ai_source_changed row', async () => {
    const r = await patch('team_manual', 'own_key', { consent: true });
    expect(r.calls).toEqual([{ aiSource: null, setBy: 'customer' }]);
    expect(r.audits).toContainEqual({
      action: 'account.ai_source_changed',
      payload: { from: 'own_key', to: null },
    });
    expect(r.audits.filter((a) => a.action === 'account.bundled_llm_consent_changed')).toHaveLength(
      1,
    );
  });

  it("CRITICAL an actual change — 'credits' → consent:false on Team — writes own_key AND an account.ai_source_changed row", async () => {
    const r = await patch('team_manual', 'credits', { consent: false });
    expect(r.calls).toEqual([{ aiSource: 'own_key', setBy: 'customer' }]);
    expect(r.audits).toContainEqual({
      action: 'account.ai_source_changed',
      payload: { from: 'credits', to: 'own_key' },
    });
  });

  it('Personal consent:false is still accepted and changes nothing — no write, no audit', async () => {
    const r = await patch('solo_manual', 'credits', { consent: false });
    expect(r.status).toBe(200);
    expect(r.body.consent).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.audits).toEqual([]);
  });
});
