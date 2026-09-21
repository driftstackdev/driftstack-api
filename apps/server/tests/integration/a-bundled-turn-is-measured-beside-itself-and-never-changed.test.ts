// A bundled turn is measured beside itself and never changed.
//
// Shadow mode runs the whole AI-credits leg — reserve, per-attempt admission,
// settle — alongside a legacy bundled turn that goes on exactly as it did. M3
// makes that a promise rather than an intention: no refusal, no thrown error, no
// altered request, and no wait longer than a short bounded one. The failure this
// guards is not a wrong number; it is a customer whose turn broke because a
// measurement nobody asked for could not reach the database.
//
// So the faults are the subject, not the happy path. A `reserve` that rejects, a
// `reserve` that NEVER ANSWERS (the database unreachable, which no statement
// timeout can bound — there is no connection to time out), a `settle` that
// throws, and a turn that throws BETWEEN the reservation and the runtime: in
// every one the customer's response must be the same bytes, and the task must
// not be left in the lease keeper's live set, where this process would renew its
// lease for ever and the sweep could never reach it (M1).
//
// ⛔ "BYTE FOR BYTE" IS ASSERTED ON A MASKED BODY, and the mask is exactly two
// things: the session id and the ISO timestamps beside it. Those differ between
// two fixtures of the SAME mode and are the only fields that do. Everything a
// credits leg could plausibly disturb — the kind, the intents, the results, the
// usage block with its flat bundled price, the ordering of keys — is compared
// literally. An unmasked comparison would be a test of `randomUUID`.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type { AgentCreditMeter } from '../../src/services/agent-credit-meter.js';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import type {
  CreditReserveInput,
  CreditReserveResult,
  CreditSettleResult,
} from '../../src/services/credit-reservations.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-shadow-turn-aaaaaaaaaaaaaaaaaaaaaaaa';
const TASK = 'Open https://portal.example.test/invoices and take a screenshot.';

/** What the credits leg was asked to do, and what the planner was handed. */
interface Seen {
  reserved: CreditReserveInput[];
  settled: Array<{ reservationId: string; reason: string }>;
  live: Set<string>;
  /** One entry per decompose call: the meter's kind, or `none`. */
  meters: string[];
}

function newSeen(): Seen {
  return { reserved: [], settled: [], live: new Set(), meters: [] };
}

const SHADOWED = (input: CreditReserveInput): CreditReserveResult => ({
  outcome: 'shadowed',
  reservationId: input.reservationId,
  reservedMicro: 60_000_000,
  wouldRefuseReason: null,
});

const SETTLED: CreditSettleResult = {
  outcome: 'settled',
  chargedMicro: 0,
  charges: [],
  claimsPaidMicro: 0,
  claimsToDebtMicro: 0,
};

/**
 * A credits runtime made of functions.
 *
 * The six statements the turn can reach are the whole surface (see
 * `AiCreditsReservations`), so a fault is a function that rejects or one that
 * never settles — both awkward to provoke out of a real service and trivial
 * here. The live set is the real one's contract: `add` on reserve, `remove` in
 * the route's finally, and `liveCount` to read it back.
 */
