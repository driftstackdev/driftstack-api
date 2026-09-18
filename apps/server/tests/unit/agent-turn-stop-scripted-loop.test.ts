// B2 — scripted, eval-style: a LOOPING turn stopped mid-loop, through the real
// AgentRuntime and the real ControlPlaneAgentExecutor.
//
// The planner is scripted (no provider, no key) and the device is a fake that
// answers dispatches and serves a page per step, so the whole loop runs for real:
// look → plan → act → look again. The customer presses Stop at the moment the
// second segment's tap has left for the device. What must hold is what a person
// watching the chat would check:
//   · the tap that was already on its way is reported with its real result;
//   · no third segment is planned and nothing after the tap is sent;
//   · the transcript's closing line tells the next planner the task is unfinished;
//   · the chat takes the next message, and that turn runs normally.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { STOP_IN_FLIGHT_GRACE_MS } from '../../src/services/agent-executor.js';
import type {
  AgentDecomposer,
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';
import { decodeWireData } from '../../src/services/harness-control-codec.js';

const PAGES = [
  '<html><body><h1>Shop</h1><a id="next" href="/p2">Next</a></body></html>',
  '<html><body><h1>Step 2</h1><button id="continue">Continue</button></body></html>',
  '<html><body><h1>Step 3</h1><button id="buy">Place order</button></body></html>',
];

/** The fake device: a page per navigation/tap, a hook on every dispatch. */
function fakeDevice(onDispatch: (d: IntentDispatch, n: number) => Promise<void> | void): {
  dispatcher: IntentDispatcher;
  log: string[];
} {
  const log: string[] = [];
  let page = 0;
  let n = 0;
  return {
    log,
    dispatcher: {
      dispatch: async (d): Promise<ParsedIntentResult> => {
        n += 1;
        const params = decodeWireData(d.inputParams) as Record<string, unknown>;
        log.push(d.intentName === 'click' ? `click ${String(params['value'])}` : d.intentName);
        await onDispatch(d, n);
        const base = { sessionId: d.sessionId, intentId: d.intentId, success: true, durationMs: 1 };
        if (d.intentName === 'get_page_source') {
          return { ...base, outputData: { source: PAGES[Math.min(page, PAGES.length - 1)] } };
        }
        if (d.intentName === 'navigate') {
          page = 0;
          return { ...base, outputData: { url: 'https://shop.test/', status: 200 } };
        }
        if (d.intentName === 'click') page += 1;
        return { ...base, outputData: {} };
      },
    },
  };
}

class ScriptedLoopPlanner implements AgentDecomposer {
  readonly calls: DecomposeArgs[] = [];
  constructor(private readonly segments: Array<Extract<DecomposeResult, { kind: 'plan' }>>) {}
  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.calls.push(args);
    const next = this.segments.shift();
    if (next === undefined) throw new Error('planned more segments than scripted');
    return Promise.resolve(next);
  }
}

const seg = (
  intents: AgentIntent[],
  status: 'continue' | 'done',
): Extract<DecomposeResult, { kind: 'plan' }> => ({
  kind: 'plan',
  intents,
  status,
  tokensConsumed: 10,
});

describe('scripted: a looping turn stopped mid-loop', () => {
  it('CRITICAL the in-flight tap is recorded, no third segment runs, the transcript says unfinished, and the next message is accepted', async () => {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-18T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const planner = new ScriptedLoopPlanner([
      seg([{ kind: 'navigate', url: 'https://shop.test/' }], 'continue'),
      seg([{ kind: 'interact', action: 'tap', selector: '#next' }], 'continue'),
      // Never reached: the customer stops the turn during the tap above.
      seg([{ kind: 'interact', action: 'tap', selector: '#buy' }], 'done'),
      // The customer's NEXT message.
      seg([{ kind: 'navigate', url: 'https://shop.test/' }], 'done'),
    ]);
    const ref: { runtime?: AgentRuntime } = {};
    let stopAnswer: string | undefined;
    const device = fakeDevice(async (d) => {
      // The second segment's tap is ON ITS WAY to the device: Stop now.
      if (d.intentName === 'click' && stopAnswer === undefined) {
        stopAnswer = await ref.runtime?.requestTurnStop(seed.id);
      }
    });
    const runtime = new AgentRuntime({
      decomposer: planner,
      executor: new ControlPlaneAgentExecutor(device.dispatcher, undefined, {
        // Backoffs are instant; the in-flight grace never runs out, so the tap's
        // own answer — not a race against a zero-length timer — decides its row.
        sleep: (ms) =>
          ms >= STOP_IN_FLIGHT_GRACE_MS ? new Promise<void>(() => undefined) : Promise.resolve(),
      }),
      sessions,
      archetype: 'iphone17_ios18_7_safari26_4',
    });
    ref.runtime = runtime;

    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'go through the shop to the order page',
    });

    expect(stopAnswer).toBe('stop_requested');
    expect(result.kind).toBe('stopped');
    if (result.kind !== 'stopped') throw new Error('narrow');
    // The tap came back done, so the segment finished; what Stop cut short was
    // the NEXT look and plan the `continue` status asked for.
    expect(result.stoppedDuring).toBe('planning');
    // The tap that was already on its way counts: it RAN, with its real result.
    expect(result.executor?.results.map((r) => [r.intent.kind, r.kind])).toEqual([
      ['navigate', 'success'],
      ['interact', 'success'],
    ]);
    expect(result.notice).toBe(
      'Stopped after step 2, as you asked. The steps above are what ran; nothing after them was sent, and the task is not finished.',
    );
    // Two planning calls — the third segment was never asked for — and on the
    // device: navigate, a look, the tap. Nothing after it.
    expect(planner.calls).toHaveLength(2);
    expect(device.log).toEqual(['navigate', 'get_page_source', 'click #next']);

    const transcript = (await sessions.get(seed.id))?.transcript ?? [];
    expect(transcript.map((e) => e.role)).toEqual(['user', 'agent']);
    expect(transcript[1]?.body).toMatch(/the task is NOT finished/);
    expect(transcript[1]?.intents).toEqual([
      { kind: 'navigate', url: 'https://shop.test/' },
      { kind: 'interact', action: 'tap', selector: '#next' },
    ]);

    // ⛔ THE NEXT SEND IS ACCEPTED — the 409 this work exists to end.
    const next = await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'start again' });
    expect(next.kind).toBe('plan-executed');
    // The next turn's planner was shown the stopped turn's record as history.
    const history = planner.calls.at(-1)?.history ?? [];
    expect(history.some((e) => /stopped by the customer/.test(e.body))).toBe(true);
  });
});
