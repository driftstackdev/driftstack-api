// S10/§4.5 — every billable attempt asks for its credits before it is sent.
//
// The question is not "does a metered call get admitted". It is whether EVERY
// attempt does, in the right ORDER, and whether each one is paid for exactly
// once — because the attempts that are easy to miss are the ones nobody writes
// down: a 5xx retry, a 429 retry, a reply-control resend after the provider
// rejects a schema, and the runtime's one re-ask of a plan nobody could read.
// Each of those is a second billable request, and a task that admitted one and
// sent two would commit half of what it spends.
//
// So the order is asserted on ONE SHARED EVENT LOG rather than per-mock:
// admit < sent < fetch < settle, per attempt, with the fetch between the two
// halves. A log that merely contains the four words in some order would pass a
// version that settled before it sent.

import { describe, expect, it } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import { splitRequestRegionsAtCacheMarkers } from '../../src/services/agent-decomposer-claude.js';
import { OpenAICompatibleAgentDecomposer } from '../../src/services/agent-decomposer-openai-compatible.js';
import {
  AgentDecomposerCreditsDeniedError,
  type DecomposeArgs,
  type TranscriptEntry,
} from '../../src/services/agent-decomposer.js';
import {
  AgentCreditMeterUnavailableError,
  enforceCreditMeter,
  type AgentCreditAttempt,
  type AgentCreditDecision,
  type AgentCreditMeter,
  type AgentCreditReservations,
  type AgentCreditSettlement,
} from '../../src/services/agent-credit-meter.js';
import { CALL_OUTPUT_CEILING, CALL_OUTPUT_FLOOR } from '../../src/services/credit-call-fit.js';
import { AgentDecomposerCancelledError } from '../../src/services/agent-planner-contract.js';
import {
  classifyDecomposerError,
  plannerReplyWasMalformed,
} from '../../src/services/agent-runtime.js';
import { __TEST_ONLY__ } from '../../src/services/agent-decomposer-claude.js';

const KEY = 'sk-ant-test-fake-key';

function args(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open https://example.com and capture the page',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: KEY,
    ...overrides,
  };
}

const PLAN_REPLY = { kind: 'plan', intents: [{ kind: 'navigate', url: 'https://example.com/' }] };

function planResponse(status = 200): Response {
  if (status !== 200) return new Response('upstream error', { status });
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(PLAN_REPLY) }],
      usage: { input_tokens: 120, output_tokens: 80 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A 400 that names the reply schema, which `callConstrained` answers by
 *  re-sending the same request without it — a SECOND billable attempt. */
function schemaRejectedResponse(): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'output_config.format: unsupported' },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

interface Recorded {
  log: string[];
  bodies: string[];
  attempts: AgentCreditAttempt[];
  settlements: AgentCreditSettlement[];
}

/**
 * A meter that records rather than decides. `answers` is consulted per attempt;
 * anything it does not answer is admitted as it stands.
 */
function recordingMeter(
  recorded: Recorded,
  answers: Array<AgentCreditDecision | 'admit'> = [],
  kind: 'enforce' | 'shadow' = 'enforce',
): AgentCreditMeter {
  let n = 0;
  return {
    kind,
    // S11 — the meter names its task so the usage row can carry the join.
    reservationId: 'res-attempt-asks',
    admit: (attempt) => {
      recorded.attempts.push(attempt);
      recorded.log.push('admit');
      const answer = answers[n++] ?? 'admit';
      if (answer !== 'admit') return Promise.resolve(answer);
      return Promise.resolve({
        outcome: 'admitted' as const,
        call: {
          maxOutputTokens: attempt.maxOutputTokens,
          markSent: () => {
            recorded.log.push('sent');
            return Promise.resolve(true);
          },
          settle: (settlement: AgentCreditSettlement) => {
            recorded.log.push(`settle:${settlement.basis}`);
            recorded.settlements.push(settlement);
            return Promise.resolve();
          },
        },
      });
    },
  };
}

function recorder(): Recorded {
  return { log: [], bodies: [], attempts: [], settlements: [] };
}

