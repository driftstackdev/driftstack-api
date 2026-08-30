// V-2161 GUI half — reopening a chat whose server session has CLOSED must carry
// that session's transcript into the fresh one, or the agent answers "I don't
// have a previous task on record in this session" (owner 2026-08-30) while the
// screen still shows the conversation.
//
// Leaving the AI view closes the server session on purpose (so a dispatched Mac
// is not stranded), which makes "closed" the ORDINARY case for a reopened chat —
// not an edge one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
const get = vi.fn();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: { agentSessions: { create, message, close, get } } }),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
}));

const { useAgentChat } = await import('../../src/lib/use-agent-chat');

const SESSION: AgentSession = {
  id: 'agt_new',
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
  model: 'claude-opus-5',
  pair_mode_state: null,
  created_at: '2026-08-30T00:00:00Z',
  updated_at: '2026-08-30T00:00:01Z',
};

const DONE: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [],
  results: [],
  ok: true,
};

const PRIOR_TURNS = [
  { id: 1, role: 'user' as const, body: 'book me a flight to Lisbon' },
  { id: 2, role: 'agent' as const, body: 'which dates?' },
];

/** The create body the hook sent, for the assertions below. */
function createArg(): Record<string, unknown> {
  const call = create.mock.calls[0];
  expect(call, 'create was called').not.toBeUndefined();
  return (call as [Record<string, unknown>])[0];
}

describe('a reopened chat continues its CLOSED session (V-2161)', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    get.mockReset();
    create.mockResolvedValue(SESSION);
    message.mockResolvedValue(DONE);
    // The ordinary case: the old session is gone, so adopt finds nothing live.
    get.mockRejectedValue(new Error('404'));
  });

  it('⛔ the next send names the closed session, so the new one inherits its transcript', async () => {
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      result.current.restore(PRIOR_TURNS, 'agt_old');
    });
    await act(async () => {
      await result.current.send('actually make it Porto');
    });

    expect(createArg().continue_from_agent_session_id).toBe('agt_old');
  });

  it('a second send REUSES the continued session — the history is carried exactly once', async () => {
    // ⚠️ The first version of this arm claimed to prove the one-shot CLEAR and did
    // not: deleting that clear left it green, because a second send never reaches
    // create() at all. The true, useful property is session REUSE — one create per
    // chat — which is what actually stops the carried transcript being seeded twice.
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      result.current.restore(PRIOR_TURNS, 'agt_old');
    });
    await act(async () => {
      await result.current.send('first');
    });
    await act(async () => {
      await result.current.send('second');
    });

    expect(create, 'one session per chat').toHaveBeenCalledTimes(1);
    expect(createArg().continue_from_agent_session_id).toBe('agt_old');
    expect(message, 'the second send goes to the SAME session').toHaveBeenCalledTimes(2);
  });

  it('a chat with no prior session sends no continue field at all', async () => {
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      result.current.restore(PRIOR_TURNS, null);
    });
    await act(async () => {
      await result.current.send('hello');
    });

    expect(createArg()).not.toHaveProperty('continue_from_agent_session_id');
  });

  it('New chat cannot resurrect the transcript of the chat being left', async () => {
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      result.current.restore(PRIOR_TURNS, 'agt_old');
    });
    // reset() is "New chat": it inherits nothing, including the pending source.
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.send('a brand new task');
    });

    expect(createArg()).not.toHaveProperty('continue_from_agent_session_id');
  });

  it('a still-LIVE session is adopted instead, and then nothing is continued from', async () => {
    // adopt() wins when the old session is still active: the hook already holds
    // that session, so forking it would create a second one against the same chat.
    get.mockResolvedValue({ ...SESSION, id: 'agt_old', status: 'active' });
    const { result } = renderHook(() => useAgentChat());

    act(() => {
      result.current.restore(PRIOR_TURNS, 'agt_old');
      result.current.adopt('agt_old');
    });
    // adopt() resolves through a promise chain; let it settle before sending, or
    // the send races the adoption and creates a session the adopt was about to
    // make unnecessary.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.send('carry on');
    });

    expect(create, 'an adopted live session needs no create').not.toHaveBeenCalled();
  });
});
