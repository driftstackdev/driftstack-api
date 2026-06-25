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
