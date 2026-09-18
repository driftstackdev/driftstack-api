// B2 — a real Stop, through AgentRuntime.
//
// What a customer who presses Stop is promised, each pinned here:
//   · the turn stops wherever it is — planning, between steps, mid-step, or
//     while reading the page back — and nothing new starts after it;
//   · a model call cut short still leaves its usage row (and its debit);
//   · the turn ends HONESTLY: a `stopped` result, one transcript entry saying
//     what ran, a `notice` sentence, and the session slot released so the next
//     message is accepted;
//   · a second API process that receives the Stop does not silently ignore it.

import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  abortedCallEvidence,
  stoppedTurnNotice,
  type AgentDecomposerUsageRecorder,
  type AgentTurnProgressEvent,
  type RunTurnResult,
} from '../../src/services/agent-runtime.js';
import {
  StubAgentExecutor,
  STOPPED_OUTCOME_UNKNOWN_REASON,
  type AgentExecutor,
  type ExecuteArgs,
  type IntentResult,
} from '../../src/services/agent-executor.js';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentDecomposer,
  AgentIntent,
  AnswerArgs,
  AnswerResult,
  DecomposeArgs,
  DecomposeResult,
  DecomposeUsage,
} from '../../src/services/agent-decomposer.js';
import {
  InMemoryAgentTurnStopChannel,
  type AgentTurnStopChannel,
} from '../../src/services/agent-turn-stop-channel.js';
import { classifyTurn } from '../../src/services/agent-turn-telemetry.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test' };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

const USAGE: DecomposeUsage = {
  decomposerKind: 'claude',
  anthropicInputTokens: 900,
  anthropicOutputTokens: 12,
  model: 'claude-sonnet-5',
};

/** What a provider-backed decomposer that honours the signal throws: the abort,
 *  carrying what the provider had counted when it could see it. */
class ProviderAbortError extends Error {
  constructor(
    readonly usage?: DecomposeUsage,
    readonly tokensConsumed?: number,
  ) {
    super('the request was aborted');
    this.name = 'AbortError';
  }
}

/** A model call that runs until the customer presses Stop, then ends the way a
 *  provider call honouring `signal` does. Records that the signal reached it. */
function untilStopped(
  signal: AbortSignal | undefined,
  evidence: { usage?: DecomposeUsage; tokensConsumed?: number } = {},
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return; // a caller that never passed one hangs, and the test times out
    const fire = (): void => {
      reject(new ProviderAbortError(evidence.usage, evidence.tokensConsumed));
    };
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
}

type DecomposeStep = (args: DecomposeArgs) => Promise<DecomposeResult>;

class ScriptedDecomposer implements AgentDecomposer {
  readonly calls: DecomposeArgs[] = [];
  readonly answerCalls: AnswerArgs[] = [];
  constructor(
    private readonly script: DecomposeStep[],
    answer?: (args: AnswerArgs) => Promise<AnswerResult>,
  ) {
    if (answer !== undefined) {
      this.answerFromObservation = (args: AnswerArgs): Promise<AnswerResult> => {
        this.answerCalls.push(args);
        return answer(args);
      };
    }
  }
  answerFromObservation?: (args: AnswerArgs) => Promise<AnswerResult>;
  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.calls.push(args);
    const step = this.script.shift();
    if (step === undefined) throw new Error('decomposer called more times than scripted');
    return step(args);
  }
}

const plan = (
  intents: AgentIntent[],
  extra: Partial<Extract<DecomposeResult, { kind: 'plan' }>> = {},
): DecomposeStep => {
  return () =>
    Promise.resolve({ kind: 'plan', intents, tokensConsumed: 50, usage: USAGE, ...extra });
};

