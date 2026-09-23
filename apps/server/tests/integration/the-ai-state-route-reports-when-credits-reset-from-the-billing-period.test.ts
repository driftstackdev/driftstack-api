// S14 — GET /v1/account/me/ai and PATCH /v1/account/me/ai-settings.
//
// Same fixture shape as S13's
// the-old-bundled-llm-routes-keep-a-defined-meaning-for-a-moved-account.test.ts:
// a fake `AiCreditsRuntime` scripts every statement the route can reach, so
// this file proves the ROUTE — which account counts as moved, what each
// refusal is, what the customer reads back — without a database. The real
// SQL behind the new repo reads is proved separately, against Postgres, in
// the-ai-credits-repo-reads-answer-from-real-tables.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AiCreditsAccounts,
  AiCreditsRuntime,
  AiCreditsStateReads,
  AiCreditsWindows,
  CreditAccountRecord,
  CurrentCreditWindow,
} from '../../src/services/ai-credits-runtime.js';
import type { AiSource, AiSourceSetBy } from '@driftstack/api-types';
import type {
  CreditLedgerPageWithBalance,
  CreditLotRecord,
} from '../../src/db/credit-ledger-repo.js';
import type { CreditRateCardRecord } from '../../src/db/credit-rate-card-repo.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { launchCardRow } from './_helpers/fake-account-ai-runtime.js';

const MICRO = 1_000_000;

interface SetAiSourceCall {
  readonly accountId: string;
  readonly aiSource: AiSource | null;
  readonly setBy: AiSourceSetBy;
}

interface FakeConfig {
  readonly mode: 'shadow' | 'enforce';
  readonly billingMode: 'legacy' | 'credits';
  readonly aiSource?: AiSource | null;
  readonly window?: CurrentCreditWindow | null;
  readonly monthlyLot?: CreditLotRecord | null;
  readonly extraLots?: readonly CreditLotRecord[];
  readonly spendableMicro?: number;
  readonly heldMicro?: number;
  readonly pendingClaimsMicro?: number;
  readonly debtMicro?: number;
  readonly debtReason?: 'payment_reversed' | 'plan_change' | null;
  readonly tasksInFlight?: number;
  readonly cardInForce?: CreditRateCardRecord | null;
  readonly nextCard?: CreditRateCardRecord | null;
}

const CARD_V1: CreditRateCardRecord = {
  version: 1,
  markupBp: 20_000,
  announcedAt: new Date('2025-12-01T00:00:00Z'),
  effectiveAt: new Date('2026-01-01T00:00:00Z'),
  withdrawnAt: null,
  createdByKeyId: null,
  note: 'v1',
};

function fakeRuntime(config: FakeConfig): {
  runtime: AiCreditsRuntime;
  setAiSourceCalls: SetAiSourceCall[];
} {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('this file never sends an AI turn'));
  const setAiSourceCalls: SetAiSourceCall[] = [];
  let record: Omit<CreditAccountRecord, 'accountId'> = {
    billingMode: config.billingMode,
    aiSource: config.aiSource ?? null,
    aiSourceSetBy: null,
    aiSourceSetAt: null,
    debtMicro: config.debtMicro ?? 0,
    autoTopUpEnabled: false,
    legacyConsentAtMove: null,
    legacyCapCentsAtMove: null,
    hadStoredKeyAtMove: null,
    movedToCreditsAt: null,
    movedBackAt: null,
  };
  const accounts: AiCreditsAccounts = {
    ensureAccount: (accountId: string) => Promise.resolve({ ...record, accountId }),
    setAiSource: (accountId: string, args: { aiSource: AiSource | null; setBy: AiSourceSetBy }) => {
      record = {
        ...record,
        aiSource: args.aiSource,
        aiSourceSetBy: args.setBy,
        aiSourceSetAt: new Date(),
      };
      setAiSourceCalls.push({ accountId, ...args });
      return Promise.resolve({ ...record, accountId });
    },
    spendableMicro: () => Promise.resolve(config.spendableMicro ?? 0),
    otherLiveGrantedMicro: unreachable,
    chargedInWindowMicro: unreachable,
  };
  const windows: AiCreditsWindows = { currentWindow: () => Promise.resolve(config.window ?? null) };
  const stateReads: AiCreditsStateReads = {
    heldMicro: () => Promise.resolve(config.heldMicro ?? 0),
    latestDebtReason: () => Promise.resolve(config.debtReason ?? null),
    monthlyLotForWindow: () => Promise.resolve(config.monthlyLot ?? null),
    liveExtraLots: () => Promise.resolve([...(config.extraLots ?? [])]),
    ledgerPageWithBalance: (): Promise<CreditLedgerPageWithBalance> =>
      Promise.resolve({ entries: [], nextCursor: null }),
    pendingClaimTotalMicro: () => Promise.resolve(config.pendingClaimsMicro ?? 0),
    openEnforceCountNoLock: () => Promise.resolve(config.tasksInFlight ?? 0),
    cardInForce: () =>
      Promise.resolve(config.cardInForce === undefined ? CARD_V1 : config.cardInForce),
    nextAnnouncedCard: () => Promise.resolve(config.nextCard ?? null),
    // The GET reads the cheapest runnable model's minimum to start (S14
    // audit #4); a card with no model rows would block every credits task.
    modelRow: (_version: number, model: string) => Promise.resolve(launchCardRow(model)),
    chargedForSessionMicro: unreachable,
    planOverride: () => Promise.resolve(null),
    refreshCredits: () =>
      Promise.resolve({
        expired: [],
        window: { outcome: 'none' },
        level: null,
        repaid: [],
        currentWindowEnd: null,
      }),
  };
  const runtime: AiCreditsRuntime = {
    mode: config.mode,
    bootId: 'boot-account-ai-route-test',
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
    accounts,
    windows,
    stateReads,
  };
  return { runtime, setAiSourceCalls };
}