function creditsRuntime(
  seen: Seen,
  faults: {
    reserve?: (input: CreditReserveInput) => Promise<CreditReserveResult>;
    settle?: () => Promise<CreditSettleResult>;
    /** The keeper objecting on the way out — the last statement of the route's finally. */
    remove?: (id: string) => void;
    /** `enforce` here still means a LEGACY turn, which is measured, never funded. */
    mode?: 'shadow' | 'enforce';
  } = {},
): AiCreditsRuntime {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  return {
    mode: faults.mode ?? 'shadow',
    bootId: 'boot-shadow-test',
    reservations: {
      reserve: (input: CreditReserveInput): Promise<CreditReserveResult> => {
        seen.reserved.push(input);
        return faults.reserve?.(input) ?? Promise.resolve(SHADOWED(input));
      },
      settle: (reservationId: string, reason: string): Promise<CreditSettleResult> => {
        seen.settled.push({ reservationId, reason });
        return faults.settle?.() ?? Promise.resolve(SETTLED);
      },
      // The per-attempt four. This fixture's planner makes no provider request,
      // so nothing reaches them; they answer "nothing to measure" rather than
      // never settling, so a future planner that DID reach them would not hang.
      planCall: () => Promise.resolve({ outcome: 'unavailable', reason: 'model' }),
      admitCall: () => never(),
      markSent: () => never(),
      settleCall: () => never(),
    },
    leaseKeeper: {
      add: (id: string) => seen.live.add(id),
      remove: (id: string) => {
        if (faults.remove !== undefined) {
          faults.remove(id);
          return;
        }
        seen.live.delete(id);
      },
      liveCount: () => seen.live.size,
    },
    report: {
      shadowReport: () => Promise.reject(new Error('not used by this test')),
      census: () => Promise.reject(new Error('not used by this test')),
    },
    // S12 — every legacy turn in this file is on `billing_mode='legacy'`:
    // nothing here tests a moved account, so the read the route takes before
    // choosing a leg always answers "legacy" and the credits leg is never
    // reached.
    accounts: {
      ensureAccount: (accountId: string) =>
        Promise.resolve({
          accountId,
          billingMode: 'legacy',
          aiSource: null,
          aiSourceSetBy: null,
          aiSourceSetAt: null,
          debtMicro: 0,
          autoTopUpEnabled: false,
        }),
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
      intents: [
        { kind: 'navigate', url: 'https://portal.example.test/invoices' },
        { kind: 'capture', capture: 'screenshot' },
      ],
      tokensConsumed: 120,
      usage: {
        decomposerKind: 'claude',
        model: 'claude-sonnet-5',
        anthropicInputTokens: 900,
        anthropicOutputTokens: 120,
        costUsdCents: 1,
      },
    });
  }
}

function meterKind(meter: AgentCreditMeter | undefined): string {
  return meter === undefined ? 'none' : meter.kind;
}

/**
 * The response with the two volatile fields masked: the session id (a fresh
 * uuid per fixture) and every ISO timestamp. Nothing else in the body varies
 * between two runs of the same mode, which is what makes the comparison a
 * statement about credits rather than about clocks.
 */
function masked(body: string, sessionId: string): string {
  return body
    .split(sessionId)
    .join('<session>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>');
}