function recorder(): {
  usageRecorder: AgentDecomposerUsageRecorder;
  rows: Array<Parameters<AgentDecomposerUsageRecorder['record']>[0]>;
} {
  const rows: Array<Parameters<AgentDecomposerUsageRecorder['record']>[0]> = [];
  return {
    rows,
    usageRecorder: {
      record: (row) => {
        rows.push(row);
        return Promise.resolve();
      },
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function setup(opts: {
  decomposer: AgentDecomposer;
  executor?: AgentExecutor;
  turnStopChannel?: AgentTurnStopChannel;
  turnStopPollMs?: number;
}) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-18T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const usage = recorder();
  const runtime = new AgentRuntime({
    decomposer: opts.decomposer,
    executor: opts.executor ?? new StubAgentExecutor(),
    sessions,
    archetype: 'iphone17_ios18_7_safari26_4',
    usageRecorder: usage.usageRecorder,
    ...(opts.turnStopChannel !== undefined ? { turnStopChannel: opts.turnStopChannel } : {}),
    ...(opts.turnStopPollMs !== undefined ? { turnStopPollMs: opts.turnStopPollMs } : {}),
  });
  return { runtime, sessions, id: seed.id, rows: usage.rows };
}

/** A dispatcher the test answers by hand, so a Stop can land mid-dispatch. */
function heldDispatcher(): {
  dispatcher: IntentDispatcher;
  sent: IntentDispatch[];
  release: (index: number) => void;
} {
  const sent: IntentDispatch[] = [];
  const resolvers: Array<(r: ParsedIntentResult) => void> = [];
  return {
    sent,
    dispatcher: {
      dispatch: (d) =>
        new Promise<ParsedIntentResult>((resolve) => {
          sent.push(d);
          resolvers.push(resolve);
        }),
    },
    release: (index) => {
      const d = sent[index];
      if (d === undefined) throw new Error(`nothing sent at ${String(index)}`);
      resolvers[index]?.({
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs: 1,
        outputData: d.intentName === 'navigate' ? { url: 'https://shop.test', status: 200 } : {},
      });
    },
  };
}

function stopped(result: RunTurnResult): Extract<RunTurnResult, { kind: 'stopped' }> {
  if (result.kind !== 'stopped') throw new Error(`expected a stopped turn, got ${result.kind}`);
  return result;
}

describe('AgentRuntime — Stop during planning', () => {
  it('CRITICAL the plan call is ENDED by the stop (the signal reached it), its usage row is kept as the turn’s charging row, and the turn ends `stopped` with nothing done', async () => {
    const decomposer = new ScriptedDecomposer([
      (a) => untilStopped(a.signal, { usage: USAGE, tokensConsumed: 37 }),
    ]);
    const { runtime, sessions, id, rows } = await setup({ decomposer });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'buy the blue one' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call to start');

    await expect(runtime.requestTurnStop(id)).resolves.toBe('stop_requested');
    const result = stopped(await turn);

    expect(decomposer.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.stoppedDuring).toBe('planning');
    expect(result.executor).toBeUndefined();
    expect(result.notice).toBe(
      'Stopped before any step ran, as you asked. Nothing was done on the page.',
    );
    // ⛔ The row is never skipped for a call that started, and as the turn's
    // first call it carries the turn's flat price (no "already posted" flag).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usage: USAGE, tokensConsumed: 37 });
    expect(rows[0]?.bundledFlatCostAlreadyPosted).toBeUndefined();
    // And the tokens the provider counted come off the chat's budget.
    const after = await sessions.get(id);
    expect(after?.tokenBudgetRemaining).toBe(100_000 - 37);
    // One agent entry saying so, after the customer's message.
    expect(after?.transcript.map((e) => e.role)).toEqual(['user', 'agent']);
    expect(after?.transcript[1]?.body).toMatch(/stopped by the customer before any step ran/);
    expect(after?.transcript[1]?.intents).toBeUndefined();
  });

  it('CRITICAL a call cut short with NOTHING observable still leaves a row — zero tokens, the session’s model — so start-and-stop is never free', async () => {
    const decomposer = new ScriptedDecomposer([(a) => untilStopped(a.signal)]);
    const { runtime, sessions, id, rows } = await setup({ decomposer });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call to start');
    await runtime.requestTurnStop(id);
    stopped(await turn);
    const session = await sessions.get(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokensConsumed: 0,
      usage: { decomposerKind: 'claude', model: session?.model },
    });
  });

  it('a plan that comes back after the stop (a planner that ignores the signal) is paid for and NEVER RUN', async () => {
    let finish: (r: DecomposeResult) => void = () => undefined;
    const decomposer = new ScriptedDecomposer([
      () =>
        new Promise<DecomposeResult>((resolve) => {
          finish = resolve;
        }),
    ]);
    const executed: ExecuteArgs[] = [];
    const executor: AgentExecutor = {
      execute: (a) => {
        executed.push(a);
        return Promise.resolve({ results: [], ok: true });
      },
    };
    const { runtime, id, rows } = await setup({ decomposer, executor });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call to start');
    await runtime.requestTurnStop(id);
    finish({ kind: 'plan', intents: [NAV, TAP], tokensConsumed: 50, usage: USAGE });
    const result = stopped(await turn);
    expect(executed).toHaveLength(0);
    expect(result.stoppedDuring).toBe('planning');
    expect(result.stepsPlanned).toBe(2);
    expect(rows).toHaveLength(1);
  });
});

describe('AgentRuntime — Stop during execution', () => {
  it('CRITICAL between steps: nothing after the stop is dispatched, the steps that ran are the record, and the notice counts them', async () => {
    const held = heldDispatcher();
    const decomposer = new ScriptedDecomposer([plan([NAV, TAP, SHOT])]);
    const executor = new ControlPlaneAgentExecutor(held.dispatcher, undefined, {
      // The look before a tap is off: this test holds each step's own dispatch
      // open by position (its Stop contract is pinned in
      // a-tap-looks-at-what-it-will-land-on-before-it-is-sent.test.ts).
      preTapLookTimeoutMs: 0,
      // No step is in flight when Stop lands here, so no grace timer should be
      // needed; one that never fires would hang the test if it were.
      sleep: () => new Promise<void>(() => undefined),
    });
    const { runtime, sessions, id } = await setup({ decomposer, executor });
    const progress: AgentTurnProgressEvent[] = [];
    const turn = runtime.runTurn({
      agentSessionId: id,
      userMessage: 'send the form',
      onProgress: (e) => progress.push(e),
    });
    await waitFor(() => held.sent.length === 1, 'the navigate to be sent');
    // The navigate's answer arrives, and in the same instant — before the
    // executor has moved on to the tap — the customer presses Stop.
    held.release(0);
    await expect(runtime.requestTurnStop(id)).resolves.toBe('stop_requested');
    const result = stopped(await turn);

    expect(held.sent.map((d) => d.intentName)).toEqual(['navigate']);
    expect(result.stoppedDuring).toBe('executing');
    expect(result.executor?.results.map((r) => r.kind)).toEqual(['success']);
    expect(result.notice).toBe(
      'Stopped after step 1 of 3, as you asked. The steps above are what ran; nothing after them was sent, and the task is not finished.',
    );
    // The stream's last word before the terminal frame is that same sentence.
    expect(progress.at(-1)).toEqual({ kind: 'notice', notice: result.notice });
    const entry = (await sessions.get(id))?.transcript.at(-1);
    expect(entry?.body).toMatch(/^✓ /);
    expect(entry?.body).toMatch(/stopped by the customer — nothing after the steps above was sent/);
    // Only the step that RAN — a recipe built from this turn cannot replay the rest.
    expect(entry?.intents).toEqual([NAV]);
  });

  it('CRITICAL a tap already in flight when Stop arrives is recorded with its REAL result, and nothing is sent after it', async () => {
    const held = heldDispatcher();
    const decomposer = new ScriptedDecomposer([plan([NAV, TAP, SHOT])]);
    const executor = new ControlPlaneAgentExecutor(held.dispatcher, undefined, {
      // The look before a tap is off: this test holds each step's own dispatch
      // open by position (its Stop contract is pinned in
      // a-tap-looks-at-what-it-will-land-on-before-it-is-sent.test.ts).
      preTapLookTimeoutMs: 0,
      // The grace timer never fires in this test: the tap answers first.
      sleep: () => new Promise<void>(() => undefined),
    });
    const { runtime, id } = await setup({ decomposer, executor });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'send the form' });
    await waitFor(() => held.sent.length === 1, 'the navigate');
    held.release(0);
    await waitFor(() => held.sent.length === 2, 'the tap to be on the wire');
    await runtime.requestTurnStop(id);
    held.release(1);
    const result = stopped(await turn);
    expect(result.executor?.results.map((r) => [r.intent.kind, r.kind])).toEqual([
      ['navigate', 'success'],
      ['interact', 'success'],
    ]);
    expect(held.sent).toHaveLength(2);
    expect(result.notice).toMatch(/^Stopped after step 2 of 3, as you asked\./);
  });

  it('a step whose outcome could not be confirmed is named as such in the notice — never "not done"', () => {
    const results: IntentResult[] = [
      { kind: 'success', intent: NAV, summary: 'ok' },
      {
        kind: 'failure',
        intent: TAP,
        reason: STOPPED_OUTCOME_UNKNOWN_REASON,
        diagnosis: { category: 'unknown', retryable: false },
      },
    ];
    expect(stoppedTurnNotice({ stoppedDuring: 'executing', results, stepsPlanned: 3 })).toBe(
      'Stopped during step 2 of 3, as you asked. That step was already running, and I could not confirm whether it happened — check the page before doing it again. Nothing after it was sent, and the task is not finished.',
    );
  });
});

