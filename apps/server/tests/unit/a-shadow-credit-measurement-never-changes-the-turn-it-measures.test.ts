// S10/M3 — a shadow credit measurement never changes the turn it measures.
//
// Shadow exists to learn what credits WOULD have cost before anyone is charged
// in them. The whole value of that measurement is that the turn it measures is
// the turn that would have happened anyway — so the failure mode that matters is
// not "the measurement was wrong", it is "the measurement was visible".
//
// The visible ways a measurement could leak into a turn, all of them tested
// here against a reservations service that is BROKEN in the two ways a database
// breaks — throwing, and never answering:
//
//   · the request body or its `max_tokens` differs from the unmetered one
//   · the reply the customer gets differs
//   · the turn throws, or is refused, where it would have succeeded
//   · the turn waits an unbounded time on a database that never answers
//
// And the accounting rule that makes the exit criterion readable: the WHOLE
// per-attempt leg — plan, admit, mark sent, settle — is ONE unit, so one blink
// counts `ai_credits_shadow_lost` exactly ONCE and silences the rest of that
// attempt. Counting per call would report four losses for one event and the
// lost rate M3 asks to drive to zero could never be read.

import { describe, expect, it } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import {
  OpenAICompatibleAgentDecomposer,
  type ChatCompletionsTarget,
} from '../../src/services/agent-decomposer-openai-compatible.js';
import type { DecomposeArgs, DecomposeResult } from '../../src/services/agent-decomposer.js';
import {
  shadowCreditMeter,
  type AgentCreditReservations,
} from '../../src/services/agent-credit-meter.js';
import { CALL_OUTPUT_CEILING } from '../../src/services/credit-call-fit.js';

const KEY = 'sk-ant-test-fake-key';
/** Short enough that a hanging database is measured in milliseconds, not seconds. */
const DEADLINE_MS = 25;

function args(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open https://example.com and capture the page',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [
      { at: '2026-09-20T10:00:00.000Z', role: 'user', body: 'earlier question' },
      { at: '2026-09-20T10:00:05.000Z', role: 'agent', body: '✓ navigate' },
    ],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: KEY,
    ...overrides,
  };
}

