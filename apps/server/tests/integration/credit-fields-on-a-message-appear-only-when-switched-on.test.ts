// S14 — the message response's `credits` field and the session's
// `credits_spent`, both behind `DRIFTSTACK_AI_CREDITS_RESPONSE_FIELDS`
// (`config.aiCreditsResponseFields`, default off).
//
// Same fake-runtime idiom as
// a-moved-accounts-turn-is-funded-from-its-chosen-ai-source.test.ts (S12):
// `reserve()`/`settle()` are scripted, so the route's own use of what they
// answer is what this file proves, not the admission ladder underneath them
// (covered elsewhere).

import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type {
  AiCreditsRuntime,
  AiCreditsStateReads,
  CreditAccountRecord,
} from '../../src/services/ai-credits-runtime.js';
import type {
  CreditReserveInput,
  CreditReserveResult,
  CreditSettleResult,
} from '../../src/services/credit-reservations.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const SONNET = 'claude-sonnet-5';
const TASK = 'Open https://portal.example.test/invoices and take a screenshot.';

type MovedAccountState = Pick<CreditAccountRecord, 'billingMode' | 'aiSource'>;

function enforceRuntime(
  accountState: MovedAccountState,
  chargedForSessionMicro: number,
): AiCreditsRuntime {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const RESERVED = (input: CreditReserveInput): CreditReserveResult => ({
    outcome: 'reserved',
    reservationId: input.reservationId,
    slot: 1,
    reservedMicro: 60_000_000,
    rateCardVersion: 7,
    holds: [],
  });
  const settled: CreditSettleResult = {
    outcome: 'settled',
    chargedMicro: 4_500_000,
    charges: [],
    claimsPaidMicro: 0,
    claimsToDebtMicro: 0,
  };
  const unreachable = (): Promise<never> => Promise.reject(new Error('not used by this test'));
  const stateReads: AiCreditsStateReads = {
    heldMicro: unreachable,
    latestDebtReason: unreachable,
    monthlyLotForWindow: unreachable,
    liveExtraLots: unreachable,
    ledgerPageWithBalance: unreachable,
    pendingClaimTotalMicro: unreachable,
    openEnforceCountNoLock: unreachable,
    cardInForce: unreachable,
    nextAnnouncedCard: unreachable,
    modelRow: unreachable,
    chargedForSessionMicro: () => Promise.resolve(chargedForSessionMicro),
  };
  return {
    mode: 'enforce',
    bootId: 'boot-response-fields-test',
    reservations: {
      reserve: (input: CreditReserveInput) => Promise.resolve(RESERVED(input)),
      settle: () => Promise.resolve(settled),
      planCall: () => Promise.resolve({ outcome: 'unavailable', reason: 'model' }),
      admitCall: () => never(),
      markSent: () => never(),
      settleCall: () => never(),
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
          ...accountState,
        }),
      setAiSource: unreachable,
      spendableMicro: unreachable,
      otherLiveGrantedMicro: unreachable,
      chargedInWindowMicro: unreachable,
    },
    windows: { currentWindow: unreachable },
    stateReads,
  };
}

class PlannerThatRecordsItsMeter implements AgentDecomposer {
  decompose(_args: DecomposeArgs): Promise<DecomposeResult> {
    return Promise.resolve({
      kind: 'plan',
      intents: [{ kind: 'navigate', url: 'https://portal.example.test/invoices' }],
      tokensConsumed: 80,
      usage: {
        decomposerKind: 'claude',
        model: SONNET,
        anthropicInputTokens: 500,
        anthropicOutputTokens: 60,
        costUsdCents: 1,
      },
    });
  }
}

interface MessageResponse {
  session: { credits_spent?: number };
  credits?: { source: string; reserved: number; charged: number; rate_card_version: number | null };
}

describe('credit fields on a message appear only when switched on', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function app(over: {
    credits: AiCreditsRuntime;
    tier?: AccountTier;
    aiCreditsResponseFields?: boolean;
  }): Promise<TestAppFixture> {
    return buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: new PlannerThatRecordsItsMeter(),
      agentDecomposerKind: 'claude',
      tier: over.tier ?? 'team_manual',
      aiCredits: over.credits,
      allowDeploymentKeyFallback: true,
      ...(over.aiCreditsResponseFields !== undefined
        ? { aiCreditsResponseFields: over.aiCreditsResponseFields }
        : {}),
    });
  }

  async function createSession(): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode, 'test setup: session create must succeed').toBe(201);
    return res.json<{ id: string }>().id;
  }

  function send(id: string) {
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: TASK },
    });
  }

  it('CRITICAL the flag ON: a credits-funded message carries credits {source, reserved, charged, rate_card_version} and the session carries credits_spent', async () => {
    fx = await app({
      credits: enforceRuntime({ billingMode: 'credits', aiSource: 'credits' }, 9_000_000),
      aiCreditsResponseFields: true,
    });
    const id = await createSession();
    const res = await send(id);
    expect(res.statusCode).toBe(200);
    const body = res.json<MessageResponse>();
    expect(body.credits).toEqual({
      source: 'credits',
      reserved: 60,
      charged: 4.5,
      rate_card_version: 7,
    });
    expect(body.session.credits_spent).toBe(9);
  });

  it('CRITICAL the flag OFF (default): the same turn carries neither field at all — not null, ABSENT', async () => {
    fx = await app({
      credits: enforceRuntime({ billingMode: 'credits', aiSource: 'credits' }, 9_000_000),
      // aiCreditsResponseFields omitted — default false.
    });
    const id = await createSession();
    const res = await send(id);
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect('credits' in body).toBe(false);
    const session = body.session as Record<string, unknown>;
    expect('credits_spent' in session).toBe(false);
  });

  it('a LEGACY account never carries credits, even with the flag on — the vocabulary does not apply to it', async () => {
    fx = await app({
      credits: enforceRuntime({ billingMode: 'legacy', aiSource: null }, 0),
      aiCreditsResponseFields: true,
    });
    const id = await createSession();
    const res = await send(id);
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect('credits' in body).toBe(false);
  });
});