describe('AgentRuntime — Stop in a looping turn', () => {
  it('CRITICAL a stop while the NEXT segment is being planned ends that call, keeps its row (flat price already posted), and the first segment’s steps stand', async () => {
    const decomposer = new ScriptedDecomposer([
      plan([NAV], { status: 'continue' }),
      (a) => untilStopped(a.signal, { usage: USAGE, tokensConsumed: 21 }),
    ]);
    const executor = new StubAgentExecutor();
    const { runtime, id, rows } = await setup({ decomposer, executor });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'find the price' });
    await waitFor(() => decomposer.calls.length === 2, 'the second segment’s plan call');
    await runtime.requestTurnStop(id);
    const result = stopped(await turn);
    expect(decomposer.calls[1]?.signal).toBe(decomposer.calls[0]?.signal);
    expect(result.stoppedDuring).toBe('planning');
    expect(result.executor?.results.map((r) => r.intent)).toEqual([NAV]);
    expect(rows.map((r) => r.bundledFlatCostAlreadyPosted)).toEqual([undefined, true]);
    expect(rows[1]).toMatchObject({ tokensConsumed: 21 });
  });

  it('CRITICAL a stop that lands after a segment’s last step prevents the NEXT look and the NEXT plan call', async () => {
    const decomposer = new ScriptedDecomposer([
      plan([NAV], { status: 'continue' }),
      // Only reachable if the loop went round again after the stop.
      (a) => untilStopped(a.signal),
    ]);
    const ref: { runtime?: AgentRuntime; id: string } = { id: '' };
    const looks: string[] = [];
    const stub = new StubAgentExecutor();
    const executor: AgentExecutor = {
      execute: async (a) => {
        const r = await stub.execute(a);
        await ref.runtime?.requestTurnStop(ref.id);
        return r;
      },
      observeDigest: (sid) => {
        looks.push(sid);
        return Promise.resolve('<page>');
      },
    };
    const { runtime, id } = await setup({ decomposer, executor });
    ref.runtime = runtime;
    ref.id = id;
    const result = stopped(await runtime.runTurn({ agentSessionId: id, userMessage: 'go on' }));
    expect(result.stoppedDuring).toBe('planning');
    expect(decomposer.calls).toHaveLength(1);
    expect(looks).toHaveLength(0);
    expect(result.notice).toMatch(/^Stopped after step 1, as you asked\./);
  });

  it('CRITICAL a stop that lands after the last step, when an answer was asked for, skips the read-back and says the question went unanswered', async () => {
    let answered = 0;
    const decomposer = new ScriptedDecomposer([plan([NAV, SHOT], { status: 'done' })], () => {
      answered += 1;
      return Promise.resolve({ answer: 'twelve pounds', tokensConsumed: 5 });
    });
    const ref: { runtime?: AgentRuntime; id: string } = { id: '' };
    let reads = 0;
    const stub = new StubAgentExecutor();
    const executor: AgentExecutor = {
      execute: async (a) => {
        const r = await stub.execute(a);
        await ref.runtime?.requestTurnStop(ref.id);
        return r;
      },
      observe: () => {
        reads += 1;
        return Promise.resolve('Price: £12');
      },
    };
    const { runtime, id } = await setup({ decomposer, executor });
    ref.runtime = runtime;
    ref.id = id;
    const result = stopped(
      await runtime.runTurn({
        agentSessionId: id,
        userMessage: 'what is the price?',
        byokApiKey: 'sk-ant-test-fake',
      }),
    );
    expect(result.stoppedDuring).toBe('reading_page');
    expect(reads).toBe(0);
    expect(answered).toBe(0);
    expect(result.notice).toMatch(/did not answer your question/);
  });

  it('a turn whose work was already finished is NOT reported stopped by a Stop that arrived as it finished', async () => {
    const decomposer = new ScriptedDecomposer([plan([NAV], { status: 'done' })]);
    const ref: { runtime?: AgentRuntime; id: string } = { id: '' };
    const stub = new StubAgentExecutor();
    const executor: AgentExecutor = {
      execute: async (a) => {
        const r = await stub.execute(a);
        // Stop lands after the last step has run and the planner said `done`.
        await ref.runtime?.requestTurnStop(ref.id);
        return r;
      },
    };
    const { runtime, id } = await setup({ decomposer, executor });
    ref.runtime = runtime;
    ref.id = id;
    const result = await runtime.runTurn({ agentSessionId: id, userMessage: 'open the shop' });
    expect(result.kind).toBe('plan-executed');
  });
});