/** A fetch that logs when it is called and answers from a queue. */
function loggingFetch(recorded: Recorded, replies: Response[]): typeof globalThis.fetch {
  let n = 0;
  return (_url: unknown, init?: RequestInit) => {
    recorded.log.push('fetch');
    recorded.bodies.push(typeof init?.body === 'string' ? init.body : '');
    const reply = replies[n++];
    if (reply === undefined) throw new Error('the corpus ran out of replies');
    return Promise.resolve(reply);
  };
}

describe('every billable attempt asks for its credits before it is sent', () => {
  it('CRITICAL the order on one shared log is admit, sent, fetch, settle — never settled before it was sent', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse()]),
    });
    const result = await decomposer.decompose(args({ creditMeter: recordingMeter(recorded) }));

    expect(result.kind).toBe('plan');
    expect(recorded.log).toEqual(['admit', 'sent', 'fetch', 'settle:provider_usage']);
  });

  it('CRITICAL a 5xx retry is a second attempt: admitted again, sent again, settled twice', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse(503), planResponse()]),
      retryBackoffMs: 0,
    });
    await decomposer.decompose(args({ creditMeter: recordingMeter(recorded) }));

    expect(recorded.log).toEqual([
      'admit',
      'sent',
      'fetch',
      // §4.6 — a non-2xx status arrived before any stream, so the provider
      // rejected the request rather than serving it: charged nothing.
      'settle:provider_rejected',
      'admit',
      'sent',
      'fetch',
      'settle:provider_usage',
    ]);
  });

  it('CRITICAL a reply-control resend is a second attempt too, and it is admitted before it goes out', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [schemaRejectedResponse(), planResponse()]),
      retryBackoffMs: 0,
    });
    await decomposer.decompose(args({ creditMeter: recordingMeter(recorded) }));

    expect(recorded.log).toEqual([
      'admit',
      'sent',
      'fetch',
      'settle:provider_rejected',
      'admit',
      'sent',
      'fetch',
      'settle:provider_usage',
    ]);
    // The resend really is the constrained request minus the control the
    // provider named — a positive control that the two attempts differ.
    expect(recorded.bodies[0]).not.toBe(recorded.bodies[1]);
    expect(recorded.bodies[0]).toContain('output_config');
    expect(recorded.bodies[1]).not.toContain('"format"');
  });

  it('CRITICAL a Stop that lands during admission sends nothing and settles never_sent', async () => {
    const recorded = recorder();
    const controller = new AbortController();
    const meter: AgentCreditMeter = {
      kind: 'enforce',
      // S11 — the meter names its task so the usage row can carry the join.
      reservationId: 'res-attempt-asks',
      admit: (attempt) => {
        recorded.log.push('admit');
        // The Stop arrives while the credit check is in flight — the one window
        // the post-fence check exists to close.
        controller.abort();
        return Promise.resolve({
          outcome: 'admitted' as const,
          call: {
            maxOutputTokens: attempt.maxOutputTokens,
            markSent: () => {
              recorded.log.push('sent');
              return Promise.resolve(true);
            },
            settle: (settlement: AgentCreditSettlement) => {
              recorded.log.push(`settle:${settlement.basis}`);
              return Promise.resolve();
            },
          },
        });
      },
    };
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse()]),
    });

    await expect(
      decomposer.decompose(args({ creditMeter: meter, signal: controller.signal })),
    ).rejects.toBeInstanceOf(AgentDecomposerCancelledError);
    expect(recorded.log).toEqual(['admit', 'settle:never_sent']);
  });

  it('CRITICAL a fetch that THROWS still settles its call — nothing may leave one open', async () => {
    const recorded = recorder();
    let calls = 0;
    const decomposer = new ClaudeAgentDecomposer({
      fetch: () => {
        calls += 1;
        recorded.log.push('fetch');
        return Promise.reject(new Error('socket hang up'));
      },
      retryBackoffMs: 0,
    });

    await expect(
      decomposer.decompose(args({ creditMeter: recordingMeter(recorded) })),
    ).rejects.toThrow(/socket hang up/);

    // ⛔ A CALL LEFT `started` HOLDS ITS WHOLE BOUND against the task until the
    // lease keeper finds it ninety seconds later and charges the customer for a
    // request that may never have been served. Both attempts settle, and both
    // settle at the bound: the request went out and left no record (§4.6, L5).
    expect(calls).toBe(2);
    expect(recorded.log).toEqual([
      'admit',
      'sent',
      'fetch',
      'settle:no_record',
      'admit',
      'sent',
      'fetch',
      'settle:no_record',
    ]);
  });

  it('CRITICAL a refusal ends the call before anything is sent, and is not a malformed reply', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse()]),
    });
    const meter = recordingMeter(recorded, [{ outcome: 'refused', reason: 'did_not_fit' }]);

    const err = await decomposer.decompose(args({ creditMeter: meter })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDecomposerCreditsDeniedError);
    expect((err as AgentDecomposerCreditsDeniedError).reason).toBe('did_not_fit');
    expect(recorded.log).toEqual(['admit']);
    // ⛔ THE RUNTIME RE-ASKS A PLANNING CALL ONCE when the PROVIDER answered with
    // something nobody could read. A refusal means the provider was never asked,
    // and a second refusal would be a second turn ending for the same reason,
    // bought with the turn's one re-ask. The screen is on the MESSAGE, so this
    // is pinned on the message the refusal actually carries.
    expect(plannerReplyWasMalformed(err)).toBe(false);
    expect(classifyDecomposerError(err)).toBe('transient');
  });

  it('CRITICAL a lowered max_tokens is the max_tokens that is sent', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse()]),
    });
    const lowered = CALL_OUTPUT_FLOOR.plan;
    const meter: AgentCreditMeter = {
      kind: 'enforce',
      // S11 — the meter names its task so the usage row can carry the join.
      reservationId: 'res-attempt-asks',
      admit: (attempt) => {
        recorded.attempts.push(attempt);
        return Promise.resolve({
          outcome: 'admitted' as const,
          call: {
            maxOutputTokens: lowered,
            markSent: () => Promise.resolve(true),
            settle: () => Promise.resolve(),
          },
        });
      },
    };
    await decomposer.decompose(args({ creditMeter: meter }));

    const sent = JSON.parse(recorded.bodies[0]!) as { max_tokens: number };
    expect(sent.max_tokens).toBe(lowered);
    // And the attempt the meter was asked about carried the ceiling it would
    // have sent, so the ladder priced the request it was actually shown.
    expect(recorded.attempts[0]?.maxOutputTokens).toBe(CALL_OUTPUT_CEILING.plan);
  });

  it('CRITICAL a trim rung rebuilds with less history, and the meter is asked again about the smaller request', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse()]),
    });
    const history: TranscriptEntry[] = Array.from({ length: 12 }, (_, i) => ({
      at: `2026-09-20T10:0${String(i)}:00.000Z`,
      role: i % 2 === 0 ? 'user' : 'agent',
      body: `entry ${String(i)} ${'x'.repeat(400)}`,
    }));
    let asked = 0;
    const meter: AgentCreditMeter = {
      kind: 'enforce',
      // S11 — the meter names its task so the usage row can carry the join.
      reservationId: 'res-attempt-asks',
      admit: (attempt) => {
        recorded.attempts.push(attempt);
        asked += 1;
        if (asked === 1) {
          // Ask for half of what is there, which no single entry can satisfy.
          return Promise.resolve({
            outcome: 'rebuild' as const,
            historyByteBudget: Math.floor(attempt.historyBytes / 2),
          });
        }
        return Promise.resolve({
          outcome: 'admitted' as const,
          call: {
            maxOutputTokens: attempt.maxOutputTokens,
            markSent: () => Promise.resolve(true),
            settle: () => Promise.resolve(),
          },
        });
      },
    };
    await decomposer.decompose(args({ history, creditMeter: meter }));

    expect(recorded.attempts).toHaveLength(2);
    const [first, second] = recorded.attempts;
    expect(second!.historyBytes).toBeLessThanOrEqual(Math.floor(first!.historyBytes / 2));
    // The rebuilt request really is smaller on the wire, and it is the one sent.
    expect(recorded.bodies).toHaveLength(1);
    expect(Buffer.byteLength(recorded.bodies[0]!, 'utf8')).toBeLessThan(
      first!.regions.oneHourRegionBytes +
        first!.regions.fiveMinuteRegionBytes +
        first!.regions.uncachedRegionBytes,
    );
  });

  it('CRITICAL a history that cannot shrink enough is refused rather than looped', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [planResponse()]),
    });
    const meter: AgentCreditMeter = {
      kind: 'enforce',
      // S11 — the meter names its task so the usage row can carry the join.
      reservationId: 'res-attempt-asks',
      // Always asks for zero bytes of history, which no conversation can reach:
      // the current task and its context are never droppable.
      admit: () => Promise.resolve({ outcome: 'rebuild' as const, historyByteBudget: 0 }),
    };
    const err = await decomposer
      .decompose(
        args({
          history: [{ at: '2026-09-20T10:00:00.000Z', role: 'user', body: 'the first thing' }],
          creditMeter: meter,
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDecomposerCreditsDeniedError);
    expect(recorded.log).toEqual([]);
  });

  it('CRITICAL an adapter that cannot measure its own requests fails closed under an enforcing meter', async () => {
    const recorded = recorder();
    const decomposer = new OpenAICompatibleAgentDecomposer({
      target: {
        qualifiedId: 'openrouter:auto',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        replyFormat: 'json_schema_strict',
        reasoningEffort: null,
        maxTokensParam: 'max_tokens',
        prices: {
          inputUsdPerMTok: 1,
          cachedInputUsdPerMTok: 1,
          cacheWriteUsdPerMTok: null,
          outputUsdPerMTok: 2,
        },
      },
      apiKey: 'or-test-key',
      fetch: loggingFetch(recorded, [planResponse()]),
    });
    const err = await decomposer
      .decompose(args({ creditMeter: recordingMeter(recorded) }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentDecomposerCreditsDeniedError);
    expect((err as AgentDecomposerCreditsDeniedError).reason).toBe('unmetered_provider');
    // Nothing was sent and nothing was measured: there is no bound to measure.
    expect(recorded.log).toEqual([]);
  });
});

