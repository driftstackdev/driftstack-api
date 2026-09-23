// S14 audit fix #10 — the message response's credits fields, behind
// `DRIFTSTACK_AI_CREDITS_RESPONSE_FIELDS`, never misreport a charge.
//
//   · `session.credits_spent` is a second read (`chargedForSessionMicro`) made
//     AFTER the turn has run and been billed. It had no catch, so a database
//     error there turned a completed, billed turn into a 500. It is now logged
//     and the field OMITTED.
//   · `credits.charged` read `enforceSettleResult?.chargedMicro ?? 0`, so a
//     settle that FAILED (left to the lease keeper, which charges it later)
//     was shown as `charged: 0` — a false "this cost you nothing". The schema
//     has no "pending" form, so the whole `credits` member is OMITTED until
//     the charge is known.
//
// Same scripted-runtime idiom as credit-fields-on-a-message-appear-only-when-switched-on.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type {
  AiCreditsRuntime,
  AiCreditsStateReads,
} from '../../src/services/ai-credits-runtime.js';
import type {
  CreditReserveInput,
  CreditReserveResult,
  CreditSettleResult,
} from '../../src/services/credit-reservations.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const SONNET = 'claude-sonnet-5';
const TASK = 'Open https://portal.example.test/invoices and take a screenshot.';

function enforceRuntime(opts: {
  settle: () => Promise<CreditSettleResult>;
  chargedForSessionMicro: () => Promise<number>;
}): AiCreditsRuntime {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const reserved = (input: CreditReserveInput): CreditReserveResult => ({
    outcome: 'reserved',
    reservationId: input.reservationId,
    slot: 1,
    reservedMicro: 60_000_000,
    rateCardVersion: 7,
    holds: [],
  });
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
    chargedForSessionMicro: opts.chargedForSessionMicro,
  };
  return {
    mode: 'enforce',
    bootId: 'boot-omits-unknown-charge-test',
    reservations: {
      reserve: (input: CreditReserveInput) => Promise.resolve(reserved(input)),
      settle: opts.settle,
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
          billingMode: 'credits',
          aiSource: 'credits',
          aiSourceSetBy: null,
          aiSourceSetAt: null,
          debtMicro: 0,
          autoTopUpEnabled: false,
          legacyConsentAtMove: null,
          legacyCapCentsAtMove: null,
          hadStoredKeyAtMove: null,
          movedToCreditsAt: null,
          movedBackAt: null,
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

const SETTLED: CreditSettleResult = {
  outcome: 'settled',
  chargedMicro: 4_500_000,
  charges: [],
  claimsPaidMicro: 0,
  claimsToDebtMicro: 0,
};

class OnePlan implements AgentDecomposer {
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

describe('a message never reports a credits charge it could not settle or read', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  async function sendOneTurn(credits: AiCreditsRuntime) {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: new OnePlan(),
      agentDecomposerKind: 'claude',
      tier: 'team_manual',
      aiCredits: credits,
      allowDeploymentKeyFallback: true,
      aiCreditsResponseFields: true,
    });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(created.statusCode, 'test setup: session create must succeed').toBe(201);
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.json<{ id: string }>().id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: TASK },
    });
  }

  it('CRITICAL a failing credits_spent read after a billed turn is a 200 with the field omitted, not a 500', async () => {
    const res = await sendOneTurn(
      enforceRuntime({
        settle: () => Promise.resolve(SETTLED),
        chargedForSessionMicro: () => Promise.reject(new Error('the database blinked')),
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ session: Record<string, unknown>; credits?: { charged: number } }>();
    expect('credits_spent' in body.session).toBe(false);
    // The turn's own charge is known and still reported.
    expect(body.credits?.charged).toBe(4.5);
  });

  it('CRITICAL a settle that failed does not read as charged: 0 — the credits member is omitted until the charge is known', async () => {
    const res = await sendOneTurn(
      enforceRuntime({
        settle: () => Promise.reject(new Error('settle lost its connection')),
        chargedForSessionMicro: () => Promise.resolve(0),
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ credits?: unknown; usage?: Record<string, unknown> }>();
    expect(body.credits, 'no credits member while the charge is unknown').toBeUndefined();
    // The usage block's cost is priced from the same settle, so it is left out
    // for the same reason — not reported as a free turn.
    expect(body.usage, 'the turn still reports its usage').toBeDefined();
    expect(body.usage?.cost_usd_cents, 'no cost while the charge is unknown').toBeUndefined();
  });

  it('with settle and the read both healthy, both fields are present (positive control)', async () => {
    const res = await sendOneTurn(
      enforceRuntime({
        settle: () => Promise.resolve(SETTLED),
        chargedForSessionMicro: () => Promise.resolve(9_000_000),
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      session: { credits_spent?: number };
      credits?: { charged: number };
      usage?: { cost_usd_cents?: number };
    }>();
    expect(body.credits?.charged).toBe(4.5);
    expect(body.session.credits_spent).toBe(9);
    // 4.5 credits charged → 5 cents, rounded up (1 credit = 1 cent).
    expect(body.usage?.cost_usd_cents).toBe(5);
  });
});
