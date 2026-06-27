// useAgentChat approve() flow. Clicking Approve on the consequential-action
// gate re-sends the SAME user message with the approval echo so the executor
// re-plans + dispatches. That re-send must NOT append a second user bubble —
// the user clicked a button, they didn't retype the request — while it MUST
// forward approveConsequentialActions and clear the gate. Guards the duplicate-
// bubble regression + the load-bearing approval echo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: { agentSessions: { create, message, close } } }),
}));

const { useAgentChat } = await import('../../src/lib/use-agent-chat');

const SESSION: AgentSession = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-opus-4-7',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

const ORDER_INTENT = { kind: 'interact', action: 'tap', value: 'Place order' } as const;

const HALT: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [ORDER_INTENT],
  results: [
    {
      kind: 'confirmation_required',
      intent: ORDER_INTENT,
      category: 'purchase',
      matchedText: 'place order',
    },
  ],
  ok: false,
};

const DONE: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [ORDER_INTENT],
  results: [{ kind: 'success', intent: ORDER_INTENT, summary: 'ordered' }],
  ok: true,
};

describe('useAgentChat approve()', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('does not duplicate the user bubble on approve, forwards the echo, clears the gate', async () => {
    message.mockResolvedValueOnce(HALT).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('place my order');
    });
    expect(result.current.pendingConfirmation).not.toBeNull();
    expect(result.current.turns.filter((t) => t.role === 'user')).toHaveLength(1);

    await act(async () => {
      await result.current.approve();
    });

    // Still exactly ONE user bubble — the approve re-send must not echo it.
    const userTurns = result.current.turns.filter((t) => t.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.text).toBe('place my order');

    // Two agent turns: the halt + the approved execution.
    expect(result.current.turns.filter((t) => t.role === 'agent')).toHaveLength(2);

    // The approval echo was forwarded on the 2nd message call.
    expect(message).toHaveBeenCalledTimes(2);
    expect(message.mock.calls[1]?.[2]).toEqual({
      approveConsequentialActions: [{ category: 'purchase', matchedText: 'place order' }],
    });

    // Gate cleared after approve.
    expect(result.current.pendingConfirmation).toBeNull();
  });

  it('send() still appends a user bubble (default unchanged)', async () => {
    message.mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('hello');
    });
    expect(result.current.turns.filter((t) => t.role === 'user')).toHaveLength(1);
    expect(result.current.turns.filter((t) => t.role === 'agent')).toHaveLength(1);
    // No approvals on a plain send.
    expect(message.mock.calls[0]?.[2]).toEqual({});
  });
});

// P2 #9 — Stop on a HUNG AI turn (the message call never resolves) must remove the
// dangling user bubble NOW (the post() rollback only fires on resolve, which never
// happens for a hung turn), so it isn't left on screen AND isn't persisted to chat
// history as an unanswered "complete" turn.
describe('useAgentChat cancel() on a hung turn', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('removes the dangling user bubble when Stop is pressed on a never-resolving turn', async () => {
    // The message call hangs forever — the rollback in post() can never fire.
    message.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      void result.current.send('do something');
      await Promise.resolve();
    });
    // The optimistic user bubble is on screen, still sending.
    expect(result.current.turns.filter((t) => t.role === 'user')).toHaveLength(1);
    expect(result.current.sending).toBe(true);
    // The user hits Stop.
    act(() => result.current.cancel());
    // The orphan bubble is gone (not waiting for the never-resolving request), and
    // the composer is un-blocked.
    expect(result.current.turns.filter((t) => t.role === 'user')).toHaveLength(0);
    expect(result.current.turns).toHaveLength(0);
    expect(result.current.sending).toBe(false);
  });

  it('keeps earlier completed turns intact when Stop hits a hung FOLLOW-UP turn', async () => {
    // First turn completes; second turn hangs, then Stop.
    message.mockResolvedValueOnce(DONE).mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('first');
    });
    expect(result.current.turns).toHaveLength(2); // user + agent
    await act(async () => {
      void result.current.send('second (hangs)');
      await Promise.resolve();
    });
    expect(result.current.turns.filter((t) => t.role === 'user')).toHaveLength(2);
    act(() => result.current.cancel());
    // The hung second user bubble is removed; the first completed pair survives.
    const userTurns = result.current.turns.filter((t) => t.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.text).toBe('first');
    expect(result.current.turns).toHaveLength(2);
  });
});

