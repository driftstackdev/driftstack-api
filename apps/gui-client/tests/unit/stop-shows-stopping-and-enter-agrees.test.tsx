// B2 — what the chat view shows between Stop and the server ending the turn,
// and what it shows once the turn has ended.
//
// ⛔ ENTER AND THE BUTTON MUST AGREE. A previous round held the Send BUTTON and
// left ⏎ sending, and the composer's own placeholder tells the customer to press
// ⏎. So every "held" arm below presses Enter, not only reads the button.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';
import type * as ChatHistory from '../../src/lib/chat-history';

const h = vi.hoisted(() => ({
  listProxies: vi.fn<() => Promise<unknown[]>>(),
  listBindings: vi.fn<() => Promise<unknown[]>>(),
  useAgentChat: vi.fn<(opts: { profileId?: string; proxyId?: string }) => UseAgentChatResult>(),
  loadChats: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: h.listProxies,
  setProxyServerId: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/profile-bindings', () => ({ listBindings: h.listBindings }));
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(),
  updateProxy: vi.fn(),
}));
vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        iterate: function* () {
          yield { id: 'prof_x', name: 'Bank profile' };
        },
      },
      agentSessions: { livekitToken: () => Promise.resolve({ ws_url: '', room: '', token: '' }) },
    },
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
  };
  return { useSettings: () => stable };
});
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', async () => {
  // The REAL summariser, so the history-rail test below runs the switch that
  // has no arm for a stopped turn — the crash that test exists to catch.
  const actual = await vi.importActual<typeof ChatHistory>('../../src/lib/chat-history');
  return {
    loadChats: h.loadChats,
    upsertChat: () => Promise.resolve([]),
    deleteChat: () => Promise.resolve([]),
    deriveChatTitle: () => 'Chat',
    chatTurnCount: actual.chatTurnCount,
    summariseTurn: actual.summariseTurn,
  };
});

const send = vi.fn(() => Promise.resolve(true));
const cancel = vi.fn();

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

// COMPLETE UseAgentChatResult so this double adds nothing to the pinned
// tsconfig.test.json backlog.
function chatWith(state: {
  sending: boolean;
  stopping?: boolean;
  turns?: ChatTurn[];
  stoppedTurnStillRunning?: boolean;
  stopAgain?: () => void;
}): UseAgentChatResult {
  return {
    turns: state.turns ?? [],
    session: SESSION,
    sending: state.sending,
    liveSteps: [],
    livePhase: null,
    livePlan: null,
    liveStepIndex: null,
    liveAnswer: null,
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    send,
    lastSendKeptMessage: () => false,
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    cancel,
    ...(state.stopping !== undefined ? { stopping: state.stopping } : {}),
    stoppedTurnStillRunning: state.stoppedTurnStillRunning ?? false,
    ...(state.stopAgain !== undefined ? { stopAgain: state.stopAgain } : {}),
    restore: vi.fn(),
    adopt: vi.fn(),
    adopting: false,
    adoptError: null,
    restoredHistoryCount: 0,
    restoredSessionId: null,
  };
}

vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: h.useAgentChat }));

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

const PROMPT = /Describe a task in plain English/i;

beforeEach(() => {
  vi.clearAllMocks();
  h.listBindings.mockResolvedValue([]);
  h.listProxies.mockResolvedValue([]);
  h.loadChats.mockResolvedValue([]);
});

async function renderWith(state: Parameters<typeof chatWith>[0]) {
  h.useAgentChat.mockReturnValue(chatWith(state));
  render(<AgentChatView initialProfileId="prof_x" />, { wrapper: AgentChatProvider });
  await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
  await new Promise((r) => setTimeout(r, 0));
  const composer = screen.getByPlaceholderText(PROMPT);
  fireEvent.change(composer, { target: { value: 'the next task' } });
  return composer;
}

