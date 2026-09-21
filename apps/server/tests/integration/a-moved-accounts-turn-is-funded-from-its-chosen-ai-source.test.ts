// S12 — a MOVED account (`billing_mode='credits'`) funds its turn from the
// source §4.3's six rules pick, under `DRIFTSTACK_AI_CREDITS_MODE=enforce`.
//
// The fake `AiCreditsRuntime` here plays the same role the S11 shadow test's
// does (see a-bundled-turn-is-measured-beside-itself-and-never-changed.test.ts):
// the six statements a turn can reach are the whole surface a route touches,
// so a fault or a fixed answer is trivial to script here and awkward to
// provoke out of a real database. What the ADMISSION ladder itself does with
// a reservation (§4.5's fit ladder, the per-call bound) is proved elsewhere
// (S7-S9's DB-integration suite); this file is about the ROUTE's use of
// `reserve()`/`settle()` — which source it asks for, what it does with a
// refusal, and what it reports back.

import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type { AgentCreditMeter } from '../../src/services/agent-credit-meter.js';
import type {
  AiCreditsRuntime,
  CreditAccountRecord,
} from '../../src/services/ai-credits-runtime.js';
import type {
  CreditReserveInput,
  CreditReserveResult,
  CreditSettleResult,
} from '../../src/services/credit-reservations.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';
const TASK = 'Open https://portal.example.test/invoices and take a screenshot.';
const STORED_KEY = 'sk-ant-api03-stored-own-key-aaaaaaaaaaaaaaaaaaaaaaaa';
const HEADER_KEY = 'sk-ant-api03-header-own-key-aaaaaaaaaaaaaaaaaaaaaaaa';

/** What the credits leg was asked to do. */
interface Seen {
  reserved: CreditReserveInput[];
  settled: Array<{ reservationId: string; reason: string }>;
  live: Set<string>;
  meters: string[];
}

function newSeen(): Seen {
  return { reserved: [], settled: [], live: new Set(), meters: [] };
}

/** A moved account's `credit_accounts` row, as `ensureAccount` answers it. */
type MovedAccountState = Pick<CreditAccountRecord, 'billingMode' | 'aiSource'>;

const LEGACY: MovedAccountState = { billingMode: 'legacy', aiSource: null };

/**
 * A real-shaped fake: `reserve()` answers RESERVED unless told otherwise,
 * `settle()` answers a fixed charge unless told otherwise. Same idiom as the
 * S11 shadow fixture, tuned for `mode:'enforce'` and a movable account state.
 * `accountState` may be a function so a test can change its answer between
 * one call and the next (simulating a cutover that happens mid-test).
 */
function enforceRuntime(
  seen: Seen,
  accountState: MovedAccountState | (() => MovedAccountState),
  faults: {
    reserve?: (input: CreditReserveInput) => Promise<CreditReserveResult>;
    settle?: () => Promise<CreditSettleResult>;
    chargedMicro?: number;
  } = {},
): AiCreditsRuntime {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const RESERVED = (input: CreditReserveInput): CreditReserveResult => ({
    outcome: 'reserved',
    reservationId: input.reservationId,
    slot: 1,
    reservedMicro: 60_000_000,
    rateCardVersion: 1,
    holds: [],
  });
  const settled: CreditSettleResult = {
    outcome: 'settled',
    chargedMicro: faults.chargedMicro ?? 4_500_000,
    charges: [],
    claimsPaidMicro: 0,
    claimsToDebtMicro: 0,
  };
  return {
    mode: 'enforce',
    bootId: 'boot-enforce-test',
    reservations: {
      reserve: (input: CreditReserveInput): Promise<CreditReserveResult> => {
        seen.reserved.push(input);
        return faults.reserve?.(input) ?? Promise.resolve(RESERVED(input));
      },
      settle: (reservationId: string, reason: string): Promise<CreditSettleResult> => {
        seen.settled.push({ reservationId, reason });
        return faults.settle?.() ?? Promise.resolve(settled);
      },
      // Nothing in these fixtures reaches per-attempt admission: the fake
      // planner below never calls creditMeter.admit(). See the module header.
      planCall: () => Promise.resolve({ outcome: 'unavailable', reason: 'model' }),
      admitCall: () => never(),
      markSent: () => never(),
      settleCall: () => never(),
    },
    leaseKeeper: {
      add: (id: string) => seen.live.add(id),
      remove: (id: string) => seen.live.delete(id),
      liveCount: () => seen.live.size,
    },
    report: {
      shadowReport: () => Promise.reject(new Error('not used by this test')),
      census: () => Promise.reject(new Error('not used by this test')),
    },
    accounts: {
      ensureAccount: (accountId: string) => {
        const state = typeof accountState === 'function' ? accountState() : accountState;
        return Promise.resolve({
          accountId,
          aiSourceSetBy: null,
          aiSourceSetAt: null,
          debtMicro: 0,
          autoTopUpEnabled: false,
          ...state,
        });
      },
    },
  };
}