describe('the bound is priced from the bytes the request will actually send', () => {
  it('CRITICAL the three regions sum to the body, and the system block is in the dearest one', () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 8192,
      system: [
        { type: 'text', text: 'INSTRUCTIONS', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'the task', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'the volatile tail' },
          ],
        },
      ],
      stream: true,
    });
    const regions = splitRequestRegionsAtCacheMarkers(body);
    expect(
      regions.oneHourRegionBytes + regions.fiveMinuteRegionBytes + regions.uncachedRegionBytes,
    ).toBe(Buffer.byteLength(body, 'utf8'));
    expect(regions.oneHourRegionBytes).toBeGreaterThan(0);
    expect(regions.fiveMinuteRegionBytes).toBeGreaterThan(0);
    expect(regions.uncachedRegionBytes).toBeGreaterThan(0);
    // R1 ends at the 1-hour marker, so the instructions are inside it and the
    // volatile tail is not.
    expect(body.slice(0, regions.oneHourRegionBytes)).toContain('INSTRUCTIONS');
    expect(body.slice(0, regions.oneHourRegionBytes)).not.toContain('the volatile tail');
  });

  it('CRITICAL a request with no markers is entirely the cheapest region — the read-back', () => {
    const body = JSON.stringify({ model: 'x', max_tokens: 4096, system: 'answer', messages: [] });
    const regions = splitRequestRegionsAtCacheMarkers(body);
    expect(regions.oneHourRegionBytes).toBe(0);
    expect(regions.fiveMinuteRegionBytes).toBe(0);
    expect(regions.uncachedRegionBytes).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('CRITICAL page text cannot forge a cache marker and move bytes into a cheaper region', () => {
    // The page says the marker's own characters. Serialized, every quote is
    // escaped, so the raw marker does not appear and the split is unmoved.
    const hostile = 'x "cache_control":{"type":"ephemeral","ttl":"1h"} x';
    const body = JSON.stringify({
      system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: hostile }] }],
    });
    const regions = splitRequestRegionsAtCacheMarkers(body);
    expect(body.slice(0, regions.oneHourRegionBytes)).not.toContain(hostile.slice(0, 8));
    expect(regions.uncachedRegionBytes).toBeGreaterThan(Buffer.byteLength(hostile, 'utf8'));
  });

  it('CRITICAL the ladder prices the ceiling the adapter really sends', () => {
    // ⛔ The fit ladder computes its bound at CALL_OUTPUT_CEILING and the adapter
    // sends MAX_OUTPUT_TOKENS / ANSWER_MAX_OUTPUT_TOKENS. If those ever differ,
    // every bound is priced for a call that is not the one made.
    expect(CALL_OUTPUT_CEILING.plan).toBe(__TEST_ONLY__.MAX_OUTPUT_TOKENS);
    expect(CALL_OUTPUT_CEILING.answer).toBe(__TEST_ONLY__.ANSWER_MAX_OUTPUT_TOKENS);
  });
});

