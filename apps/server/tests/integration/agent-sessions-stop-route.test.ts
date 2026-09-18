// B2 — POST /v1/agent-sessions/:id/stop, through the real route and runtime.
//
// The route's contract, each arm driven over HTTP:
//   · the same caller who may send the turn may stop it (owner; no auth → 401;
//     another account → 404, in cross-account-agent-session-isolation.test.ts);
//   · it answers at once — 202 `stop_requested` while a turn runs, 200
//     `no_turn_running` when none does — and is idempotent;
//   · the turn ends on ITS OWN response, as `kind: 'stopped'`, on both the JSON
//     and the streaming lane, with the steps that ran and a notice;
//   · ⛔ the next message is accepted — no 409 after a stop;
//   · the aborted model call leaves a usage row, and telemetry files the turn as
//     stopped by the customer.

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
 * First call: runs until the stop reaches it through `signal`, then ends the
 * way a provider call honouring the signal does, carrying what was counted.
 * Every later call: an immediate one-step plan.
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

async function createSession(fx: TestAppFixture): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: auth(fx),
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const stop = (fx: TestAppFixture, id: string, payload: Record<string, unknown> = {}) =>
  fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${id}/stop`,
    headers: auth(fx),
    payload,
  });

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('POST /v1/agent-sessions/:id/stop', () => {
  it('CRITICAL stops a running JSON turn: 202 at once, the turn answers `stopped`, and the NEXT message is accepted (no 409)', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: auth(fx),
      payload: { user_message: 'open example.test' },
    });
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');

    const res = await stop(fx, id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'stop_requested', session_id: id });

    const ended = await turn;
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({
      kind: 'stopped',
      ok: false,
      intents: [],
      results: [],
      stopped_during: 'planning',
      notice: 'Stopped before any step ran, as you asked. Nothing was done on the page.',
      usage: { decomposer_kind: 'claude', anthropic_input_tokens: 800 },
    });
    // The signal the route's turn carried is what the stop aborted.
    expect(planner.signals[0]?.aborted).toBe(true);

    // ⛔ The slot is free: the customer's next Send runs.
    const next = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: auth(fx),
      payload: { user_message: 'try again' },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json<{ kind: string }>().kind).toBe('plan-executed');
  });

  it('CRITICAL on the streaming lane the terminal frame says stopped, and a notice frame with the same sentence comes before it', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { ...auth(fx), accept: 'text/event-stream' },
      payload: { user_message: 'open example.test' },
    });
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');
    expect((await stop(fx, id)).statusCode).toBe(202);

    const body = (await turn).body;
    const frames = body
      .split('\n\n')
      .filter((f) => f.startsWith('event: '))
      .map((f) => {
        const [eventLine, dataLine] = f.split('\n');
        return {
          event: eventLine?.slice('event: '.length),
          data: JSON.parse(dataLine?.slice('data: '.length) ?? 'null') as Record<string, unknown>,
        };
      });
    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('response');
    expect(terminal?.data.status).toBe(200);
    const result = terminal?.data.body as { kind: string; notice: string };
    expect(result.kind).toBe('stopped');
    const notice = frames.at(-2);
    expect(notice).toEqual({ event: 'notice', data: { notice: result.notice } });
  });

  it('is a success that says so when nothing is running, and is safe to repeat', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    for (let i = 0; i < 2; i += 1) {
      const res = await stop(fx, id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'no_turn_running', session_id: id });
    }
  });

  it('two stops at once both succeed, and the turn ends once', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: auth(fx),
      payload: { user_message: 'open example.test' },
    });
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');
    const [a, b] = await Promise.all([stop(fx, id), stop(fx, id)]);
    // Whichever lands first stops the turn (202). The other lands either while it
    // is still winding down (202 again) or after it has ended (200, nothing
    // running) — both are the idempotent success the route promises.
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toContain(202);
    expect(codes.every((c) => c === 200 || c === 202)).toBe(true);
    expect((await turn).json<{ kind: string }>().kind).toBe('stopped');
    expect((await stop(fx, id)).json()).toEqual({ status: 'no_turn_running', session_id: id });
  });

  it('the aborted call leaves its usage row, and telemetry files the turn as stopped by the customer', async () => {
    const { fx, planner } = await build();
    const id = await createSession(fx);
    const turn = fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: auth(fx),
      payload: { user_message: 'open example.test' },
    });
    await waitFor(() => planner.calls === 1, 'the plan call to be in flight');
    await stop(fx, id);
    await turn;
    expect(fx.agentDecomposerUsageRecords).toHaveLength(1);
    expect(fx.agentDecomposerUsageRecords[0]).toMatchObject({
      agentSessionId: id,
      usage: USAGE,
      tokensConsumed: 30,
    });
    await fx.agentTurnTelemetry.flush();
    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'stopped', customerStopped: true });
  });

  it('refuses an unauthenticated caller before it can learn anything', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for a session that does not exist', async () => {
    const { fx } = await build();
    const res = await stop(fx, 'agt_00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('refuses a body field it does not understand rather than ignoring it', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    const res = await stop(fx, id, { turn_id: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('with AI chat not activated, answers the documented 503 rather than a bare 404', async () => {
    const fx = await buildTestApp({});
    fixtures.push(fx);
    const res = await stop(fx, 'agt_x');
    expect(res.statusCode).toBe(503);
  });

  it.each<[string, { accept?: 'text/event-stream' }]>([
    ['JSON', {}],
    ['streaming', { accept: 'text/event-stream' }],
  ])(
    'CRITICAL (%s lane) a Stop pressed right after Send — while the message is still in its checks — stops the turn before anything is planned',
    async (_lane, extraHeaders) => {
      const { fx, planner } = await build();
      const id = await createSession(fx);
      const receipts = fx.agentTurnReceiptsRepo;
      if (receipts === undefined) throw new Error('receipts repo expected');
      // Hold the message in its idempotency reservation, which runs before the
      // runtime has taken the session's turn slot.
      const realReserve = receipts.reserve.bind(receipts);
      let releaseReserve: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseReserve = resolve;
      });
      let reserving = false;
      receipts.reserve = async (a) => {
        reserving = true;
        await held;
        return realReserve(a);
      };
      const turn = fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${id}/message`,
        headers: { ...auth(fx), ...extraHeaders, 'idempotency-key': 'stop-right-after-send' },
        payload: { user_message: 'open example.test' },
      });
      await waitFor(() => reserving, 'the message to reach its reservation');
      const res = await stop(fx, id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'stop_requested', session_id: id });
      releaseReserve();
      const ended = await turn;
      expect(ended.statusCode).toBe(200);
      // The JSON lane answers with the body; the streaming lane carries the same
      // body in its terminal `response` frame.
      const body: unknown =
        extraHeaders.accept === undefined
          ? ended.json()
          : (
              JSON.parse(
                ended.body
                  .split('\n\n')
                  .filter((f) => f.startsWith('event: response'))
                  .at(-1)
                  ?.split('\n')[1]
                  ?.slice('data: '.length) ?? 'null',
              ) as { body: unknown }
            ).body;
      expect(body).toMatchObject({ kind: 'stopped', stopped_during: 'planning' });
      expect(planner.calls).toBe(0);
      // And it is over: nothing is left running for a later Stop to find.
      expect((await stop(fx, id)).json()).toEqual({ status: 'no_turn_running', session_id: id });
    },
  );

  it('CRITICAL answers 503 — never "no turn running" — when it could not find out whether a turn is running', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    const spy = vi
      .spyOn(AgentRuntime.prototype, 'requestTurnStop')
      .mockRejectedValue(new Error('the shared turn store did not answer in time'));
    try {
      const res = await stop(fx, id);
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.json())).not.toMatch(/no_turn_running/);
    } finally {
      spy.mockRestore();
    }
  });

  it('the session’s own control key may stop its turn; a control key for ANOTHER session may not', async () => {
    const { fx } = await build();
    const id = await createSession(fx);
    const other = await createSession(fx);
    const mint = async (sid: string): Promise<string> => {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/agent-sessions/${sid}/gui-control-key`,
        headers: auth(fx),
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ gui_control_key: string }>().gui_control_key;
    };
    const own = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: { 'x-driftstack-gui-control-key': await mint(id) },
      payload: {},
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ status: 'no_turn_running', session_id: id });
    const foreign = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: { 'x-driftstack-gui-control-key': await mint(other) },
      payload: {},
    });
    // The key is bound to its own session: presented here it authenticates nothing.
    expect(foreign.statusCode).toBe(401);
  });
});