/** A planner that records what the runtime handed it and always plans the same turn. */
class PlannerThatRecordsItsMeter implements AgentDecomposer {
  constructor(private readonly seen: Seen) {}

  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.seen.meters.push(meterKind(args.creditMeter));
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

class PlannerThatThrows implements AgentDecomposer {
  constructor(private readonly seen: Seen) {}

  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.seen.meters.push(meterKind(args.creditMeter));
    return Promise.reject(new Error('the planner could not be reached'));
  }
}

function meterKind(meter: AgentCreditMeter | undefined): string {
  return meter === undefined ? 'none' : meter.kind;
}

describe("a moved account's turn is funded from its chosen AI source", () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function app(over: {
    credits?: AiCreditsRuntime;
    tier?: AccountTier;
    decomposer?: AgentDecomposer;
    allowFallback?: boolean;
    enableByok?: boolean;
    captureUsage?: boolean;
    /** 'cli_device' is the only credential that reaches the API on a `free`
     *  account (ordinary keys are refused by the Free customer-API boundary
     *  before any route gate runs) — needed only for the Free-tier arm. */
    keyProvenance?: 'cli_device';
  }): Promise<TestAppFixture> {
    return buildTestApp({
      enableAgentRuntime: true,
      ...(over.decomposer !== undefined ? { agentDecomposer: over.decomposer } : {}),
      agentDecomposerKind: 'claude',
      ...(over.tier !== undefined ? { tier: over.tier } : {}),
      ...(over.credits !== undefined ? { aiCredits: over.credits } : {}),
      // Fallback switched ON in the test app throughout this file: M10 says a
      // moved account must never reach it, whatever the deployment posture —
      // so proving that against an ENABLED fallback is the honest test, not
      // one where the fallback was simply unavailable to reach.
      allowDeploymentKeyFallback: over.allowFallback ?? true,
      ...(over.enableByok === true ? { enableByokAnthropic: true } : {}),
      ...(over.captureUsage === true ? { captureAgentDecomposerUsage: true } : {}),
      ...(over.keyProvenance !== undefined ? { keyProvenance: over.keyProvenance } : {}),
    });
  }

  async function createSession(
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<{ status: number; id?: string; body: unknown }> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload,
    });
    return {
      status: res.statusCode,
      id: res.statusCode === 201 ? res.json<{ id: string }>().id : undefined,
      body: res.json(),
    };
  }

  function send(id: string, headers: Record<string, string> = {}) {
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: TASK },
    });
  }

  async function setStoredKey(): Promise<void> {
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: STORED_KEY },
    });
    expect(res.statusCode, 'test setup: storing the key must succeed').toBe(200);
  }

  it('CRITICAL a credits-source account (ai_source=credits) never runs on its stored key, even though one is on file — the reservation is opened and the planner is handed an ENFORCE meter', async () => {
    const seen = newSeen();
    // team_manual allows an own key, so the stored key really is usable —
    // proving the credits leg is chosen because ai_source says so, not
    // because no alternative existed.
    fx = await app({
      tier: 'team_manual',
      enableByok: true,
      captureUsage: true,
      decomposer: new PlannerThatRecordsItsMeter(seen),
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'credits' }),
    });
    await setStoredKey();
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(200);
    expect(seen.meters).toEqual(['enforce']);
    expect(seen.reserved).toHaveLength(1);
    expect(fx.agentDecomposerUsageRecords[0]?.keySource).toBe('credits');
  });

  it('CRITICAL an AUTOMATIC account (ai_source=null) keeps using its usable stored key — no reservation is ever opened', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      enableByok: true,
      captureUsage: true,
      decomposer: new PlannerThatRecordsItsMeter(seen),
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: null }),
    });
    await setStoredKey();
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(200);
    expect(seen.reserved).toEqual([]);
    expect(seen.meters).toEqual(['none']);
    expect(fx.agentDecomposerUsageRecords[0]?.keySource).toBe('cached');
  });

  it('CRITICAL the SAME automatic account spends credits the moment it has no usable key left', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      captureUsage: true,
      decomposer: new PlannerThatRecordsItsMeter(seen),
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: null }),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(200);
    expect(seen.reserved).toHaveLength(1);
    expect(fx.agentDecomposerUsageRecords[0]?.keySource).toBe('credits');
  });

  it('CRITICAL⛔ a CHOSEN own key (ai_source=own_key) that is missing is told to add one, spends no credits, and never silently falls back to credits — the contrast with the automatic account above proves the difference is attributable to ai_source alone', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'own_key' }),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(502);
    expect(res.json<{ type: string }>().type).toBe(
      'https://errors.driftstack.dev/byok-anthropic-required',
    );
    expect(seen.reserved).toEqual([]);
  });

  it('CRITICAL⛔ NEGATIVE CONTROL — the same own-key-missing account is refused even with the staging fallback SWITCHED ON in the test app: it never becomes keySource=fallback (M10) and it never reaches credits (§4.3 rule 3)', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      allowFallback: true,
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'own_key' }),
    });
    const { id } = await createSession();
    const res = await send(id!);

    // Never a 200 on the deployment's fallback key, and never a credits spend.
    expect(res.statusCode).toBe(502);
    expect(seen.reserved).toEqual([]);
  });

  it('CRITICAL Personal (solo_manual) gets AI on credits', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'solo_manual',
      captureUsage: true,
      decomposer: new PlannerThatRecordsItsMeter(seen),
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'credits' }),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(200);
    expect(seen.reserved).toHaveLength(1);
    expect(fx.agentDecomposerUsageRecords[0]?.keySource).toBe('credits');
  });

  it('CRITICAL ...and can never use its own key: a header key is refused 403 own_key_not_on_plan, and no credits are spent', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'solo_manual',
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'credits' }),
    });
    const { id } = await createSession();

    const turn = await send(id!, { 'x-byok-anthropic-api-key': HEADER_KEY });
    expect(turn.statusCode).toBe(403);
    const body = turn.json<{ own_key_not_on_plan?: boolean }>();
    expect(body.own_key_not_on_plan).toBe(true);
    expect(seen.reserved).toEqual([]);
  });

  it('CRITICAL Free gets no AI at all, even when it sends its own key on the request', async () => {
    fx = await app({
      tier: 'free',
      keyProvenance: 'cli_device',
      credits: enforceRuntime(newSeen(), { billingMode: 'credits', aiSource: null }),
    });
    const create = await createSession({}, { 'x-byok-anthropic-api-key': HEADER_KEY });
    expect(create.status).toBe(403);
    const body = create.body as { ai_not_on_plan?: boolean; tier?: string };
    expect(body.ai_not_on_plan).toBe(true);
    expect(body.tier).toBe('free');
  });

  it('CRITICAL Opus is refused with a reason at CREATE for a moved account, before a session even exists', async () => {
    fx = await app({
      tier: 'team_manual',
      credits: enforceRuntime(newSeen(), { billingMode: 'credits', aiSource: 'credits' }),
    });
    const create = await createSession({ model: OPUS });
    expect(create.status).toBe(403);
    const body = create.body as { requires_own_key?: boolean; model?: string };
    expect(body.requires_own_key).toBe(true);
    expect(body.model).toBe(OPUS);
  });

  it("CRITICAL⛔ and Personal's Opus-at-create copy never mentions adding a key", async () => {
    fx = await app({
      tier: 'solo_manual',
      credits: enforceRuntime(newSeen(), { billingMode: 'credits', aiSource: 'credits' }),
    });
    const create = await createSession({ model: OPUS });
    expect(create.status).toBe(403);
    const detail = (create.body as { detail?: string }).detail ?? '';
    expect(detail.toLowerCase()).not.toContain('key');
    expect(detail).toContain('isn’t included in your plan');
  });

  it('CRITICAL a moved account whose OWN KEY is usable is never refused Opus at create — the create-time check agrees with what the turn will actually do', async () => {
    fx = await app({
      tier: 'team_manual',
      enableByok: true,
      credits: enforceRuntime(newSeen(), { billingMode: 'credits', aiSource: 'own_key' }),
    });
    await setStoredKey();
    const create = await createSession({ model: OPUS });
    expect(create.status).toBe(201);
  });

  it('CRITICAL Opus is refused on every TURN too, not just at create — a session created before the account moved is still checked when it is sent, drawn from the RESERVATION’s own refusal', async () => {
    const seen = newSeen();
    let moved = false;
    fx = await app({
      tier: 'team_manual',
      enableByok: true,
      credits: enforceRuntime(
        seen,
        () => (moved ? { billingMode: 'credits', aiSource: 'credits' } : LEGACY),
        {
          reserve: () =>
            Promise.resolve({
              outcome: 'refused',
              reason: 'model',
              modelRefusal: 'own_key_only',
              debtReason: null,
              debtMicro: 0,
              availableMicro: 0,
              minStartMicro: null,
              openTasks: 0,
            }),
        },
      ),
    });
    await setStoredKey();
    // Created while the account still reads as legacy: the stored key lets
    // Opus create succeed through the ordinary legacy path.
    const create = await createSession({ model: OPUS });
    expect(create.status).toBe(201);

    // The account is moved, and this turn's ai_source is an explicit
    // 'credits' choice — so even with the SAME stored key still on file, this
    // turn is funded from credits, and credits cannot run Opus.
    moved = true;
    const res = await send(create.id!);
    expect(res.statusCode).toBe(403);
    const body = res.json<{ requires_own_key?: boolean; model?: string }>();
    expect(body.requires_own_key).toBe(true);
    expect(body.model).toBe(OPUS);
    expect(seen.reserved).toHaveLength(1);
  });

  it('CRITICAL out of credits is a 402 that says credits will refresh', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      credits: enforceRuntime(
        seen,
        { billingMode: 'credits', aiSource: 'credits' },
        {
          reserve: () =>
            Promise.resolve({
              outcome: 'refused',
              reason: 'balance',
              modelRefusal: null,
              debtReason: null,
              debtMicro: 0,
              availableMicro: 0,
              minStartMicro: 6_000_000,
              openTasks: 1,
            }),
        },
      ),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(402);
    const body = res.json<{ type: string; reason?: string; detail?: string }>();
    expect(body.type).toBe('https://errors.driftstack.dev/ai-credits-exhausted');
    expect(body.reason).toBe('balance');
    expect(body.detail?.toLowerCase()).toContain('refresh');
  });

  it('CRITICAL debt is a 402 naming the debt reason', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      credits: enforceRuntime(
        seen,
        { billingMode: 'credits', aiSource: 'credits' },
        {
          reserve: () =>
            Promise.resolve({
              outcome: 'refused',
              reason: 'debt',
              modelRefusal: null,
              debtReason: 'payment_reversed',
              debtMicro: 12_000_000,
              availableMicro: 0,
              minStartMicro: null,
              openTasks: 0,
            }),
        },
      ),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(402);
    const body = res.json<{ reason?: string; debt_reason?: string; debt_credits?: number }>();
    expect(body.reason).toBe('debt');
    expect(body.debt_reason).toBe('payment_reversed');
    expect(body.debt_credits).toBe(12);
  });

  it("CRITICAL a fourth task gets the 429 old SDKs already understand, with ai_tasks_in_flight for the ones that don't", async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      credits: enforceRuntime(
        seen,
        { billingMode: 'credits', aiSource: 'credits' },
        {
          reserve: () =>
            Promise.resolve({
              outcome: 'refused',
              reason: 'tasks_in_flight',
              modelRefusal: null,
              debtReason: null,
              debtMicro: 0,
              availableMicro: 0,
              minStartMicro: null,
              openTasks: 3,
            }),
        },
      ),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(429);
    const body = res.json<{ type: string; ai_tasks_in_flight?: boolean }>();
    expect(body.type).toBe('https://errors.driftstack.dev/concurrency-limit');
    expect(body.ai_tasks_in_flight).toBe(true);
  });

  it('CRITICAL a thrown turn still settles, and the live set ends empty', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      decomposer: new PlannerThatThrows(seen),
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'credits' }),
    });
    const { id } = await createSession();
    const res = await send(id!);

    // A planner failure is a customer-readable ending, not a 5xx — same
    // reasoning as the S11 fixture's identical arm.
    expect(res.statusCode).toBe(200);
    expect(seen.reserved).toHaveLength(1);
    expect(seen.settled).toHaveLength(1);
    expect(seen.settled[0]?.reason).toBe('completed');
    expect(seen.live.size).toBe(0);
  });

  it('CRITICAL an idempotent replay does not reserve again', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      decomposer: new PlannerThatRecordsItsMeter(seen),
      credits: enforceRuntime(seen, { billingMode: 'credits', aiSource: 'credits' }),
    });
    const { id } = await createSession();
    const key = { 'idempotency-key': 'replayed-enforce-turn-1' };

    const first = await send(id!, key);
    const replay = await send(id!, key);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(seen.reserved).toHaveLength(1);
    expect(seen.settled).toHaveLength(1);
  });

  it('CRITICAL the cost field stays a whole number even when the real charge is not a whole number of credits', async () => {
    const seen = newSeen();
    fx = await app({
      tier: 'team_manual',
      decomposer: new PlannerThatRecordsItsMeter(seen),
      // 2,345,678 microcredits = 2.345678 credits; ceil'd for the customer.
      credits: enforceRuntime(
        seen,
        { billingMode: 'credits', aiSource: 'credits' },
        { chargedMicro: 2_345_678 },
      ),
    });
    const { id } = await createSession();
    const res = await send(id!);

    expect(res.statusCode).toBe(200);
    const body = res.json<{ usage?: { cost_usd_cents?: number } }>();
    expect(body.usage?.cost_usd_cents).toBe(3);
    expect(Number.isInteger(body.usage?.cost_usd_cents)).toBe(true);
  });

  it('legacy (non-moved) accounts run exactly as before under enforce mode — byte-identical to the credits-off baseline, and the credits leg is never opened', async () => {
    // Baseline: no aiCredits member at all (the production default, mode off).
    fx = await app({ tier: 'team_manual' });
    const offId = (await createSession()).id!;
    const off = await send(offId);
    await fx.cleanup();

    const seen = newSeen();
    fx = await app({ tier: 'team_manual', credits: enforceRuntime(seen, LEGACY) });
    const onId = (await createSession()).id!;
    const on = await send(onId);

    expect(on.statusCode).toBe(off.statusCode);
    // Mask the two fields that legitimately differ between two runs (the
    // session id and any ISO timestamp) before comparing bodies.
    const mask = (body: string, sessionId: string): string =>
      body
        .split(sessionId)
        .join('<session>')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>');
    expect(mask(on.body, onId)).toEqual(mask(off.body, offId));
    expect(seen.reserved, 'a legacy account must never open the enforce leg').toEqual([]);
  });
});