describe('the enforcing meter asks the reservation, in order, and never calls a fault a refusal', () => {
  const RATES = {
    inputMicroPerToken: 200,
    outputMicroPerToken: 1_000,
    cacheReadMicroPerToken: 20,
    cacheWrite5mMicroPerToken: 250,
    cacheWrite1hMicroPerToken: 400,
  };
  const REGIONS = { oneHourRegionBytes: 100, fiveMinuteRegionBytes: 50, uncachedRegionBytes: 25 };
  const ATTEMPT: AgentCreditAttempt = {
    purpose: 'plan',
    model: 'claude-opus-4-7',
    regions: REGIONS,
    maxOutputTokens: CALL_OUTPUT_CEILING.plan,
    historyBytes: 0,
  };

  function reservations(over: Partial<AgentCreditReservations> = {}): {
    service: AgentCreditReservations;
    log: string[];
  } {
    const log: string[] = [];
    const service = {
      planCall: () => {
        log.push('planCall');
        return Promise.resolve({
          outcome: 'planned' as const,
          decision: {
            rung: 'ceiling' as const,
            maxOutputTokens: CALL_OUTPUT_CEILING.plan,
            bound: { inputBoundTokens: 2223, inputBoundMicro: 872_500, boundMicro: 9_064_500 },
          },
          model: 'claude-opus-4-7',
          roomMicro: 30_000_000,
          reservedMicro: 30_000_000,
          rates: RATES,
        });
      },
      admitCall: () => {
        log.push('admitCall');
        return Promise.resolve({
          outcome: 'admitted' as const,
          callId: 'call-1',
          seq: 1,
          mode: 'enforce' as const,
          leftMicro: 20_000_000,
          overReservation: false,
        });
      },
      markSent: () => {
        log.push('markSent');
        return Promise.resolve(true);
      },
      settleCall: () => {
        log.push('settleCall');
        return Promise.resolve({
          outcome: 'settled' as const,
          chargedMicro: 1,
          boundMicro: 2,
          overBound: false,
        });
      },
      ...over,
    };
    return { service, log };
  }

  it('CRITICAL planCall then admitCall then markSent then settleCall, once each', async () => {
    const { service, log } = reservations();
    const meter = enforceCreditMeter({
      reservations: service,
      reservationId: 'res-1',
      newCallId: () => 'call-1',
    });
    const decision = await meter.admit(ATTEMPT);
    expect(decision.outcome).toBe('admitted');
    if (decision.outcome !== 'admitted') return;
    expect(await decision.call.markSent()).toBe(true);
    await decision.call.settle({ basis: 'no_record' });
    expect(log).toEqual(['planCall', 'admitCall', 'markSent', 'settleCall']);
  });

  it('CRITICAL a database fault during admission is TRANSIENT and never says the credits ran out', async () => {
    const { service } = reservations({
      planCall: () => Promise.reject(new Error('connection terminated unexpectedly')),
    });
    const meter = enforceCreditMeter({ reservations: service, reservationId: 'res-1' });
    const err = await meter.admit(ATTEMPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentCreditMeterUnavailableError);
    expect(err).not.toBeInstanceOf(AgentDecomposerCreditsDeniedError);
    // ⛔ The customer whose database blinked has spent nothing, and the sentence
    // must not say they have. H5: one fault must not read as an empty balance.
    // It says the CHECK could not be completed, which is a statement about this
    // process, and claims nothing about the balance.
    expect((err as Error).message).toMatch(/could not be completed/i);
    expect((err as Error).message).not.toMatch(/ran out|used all|no .*left|exhaust/i);
    // And it classifies transient, so the turn degrades to "try again in a
    // moment" rather than to a 500 or to a refusal the customer cannot act on.
    expect(classifyDecomposerError(err)).toBe('transient');
  });

  it('CRITICAL a settlement that throws is swallowed, because the lease keeper finishes it', async () => {
    const failures: unknown[] = [];
    const { service } = reservations({
      settleCall: () => Promise.reject(new Error('deadlock detected')),
    });
    const meter = enforceCreditMeter({
      reservations: service,
      reservationId: 'res-1',
      onSettleFailed: (err) => failures.push(err),
    });
    const decision = await meter.admit(ATTEMPT);
    if (decision.outcome !== 'admitted') throw new Error('expected an admission');
    // Never throws: a settlement that escaped would replace the turn's own
    // outcome with a database error (§5.3 — the keeper settles within 90 s).
    await expect(decision.call.settle({ basis: 'no_record' })).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it('CRITICAL a refusal the task cannot fix is a value, not a fault, and it names the predicate', async () => {
    const { service } = reservations({
      admitCall: () =>
        Promise.resolve({ outcome: 'refused' as const, reason: 'did_not_fit', leftMicro: 0 }),
    });
    const meter = enforceCreditMeter({ reservations: service, reservationId: 'res-1' });
    const decision = await meter.admit(ATTEMPT);
    expect(decision).toEqual({ outcome: 'refused', reason: 'did_not_fit' });
  });

  it('CRITICAL a meter may LOWER a call\u2019s ceiling and never RAISE it, and the bound follows', async () => {
    // ⛔ THE DIRECTION IS THE WHOLE POINT. The ladder prices the ceiling the
    // adapter normally sends; an adapter asking for LESS must not be admitted —
    // and charged, when a torn stream settles `partial_usage` at the recorded
    // ceiling — for output it never asked for. Unreachable while the two
    // ceilings agree (pinned above), which is exactly why it needs an arm.
    const bounds: number[] = [];
    const { service } = reservations({
      admitCall: (input: { bound: { maxOutputTokens: number; boundMicro: number } }) => {
        bounds.push(input.bound.maxOutputTokens);
        return Promise.resolve({
          outcome: 'admitted' as const,
          callId: 'call-1',
          seq: 1,
          mode: 'enforce' as const,
          leftMicro: 1,
          overReservation: false,
        });
      },
    });
    const meter = enforceCreditMeter({ reservations: service, reservationId: 'res-1' });

    const modest = CALL_OUTPUT_FLOOR.plan;
    const decision = await meter.admit({ ...ATTEMPT, maxOutputTokens: modest });
    expect(decision.outcome).toBe('admitted');
    if (decision.outcome !== 'admitted') return;
    expect(decision.call.maxOutputTokens).toBe(modest);
    // The bound written to the call row is priced at the ceiling that will be
    // sent, not at the ladder's.
    expect(bounds).toEqual([modest]);
  });

  it('CRITICAL a call on a model the task did not reserve is refused (M10)', async () => {
    const { service } = reservations();
    const meter = enforceCreditMeter({ reservations: service, reservationId: 'res-1' });
    const decision = await meter.admit({ ...ATTEMPT, model: 'claude-haiku-4-5' });
    expect(decision).toEqual({ outcome: 'refused', reason: 'model' });
  });
});

/**
 * §4.6 — the basis a call settles under is chosen by HOW THE ATTEMPT ENDED, and
 * the provider has two ways of saying the same thing.
 *
 * ⛔ AN ERROR FRAME IS A STATUS, NOT A TORN STREAM. The provider answers a
 * rejected or overloaded request either with an HTTP status and a JSON problem
 * body, or with a 200 `text/event-stream` whose first frame is
 * `{"type":"error"}`. `ANTHROPIC_STREAM_ERROR_STATUS` maps the frame's own word
 * back to the status it stands for, and the adapter already decides RETRY policy
 * from that number — so the two deliveries are one event as far as this process
 * is concerned.
 *
 * §4.6 gives `no_record` to "sent=true and no usage AND NO STATUS: a transport
 * failure, a Stop before `message_start`, a crash, a lost lease", charged the
 * FULL BOUND (L5); and `provider_rejected` to a provider that rejected the
 * request rather than serving it, charged 0. An error frame that arrives before
 * `message_start` HAS a status and produced nothing, so it is the second — and
 * settling it as the first would charge a task the whole bound of a request the
 * provider refused, twice over on a 429 or a 5xx, which is retried.
 */
describe('the basis a call settles under is the one §4.6 names for how the attempt ended', () => {
  const encoder = new TextEncoder();

  function sse(frames: string[]): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  const errorFrame = (type: string): string =>
    `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type, message: 'upstream said no' },
    })}\n\n`;

  const messageStart = `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: { usage: { input_tokens: 120, output_tokens: 1 } },
  })}\n\n`;

  it('CRITICAL an error frame BEFORE message_start is the provider rejecting the request, charged nothing', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [
        sse([errorFrame('overloaded_error')]),
        sse([errorFrame('overloaded_error')]),
      ]),
      retryBackoffMs: 0,
    });

    await expect(
      decomposer.decompose(args({ creditMeter: recordingMeter(recorded) })),
    ).rejects.toThrow(/Anthropic API 529/);

    // The SAME failure delivered as an HTTP 503 settles `provider_rejected` on
    // both attempts (the 5xx-retry arm above). Delivered as a frame it must not
    // cost the task two full bounds for two requests that produced nothing.
    expect(recorded.log).toEqual([
      'admit',
      'sent',
      'fetch',
      'settle:provider_rejected',
      'admit',
      'sent',
      'fetch',
      'settle:provider_rejected',
    ]);
    expect(recorded.settlements.map((s) => s.basis)).toEqual([
      'provider_rejected',
      'provider_rejected',
    ]);
  });

  it('CRITICAL an error frame AFTER message_start is a call cut short, and still settles partial_usage', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [
        sse([messageStart, errorFrame('api_error')]),
        sse([messageStart, errorFrame('api_error')]),
      ]),
      retryBackoffMs: 0,
    });

    await expect(
      decomposer.decompose(args({ creditMeter: recordingMeter(recorded) })),
    ).rejects.toThrow(/Anthropic API 500/);

    // The negative half of the arm above: the provider DID start serving, said
    // what the input cost, and the output half is paid for at the ceiling the
    // call was admitted under (`callSettlement`). Charging 0 here would record a
    // paid call as free.
    expect(recorded.settlements.map((s) => s.basis)).toEqual(['partial_usage', 'partial_usage']);
    const [first] = recorded.settlements;
    expect(first?.basis === 'partial_usage' ? first.usage.uncachedInput : -1).toBe(120);
  });

  it('CRITICAL a non-2xx whose body cannot be read is still the provider rejecting the request', async () => {
    const recorded = recorder();
    // A rejection an intermediary answered with a page bigger than the ceiling
    // the adapter reads: the STATUS already said the request was refused, and
    // failing to read the explanation does not turn that into a call that was
    // served.
    const huge = new Response('x'.repeat(70 * 1024), { status: 503 });
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [huge]),
      retryBackoffMs: 0,
    });

    await expect(
      decomposer.decompose(args({ creditMeter: recordingMeter(recorded) })),
    ).rejects.toThrow(/too large|exceeded/i);

    expect(recorded.log).toEqual(['admit', 'sent', 'fetch', 'settle:provider_rejected']);
  });

  it('CRITICAL a stream that simply stops has no status, and keeps no_record', async () => {
    const recorded = recorder();
    const decomposer = new ClaudeAgentDecomposer({
      fetch: loggingFetch(recorded, [sse([]), sse([])]),
      retryBackoffMs: 0,
    });

    await expect(
      decomposer.decompose(args({ creditMeter: recordingMeter(recorded) })),
    ).rejects.toThrow(/ended before the message completed/);

    // A body that closed early is exactly §4.6's `no_record`: it went out, and
    // nothing came back to say what it cost. The full bound is the owner's rule
    // (L5), and the repair above must not reach it.
    expect(recorded.settlements.map((s) => s.basis)).toEqual(['no_record', 'no_record']);
  });
});
