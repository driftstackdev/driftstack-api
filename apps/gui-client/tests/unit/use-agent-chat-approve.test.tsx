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

// Egress + profiles-hub parity: the hook writes/clears the local profile binding so
// the Profiles hub reflects an AI-driven profile as running. Mock the store so no
// Tauri runtime is needed and the calls are observable.
const markLaunched = vi.fn(() => Promise.resolve());
const clearProfileSession = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: (profileId: string, sessionId: string) => markLaunched(profileId, sessionId),
  clearSession: (profileId: string) => clearProfileSession(profileId),
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
      idempotencyKey: expect.any(String) as string,
      approveConsequentialActions: [{ category: 'purchase', matchedText: 'place order' }],
    });

    // Gate cleared after approve.
    expect(result.current.pendingConfirmation).toBeNull();
  });

  it('accumulates approvals across successive halts (a 2-consequential-action plan must not loop)', async () => {
    // The server re-decomposes on each message and reads approvals ONLY from that
    // message. If approve() sent just the latest approval, a plan that halts on
    // action A then action B would re-halt on A forever after B is approved. Each
    // approve must re-send ALL approvals gathered so far.
    const PAY_INTENT = { kind: 'interact', action: 'tap', value: 'Confirm payment' } as const;
    const HALT_B: AgentMessageResponse = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [PAY_INTENT],
      results: [
        {
          kind: 'confirmation_required',
          intent: PAY_INTENT,
          category: 'payment',
          matchedText: 'confirm payment',
        },
      ],
      ok: false,
    };
    message.mockResolvedValueOnce(HALT).mockResolvedValueOnce(HALT_B).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('place my order then pay');
    });
    expect(result.current.pendingConfirmation?.matchedText).toBe('place order');

    await act(async () => {
      await result.current.approve(); // approve action A → server halts on action B
    });
    expect(result.current.pendingConfirmation?.matchedText).toBe('confirm payment');

    await act(async () => {
      await result.current.approve(); // approve action B → completes
    });

    // The 3rd message carries BOTH approvals (accumulated), not just the latest.
    expect(message).toHaveBeenCalledTimes(3);
    expect(message.mock.calls[1]?.[2]).toEqual({
      idempotencyKey: expect.any(String) as string,
      approveConsequentialActions: [{ category: 'purchase', matchedText: 'place order' }],
    });
    expect(message.mock.calls[2]?.[2]).toEqual({
      idempotencyKey: expect.any(String) as string,
      approveConsequentialActions: [
        { category: 'purchase', matchedText: 'place order' },
        { category: 'payment', matchedText: 'confirm payment' },
      ],
    });
    expect(result.current.pendingConfirmation).toBeNull();
  });

  it('a fresh send() resets the accumulated approvals (a new task does not carry the last one)', async () => {
    message.mockResolvedValueOnce(HALT).mockResolvedValueOnce(DONE).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('place my order');
    });
    await act(async () => {
      await result.current.approve(); // accumulates the purchase approval
    });
    // A brand-new task — its message must NOT carry the previous approval.
    await act(async () => {
      await result.current.send('just take a screenshot');
    });
    expect(message.mock.calls[2]?.[2]).toEqual({
      idempotencyKey: expect.any(String) as string,
    });
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
    expect(message.mock.calls[0]?.[2]).toEqual({
      idempotencyKey: expect.any(String) as string,
    });
  });

  it('reuses one receipt key after an ambiguous transport failure, then rotates after success', async () => {
    message
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(DONE)
      .mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('submit once');
    });
    const firstKey = (message.mock.calls[0]?.[2] as { idempotencyKey: string }).idempotencyKey;

    await act(async () => {
      await result.current.send('submit once');
    });
    const retryKey = (message.mock.calls[1]?.[2] as { idempotencyKey: string }).idempotencyKey;
    expect(retryKey).toBe(firstKey);

    await act(async () => {
      await result.current.send('submit once');
    });
    const laterKey = (message.mock.calls[2]?.[2] as { idempotencyKey: string }).idempotencyKey;
    expect(laterKey).not.toBe(firstKey);
  });

  it('rotates the receipt immediately when the logical request body changes', async () => {
    message.mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('first task');
    });
    await act(async () => {
      await result.current.send('different task');
    });
    expect((message.mock.calls[0]?.[2] as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (message.mock.calls[1]?.[2] as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('does not expose an unknown agent-request exception', async () => {
    message.mockRejectedValueOnce(
      new Error('worker failed private-control.internal /Users/customer token=secret'),
    );
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('hello');
    });

    expect(result.current.error?.message).toBe('The agent request failed — try again.');
    expect(result.current.error?.message).not.toMatch(
      /private-control|\/Users|token=secret|worker/i,
    );
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

// Egress-leak fix — the AI session create must carry the resolved proxy_id so a
// session on a proxied profile exits through the configured proxy, not the
// operator default. The view resolves the id from the profile's local binding and
// threads it via the proxyId opt; the hook forwards it verbatim to create().
describe('useAgentChat egress proxy_id threading', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
    message.mockResolvedValue(DONE);
    markLaunched.mockClear();
    clearProfileSession.mockClear();
  });

  it('forwards proxy_id + profile_id on create when a proxied profile is attached', async () => {
    const { result } = renderHook(() =>
      useAgentChat({ profileId: 'prof_x', proxyId: 'apx_residential_1' }),
    );
    await act(async () => {
      await result.current.send('open the bank');
    });
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.proxy_id).toBe('apx_residential_1');
    expect(body.profile_id).toBe('prof_x');
    expect(body.mode).toBe('ai');
  });

  it('omits proxy_id entirely when no proxy is resolved (operator-default egress, unchanged)', async () => {
    const { result } = renderHook(() => useAgentChat({ profileId: 'prof_x' }));
    await act(async () => {
      await result.current.send('open the bank');
    });
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('proxy_id' in body).toBe(false);
    expect(body.profile_id).toBe('prof_x');
  });
});