function planResponse(): Response {
  return new Response(
    JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: 'plan',
            intents: [{ kind: 'navigate', url: 'https://example.com/' }],
          }),
        },
      ],
      usage: { input_tokens: 120, output_tokens: 80 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function capturingFetch(bodies: string[], replies: () => Response[]): typeof globalThis.fetch {
  const queue = replies();
  let n = 0;
  return (_url: unknown, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const reply = queue[n++];
    if (reply === undefined) throw new Error('ran out of replies');
    return Promise.resolve(reply);
  };
}

/** A reservations service every one of whose four statements throws. */
const THROWING: AgentCreditReservations = {
  planCall: () => Promise.reject(new Error('connection terminated unexpectedly')),
  admitCall: () => Promise.reject(new Error('connection terminated unexpectedly')),
  markSent: () => Promise.reject(new Error('connection terminated unexpectedly')),
  settleCall: () => Promise.reject(new Error('connection terminated unexpectedly')),
};

/** A reservations service that accepts every statement and never answers one. */
const HANGING: AgentCreditReservations = {
  planCall: () => new Promise(() => undefined),
  admitCall: () => new Promise(() => undefined),
  markSent: () => new Promise(() => undefined),
  settleCall: () => new Promise(() => undefined),
} as unknown as AgentCreditReservations;

/** A working one, so "measured" and "lost" can be told apart. */
function working(log: string[]): AgentCreditReservations {
  return {
    planCall: () => {
      log.push('planCall');
      return Promise.resolve({
        outcome: 'planned' as const,
        decision: {
          rung: 'ceiling' as const,
          maxOutputTokens: CALL_OUTPUT_CEILING.plan,
          bound: { inputBoundTokens: 3000, inputBoundMicro: 1_200_000, boundMicro: 9_392_000 },
        },
        model: 'claude-opus-4-7',
        roomMicro: 30_000_000,
        reservedMicro: 30_000_000,
        rates: {
          inputMicroPerToken: 200,
          outputMicroPerToken: 1_000,
          cacheReadMicroPerToken: 20,
          cacheWrite5mMicroPerToken: 250,
          cacheWrite1hMicroPerToken: 400,
        },
      });
    },
    admitCall: () => {
      log.push('admitCall');
      return Promise.resolve({
        outcome: 'admitted' as const,
        callId: 'call-1',
        seq: 1,
        mode: 'shadow' as const,
        leftMicro: 0,
        overReservation: true,
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
  };
}

/** The turn as it happens with no meter at all: the thing shadow must equal. */
async function unmetered(): Promise<{ bodies: string[]; result: DecomposeResult }> {
  const bodies: string[] = [];
  const decomposer = new ClaudeAgentDecomposer({
    fetch: capturingFetch(bodies, () => [planResponse()]),
  });
  return { bodies, result: await decomposer.decompose(args()) };
}

describe('a shadow credit measurement never changes the turn it measures', () => {
  it('CRITICAL with a reservations service that THROWS on every statement, the turn is identical and the loss is counted once', async () => {
    const baseline = await unmetered();
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const decomposer = new ClaudeAgentDecomposer({
      fetch: capturingFetch(bodies, () => [planResponse()]),
    });

    const result = await decomposer.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations: THROWING,
          reservationId: 'res-shadow',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );

    // The wire, byte for byte — the body, and therefore `max_tokens`, the system
    // block, the cache markers and every message.
    expect(bodies).toEqual(baseline.bodies);
    // The reply the customer gets.
    expect(result).toEqual(baseline.result);
    // ⛔ ONE loss for the attempt, not one per statement.
    expect(lost).toHaveLength(1);
  });

  it('CRITICAL with a reservations service that NEVER ANSWERS, the turn is identical and bounded', async () => {
    const baseline = await unmetered();
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const decomposer = new ClaudeAgentDecomposer({
      fetch: capturingFetch(bodies, () => [planResponse()]),
    });

    const startedAt = Date.now();
    const result = await decomposer.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations: HANGING,
          reservationId: 'res-shadow',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(bodies).toEqual(baseline.bodies);
    expect(result).toEqual(baseline.result);
    expect(lost).toHaveLength(1);
    // A hung database must not hang a turn: the wait is the deadline, once, not
    // once per statement and never unbounded.
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });

  it('CRITICAL each ATTEMPT counts its own single loss — a retry is a second attempt, not a second count of the first', async () => {
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const decomposer = new ClaudeAgentDecomposer({
      fetch: capturingFetch(bodies, () => [
        new Response('upstream error', { status: 503 }),
        planResponse(),
      ]),
      retryBackoffMs: 0,
    });

    await decomposer.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations: THROWING,
          reservationId: 'res-shadow',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );

    expect(bodies).toHaveLength(2);
    expect(lost).toHaveLength(2);
  });

  it('CRITICAL a model the pinned card never priced is nothing to measure, and counts NO loss', async () => {
    const baseline = await unmetered();
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const log: string[] = [];
    const reservations = {
      ...working(log),
      // A shadow task that reserved zero on a model with no card row. The
      // census must see the would-refuse reason it recorded at reserve; there is
      // no bound to plan, and nothing has gone wrong.
      planCall: () => {
        log.push('planCall');
        return Promise.resolve({ outcome: 'unavailable' as const, reason: 'model' as const });
      },
    } as unknown as AgentCreditReservations;
    const decomposer = new ClaudeAgentDecomposer({
      fetch: capturingFetch(bodies, () => [planResponse()]),
    });

    const result = await decomposer.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations,
          reservationId: 'res-shadow',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );

    expect(bodies).toEqual(baseline.bodies);
    expect(result).toEqual(baseline.result);
    // ⛔ NOTHING LOST. A loss here would put a permanent floor under the lost
    // rate for every own-key-only model in the picker, and M3 names a lost rate
    // of zero as a shadow exit criterion.
    expect(lost).toEqual([]);
    // And nothing beyond the plan was attempted: there was nothing to measure.
    expect(log).toEqual(['planCall']);
  });

  it('CRITICAL a working shadow leg measures all four statements and changes nothing', async () => {
    const baseline = await unmetered();
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const log: string[] = [];
    const decomposer = new ClaudeAgentDecomposer({
      fetch: capturingFetch(bodies, () => [planResponse()]),
    });

    const result = await decomposer.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations: working(log),
          reservationId: 'res-shadow',
          newCallId: () => 'call-1',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );

    expect(log).toEqual(['planCall', 'admitCall', 'markSent', 'settleCall']);
    expect(lost).toEqual([]);
    expect(bodies).toEqual(baseline.bodies);
    expect(result).toEqual(baseline.result);
  });

  it('CRITICAL a database that goes away MID-ATTEMPT loses that attempt once, and the request still goes out', async () => {
    // The interleaving the two broken-from-the-start services cannot reach: the
    // leg gets as far as a call row and THEN the database goes. `markSent` is
    // the one step whose answer the adapter branches on — false means "do not
    // send" — so a shadow leg that reported its own loss as that answer would
    // cancel a live request over a measurement, which is the M3 violation in its
    // sharpest form. It must answer true, end its own leg, and count once.
    const baseline = await unmetered();
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const log: string[] = [];
    const goesAway: AgentCreditReservations = {
      ...working(log),
      markSent: () => {
        log.push('markSent');
        return Promise.reject(new Error('terminating connection due to administrator command'));
      },
      settleCall: () => {
        log.push('settleCall');
        return Promise.reject(new Error('terminating connection due to administrator command'));
      },
    };
    const decomposer = new ClaudeAgentDecomposer({
      fetch: capturingFetch(bodies, () => [planResponse()]),
    });

    const result = await decomposer.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations: goesAway,
          reservationId: 'res-shadow',
          newCallId: () => 'call-1',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );

    // The request went out and the turn is the unmetered turn.
    expect(bodies).toEqual(baseline.bodies);
    expect(result).toEqual(baseline.result);
    // ONE loss for ONE blink, and the settlement is not attempted after it: the
    // leg is over, so a second count cannot be reached.
    expect(lost).toHaveLength(1);
    expect(log).toEqual(['planCall', 'admitCall', 'markSent']);
  });

  it('CRITICAL an adapter that cannot be metered sends exactly as it does today under a shadow meter, and counts nothing', async () => {
    const lost: unknown[] = [];
    const bodies: string[] = [];
    const reply = (): Response[] => [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: 'plan',
                  intents: [{ kind: 'navigate', url: 'https://example.com/' }],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ];
    const target: ChatCompletionsTarget = {
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
    };

    const withoutMeter: string[] = [];
    const plain = new OpenAICompatibleAgentDecomposer({
      target,
      apiKey: 'or-test-key',
      fetch: capturingFetch(withoutMeter, reply),
    });
    const plainResult = await plain.decompose(args());

    const metered = new OpenAICompatibleAgentDecomposer({
      target,
      apiKey: 'or-test-key',
      fetch: capturingFetch(bodies, reply),
    });
    const meteredResult = await metered.decompose(
      args({
        creditMeter: shadowCreditMeter({
          reservations: THROWING,
          reservationId: 'res-shadow',
          onShadowLost: (err) => lost.push(err),
          shadowDeadlineMs: DEADLINE_MS,
        }),
      }),
    );

    expect(bodies).toEqual(withoutMeter);
    expect(meteredResult).toEqual(plainResult);
    // ⛔ NOT EVEN A LOSS. Nothing was attempted, so nothing was lost; a loss here
    // would be a floor under the lost rate for every turn on this lane.
    expect(lost).toEqual([]);
  });
});
