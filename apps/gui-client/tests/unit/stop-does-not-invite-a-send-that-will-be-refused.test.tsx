// P6 — Stop frees the composer, the server keeps running the turn, and the next
// Send hits a busy session and is refused. That refusal is 26% of every AI turn
// this product has ever served.
//
// ⛔ WHAT THIS FIXES AND WHAT IT DOES NOT. This is the CLIENT half: the stream
// stays attached, and the composer stops offering a Send it knows cannot land,
// saying "still finishing the previous task" instead. The turn itself is still
// running on the server — a true server-side cancel is a separate change.
// Calling this "Stop" and then refusing the customer's next message is the thing
// being corrected; the word "stopped" was making a promise the product does not
// keep, and the honest state is now on screen rather than only in a toast.
//
// The arm that matters is the LAST one: the flag must clear when the stopped
// turn's own request settles, and not on a timer. A timer would guess, and
// guessing early puts the customer back in front of the same refusal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
const CLIENT = { agentSessions: { create, message, close } };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: CLIENT }),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
}));

const { useAgentChat } = await import('../../src/lib/use-agent-chat');

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
  model: 'claude-opus-4-7',
  pair_mode_state: null,
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:01Z',
};

const NAV = { kind: 'navigate', url: 'https://example.com' } as const;
const DONE: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [NAV],
  results: [{ kind: 'success', intent: NAV, summary: 'ok' }],
  ok: true,
};

describe('P6 — Stop does not invite a Send that will be refused', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('after Stop, the composer says the previous task is still finishing', async () => {
    // A turn that never resolves is the exact case: the server is still driving
    // the browser, which is why the next Send would be refused.
    message.mockReturnValue(new Promise<AgentMessageResponse>(() => {}));
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      void result.current.send('go to example.com');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.sending).toBe(true);

    act(() => {
      result.current.cancel();
    });

    // The composer is released — Stop must always do that, it is why it exists.
    expect(result.current.sending).toBe(false);
    // ⛔ AND IT IS HONEST ABOUT WHY THE NEXT SEND CANNOT GO YET. Before this the
    // two were the same state, so the UI offered Send and the server refused it.
    expect(result.current.stoppedTurnStillRunning).toBe(true);
  });

  it('⛔ CLEARS WHEN THE STOPPED TURN ACTUALLY SETTLES — not on a timer that would guess', async () => {
    let settle: (r: AgentMessageResponse) => void = () => {};
    message.mockReturnValue(
      new Promise<AgentMessageResponse>((resolve) => {
        settle = resolve;
      }),
    );
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      void result.current.send('go to example.com');
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.stoppedTurnStillRunning).toBe(true);

    await act(async () => {
      settle(DONE);
      await Promise.resolve();
    });
    // The server finished; the session is free; the customer may send again.
    expect(result.current.stoppedTurnStillRunning).toBe(false);
  });

  it('a turn that ENDS in failure still releases the composer — the session is free either way', async () => {
    let fail: (e: Error) => void = () => {};
    message.mockReturnValue(
      new Promise<AgentMessageResponse>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      void result.current.send('go to example.com');
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.cancel();
    });

    await act(async () => {
      fail(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
    });
    // ⛔ A flag that only cleared on SUCCESS would strand the composer forever
    // on exactly the turns that went wrong.
    expect(result.current.stoppedTurnStillRunning).toBe(false);
  });

  it('a turn that is never stopped never raises the flag — this costs the ordinary path nothing', async () => {
    message.mockResolvedValue(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('go to example.com');
    });
    expect(result.current.stoppedTurnStillRunning).toBe(false);
    expect(result.current.sending).toBe(false);
  });

  it('Stop with nothing in flight is a no-op, not a composer that locks itself', () => {
    const { result } = renderHook(() => useAgentChat());
    act(() => {
      result.current.cancel();
    });
    expect(result.current.stoppedTurnStillRunning).toBe(false);
  });
});