describe('useAgentChat restore()', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    close.mockReset();
    create.mockResolvedValue(SESSION);
    close.mockResolvedValue(undefined);
  });

  it('loads a saved transcript, drops the live session, keeps new ids above the restored max', async () => {
    message.mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());
    const saved = [
      { id: 5, role: 'user' as const, text: 'earlier task' },
      { id: 6, role: 'agent' as const, response: DONE },
    ];
    act(() => {
      result.current.restore(saved);
    });
    expect(result.current.turns).toHaveLength(2);
    expect(result.current.turns[0]?.text).toBe('earlier task');
    expect(result.current.session).toBeNull();
    // The restored turns are flagged as history the (absent) live session won't
    // remember — drives the view's honest "continuing starts a new session" divider.
    expect(result.current.restoredHistoryCount).toBe(2);

    // Continuing a restored chat starts a fresh session + assigns ids above 6.
    await act(async () => {
      await result.current.send('next step');
    });
    const newUser = result.current.turns.find((t) => t.role === 'user' && t.text === 'next step');
    expect(newUser).toBeDefined();
    expect((newUser as { id: number }).id).toBeGreaterThan(6);
    expect(create).toHaveBeenCalledTimes(1);
    // A fresh live session now backs the chat → the restored-history marker clears.
    expect(result.current.restoredHistoryCount).toBe(0);
  });

  it('does NOT re-show the Approve/Deny gate for a restored chat that ended on a halt', () => {
    // The dead-prompt bug: reopening a chat whose last agent turn was a
    // consequential-action halt re-rendered a live-looking Approve/Deny bar where
    // Approve was permanently dead (restore cleared lastUserMessage). The gate must
    // stay suppressed for restored history while there's no live session.
    const { result } = renderHook(() => useAgentChat());
    act(() => {
      result.current.restore([
        { id: 1, role: 'user', text: 'place my order' },
        { id: 2, role: 'agent', response: HALT },
      ]);
    });
    expect(result.current.session).toBeNull();
    expect(result.current.restoredHistoryCount).toBe(2);
    // No live-looking confirmation on the read-only restored chat.
    expect(result.current.pendingConfirmation).toBeNull();
  });

  it('a NEW halt after continuing a restored chat still gates normally', async () => {
    message.mockResolvedValueOnce(HALT);
    const { result } = renderHook(() => useAgentChat());
    act(() => {
      result.current.restore([
        { id: 1, role: 'user', text: 'old' },
        { id: 2, role: 'agent', response: DONE },
      ]);
    });
    // Restored, no gate.
    expect(result.current.pendingConfirmation).toBeNull();
    // Continue → a fresh session + a NEW halt → the gate is live again.
    await act(async () => {
      await result.current.send('place my order');
    });
    expect(result.current.session).not.toBeNull();
    expect(result.current.pendingConfirmation).not.toBeNull();
  });
});

describe('useAgentChat session-leak close', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    close.mockReset();
    create.mockResolvedValue(SESSION);
    message.mockResolvedValue(DONE);
    close.mockResolvedValue(undefined);
  });

  it('reset() closes the prior server session (New chat must not leak it)', async () => {
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('do a thing');
    });
    expect(result.current.session?.id).toBe('agt_1');
    expect(close).not.toHaveBeenCalled();

    act(() => {
      result.current.reset();
    });
    expect(close).toHaveBeenCalledWith('agt_1');
    expect(result.current.session).toBeNull();
    expect(result.current.restoredHistoryCount).toBe(0);
  });

  it('Stop while the first message is in flight closes the just-created server session (no leak)', async () => {
    // create() resolves only after we Stop, so the gen-mismatch branch runs with a
    // `created` session that was never stored — it must be closed, not leaked.
    let resolveCreate: ((s: AgentSession) => void) | null = null;
    create.mockReset();
    create.mockImplementation(
      () =>
        new Promise<AgentSession>((res) => {
          resolveCreate = res;
        }),
    );
    close.mockReset();
    close.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAgentChat());

    // Kick off the first send (create() hangs, unresolved).
    let sendPromise: Promise<boolean> = Promise.resolve(false);
    act(() => {
      sendPromise = result.current.send('place my order');
    });
    // User hits Stop while create() is still in flight.
    act(() => {
      result.current.cancel();
    });
    // Now create() resolves — the gen mismatch fires and the session is closed.
    await act(async () => {
      resolveCreate?.({ ...SESSION, id: 'agt_orphan' });
      await sendPromise;
    });

    expect(close).toHaveBeenCalledWith('agt_orphan');
    // The abandoned session was never adopted as the chat's live session.
    expect(result.current.session).toBeNull();
  });

  it('restore() closes the prior server session before switching chats', async () => {
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('do a thing');
    });
    expect(result.current.session?.id).toBe('agt_1');

    act(() => {
      result.current.restore([{ id: 9, role: 'user', text: 'older' }]);
    });
    expect(close).toHaveBeenCalledWith('agt_1');
  });

  it('does NOT close when there is no live session yet (reset on an empty chat is a no-op)', () => {
    const { result } = renderHook(() => useAgentChat());
    act(() => {
      result.current.reset();
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the live session on unmount (leaving the AI view must not leak it)', async () => {
    const { result, unmount } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('do a thing');
    });
    expect(close).not.toHaveBeenCalled();
    unmount();
    expect(close).toHaveBeenCalledWith('agt_1');
  });
});
