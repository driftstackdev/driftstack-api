// S13 — the old bundled-llm-settings/-status routes, on a MOVED account
// (`billing_mode = 'credits'`, §8.6). Same fixture shape as S12's
// turn-funding route tests: a fake `AiCreditsRuntime` scripts the six
// statements a turn can reach, and here — the account read, the one write
// (`setAiSource`), and the three no-lock numeric reads these three routes
// need. The arithmetic those reads feed is proved without a database in
// moved-account-bundled-llm-numbers-are-computed-not-stored.test.ts; the real
// SQL behind each read is proved against Postgres in
// a-moved-accounts-old-status-numbers-are-read-correctly-from-real-tables.test.ts.
// This file is the ROUTE: which account counts as "moved", what each PATCH
// shape does, and what the customer reads back.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AiCreditsAccounts,
  AiCreditsRuntime,
  AiCreditsWindows,
  CreditAccountRecord,
  CurrentCreditWindow,
} from '../../src/services/ai-credits-runtime.js';
import type { AiSource, AiSourceSetBy } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const MICRO = 1_000_000;

interface SetAiSourceCall {
  readonly accountId: string;
  readonly aiSource: AiSource | null;
  readonly setBy: AiSourceSetBy;
}

interface FakeRuntimeConfig {
  readonly mode: 'shadow' | 'enforce';
  readonly billingMode: 'legacy' | 'credits';
  readonly aiSource: AiSource | null;
  readonly window?: CurrentCreditWindow | null;
  readonly otherLiveGrantedMicro?: number;
  readonly spendableMicro?: number;
  readonly chargedInWindowMicro?: number;
}

interface FakeRuntime {
  readonly runtime: AiCreditsRuntime;
  readonly setAiSourceCalls: SetAiSourceCall[];
  readonly ensureAccountCalls: string[];
}

/**
 * A credits runtime whose `accounts`/`windows` are made of functions, and
 * whose turn-funding surface (reservations/leaseKeeper/report) is never
 * reachable — nothing in this file sends a turn. `setAiSource` actually
 * mutates its own state, so a GET after a PATCH reads what the PATCH wrote,
 * the same round trip the real repository gives S13's route.
 */
function fakeMovedRuntime(config: FakeRuntimeConfig): FakeRuntime {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('this file never sends an AI turn'));
  const setAiSourceCalls: SetAiSourceCall[] = [];
  const ensureAccountCalls: string[] = [];
  let record: Omit<CreditAccountRecord, 'accountId'> = {
    billingMode: config.billingMode,
    aiSource: config.aiSource,
    aiSourceSetBy: null,
    aiSourceSetAt: null,
    debtMicro: 0,
    autoTopUpEnabled: false,
  };
  const window = config.window ?? null;
  const accounts: AiCreditsAccounts = {
    ensureAccount: (accountId: string) => {
      ensureAccountCalls.push(accountId);
      return Promise.resolve({ ...record, accountId });
    },
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
    otherLiveGrantedMicro: () => Promise.resolve(config.otherLiveGrantedMicro ?? 0),
    chargedInWindowMicro: () => Promise.resolve(config.chargedInWindowMicro ?? 0),
  };
  const windows: AiCreditsWindows = {
    currentWindow: () => Promise.resolve(window),
  };
  const runtime: AiCreditsRuntime = {
    mode: config.mode,
    bootId: 'boot-bundled-llm-route-test',
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
  };
  return { runtime, setAiSourceCalls, ensureAccountCalls };
}

const TEAM_WINDOW: CurrentCreditWindow = {
  id: 'window-team-1',
  windowStart: '2026-06-01T00:00:00.000000Z',
  windowEnd: '2026-07-01T00:00:00.000000Z',
  levelMicro: 3_000 * MICRO,
};

interface StatusBody {
  consent: boolean;
  cap_cents: number;
  used_this_month_cents: number;
  remaining_cents: number;
  refused_count_this_month: number;
  month_started_at: string;
}

