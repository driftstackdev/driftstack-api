// (l) SOCKS5/chat audit — findings #12, #8, #17 (L4).
//
// #12 adopt()'s GET was `.catch(() => undefined)` — unconditional, though the
//     comment named a 404 as the ordinary case. On an offline blip / 5xx /
//     timeout the reattach fell through: `adopting` cleared, continueFromRef
//     still named the (possibly live) session, and the next send created a
//     session `continue_from` a live one — the 409 ("The item changed or is
//     busy") the N5 adopting gate was added to stop, reachable again.
// #8  Enter while adopting was a silent no-op; the only explanation was the
//     disabled Send's hover title.
// #17 After adopt() attached a live session, the restored halt's Approve/Deny
//     bar re-appeared (setRestoredHistoryCount(0) removed the guard) with
//     Approve a silent no-op (restore() had nulled lastUserMessage).
//
// Hook arms use the real hook with a stubbed client; view arms mock the hook.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
const get = vi.fn();
const h = vi.hoisted(() => ({
  useAgentChat: vi.fn<(opts: { profileId?: string; proxyId?: string }) => UseAgentChatResult>(),
  loadChats: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
  useAgentChatReal: null as null | ((opts?: object) => UseAgentChatResult),
}));

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      agentSessions: {
        create,
        message,
        close,
        get,
        livekitToken: () => Promise.resolve({ ws_url: '', room: '', token: '' }),
      },
      profiles: {
        iterate: function* () {
          yield { id: 'prof_x', name: 'Bank profile' };
        },
      },
    },
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
  };
  return { useSettings: () => stable };
});
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
  listBindings: () => Promise.resolve([]),
}));
vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  setProxyServerId: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/account-proxies', () => ({ createProxy: vi.fn(), updateProxy: vi.fn() }));
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => h.loadChats(),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
  chatTurnCount: (c: { turns: unknown[] }) => c.turns.length,
}));
// The VIEW arms mock the hook; the HOOK arms import the real one through
// `importActual` so both live in one file without two module graphs.
vi.mock('../../src/lib/use-agent-chat', async (importOriginal) => {
  const real = await importOriginal<typeof UseAgentChatModule>();
  h.useAgentChatReal = real.useAgentChat;
  return { ...real, useAgentChat: h.useAgentChat };
});

const realHook = await import('../../src/lib/use-agent-chat');
const { AgentChatView, REATTACHING_NOTICE, SEND_HELD_SUFFIX } =
  await import('../../src/views/AgentChatView');
const useAgentChat = (): UseAgentChatResult => {
  const fn = h.useAgentChatReal;
  if (fn === null) throw new Error('real hook not captured');
  return fn({});
};

