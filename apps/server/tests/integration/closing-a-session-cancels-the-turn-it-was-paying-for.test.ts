// The reference says, under Message: "a takeover, handback, mode change, pause,
// or close cancels the turn even if the session later returns to the same mode".
//
// It was true only in the weak sense that nothing FURTHER was started. The model
// call already in flight ran to completion, was paid for, and its answer was
// thrown away — a customer who closes a session to cut a turn short kept paying
// for a plan nobody would ever read, and the close did not return until it came
// back. Only POST /stop ever aborted the turn's controller.
//
// Each arm below drives one of those actions over HTTP while a planning call is
// in flight, and asserts on the SIGNAL the planner was handed — the one thing
// that says the provider call was really cut short rather than merely ignored.
//
//   · close     — aborts the call AND waits, bounded, for the turn to wind down,
//                 so the message answers `stopped` (the shape the stop route
//                 produces) with its usage row, not a 409 about a closed session.
//   · takeover / handback / mode change — abort the call and do NOT wait: the
//                 person asking for control gets it at once, and the turn answers
//                 the 409 `ai_control_unavailable` it has always answered.
//   · pause     — has no customer route: a session is paused by the product when
//                 it meets a bot challenge, so there is nothing here to fix.
//
// NEGATIVE CONTROL, in the same file: a mode change that changes nothing (the
// idempotent no-op return) must leave a running turn alone.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
  DecomposeUsage,
} from '../../src/services/agent-decomposer.js';

let fixtures: TestAppFixture[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fx of fixtures) await fx.cleanup();
  fixtures = [];
});

const USAGE: DecomposeUsage = {
  decomposerKind: 'claude',
  anthropicInputTokens: 800,
  anthropicOutputTokens: 5,
  model: 'claude-sonnet-5',
};

/**
 * First call: hangs until the signal it was handed aborts, then ends the way a
 * provider call honouring an abort does, carrying what was counted. Every later
 * call: an immediate one-step plan. (The same stand-in the stop route's own test
 * uses, so the two measure the same thing.)
 */
class StoppablePlanner implements AgentDecomposer {
  calls = 0;
  signals: Array<AbortSignal | undefined> = [];
  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.calls += 1;
    this.signals.push(args.signal);
    if (this.calls > 1) {
      return Promise.resolve({
        kind: 'plan',
        intents: [{ kind: 'navigate', url: 'https://example.test/' }],
        tokensConsumed: 10,
      });
    }
    return new Promise<DecomposeResult>((_resolve, reject) => {
      const fire = (): void => {
        reject(Object.assign(new Error('aborted'), { usage: USAGE, tokensConsumed: 30 }));
      };
      if (args.signal === undefined) return;
      if (args.signal.aborted) fire();
      else args.signal.addEventListener('abort', fire, { once: true });
    });
  }
}

async function build(): Promise<{ fx: TestAppFixture; planner: StoppablePlanner }> {
  const planner = new StoppablePlanner();
  const fx = await buildTestApp({
    enableAgentRuntime: true,
    agentDecomposer: planner,
    captureAgentDecomposerUsage: true,
  });
  fixtures.push(fx);
  return { fx, planner };
}

const auth = (fx: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fx.plaintext}`,
});

async function createSession(fx: TestAppFixture, mode: 'ai' | 'pair' = 'ai'): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: auth(fx),
    payload: { mode },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const send = (fx: TestAppFixture, id: string) =>
  fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${id}/message`,
    headers: auth(fx),
    payload: { user_message: 'open example.test' },
  });

const closeSession = (fx: TestAppFixture, id: string) =>
  fx.app.inject({ method: 'DELETE', url: `/v1/agent-sessions/${id}`, headers: auth(fx) });

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('an action that cancels a turn cancels the model call it is paying for', () => {
  it('CRITICAL closing a session during a planning call aborts that call, and the turn ends as stopped with the usage it consumed', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: auth(fx),
      payload: { user_message: 'open example.test' },
    });
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');

    const closed = await closeSession(fx, id);
    expect(closed.statusCode).toBe(204);

    // The signal the turn's provider call was handed is what the close aborted.
    expect(planner.signals[0]?.aborted).toBe(true);

    const ended = await turn;
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({
      kind: 'stopped',
      ok: false,
      stopped_during: 'planning',
      usage: { decomposer_kind: 'claude', anthropic_input_tokens: 800 },
    });
    // Recorded exactly as the stop path records it: the aborted call's row.
    expect(fx.agentDecomposerUsageRecords).toHaveLength(1);
    expect(fx.agentDecomposerUsageRecords[0]).toMatchObject({
      agentSessionId: id,
      usage: USAGE,
      tokensConsumed: 30,
    });
    // And the session really is closed.
    const after = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: auth(fx),
    });
    expect(after.json<{ status: string }>().status).toBe('closed');
  });

  it('closing a session with nothing running is the same immediate success it was, and closing twice still is', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    expect((await closeSession(fx, id)).statusCode).toBe(204);
    expect((await closeSession(fx, id)).statusCode).toBe(204);
  });

  it('closes the session even when the stop could not be confirmed', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    vi.spyOn(AgentRuntime.prototype, 'requestTurnStop').mockRejectedValue(
      new Error('the shared turn store did not answer in time'),
    );
    const closed = await closeSession(fx, id);
    expect(closed.statusCode).toBe(204);
    const after = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: auth(fx),
    });
    expect(after.json<{ status: string }>().status).toBe('closed');
  });

  it('a takeover during a planning call aborts that call, and the turn answers that control changed', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx, 'pair');
    const turn = send(fx, id);
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: auth(fx),
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(200);
    expect(planner.signals[0]?.aborted).toBe(true);

    const ended = await turn;
    expect(ended.statusCode).toBe(409);
    expect(ended.json()).toMatchObject({ ai_control_unavailable: true });
  });

  it('a handback during a planning call aborts that call', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx, 'pair');
    const turn = send(fx, id);
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');
    // Control reaches the person some way other than this route — the live
    // view's own takeover grant — which is the only way a handback can find a
    // turn still in flight: a message is not admitted while a human is driving.
    const repo = fx.agentSessionsRepo!;
    await repo.setPairModeState(id, {
      kind: 'human-driving',
      clientId: 'cli_tab_a',
      sinceAt: new Date().toISOString(),
    });
    expect(planner.signals[0]?.aborted).toBe(false);

    const back = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: auth(fx),
      payload: { client_id: 'cli_tab_a' },
    });
    expect(back.statusCode).toBe(200);
    expect(planner.signals[0]?.aborted).toBe(true);
    expect((await turn).statusCode).toBe(409);
  });

  it('a mode change during a planning call aborts that call', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = send(fx, id);
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: auth(fx),
      payload: { mode: 'manual' },
    });
    expect(res.statusCode).toBe(200);
    expect(planner.signals[0]?.aborted).toBe(true);
    expect((await turn).statusCode).toBe(409);
  });

  it('NEGATIVE CONTROL a mode change that changes nothing leaves the running turn alone', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = send(fx, id);
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: auth(fx),
      payload: { mode: 'ai' },
    });
    expect(res.statusCode).toBe(200);
    expect(planner.signals[0]?.aborted).toBe(false);

    // The turn is still running, and ends only when it is really stopped.
    const stopped = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: auth(fx),
      payload: {},
    });
    expect(stopped.statusCode).toBe(202);
    expect((await turn).json<{ kind: string }>().kind).toBe('stopped');
  });
});
