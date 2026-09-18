// B2 — Stop reaches the server.
//
// Before this, Stop only stopped WAITING: the server kept driving the browser,
// and the chat refused the next Send until the old turn ended on its own. Now
// Stop asks the server to stop the turn, keeps the turn's own request attached
// so the steps that ran keep arriving, and frees the composer when the SERVER
// says the turn is over — its `stopped` response. Two bounds keep a failed Stop
// from locking the chat: the stop request is tried twice, and the chat stops
// waiting after STOP_CONFIRM_DEADLINE_MS either way, keeping what ran on screen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentIntentResult, AgentMessageResponse, AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
const stop = vi.fn();
const CLIENT = { agentSessions: { create, message, close, stop } };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: CLIENT }),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
}));

const {
  useAgentChat,
  STOP_CONFIRM_DEADLINE_MS,
  STOP_FAILED_REASON,
  STOP_UNCONFIRMED_REASON,
  STOP_RETRY_DELAY_MS,
  STOP_REASK_LIMIT,
} = await import('../../src/lib/use-agent-chat');

const SESSION: AgentSession = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  stop_on_exit_ip_change: false,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  pair_mode_state: null,
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:01Z',
};

const NAV = { kind: 'navigate', url: 'https://example.com' } as const;
const STEP: AgentIntentResult = { kind: 'success', intent: NAV, summary: 'navigated' };
const STOPPED: AgentMessageResponse = {
  kind: 'stopped',
  session: SESSION,
  intents: [NAV],
  results: [STEP],
  ok: false,
  notice: 'Stopped after step 1 of 3, as you asked.',
  stopped_during: 'executing',
};

type MessageOpts = { onStep?: (s: { index: number; result: AgentIntentResult }) => void };