describe('a bundled turn is measured beside itself and never changed', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function bundledApp(
    seen: Seen,
    credits: AiCreditsRuntime | undefined,
    over: { kind?: 'claude' | 'deterministic' } = {},
  ): Promise<TestAppFixture> {
    return buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: new PlannerThatRecordsItsMeter(seen),
      agentDecomposerKind: over.kind ?? 'claude',
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
      ...(credits === undefined ? {} : { aiCredits: credits }),
    });
  }

  async function createSession(mode?: 'manual'): Promise<string> {
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: mode === undefined ? {} : { mode, token_budget: 10_000 },
    });
    return create.json<{ id: string }>().id;
  }

  function send(id: string, headers: Record<string, string> = {}) {
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: TASK },
    });
  }

  /** One bundled turn, returning the masked body and what the credits leg saw. */
  async function bundledTurn(
    credits: AiCreditsRuntime | undefined,
    seen: Seen,
    over: { kind?: 'claude' | 'deterministic' } = {},
  ): Promise<{ status: number; body: string }> {
    fx = await bundledApp(seen, credits, over);
    const id = await createSession();
    const res = await send(id);
    return { status: res.statusCode, body: masked(res.body, id) };
  }

  it('CRITICAL with credits off the runtime is not wired at all, so nothing can be reserved, settled or asked — and the planner is handed no meter', async () => {
    const seen = newSeen();
    const off = await bundledTurn(undefined, seen);

    expect(off.status).toBe(200);
    // Not "no query ran": with the mode off there is no object to query THROUGH.
    // The six functions a turn could reach do not exist on this app.
    expect(seen.reserved).toEqual([]);
    expect(seen.settled).toEqual([]);
    expect(seen.meters).toEqual(['none']);
  });

  it('CRITICAL the customer reads the same bytes in shadow mode as with credits off — the kind, the steps, the results and the flat bundled price all identical once the session id and timestamps are masked', async () => {
    const offSeen = newSeen();
    const off = await bundledTurn(undefined, offSeen);
    await fx.cleanup();

    const shadowSeen = newSeen();
    const shadow = await bundledTurn(creditsRuntime(shadowSeen), shadowSeen);

    expect(shadow.status).toBe(off.status);
    expect(shadow.body).toEqual(off.body);
    // And the leg really ran — otherwise the equality above is the equality of
    // two turns that both did nothing, which is the shape this whole file is
    // about not shipping.
    expect(shadowSeen.reserved).toHaveLength(1);
    expect(shadowSeen.meters).toEqual(['shadow']);
  });

  it('CRITICAL the task is reserved under the boot id the lease keeper holds, and handed to the keeper. A reservation owned by any other value is renewed by nobody: renewLeases filters on lease_owner, so its lease would lapse under the very process that is still running the turn.', async () => {
    const seen = newSeen();
    await bundledTurn(creditsRuntime(seen), seen);

    expect(seen.reserved).toHaveLength(1);
    expect(seen.reserved[0]?.bootId).toBe('boot-shadow-test');
    expect(seen.reserved[0]?.mode).toBe('shadow');
    expect(seen.reserved[0]?.model).toBe('claude-sonnet-5');
    // M2 — the customer's Idempotency-Key is never claimed by a shadow row; the
    // unique index it would take belongs to the enforced task that comes later.
    expect(seen.reserved[0]?.idempotencyKey).toBeNull();
  });

  it('CRITICAL the live set is empty again when the turn ends, and settle ran exactly once. A task left in it is renewed for ever by this process and can never be reached by the sweep that would have finished it (M1).', async () => {
    const seen = newSeen();
    await bundledTurn(creditsRuntime(seen), seen);

    expect(seen.settled).toHaveLength(1);
    expect(seen.settled[0]?.reason).toBe('completed');
    expect(seen.settled[0]?.reservationId).toBe(seen.reserved[0]?.reservationId);
    expect(seen.live.size, 'the lease keeper still believes this process is running a task').toBe(
      0,
    );
  });

  it('CRITICAL a reserve that REJECTS leaves the turn untouched: the same bytes, no meter, nothing in the live set, and nothing settled for a task that was never opened', async () => {
    const offSeen = newSeen();
    const off = await bundledTurn(undefined, offSeen);
    await fx.cleanup();

    const seen = newSeen();
    const broken = creditsRuntime(seen, {
      reserve: () => Promise.reject(new Error('the credits database is unreachable')),
    });
    const shadow = await bundledTurn(broken, seen);

    expect(shadow.status).toBe(200);
    expect(shadow.body).toEqual(off.body);
    expect(seen.meters).toEqual(['none']);
    expect(seen.live.size).toBe(0);
    expect(seen.settled).toEqual([]);
  });

  it('CRITICAL a reserve that NEVER ANSWERS costs the turn a bounded wait and nothing else. No statement timeout can bound this: a pool that hands out no connection has no statement to time out, which is exactly what "the database is unreachable" looks like from inside a turn.', async () => {
    const offSeen = newSeen();
    const off = await bundledTurn(undefined, offSeen);
    await fx.cleanup();

    const seen = newSeen();
    const hanging = creditsRuntime(seen, {
      reserve: () => new Promise<CreditReserveResult>(() => undefined),
    });
    const started = Date.now();
    const shadow = await bundledTurn(hanging, seen);
    const waited = Date.now() - started;

    expect(shadow.status).toBe(200);
    expect(shadow.body).toEqual(off.body);
    expect(seen.meters).toEqual(['none']);
    expect(seen.live.size).toBe(0);
    // The deadline is 2s. A generous ceiling on the WHOLE request, so this is a
    // statement about boundedness rather than about this machine's speed — an
    // unbounded wait fails it by never returning at all.
    expect(waited).toBeLessThan(20_000);
  });

  it('CRITICAL a settle that THROWS still empties the live set. This is the case where leaving the task in it does the damage: the settle failed, so the keeper is the only thing that can finish the task — and it can never reach a task this process keeps renewing.', async () => {
    const offSeen = newSeen();
    const off = await bundledTurn(undefined, offSeen);
    await fx.cleanup();

    const seen = newSeen();
    const broken = creditsRuntime(seen, {
      settle: () => Promise.reject(new Error('settling the measurement failed')),
    });
    const shadow = await bundledTurn(broken, seen);

    expect(shadow.status).toBe(200);
    expect(shadow.body).toEqual(off.body);
    expect(seen.reserved).toHaveLength(1);
    expect(seen.settled).toHaveLength(1);
    expect(seen.live.size, 'a failed settle must still remove — M1').toBe(0);
  });

  it('CRITICAL a LEASE KEEPER that objects on the way out cannot end the turn either. Handing the lease back is the LAST statement of the route’s finally, and a throw that leaves a finally does not merely lose the measurement: it REPLACES whatever the turn was about to answer, so a 200 — or a typed 409 — becomes a 500 for a customer who asked for none of this. The open half already swallows exactly this fault; the close half is the one that reaches the customer.', async () => {
    const offSeen = newSeen();
    const off = await bundledTurn(undefined, offSeen);
    await fx.cleanup();

    const seen = newSeen();
    const broken = creditsRuntime(seen, {
      remove: (id: string) => {
        seen.live.delete(id);
        throw new Error('the lease keeper is gone');
      },
    });
    const shadow = await bundledTurn(broken, seen);

    expect(shadow.status).toBe(200);
    expect(shadow.body).toEqual(off.body);
    // The measurement itself ran and settled — only the bookkeeping after it
    // failed, which is what makes this a statement about the swallow.
    expect(seen.reserved).toHaveLength(1);
    expect(seen.settled).toHaveLength(1);
  });

  it('CRITICAL a legacy turn is MEASURED even when the deployment’s mode is `enforce`, never funded by it. Enforce is S12’s, and S12 moves accounts; until an account is moved, enforcing its turn would refuse a paying customer for credits they were never given and charge a reservation that holds real lots. The reservation is `shadow` and the planner’s meter is a `shadow` one whatever the mode says.', async () => {
    const seen = newSeen();
    const res = await bundledTurn(creditsRuntime(seen, { mode: 'enforce' }), seen);

    expect(res.status).toBe(200);
    expect(seen.reserved).toHaveLength(1);
    expect(seen.reserved[0]?.mode).toBe('shadow');
    expect(seen.meters).toEqual(['shadow']);
  });

  it('CRITICAL an idempotent REPLAY is never reserved a second time. The receipt answers before the turn is ever executed, so one turn cannot be measured twice — which would double its task count, its calls and its shadow charge in the very report that decides whether the numbers are trustworthy.', async () => {
    const seen = newSeen();
    fx = await bundledApp(seen, creditsRuntime(seen));
    const id = await createSession();
    const key = { 'idempotency-key': 'replayed-shadow-turn-1' };

    const first = await send(id, key);
    const replay = await send(id, key);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);
    // One turn ran, so exactly one task was opened and one settled.
    expect(seen.reserved).toHaveLength(1);
    expect(seen.settled).toHaveLength(1);
    expect(seen.live.size).toBe(0);
  });

  it('CRITICAL a task opened before the turn FAILS cannot leak. The reservation is taken early — inside the try, before the checks that can still refuse — and the route has exactly one finally, so the ending where the planner never produced a plan closes the task like every other ending. (The runtime turns a planner failure into a customer-readable ending rather than letting it escape, which is why the status below is a 200 and not a 5xx; what is being asserted is the task, not the status.)', async () => {
    const seen = newSeen();
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: {
        decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
          seen.meters.push(meterKind(args.creditMeter));
          return Promise.reject(new Error('the planner could not be reached'));
        },
      },
      agentDecomposerKind: 'claude',
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
      aiCredits: creditsRuntime(seen),
    });
    const id = await createSession();

    const res = await send(id);

    // The customer's ending is the one a failed planner always gave, and says
    // nothing about credits.
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/credit/i);
    // The task was open when it threw, and it is closed and out of the live set.
    expect(seen.meters).toEqual(['shadow']);
    expect(seen.reserved).toHaveLength(1);
    expect(seen.settled).toHaveLength(1);
    expect(seen.live.size).toBe(0);
  });

  it('CRITICAL an own-key turn is never reserved. It is the customer spending with their own provider account; measuring it would put their bill into Driftstack’s shadow ledger.', async () => {
    const seen = newSeen();
    fx = await bundledApp(seen, creditsRuntime(seen));
    const id = await createSession();

    const res = await send(id, { 'x-byok-anthropic-api-key': OWN_KEY });

    expect(res.statusCode).toBe(200);
    expect(seen.reserved).toEqual([]);
    expect(seen.meters).toEqual(['none']);
  });

  it('CRITICAL a deterministic deployment is never reserved: it calls no model, so there is nothing to price', async () => {
    const seen = newSeen();
    const res = await bundledTurn(creditsRuntime(seen), seen, { kind: 'deterministic' });

    expect(res.status).toBe(200);
    expect(seen.reserved).toEqual([]);
  });

  it('CRITICAL a manual note is never reserved. It returns before any provider resource is touched, because a human log line authorizes none of them — and calls no model either.', async () => {
    const seen = newSeen();
    fx = await bundledApp(seen, creditsRuntime(seen));
    const id = await createSession('manual');

    const res = await send(id);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ kind: string }>().kind).toBe('logged-manual');
    expect(seen.reserved).toEqual([]);
  });
});