// Profiles-hub parity — an AI session on a saved profile must mark that profile
// "running" (the same local binding the manual launch writes) so the Profiles hub
// shows it as busy with a Stop, and clear it when the session is closed/abandoned.
describe('useAgentChat profile binding (Profiles-hub running state)', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    close.mockReset();
    create.mockResolvedValue(SESSION);
    message.mockResolvedValue(DONE);
    close.mockResolvedValue(undefined);
    markLaunched.mockClear();
    clearProfileSession.mockClear();
  });

  it('markLaunched(profileId, sessionId) fires after the AI session is created', async () => {
    const { result } = renderHook(() => useAgentChat({ profileId: 'prof_x' }));
    await act(async () => {
      await result.current.send('do a thing');
    });
    expect(markLaunched).toHaveBeenCalledWith('prof_x', 'agt_1');
  });

  it('does NOT bind a stateless (temporary) session', async () => {
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('do a thing');
    });
    expect(markLaunched).not.toHaveBeenCalled();
  });

  it('clears the profile binding on reset (New chat returns the Profiles row to idle)', async () => {
    const { result } = renderHook(() => useAgentChat({ profileId: 'prof_x' }));
    await act(async () => {
      await result.current.send('do a thing');
    });
    expect(clearProfileSession).not.toHaveBeenCalled();
    act(() => {
      result.current.reset();
    });
    expect(clearProfileSession).toHaveBeenCalledWith('prof_x');
  });

  it('clears the profile binding on unmount (leaving the view frees the Profiles row)', async () => {
    const { result, unmount } = renderHook(() => useAgentChat({ profileId: 'prof_x' }));
    await act(async () => {
      await result.current.send('do a thing');
    });
    unmount();
    expect(clearProfileSession).toHaveBeenCalledWith('prof_x');
  });

  it('does NOT clear a binding when no live session ever started (no manual-launch binding stomp)', () => {
    const { unmount } = renderHook(() => useAgentChat({ profileId: 'prof_x' }));
    // Leaving the view before sending anything must not wipe a binding the
    // manual-launch path may own for this profile.
    unmount();
    expect(clearProfileSession).not.toHaveBeenCalled();
  });
});