/** A turn the test ends by hand, streaming one step first. */
function heldTurn(): {
  settle: (r: AgentMessageResponse) => void;
  fail: (e: unknown) => void;
  streamStep: () => void;
} {
  let settle: (r: AgentMessageResponse) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  let opts: MessageOpts | undefined;
  message.mockImplementation((_sid: string, _msg: string, o: MessageOpts) => {
    opts = o;
    return new Promise<AgentMessageResponse>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
  });
  return {
    settle: (r) => settle(r),
    fail: (e) => fail(e),
    streamStep: () => opts?.onStep?.({ index: 0, result: STEP }),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

async function startTurn() {
  const hook = renderHook(() => useAgentChat());
  act(() => {
    void hook.result.current.send('go to example.com');
  });
  await act(flush);
  return hook;
}

describe('B2 — Stop reaches the server', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    stop.mockReset();
    create.mockResolvedValue(SESSION);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CRITICAL Stop asks the SERVER to stop this session’s turn, shows "Stopping…", and keeps the composer held until the turn itself ends', async () => {
    const turn = heldTurn();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      turn.streamStep();
    });

    act(() => {
      result.current.cancel();
    });
    await act(flush);
    expect(stop).toHaveBeenCalledWith('agt_1');
    expect(result.current.stopping).toBe(true);
    // ⛔ Still attached: the 202 is not the end of the turn, and freeing the
    // composer on it would invite the Send the server refuses.
    expect(result.current.sending).toBe(true);
    expect(result.current.stoppedTurnStillRunning).toBe(false);
    expect(result.current.liveSteps).toEqual([STEP]);
  });

  it('CRITICAL the turn’s own `stopped` response frees the composer — the steps that ran stay in the chat, and the next Send goes out', async () => {
    const turn = heldTurn();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      turn.settle(STOPPED);
      await flush();
    });
    expect(result.current.sending).toBe(false);
    expect(result.current.stopping).toBe(false);
    expect(result.current.stoppedTurnStillRunning).toBe(false);
    // The customer's message and the stopped turn, with what ran.
    expect(result.current.turns.map((t) => t.role)).toEqual(['user', 'agent']);
    expect(result.current.turns[1]?.response).toEqual(STOPPED);

    // ⛔ No refusal after a stop: the next message is sent.
    message.mockResolvedValue({ ...STOPPED, kind: 'plan-executed', ok: true, results: [STEP] });
    let ok = false;
    await act(async () => {
      ok = await result.current.send('try again');
    });
    expect(ok).toBe(true);
    expect(message).toHaveBeenCalledTimes(2);
  });

  it('pressing Stop twice sends one stop request', async () => {
    heldTurn();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
      result.current.cancel();
    });
    await act(flush);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('one failed stop request is retried — a pause later, not at once — before anything changes on screen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    heldTurn();
    stop
      .mockRejectedValueOnce(new Error('offline blip'))
      .mockResolvedValueOnce({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(flush);
    // Retrying at once mostly fails the same way twice.
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(STOP_RETRY_DELAY_MS - 1);
      await flush();
    });
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await flush();
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(result.current.stopping).toBe(true);
    expect(result.current.sending).toBe(true);
  });

  it(`CRITICAL "no turn running" while our message is still unanswered is asked again, a pause apart, at most ${String(STOP_REASK_LIMIT)} more times`, async () => {
    // What a server that has not reached this chat's turn yet answers — a
    // second API process, while the message is still in its checks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    heldTurn();
    stop.mockResolvedValue({ status: 'no_turn_running', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(flush);
    expect(stop).toHaveBeenCalledTimes(1);
    for (let i = 0; i < STOP_REASK_LIMIT + 2; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(STOP_RETRY_DELAY_MS);
        await flush();
      });
    }
    expect(stop).toHaveBeenCalledTimes(1 + STOP_REASK_LIMIT);
    // Still waiting on the turn's own answer; the deadline bounds the rest.
    expect(result.current.stopping).toBe(true);
    expect(result.current.sending).toBe(true);
  });

  it('a re-ask that finds the turn stops re-asking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    heldTurn();
    stop
      .mockResolvedValueOnce({ status: 'no_turn_running', session_id: 'agt_1' })
      .mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(flush);
    for (let i = 0; i < STOP_REASK_LIMIT + 2; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(STOP_RETRY_DELAY_MS);
        await flush();
      });
    }
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('no re-ask fires once the turn has answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = heldTurn();
    stop.mockResolvedValue({ status: 'no_turn_running', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(flush);
    await act(async () => {
      turn.settle(STOPPED);
      await flush();
    });
    await act(async () => {
      vi.advanceTimersByTime(STOP_RETRY_DELAY_MS * (STOP_REASK_LIMIT + 2));
      await flush();
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL a stop request that FAILS does not lock the composer: the chat stops waiting, keeps what ran with a sentence saying why, and holds Send until the old turn settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = heldTurn();
    stop.mockRejectedValue(new Error('offline'));
    const { result } = await startTurn();
    act(() => {
      turn.streamStep();
    });
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await flush();
      vi.advanceTimersByTime(STOP_RETRY_DELAY_MS);
      await flush();
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(result.current.sending).toBe(false);
    expect(result.current.stopping).toBe(false);
    expect(result.current.stoppedTurnStillRunning).toBe(true);
    expect(result.current.turns.map((t) => t.role)).toEqual(['user', 'agent']);
    expect(result.current.turns[1]?.interrupted).toEqual({
      reason: STOP_FAILED_REASON,
      steps: [STEP],
    });

    // ⛔ Not the last chance: the customer can ask the server again.
    expect(result.current.stopAgain).toBeTypeOf('function');
    stop.mockReset();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    act(() => {
      result.current.stopAgain?.();
    });
    expect(result.current.stopping).toBe(true);
    await act(flush);
    expect(stop).toHaveBeenCalledWith('agt_1');
    expect(result.current.stopping).toBe(false);
    // Asking again does not free Send: only the old turn settling does.
    expect(result.current.stoppedTurnStillRunning).toBe(true);

    // The detached request settling later changes nothing on screen — the
    // message it belongs to is not rolled back — and releases Send.
    await act(async () => {
      turn.settle(STOPPED);
      await flush();
    });
    expect(result.current.turns.map((t) => t.role)).toEqual(['user', 'agent']);
    expect(result.current.stoppedTurnStillRunning).toBe(false);
    expect(result.current.stopAgain).toBeUndefined();
  });

  it('there is no second Stop to offer while the first is still being waited for', async () => {
    heldTurn();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    expect(result.current.stopAgain).toBeUndefined();
    act(() => {
      result.current.cancel();
    });
    await act(flush);
    expect(result.current.stopAgain).toBeUndefined();
  });

  it(`CRITICAL THE BOUND: a stop the server never confirms stops being waited for after ${String(STOP_CONFIRM_DEADLINE_MS)}ms`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    heldTurn();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(flush);
    act(() => {
      vi.advanceTimersByTime(STOP_CONFIRM_DEADLINE_MS - 1);
    });
    expect(result.current.stopping).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.sending).toBe(false);
    expect(result.current.stopping).toBe(false);
    expect(result.current.stoppedTurnStillRunning).toBe(true);
    expect(result.current.turns[1]?.interrupted?.reason).toBe(STOP_UNCONFIRMED_REASON);
  });

  it('the bound never fires for a turn that ended in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = heldTurn();
    stop.mockResolvedValue({ status: 'stop_requested', session_id: 'agt_1' });
    const { result } = await startTurn();
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      turn.settle(STOPPED);
      await flush();
    });
    act(() => {
      vi.advanceTimersByTime(STOP_CONFIRM_DEADLINE_MS * 2);
    });
    expect(result.current.turns.map((t) => t.role)).toEqual(['user', 'agent']);
    expect(result.current.turns[1]?.response?.kind).toBe('stopped');
    expect(result.current.stoppedTurnStillRunning).toBe(false);
  });
});