interface SettingsBody {
  consent: boolean;
  monthly_cap_usd_cents: number;
}

describe('the old bundled-llm routes keep a defined meaning for a moved account (§8.6)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it("CRITICAL the old 'Enable AI' button (consent:true) makes a moved account automatic", async () => {
    const { runtime, setAiSourceCalls } = fakeMovedRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'own_key',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().consent).toBe(true);
    expect(setAiSourceCalls).toEqual([
      { accountId: fx.accountId, aiSource: null, setBy: 'customer' },
    ]);
  });

  it('CRITICAL consent:false chooses own key where the plan allows it (Team)', async () => {
    const { runtime, setAiSourceCalls } = fakeMovedRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: null,
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().consent).toBe(false);
    expect(setAiSourceCalls).toEqual([
      { accountId: fx.accountId, aiSource: 'own_key', setBy: 'customer' },
    ]);
  });

  it('CRITICAL consent:false on Personal is ACCEPTED and changes NOTHING — 200, and the response tells the truth: consent stays true', async () => {
    const { runtime, setAiSourceCalls } = fakeMovedRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: null,
    });
    fx = await buildTestApp({ tier: 'solo_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsBody>().consent).toBe(true);
    // NEGATIVE CONTROL — no write was even attempted. A Personal account can
    // never end up with ai_source='own_key' this way.
    expect(setAiSourceCalls).toEqual([]);
  });

  it('CRITICAL consent:true on a plan with no AI at all (Free) is refused ai_not_on_plan, and nothing is written', async () => {
    const { runtime, setAiSourceCalls } = fakeMovedRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: null,
    });
    // Free-tier ordinary keys are refused by the customer-API boundary before
    // any route runs; `cli_device` provenance is the one credential Free can
    // reach this route with (the same posture free-tier tests elsewhere use).
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ ai_not_on_plan?: boolean }>().ai_not_on_plan).toBe(true);
    expect(setAiSourceCalls).toEqual([]);
  });

  describe("the old status reports credits in its old shape and passes the dashboard's own save check", () => {
    it('CRITICAL GET status returns the 6-field legacy shape, with the computed numbers', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: 'own_key',
        window: TEAM_WINDOW,
        spendableMicro: 1_200 * MICRO,
        chargedInWindowMicro: 500 * MICRO,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me/bundled-llm-status',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<StatusBody>();
      expect(Object.keys(body).sort()).toEqual(
        [
          'cap_cents',
          'consent',
          'month_started_at',
          'refused_count_this_month',
          'remaining_cents',
          'used_this_month_cents',
        ].sort(),
      );
      expect(body.consent).toBe(false); // ai_source='own_key'
      expect(body.cap_cents).toBe(3_000);
      expect(body.used_this_month_cents).toBe(500);
      expect(body.remaining_cents).toBe(1_200);
      expect(body.refused_count_this_month).toBe(0);
      expect(body.month_started_at).toBe('2026-06-01T00:00:00.000Z');
    });

    it("CRITICAL replicates settings.astro's post-save comparison for a Team account flipping consent on and re-sending the shown cap: live.consent === desired.consent && live.cap_cents === desired.monthly_cap_usd_cents", async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: 'own_key',
        window: TEAM_WINDOW,
        spendableMicro: 1_200 * MICRO,
        chargedInWindowMicro: 500 * MICRO,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const before = (
        await fx.app.inject({
          method: 'GET',
          url: '/v1/account/me/bundled-llm-status',
          headers: { authorization: `Bearer ${fx.plaintext}` },
        })
      ).json<StatusBody>();
      expect(before.consent).toBe(false);

      const desired = (
        await fx.app.inject({
          method: 'PATCH',
          url: '/v1/account/me/bundled-llm-settings',
          headers: { authorization: `Bearer ${fx.plaintext}` },
          payload: { consent: true, monthly_cap_usd_cents: before.cap_cents },
        })
      ).json<SettingsBody>();

      const live = (
        await fx.app.inject({
          method: 'GET',
          url: '/v1/account/me/bundled-llm-status',
          headers: { authorization: `Bearer ${fx.plaintext}` },
        })
      ).json<StatusBody>();

      // The dashboard's own check (settings.astro:1388-1404), replicated:
      expect(
        live.consent === desired.consent && live.cap_cents === desired.monthly_cap_usd_cents,
      ).toBe(true);
      expect(live.consent).toBe(true);
      expect(live.cap_cents).toBe(3_000);
    });
  });

  describe('the cap can only be re-saved, never changed', () => {
    it('CRITICAL re-saving the exact shown limit is accepted', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: null,
        window: TEAM_WINDOW,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { monthly_cap_usd_cents: 3_000 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<SettingsBody>().monthly_cap_usd_cents).toBe(3_000);
    });

    it("CRITICAL changing it says credits come with the plan — a 400 field error the dashboard's existing refusal path renders", async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: null,
        window: TEAM_WINDOW,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { monthly_cap_usd_cents: 3_001 },
      });
      expect(res.statusCode).toBe(400);
      // ApiError.toProblem() spreads `extensions` at the TOP level of the
      // problem body, not nested under an `extensions` key.
      const body = res.json<{ issues?: { fieldErrors?: Record<string, string[]> } }>();
      expect(body.issues?.fieldErrors?.monthly_cap_usd_cents).toEqual([
        "Monthly AI credits come with your plan and can't be changed here.",
      ]);
    });

    it('a LOWER value is refused too, same as a higher one — there is nothing to lower toward', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: null,
        window: TEAM_WINDOW,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { monthly_cap_usd_cents: 2_999 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('CRITICAL a moved account never reads the old cap: mutating the stored legacy cap for the same account id leaves the status unchanged', async () => {
    const { runtime } = fakeMovedRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: null,
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({
      tier: 'team_manual',
      aiCredits: runtime,
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 999_999 },
    });
    const before = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(before.json<StatusBody>().cap_cents).toBe(3_000);

    // Mutate the LEGACY stored row directly — the old column this account's
    // route must never read.
    fx.bundledLlmRepo.set(fx.accountId, { consent: true, monthlyCapUsdCents: 50 });

    const after = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(after.json<StatusBody>()).toEqual(before.json<StatusBody>());

    const settings = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(settings.json<SettingsBody>().monthly_cap_usd_cents).toBe(3_000);
  });

  it('with no current window (no paid coverage yet), cap/used/remaining read 0 and the month falls back to the calendar month', async () => {
    const { runtime } = fakeMovedRuntime({
      mode: 'enforce',
      billingMode: 'credits',
      aiSource: 'credits',
      window: null,
      otherLiveGrantedMicro: 999 * MICRO,
      spendableMicro: 999 * MICRO,
      chargedInWindowMicro: 999 * MICRO,
    });
    fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<StatusBody>();
    expect(body.cap_cents).toBe(0);
    expect(body.used_this_month_cents).toBe(0);
    expect(body.remaining_cents).toBe(0);
    expect(body.consent).toBe(true);
  });

  describe('the consent audit row', () => {
    it('CRITICAL is written with the ai_source transition when the effective consent flips', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: 'own_key',
        window: TEAM_WINDOW,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { consent: true },
      });
      expect(res.statusCode).toBe(200);
      const rows = fx.accountAuditRepo
        .getAll()
        .filter((r) => r.action === 'account.bundled_llm_consent_changed');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({
        from: false,
        to: true,
        ai_source_from: 'own_key',
        ai_source_to: null,
      });
    });

    it('is NOT written when the request did not actually flip the effective consent (already automatic, consent:true again)', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: null,
        window: TEAM_WINDOW,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { consent: true },
      });
      expect(res.statusCode).toBe(200);
      expect(
        fx.accountAuditRepo
          .getAll()
          .filter((r) => r.action === 'account.bundled_llm_consent_changed'),
      ).toHaveLength(0);
    });

    it('is NOT written for a cap-only PATCH', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'credits',
        aiSource: null,
        window: TEAM_WINDOW,
      });
      fx = await buildTestApp({ tier: 'team_manual', aiCredits: runtime });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { monthly_cap_usd_cents: 3_000 },
      });
      expect(res.statusCode).toBe(200);
      expect(
        fx.accountAuditRepo
          .getAll()
          .filter((r) => r.action === 'account.bundled_llm_consent_changed'),
      ).toHaveLength(0);
    });
  });

  it('CRITICAL shadow mode leaves the routes untouched — a cutover-moved account (billing_mode=credits) under mode=shadow is treated as legacy, and the credits accounts read is never even asked', async () => {
    const { runtime, ensureAccountCalls } = fakeMovedRuntime({
      mode: 'shadow',
      billingMode: 'credits',
      aiSource: 'credits',
      window: TEAM_WINDOW,
    });
    fx = await buildTestApp({
      tier: 'team_manual',
      aiCredits: runtime,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 4_242 },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatusBody>();
    // The LEGACY numbers, not the fake credits runtime's.
    expect(body.consent).toBe(true);
    expect(body.cap_cents).toBe(4_242);
    // NEGATIVE CONTROL — resolveMovedAccount short-circuited on `mode`
    // before it ever asked the credits runtime anything.
    expect(ensureAccountCalls).toEqual([]);
  });

  describe('legacy accounts are unchanged by AI credits', () => {
    it('CRITICAL golden comparison: GET settings/status and a PATCH are byte-identical with aiCredits absent vs present-but-legacy', async () => {
      // api_builder: one of the legacy tiers `requireBundledLlmTier` (S42)
      // actually allows consent:true on, so the PATCH below is a 200, not a
      // 403 — a 403's `instance` field is a fresh UUID per request and would
      // never compare equal between two independent fixtures regardless of
      // whether anything about the CREDITS wiring changed anything.
      const withoutCredits = await buildTestApp({
        tier: 'api_builder',
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
      });
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'legacy',
        aiSource: null,
      });
      // Neither response shape carries an account id, so the two fixtures
      // need not share one — each is its own isolated in-memory app; what
      // this compares is the two RESPONSES, byte for byte.
      const withLegacyCredits = await buildTestApp({
        tier: 'api_builder',
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
        aiCredits: runtime,
      });
      try {
        for (const [method, url] of [
          ['GET', '/v1/account/me/bundled-llm-settings'],
          ['GET', '/v1/account/me/bundled-llm-status'],
        ] as const) {
          const a = await withoutCredits.app.inject({
            method,
            url,
            headers: { authorization: `Bearer ${withoutCredits.plaintext}` },
          });
          const b = await withLegacyCredits.app.inject({
            method,
            url,
            headers: { authorization: `Bearer ${withLegacyCredits.plaintext}` },
          });
          expect(b.statusCode).toBe(a.statusCode);
          expect(b.json()).toEqual(a.json());
        }
        const patchA = await withoutCredits.app.inject({
          method: 'PATCH',
          url: '/v1/account/me/bundled-llm-settings',
          headers: { authorization: `Bearer ${withoutCredits.plaintext}` },
          payload: { consent: true },
        });
        const patchB = await withLegacyCredits.app.inject({
          method: 'PATCH',
          url: '/v1/account/me/bundled-llm-settings',
          headers: { authorization: `Bearer ${withLegacyCredits.plaintext}` },
          payload: { consent: true },
        });
        expect(patchB.statusCode).toBe(patchA.statusCode);
        expect(patchB.json()).toEqual(patchA.json());
      } finally {
        await withoutCredits.cleanup();
        await withLegacyCredits.cleanup();
      }
    });

    it('the $100 new-write bound still refuses a legacy account, aiCredits present or not', async () => {
      const { runtime } = fakeMovedRuntime({
        mode: 'enforce',
        billingMode: 'legacy',
        aiSource: null,
      });
      fx = await buildTestApp({
        tier: 'team_manual',
        aiCredits: runtime,
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
      });
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { monthly_cap_usd_cents: 15_000 },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