describe('AgentRuntime — Stop during the read-back', () => {
  it('CRITICAL the answer call is ended, its row is kept (flat price already posted), and the turn says the question went unanswered', async () => {
    const decomposer = new ScriptedDecomposer([plan([NAV, SHOT])], (a) =>
      untilStopped(a.signal, { usage: USAGE, tokensConsumed: 9 }),
    );
    const stub = new StubAgentExecutor();
    const executor: AgentExecutor = {
      execute: (a) => stub.execute(a),
      observe: () => Promise.resolve('Price: £12'),
    };
    const { runtime, sessions, id, rows } = await setup({ decomposer, executor });
    const turn = runtime.runTurn({
      agentSessionId: id,
      userMessage: 'what is the price?',
      byokApiKey: 'sk-ant-test-fake',
    });
    await waitFor(() => decomposer.answerCalls.length === 1, 'the answer call');
    expect(decomposer.answerCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    await runtime.requestTurnStop(id);
    const result = stopped(await turn);
    expect(result.stoppedDuring).toBe('answering');
    expect(result.notice).toBe(
      'Stopped before reading the page back, as you asked. The steps above all ran, but I did not answer your question.',
    );
    expect(rows.map((r) => r.bundledFlatCostAlreadyPosted)).toEqual([undefined, true]);
    const transcript = (await sessions.get(id))?.transcript ?? [];
    // user + the plan entry (published before the read-back) + the stop line.
    expect(transcript).toHaveLength(3);
    expect(transcript[2]?.body).toMatch(/stopped by the customer before the page was read back/);
  });
});

describe('AgentRuntime — the stop request itself', () => {
  it('CRITICAL after a stop the session slot is RELEASED: the next message runs, it is not refused as busy', async () => {
    const decomposer = new ScriptedDecomposer([(a) => untilStopped(a.signal), plan([NAV])]);
    const { runtime, id } = await setup({ decomposer });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'first' });
    await waitFor(() => decomposer.calls.length === 1, 'the first plan call');
    await runtime.requestTurnStop(id);
    stopped(await turn);
    const next = await runtime.runTurn({ agentSessionId: id, userMessage: 'second' });
    expect(next.kind).toBe('plan-executed');
  });

  it('is idempotent while the turn is stopping, and says so once it has ended', async () => {
    const decomposer = new ScriptedDecomposer([(a) => untilStopped(a.signal)]);
    const { runtime, id } = await setup({ decomposer });
    await expect(runtime.requestTurnStop(id)).resolves.toBe('no_turn_running');
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call');
    await expect(runtime.requestTurnStop(id)).resolves.toBe('stop_requested');
    await expect(runtime.requestTurnStop(id)).resolves.toBe('stop_requested');
    stopped(await turn);
    await expect(runtime.requestTurnStop(id)).resolves.toBe('no_turn_running');
  });

  it('CRITICAL a stop on ANOTHER process reaches the turn through the shared store, and "nothing running" is true of the whole deployment', async () => {
    const channel = new InMemoryAgentTurnStopChannel();
    const decomposer = new ScriptedDecomposer([(a) => untilStopped(a.signal)]);
    const owner = await setup({ decomposer, turnStopChannel: channel, turnStopPollMs: 2 });
    // A second API process: its own runtime (its own in-memory registry), the same store.
    const other = new AgentRuntime({
      decomposer: new ScriptedDecomposer([]),
      executor: new StubAgentExecutor(),
      sessions: owner.sessions,
      archetype: 'iphone17_ios18_7_safari26_4',
      turnStopChannel: channel,
    });
    await expect(other.requestTurnStop(owner.id)).resolves.toBe('no_turn_running');
    const turn = owner.runtime.runTurn({ agentSessionId: owner.id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call');
    await expect(other.requestTurnStop(owner.id)).resolves.toBe('stop_requested');
    const result = stopped(await turn);
    expect(result.stoppedDuring).toBe('planning');
    // The claim is released with the turn.
    await expect(other.requestTurnStop(owner.id)).resolves.toBe('no_turn_running');
  });

  it('CRITICAL when this process does not hold the turn and the shared store cannot be asked, it THROWS — "could not find out" is never reported as "nothing running"', async () => {
    const broken: AgentTurnStopChannel = {
      claim: () => Promise.resolve(),
      release: () => Promise.resolve(),
      requestStop: () => Promise.reject(new Error('store down')),
      stopRequested: () => Promise.resolve(false),
    };
    const { runtime, id } = await setup({
      decomposer: new ScriptedDecomposer([]),
      turnStopChannel: broken,
    });
    await expect(runtime.requestTurnStop(id)).rejects.toThrow('store down');
  });

  it('a store that fails to take the claim costs cross-process Stop, never the turn — a stop on this process still works', async () => {
    const broken: AgentTurnStopChannel = {
      claim: () => Promise.reject(new Error('store down')),
      release: () => Promise.reject(new Error('store down')),
      requestStop: () => Promise.reject(new Error('store down')),
      stopRequested: () => Promise.reject(new Error('store down')),
    };
    const decomposer = new ScriptedDecomposer([(a) => untilStopped(a.signal)]);
    const { runtime, id } = await setup({ decomposer, turnStopChannel: broken, turnStopPollMs: 2 });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call');
    await expect(runtime.requestTurnStop(id)).resolves.toBe('stop_requested');
    stopped(await turn);
  });

  it('control changing hands while the turn stops still wins: nothing is published under the successor', async () => {
    const holder: { sessions?: InMemoryAgentSessionsRepo; id?: string } = {};
    const decomposer = new ScriptedDecomposer([
      async (a) => {
        try {
          return await untilStopped(a.signal);
        } finally {
          // A person takes over in the same instant the customer pressed Stop.
          if (holder.sessions !== undefined && holder.id !== undefined) {
            await holder.sessions.setMode(holder.id, 'manual', null);
          }
        }
      },
    ]);
    const fx = await setup({ decomposer });
    holder.sessions = fx.sessions;
    holder.id = fx.id;
    const turn = fx.runtime.runTurn({ agentSessionId: fx.id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call');
    await fx.runtime.requestTurnStop(fx.id);
    const result = await turn;
    expect(result.kind).toBe('ai-control-unavailable');
    expect((await fx.sessions.get(fx.id))?.transcript.map((e) => e.role)).toEqual(['user']);
  });
});

describe('the stopped turn, as telemetry and accounting read it', () => {
  it('telemetry files it as `stopped` by the customer, with no death reason — a choice, not a failure', async () => {
    const decomposer = new ScriptedDecomposer([(a) => untilStopped(a.signal)]);
    const { runtime, id } = await setup({ decomposer });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    await waitFor(() => decomposer.calls.length === 1, 'the plan call');
    await runtime.requestTurnStop(id);
    const result = await turn;
    expect(
      classifyTurn({ status: 200, body: {}, result, sawPlanning: true, sawAnswering: false }),
    ).toEqual({
      outcome: 'stopped',
      deathReason: 'none',
      diedStepIndex: null,
      diedStepKind: null,
      customerStopped: true,
    });
  });

  it('CRITICAL with no turn result handed over, a stopped BODY is still filed as stopped — never as a completion', () => {
    expect(
      classifyTurn({
        status: 200,
        body: { kind: 'stopped', ok: false },
        result: undefined,
        sawPlanning: true,
        sawAnswering: false,
      }),
    ).toEqual({
      outcome: 'stopped',
      deathReason: 'none',
      diedStepIndex: null,
      diedStepKind: null,
      customerStopped: true,
    });
  });

  it('reads the provider’s evidence defensively: a malformed block is replaced, never trusted', () => {
    expect(abortedCallEvidence({ usage: USAGE, tokensConsumed: 12.7 }, 'm')).toEqual({
      usage: USAGE,
      tokensConsumed: 12,
    });
    expect(abortedCallEvidence({ usage: { bogus: true }, tokensConsumed: -4 }, 'm')).toEqual({
      usage: { decomposerKind: 'claude', model: 'm' },
      tokensConsumed: 0,
    });
    expect(abortedCallEvidence('not even an object', undefined)).toEqual({
      usage: { decomposerKind: 'claude' },
      tokensConsumed: 0,
    });
  });
});

describe('AgentRuntime — round 2: the edges a Stop can land on', () => {
  it('CRITICAL a Stop pressed right after Send — before the turn has registered — still stops it: nothing is planned', async () => {
    const decomposer = new ScriptedDecomposer([plan([NAV])]);
    const { runtime, sessions, id } = await setup({ decomposer });
    // The route opens the window the moment it has admitted the message; the
    // runtime's own first read is held, so the turn has not taken its slot yet.
    const window = runtime.openTurnStopWindow(id);
    const realGet = sessions.get.bind(sessions);
    let releaseGet: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let firstRead = true;
    sessions.get = async (sid) => {
      if (firstRead) {
        firstRead = false;
        await held;
      }
      return realGet(sid);
    };
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'go', stopWindow: window });
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await expect(runtime.requestTurnStop(id)).resolves.toBe('stop_requested');
    releaseGet();
    const result = stopped(await turn);
    window.close();
    expect(result.stoppedDuring).toBe('planning');
    expect(result.notice).toBe(
      'Stopped before any step ran, as you asked. Nothing was done on the page.',
    );
    expect(decomposer.calls).toHaveLength(0);
    // And the session is free for the next message.
    await expect(runtime.requestTurnStop(id)).resolves.toBe('no_turn_running');
  });

  it('a closed window is forgotten: a Stop after the request ended says nothing is running', async () => {
    const { runtime, id } = await setup({ decomposer: new ScriptedDecomposer([]) });
    const window = runtime.openTurnStopWindow(id);
    window.close();
    await expect(runtime.requestTurnStop(id)).resolves.toBe('no_turn_running');
    expect(window.signal.aborted).toBe(false);
  });

  it('CRITICAL a Stop during the look BETWEEN segments starts no further plan call and writes no further usage row', async () => {
    const decomposer = new ScriptedDecomposer([
      plan([NAV], { status: 'continue' }),
      // Only reachable if the loop planned after the look was cut short.
      plan([TAP], { status: 'done' }),
    ]);
    const ref: { runtime?: AgentRuntime; id: string } = { id: '' };
    const stub = new StubAgentExecutor();
    let lookSignal: AbortSignal | undefined;
    const executor: AgentExecutor = {
      execute: (a) => stub.execute(a),
      // The look is what the customer was watching when they pressed Stop; it
      // ends when the stop reaches it, as the real one does.
      observeDigest: (_sid, _cont, signal) => {
        lookSignal = signal;
        return new Promise<string | null>((resolve) => {
          void ref.runtime?.requestTurnStop(ref.id);
          if (signal === undefined) return;
          if (signal.aborted) resolve('<page>');
          else signal.addEventListener('abort', () => resolve('<page>'), { once: true });
        });
      },
    };
    const { runtime, id, rows } = await setup({ decomposer, executor });
    ref.runtime = runtime;
    ref.id = id;
    const result = stopped(await runtime.runTurn({ agentSessionId: id, userMessage: 'go on' }));
    expect(lookSignal).toBeInstanceOf(AbortSignal);
    expect(result.stoppedDuring).toBe('planning');
    expect(decomposer.calls).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('CRITICAL a page read that FAILS while a Stop is pending writes no read-back usage row — no model call was cut short', async () => {
    const decomposer = new ScriptedDecomposer([plan([NAV, SHOT], { status: 'done' })], () =>
      Promise.resolve({ answer: 'never asked', tokensConsumed: 5, usage: USAGE }),
    );
    const ref: { runtime?: AgentRuntime; id: string } = { id: '' };
    const stub = new StubAgentExecutor();
    const executor: AgentExecutor = {
      execute: (a) => stub.execute(a),
      observe: async () => {
        await ref.runtime?.requestTurnStop(ref.id);
        throw new Error('the page read failed');
      },
    };
    const { runtime, id, rows } = await setup({ decomposer, executor });
    ref.runtime = runtime;
    ref.id = id;
    const result = stopped(
      await runtime.runTurn({
        agentSessionId: id,
        userMessage: 'what is the price?',
        byokApiKey: 'sk-ant-test-fake',
      }),
    );
    expect(result.stoppedDuring).toBe('reading_page');
    expect(decomposer.answerCalls).toHaveLength(0);
    // The plan call's row only.
    expect(rows).toHaveLength(1);
  });

  it('CRITICAL a Stop during the LAST step of a finished plan does not call the finished task unfinished', async () => {
    const decomposer = new ScriptedDecomposer([plan([NAV, TAP], { status: 'done' })]);
    const device = heldDispatcher();
    const executor = new ControlPlaneAgentExecutor(device.dispatcher, undefined, {
      // The look before a tap is off: this test holds each step's own dispatch
      // open by position (its Stop contract is pinned in
      // a-tap-looks-at-what-it-will-land-on-before-it-is-sent.test.ts).
      preTapLookTimeoutMs: 0,
      sleep: () => new Promise<void>(() => undefined),
    });
    const { runtime, sessions, id } = await setup({ decomposer, executor });
    const turn = runtime.runTurn({ agentSessionId: id, userMessage: 'buy it' });
    await waitFor(() => device.sent.length === 1, 'the navigate');
    device.release(0);
    await waitFor(() => device.sent.length === 2, 'the tap');
    await runtime.requestTurnStop(id);
    device.release(1);
    const result = await turn;
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.executor.ok).toBe(true);
    const transcript = (await sessions.get(id))?.transcript ?? [];
    expect(transcript.some((e) => /NOT finished/.test(e.body))).toBe(false);
  });

  it('a Stop that finds no local turn answers within the bound when the shared store hangs — it throws, and is never read as "nothing running"', async () => {
    const hung: AgentTurnStopChannel = {
      claim: () => Promise.resolve(),
      release: () => Promise.resolve(),
      requestStop: () => new Promise<boolean>(() => undefined),
      stopRequested: () => Promise.resolve(false),
    };
    const { runtime, id } = await setup({
      decomposer: new ScriptedDecomposer([]),
      turnStopChannel: hung,
    });
    const started = Date.now();
    await expect(runtime.requestTurnStop(id)).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('CRITICAL once a turn has answered, no process still sees it as running: the claim is released before the turn returns', async () => {
    const shared = new InMemoryAgentTurnStopChannel();
    // A store whose release takes a moment, as a real one does.
    const slowRelease: AgentTurnStopChannel = {
      claim: (s, t) => shared.claim(s, t),
      release: async (s, t) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        await shared.release(s, t);
      },
      requestStop: (s) => shared.requestStop(s),
      stopRequested: (s, t) => shared.stopRequested(s, t),
    };
    const decomposer = new ScriptedDecomposer([plan([NAV])]);
    const { runtime, id } = await setup({ decomposer, turnStopChannel: slowRelease });
    const result = await runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    expect(result.kind).toBe('plan-executed');
    await expect(shared.requestStop(id)).resolves.toBe(false);
  });

  it('a claim that lands AFTER its deadline is still released — it cannot outlive the turn', async () => {
    const shared = new InMemoryAgentTurnStopChannel();
    let landClaim: () => void = () => undefined;
    const lateClaim: AgentTurnStopChannel = {
      claim: (s, t) =>
        new Promise<void>((resolve) => {
          landClaim = () => {
            void shared.claim(s, t).then(resolve);
          };
        }),
      release: (s, t) => shared.release(s, t),
      requestStop: (s) => shared.requestStop(s),
      stopRequested: (s, t) => shared.stopRequested(s, t),
    };
    const decomposer = new ScriptedDecomposer([plan([NAV])]);
    const { runtime, id } = await setup({ decomposer, turnStopChannel: lateClaim });
    const result = await runtime.runTurn({ agentSessionId: id, userMessage: 'go' });
    expect(result.kind).toBe('plan-executed');
    // The claim lands now, after the turn has returned.
    landClaim();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await expect(shared.requestStop(id)).resolves.toBe(false);
  });
});