describe('B2 — the chat between Stop and the end of the turn', () => {
  it('while a turn runs, the button is Stop and pressing it asks the hook to stop', async () => {
    await renderWith({ sending: true, stopping: false });
    const button = screen.getByRole('button', { name: /^stop$/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL once pressed it says "Stopping…" — on the button and in the composer — and cannot be pressed again', async () => {
    await renderWith({ sending: true, stopping: true });
    const button = screen.getByRole('button', { name: 'Stopping…' });
    expect(button).toBeDisabled();
    expect(document.querySelector('[data-component="chat-stopping-notice"]')?.textContent).toBe(
      'Stopping…',
    );
  });

  // A REGRESSION PIN, not a B2 proof: while `sending` is true, submit() was
  // already refusing before B2. It stays so that "Stopping…" can never become a
  // state in which ⏎ sends. The B2 arm Enter must agree with is the one below.
  it('⛔ ENTER DOES NOT SEND while the turn is stopping, exactly as the button cannot — and the draft is kept', async () => {
    const composer = await renderWith({ sending: true, stopping: true });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(composer).toHaveValue('the next task');
  });

  it('⛔ THE VACUITY CONTROL: once the turn has ended, Enter and the button both send', async () => {
    const composer = await renderWith({ sending: false });
    expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('the next task');
    expect(document.querySelector('[data-component="chat-stopping-notice"]')).toBeNull();
  });

  it('CRITICAL after a Stop that could not be confirmed: Enter and Send are both held, and "Try stopping again" asks the hook to stop again', async () => {
    const stopAgain = vi.fn();
    const composer = await renderWith({ sending: false, stoppedTurnStillRunning: true, stopAgain });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try stopping again' }));
    expect(stopAgain).toHaveBeenCalledTimes(1);
  });

  it('"Try stopping again" says "Stopping…" and is held while that request is out', async () => {
    await renderWith({
      sending: false,
      stoppedTurnStillRunning: true,
      stopping: true,
      stopAgain: vi.fn(),
    });
    const again = document.querySelector('[data-component="chat-stop-again"]');
    expect(again?.textContent).toBe('Stopping…');
    expect(again).toBeDisabled();
  });

  it('no "Try stopping again" is offered when the hook has nothing to ask', async () => {
    await renderWith({ sending: false, stoppedTurnStillRunning: true });
    expect(document.querySelector('[data-component="chat-still-finishing-notice"]')).not.toBeNull();
    expect(document.querySelector('[data-component="chat-stop-again"]')).toBeNull();
  });

  it('CRITICAL a saved chat holding a stopped turn opens in the history rail without taking the view down', async () => {
    const nav = { kind: 'navigate', url: 'https://example.com' } as const;
    h.loadChats.mockResolvedValue([
      {
        id: 'chat_1',
        title: 'Chat',
        profileId: 'prof_x',
        model: 'claude-sonnet-5',
        createdAt: 1,
        updatedAt: 2,
        turns: [
          { id: 1, role: 'user', text: 'do the thing' },
          {
            id: 2,
            role: 'agent',
            response: {
              kind: 'stopped',
              session: SESSION,
              intents: [nav],
              results: [{ kind: 'success', intent: nav, summary: 'navigated' }],
              ok: false,
              notice: 'Stopped after step 1 of 3, as you asked.',
              stopped_during: 'executing',
            },
          },
        ],
      },
    ]);
    await renderWith({ sending: false });
    const show = await screen.findByRole('button', { name: 'Show what happened in Chat' });
    fireEvent.click(show);
    expect(
      await screen.findByText('stopped — 1 step ran: Stopped after step 1 of 3, as you asked.'),
    ).toBeInTheDocument();
  });

  it('CRITICAL a stopped turn shows the server’s sentence and ONLY the steps that ran', async () => {
    const nav = { kind: 'navigate', url: 'https://example.com' } as const;
    const response: AgentMessageResponse = {
      kind: 'stopped',
      session: SESSION,
      intents: [nav],
      results: [{ kind: 'success', intent: nav, summary: 'navigated to example.com' }],
      ok: false,
      notice: 'Stopped after step 1 of 3, as you asked.',
      stopped_during: 'executing',
    };
    await renderWith({
      sending: false,
      turns: [
        { id: 1, role: 'user', text: 'do the thing' },
        { id: 2, role: 'agent', response },
      ],
    });
    expect(screen.getByText('Stopped after step 1 of 3, as you asked.')).toBeInTheDocument();
    expect(screen.getByText(/steps that ran/i)).toBeInTheDocument();
    const block = document.querySelector('[data-component="stopped-turn"]');
    expect(block?.querySelectorAll('li')).toHaveLength(1);
    // Never the "can't be shown in this version" fallback.
    expect(screen.queryByText(/can’t be shown in this version/)).toBeNull();
  });
});