const TEAM_WINDOW: CurrentCreditWindow = {
  id: 'window-team-1',
  windowStart: '2026-06-01T00:00:00.000000Z',
  windowEnd: '2026-07-01T00:00:00.000000Z',
  levelMicro: 3_000 * MICRO,
};

const TEAM_MONTHLY_LOT: CreditLotRecord = {
  id: 'lot-monthly-1',
  accountId: 'acct',
  kind: 'monthly',
  spendRank: 0,
  windowId: 'window-team-1',
  grantKey: 'grant-1',
  grantedMicro: 3_000 * MICRO,
  remainingMicro: 2_500 * MICRO,
  heldMicro: 0,
  startsAt: new Date('2026-06-01T00:00:00Z'),
  expiresAt: new Date('2026-07-01T00:00:00Z'),
  revokedAt: null,
  createdAt: new Date('2026-06-01T00:00:00Z'),
};

interface AiStateBody {
  billing: 'legacy' | 'credits';
  plan: { tier: string; ai_included: boolean; monthly_included_credits: number | null };
  ai_source: string | null;
  effective_source: string | null;
  balance: {
    available_credits: number;
    monthly: { granted_credits: number; remaining_credits: number; resets_at: string } | null;
    tasks_in_flight: number;
  };
  blocked_reason: string | null;
  debt_reason: string | null;
  rate_card: { version: number };
}