const SESSION: AgentSession = {
  id: 'agt_old',
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
  stop_on_exit_ip_change: false,
  created_at: '2026-08-30T00:00:00Z',
  updated_at: '2026-08-30T00:00:01Z',
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
const PRIOR = [
  { id: 1, role: 'user' as const, text: 'place my order' },
  { id: 2, role: 'agent' as const, response: HALT },
];

/** Let adopt()'s promise chain (two attempts at most) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  create.mockReset();
  message.mockReset();
  close.mockReset();
  get.mockReset();
  create.mockResolvedValue({ ...SESSION, id: 'agt_new' });
  message.mockResolvedValue(DONE);
  close.mockResolvedValue(undefined);
  h.loadChats.mockResolvedValue([]);
});

describe('#12 — adopt() distinguishes 404 from every other failure', () => {
  it('CRITICAL a non-404 failure (twice) keeps `adopting` true and names it — the 409 path is never reached', async () => {
    get.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(get).toHaveBeenCalledTimes(2); // one retry, then give up
    expect(result.current.adopting).toBe(true);
    expect(result.current.adoptError).toBe(realHook.ADOPT_FAILED_NOTICE);
    expect(result.current.session).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('a bare network error (no status) is NOT a 404 — held too', async () => {
    get.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.adopting).toBe(true);
    expect(result.current.adoptError).toBe(realHook.ADOPT_FAILED_NOTICE);
    expect(realHook.isNotFoundError(new Error('404'))).toBe(false);
  });

  it('one blip then an active answer: the retry adopts the live session', async () => {
    get
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 502 }))
      .mockResolvedValueOnce(SESSION);
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.session?.id).toBe('agt_old');
    expect(result.current.adopting).toBe(false);
    expect(result.current.adoptError).toBeNull();
  });

  it('CONTROL — a 404 settles `adopting` false with no notice: the divider says the truth', async () => {
    get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(get).toHaveBeenCalledTimes(1); // a 404 is never retried
    expect(result.current.adopting).toBe(false);
    expect(result.current.adoptError).toBeNull();
    expect(result.current.restoredHistoryCount).toBe(2);
  });

  it('adopt() again (the retry) clears the notice and can succeed; a new chat clears it too', async () => {
    get.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.adoptError).not.toBeNull();
    get.mockResolvedValue(SESSION);
    act(() => {
      result.current.adopt('agt_old');
    });
    expect(result.current.adoptError).toBeNull();
    await settle();
    expect(result.current.session?.id).toBe('agt_old');
    expect(result.current.adopting).toBe(false);
    // And reset() (New chat) never carries a stale notice into the next chat.
    get.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.adopting).toBe(true);
    act(() => {
      result.current.reset();
    });
    expect(result.current.adopting).toBe(false);
    expect(result.current.adoptError).toBeNull();
  });
});

describe('#17 — after adopt(), the Approve/Deny bar reflects the LIVE session', () => {
  it('CRITICAL a restored halt on an adopted live session gates, and Approve re-sends the restored user message with the approval', async () => {
    get.mockResolvedValue(SESSION);
    message.mockResolvedValueOnce(DONE);
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
    });
    expect(result.current.pendingConfirmation).toBeNull(); // read-only restored chat
    act(() => {
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.session?.id).toBe('agt_old');
    expect(result.current.pendingConfirmation).not.toBeNull();
    await act(async () => {
      await result.current.approve();
    });
    // MUTATION: drop the lastUserMessage seed in adopt() → approve() returns
    // early → message never called → red.
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0]?.[0]).toBe('agt_old');
    expect(message.mock.calls[0]?.[1]).toBe('place my order');
    expect(message.mock.calls[0]?.[2]).toMatchObject({
      approveConsequentialActions: [{ category: 'purchase', matchedText: 'place order' }],
    });
    expect(result.current.pendingConfirmation).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('CONTROL — no restored user turn to re-send: the halt stays suppressed rather than showing a dead Approve', async () => {
    get.mockResolvedValue(SESSION);
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore([{ id: 2, role: 'agent' as const, response: HALT }], 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.session?.id).toBe('agt_old');
    expect(result.current.pendingConfirmation).toBeNull();
  });

  it('CONTROL — a fresh send after a restored (not adopted) chat still gates a NEW halt normally', async () => {
    get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    message.mockResolvedValueOnce(HALT);
    const { result } = renderHook(useAgentChat);
    act(() => {
      result.current.restore(PRIOR, 'agt_old');
      result.current.adopt('agt_old');
    });
    await settle();
    expect(result.current.pendingConfirmation).toBeNull();
    await act(async () => {
      await result.current.send('now do it');
    });
    expect(result.current.pendingConfirmation).not.toBeNull();
  });
});

const send = vi.fn(() => Promise.resolve(true));
const adopt = vi.fn();
function chatWith(over: Partial<UseAgentChatResult>): UseAgentChatResult {
  return {
    turns: [],
    session: null,
    sending: false,
    liveSteps: [],
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    send,
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    cancel: vi.fn(),
    restore: vi.fn(),
    adopt,
    adopting: true,
    adoptError: null,
    restoredHistoryCount: 0,
    restoredSessionId: null,
    ...over,
  };
}
const PROMPT = /Describe a task in plain English/i;

describe('#8 — while adopting, Enter shows the notice instead of a silent no-op', () => {
  beforeEach(() => {
    send.mockClear();
    adopt.mockClear();
  });

  it('CRITICAL the reattach is visible without hovering, and Enter names the held send', async () => {
    // A reopened chat has turns — the notice row lives in the transcript list.
    h.useAgentChat.mockReturnValue(chatWith({ turns: PRIOR }));
    render(<AgentChatView initialProfileId="prof_x" />);
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));
    // The notice row (same slot as "Starting a session…").
    expect(screen.getByRole('status', { name: REATTACHING_NOTICE })).toBeInTheDocument();
    const caption = document.querySelector('[data-component="chat-adopt-notice"]');
    expect(caption?.textContent).toBe(REATTACHING_NOTICE);
    expect(caption?.getAttribute('data-held')).toBe('false');
    fireEvent.change(screen.getByPlaceholderText(PROMPT), { target: { value: 'reopen and go' } });
    fireEvent.keyDown(screen.getByPlaceholderText(PROMPT), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    // MUTATION: restore the bare `chat.adopting` early return in submit() →
    // no held caption → red.
    expect(caption?.getAttribute('data-held')).toBe('true');
    expect(caption?.textContent).toBe(`${REATTACHING_NOTICE} ${SEND_HELD_SUFFIX}`);
    // The draft is kept for when the reattach settles.
    expect(screen.getByPlaceholderText(PROMPT)).toHaveValue('reopen and go');
  });

  it('CONTROL — not adopting: the ordinary "Enter to send" caption, no notice row', async () => {
    h.useAgentChat.mockReturnValue(chatWith({ adopting: false }));
    render(<AgentChatView initialProfileId="prof_x" />);
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    expect(document.querySelector('[data-component="chat-adopt-notice"]')).toBeNull();
    expect(screen.queryByRole('status', { name: REATTACHING_NOTICE })).toBeNull();
    expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeInTheDocument();
  });

  it('#12 — a failed reattach shows the notice with a retry that adopts the active chat’s session again; Send stays disabled', async () => {
    h.loadChats.mockResolvedValue([
      {
        id: 'chat_1',
        title: 'Chat',
        profileId: 'prof_x',
        model: 'claude-opus-5',
        turns: PRIOR,
        createdAt: 1,
        updatedAt: 2,
        sessionId: 'agt_old',
      },
    ]);
    h.useAgentChat.mockReturnValue(chatWith({ adoptError: realHook.ADOPT_FAILED_NOTICE }));
    render(<AgentChatView initialProfileId="prof_x" />);
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    // Open the stored chat (the rail row), which is what makes it the active one.
    const row = (await screen.findByText('Chat')).closest('button');
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLButtonElement);
    expect(adopt).toHaveBeenCalledWith('agt_old');
    adopt.mockClear();
    const caption = document.querySelector('[data-component="chat-adopt-notice"]');
    expect(caption?.textContent).toContain(realHook.ADOPT_FAILED_NOTICE);
    // No pulsing "reattaching" row for a reattach that already failed.
    expect(screen.queryByRole('status', { name: REATTACHING_NOTICE })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(PROMPT), { target: { value: 'go' } });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(adopt).toHaveBeenCalledWith('agt_old');
  });
});
