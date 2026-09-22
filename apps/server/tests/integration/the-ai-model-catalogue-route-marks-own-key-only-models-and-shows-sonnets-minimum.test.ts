// S14 — GET /v1/ai/models. Fake AiCreditsRuntime, same shape as the sibling
// account-ai.ts route tests; the per-model derivation itself is proved
// without a database in
// the-model-catalogue-marks-own-key-only-models-and-shows-sonnets-minimum.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1 } from '@driftstack/api-types';
import type {
  AiCreditsRuntime,
  AiCreditsStateReads,
} from '../../src/services/ai-credits-runtime.js';
import type {
  CreditRateCardModelRecord,
  CreditRateCardRecord,
} from '../../src/db/credit-rate-card-repo.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const CARD_V1: CreditRateCardRecord = {
  version: 1,
  markupBp: 20_000,
  announcedAt: new Date('2025-12-01T00:00:00Z'),
  effectiveAt: new Date('2026-01-01T00:00:00Z'),
  withdrawnAt: null,
  createdByKeyId: null,
  note: 'v1',
};

function modelRowFor(model: string): CreditRateCardModelRecord | null {
  const row = (
    CREDIT_RATE_CARD_V1.models as Record<
      string,
      (typeof CREDIT_RATE_CARD_V1.models)['claude-sonnet-5']
    >
  )[model];
  return row === undefined ? null : { ...row, version: 1, model };
}

function fakeRuntime(): AiCreditsRuntime {
  const unreachable = (): Promise<never> => Promise.reject(new Error('not used by this route'));
  const stateReads: AiCreditsStateReads = {
    heldMicro: unreachable,
    latestDebtReason: unreachable,
    monthlyLotForWindow: unreachable,
    liveExtraLots: unreachable,
    ledgerPageWithBalance: unreachable,
    pendingClaimTotalMicro: unreachable,
    openEnforceCountNoLock: unreachable,
    cardInForce: () => Promise.resolve(CARD_V1),
    nextAnnouncedCard: () => Promise.resolve(null),
    modelRow: (_version: number, model: string) => Promise.resolve(modelRowFor(model)),
    chargedForSessionMicro: unreachable,
  };
  return {
    mode: 'enforce',
    bootId: 'boot-ai-models-route-test',
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
      ensureAccount: unreachable,
      setAiSource: unreachable,
      spendableMicro: unreachable,
      otherLiveGrantedMicro: unreachable,
      chargedInWindowMicro: unreachable,
    },
    windows: { currentWindow: unreachable },
    stateReads,
  };
}

interface CatalogueEntry {
  id: string;
  on_credits_reason: string | null;
  available_on_your_plan: boolean;
  min_credits_to_start: number | null;
}

describe('GET /v1/ai/models', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL marks Opus 5 own_key_only and Sonnet 5 on_credits with its minimum, read scope', async () => {
    fx = await buildTestApp({ tier: 'solo_manual', aiCredits: fakeRuntime() });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: CatalogueEntry[] }>();
    const opus5 = body.data.find((m) => m.id === 'claude-opus-5');
    const sonnet5 = body.data.find((m) => m.id === 'claude-sonnet-5');
    expect(opus5?.on_credits_reason).toBe('own_key_only');
    // Personal (solo_manual) forbids an own key, so Opus 5 is unavailable here.
    expect(opus5?.available_on_your_plan).toBe(false);
    expect(sonnet5?.on_credits_reason).toBeNull();
    expect(sonnet5?.min_credits_to_start).toBe(6);
    expect(sonnet5?.available_on_your_plan).toBe(true);
  });

  it('lists every AgentModel id exactly once', async () => {
    fx = await buildTestApp({ tier: 'api_scale', aiCredits: fakeRuntime() });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ data: CatalogueEntry[] }>();
    const ids = body.data.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-5');
  });

  it('write-only scope is refused (requires read)', async () => {
    fx = await buildTestApp({ tier: 'api_scale', aiCredits: fakeRuntime(), scopes: ['write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/ai/models',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