describe('GET /v1/account/me/ai', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL a moved account under enforce says when its monthly credits reset, from the billing period', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
      monthlyLot: TEAM_MONTHLY_LOT,
      spendableMicro: 2_500 * MICRO,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AiStateBody>();
    expect(body.billing).toBe('credits');
    expect(body.balance.monthly).toEqual({
      granted_credits: 3000,
      remaining_credits: 2500,
      period_start: '2026-06-01T00:00:00.000000Z',
      resets_at: '2026-07-01T00:00:00.000000Z',
    });
    expect(body.balance.available_credits).toBe(2500);
    expect(body.ai_source).toBe('credits');
    expect(body.effective_source).toBe('credits');
    expect(body.blocked_reason).toBeNull();
  });

  it('CRITICAL a LEGACY account (billing_mode legacy) gets blocked_reason: null and balance.monthly: null — the credits vocabulary does not apply to it (S14 brief item 1)', async () => {
    const { runtime } = fakeRuntime({ mode: 'enforce', billingMode: 'legacy' });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AiStateBody>();
    expect(body.billing).toBe('legacy');
    expect(body.balance.monthly).toBeNull();
    expect(body.blocked_reason).toBeNull();
    expect(body.ai_source).toBeNull();
    expect(body.effective_source).toBeNull();
  });

  it('CRITICAL a moved account under SHADOW mode reads as legacy (§4.1s table): shadow never cuts a customer over', async () => {
    const { runtime } = fakeRuntime({
      mode: 'shadow',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AiStateBody>().billing).toBe('legacy');
  });

  it('debt blocks a credits-sourced account and carries its reason', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
      debtMicro: 5 * MICRO,
      debtReason: 'payment_reversed',
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<AiStateBody>();
    expect(body.blocked_reason).toBe('debt');
    expect(body.debt_reason).toBe('payment_reversed');
  });

  it('CRITICAL honours X-Driftstack-Account act-as, the way GET /v1/billing does: a team member acting as the owner reads the OWNER’s plan, not their own', async () => {
    const TEAM_OWNER_ID = '00000000-0000-4000-8000-0000000000e1';
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    // The caller's own tier is Personal (no own-key allowed); the owner's is
    // Team (own-key allowed). Reading `plan.own_key_allowed` back tells the
    // two apart — proof this answered from the OWNER's tier, not the caller's.
    fx = await buildTestApp({ tier: 'solo_manual', aiCredits: runtime });
    fx.authRepo.upsertAccount({
      id: TEAM_OWNER_ID,
      email: 'owner@driftstack.local',
      name: 'Owner',
      tier: 'team_manual',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: 'membership-e1', ownerAccountId: TEAM_OWNER_ID, role: 'member' },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AiStateBody & { plan: { own_key_allowed: boolean; tier: string } }>();
    expect(body.plan.tier).toBe('team_manual');
    expect(body.plan.own_key_allowed).toBe(true);
  });

  it('fails closed (4xx) when acting as an account the caller is not a member of', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-0000000000e2',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('CRITICAL with the runtime present, a [write]-only key is refused read scope on every GET — the coverage customer-scope-refusal-coverage.test.ts cannot exercise itself, because its fixture never wires aiCredits (see that file’s NOT_ACTIVATABLE entries for these four routes)', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime, scopes: ['write'] });
    for (const url of ['/v1/account/me/ai', '/v1/account/me/ai/ledger']) {
      const res = await fx.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode, `GET ${url} with a [write]-only key`).toBe(403);
    }
  });

  it('CRITICAL with the runtime present, a [read]-only key is refused account_owner scope on the PATCH', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime, scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'credits' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('extras[] lists a live non-monthly lot beside the monthly one', async () => {
    const goodwill: CreditLotRecord = {
      ...TEAM_MONTHLY_LOT,
      id: 'lot-goodwill-1',
      kind: 'adjustment',
      windowId: null,
      remainingMicro: 200 * MICRO,
      expiresAt: new Date('2026-08-01T00:00:00Z'),
    };
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
      monthlyLot: TEAM_MONTHLY_LOT,
      extraLots: [goodwill],
      spendableMicro: 2_700 * MICRO,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ balance: { extras: { kind: string; remaining_credits: number }[] } }>();
    expect(body.balance.extras).toEqual([
      { kind: 'goodwill', remaining_credits: 200, expires_at: '2026-08-01T00:00:00.000Z' },
    ]);
  });

  it('the routes do not exist while credits are off — 404, not 200 with a different shape', async () => {
    fx = await buildTestApp({ tier: 'team_manual' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('the ledger and models routes are ALSO absent while credits are off', async () => {
    fx = await buildTestApp({ tier: 'team_manual' });
    const ledger = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai/ledger',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const models = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const settings = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'credits' },
    });
    expect(ledger.statusCode).toBe(404);
    expect(models.statusCode).toBe(404);
    expect(settings.statusCode).toBe(404);
  });
});

interface SettingsBody {
  ai_source: string | null;
}

describe('PATCH /v1/account/me/ai-settings', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL account-owner scope is required — write scope alone is refused', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
    });
    fx = await buildTestApp({
      tier: 'team_manual',
      aiCredits: runtime,
      scopes: ['read', 'write'],
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'own_key' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CRITICAL plan-gated: Personal choosing own_key is refused 403 {own_key_not_on_plan}, and nothing is written', async () => {
    const { runtime, setAiSourceCalls } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
    });
    fx = await buildTestApp({ tier: 'solo_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'own_key' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ own_key_not_on_plan?: boolean }>().own_key_not_on_plan).toBe(true);
    expect(setAiSourceCalls).toEqual([]);
  });

  it('CRITICAL a legacy account is refused 409 {credits_not_active} with the exact plan sentence', async () => {
    const { runtime, setAiSourceCalls } = fakeRuntime({ mode: 'enforce', billingMode: 'legacy' });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'credits' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ detail?: string; credits_not_active?: boolean }>();
    expect(body.credits_not_active).toBe(true);
    expect(body.detail).toBe("AI credits aren't active on this account yet.");
    expect(setAiSourceCalls).toEqual([]);
  });

  it('CRITICAL audited as account.ai_source_changed when the value actually changes', async () => {
    const { runtime } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'own_key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().ai_source).toBe('own_key');
    const audited = fx.accountAuditRepo
      .getAll()
      .some((r) => r.action === 'account.ai_source_changed' && r.accountId === fx.accountId);
    expect(audited).toBe(true);
  });

  it('CRITICAL idempotent: re-sending the value already on file is 200 and writes no audit row', async () => {
    const { runtime, setAiSourceCalls } = fakeRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const before = fx.accountAuditRepo.getAll().length;
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/ai-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ai_source: 'credits' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().ai_source).toBe('credits');
    expect(setAiSourceCalls, 'no setAiSource call on a resend of the same value').toEqual([]);
    expect(fx.accountAuditRepo.getAll().length).toBe(before);
  });
});
