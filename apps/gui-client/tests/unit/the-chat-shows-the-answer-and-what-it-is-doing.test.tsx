// What the customer actually sees. Three fixes, one screen.
//
// B1 — "go to ifconfig.me and tell me the IP" rendered "✓ navigated · ✓ captured
// screenshot" and nothing else. The answer existed the whole time: computed,
// sanitised, billed, written to the transcript, and never once put on screen.
// It now leads the reply, with the steps beneath it as supporting detail.
//
// B2 — while a turn runs, the customer sees the phase, the whole plan, and which
// step is on. Before this there was a spinner and no information at all for the
// first 10 to 30 seconds.
//
// B6 — a turn that stopped partway shows what ran and why it stopped, instead of
// erasing both.
//
// ⛔ Each arm carries its own negative: a turn with NO answer must render exactly
// as it did before, a turn with no live plan must fall back to the old spinner,
// and a completed turn must not render the interrupted framing. Without those,
// an unconditional render would satisfy every positive arm here.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
  upsertChat: vi.fn<(chat: { id: string; model: string }, now: number) => Promise<unknown[]>>(),
}));

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        iterate: function* () {
          /* no profiles */
        },
      },
      agentSessions: { livekitToken: h.livekitToken, get: h.getSession },
    },
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
  };
  return { useSettings: () => stable };
});
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => Promise.resolve([]),
  upsertChat: h.upsertChat,
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
}));

const SESSION: AgentSession = {
  id: 'agt_live',
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
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

const NAV = { kind: 'navigate', url: 'https://ifconfig.me' } as const;
const SHOT = { kind: 'capture', capture: 'screenshot' } as const;

function planTurn(answer?: string): ChatTurn {
  const response = {
    kind: 'plan-executed',
    session: SESSION,
    intents: [NAV, SHOT],
    results: [
      { kind: 'success', intent: NAV, summary: 'navigated' },
      { kind: 'success', intent: SHOT, summary: 'captured screenshot' },
    ],
    ok: true,
    ...(answer !== undefined ? { answer } : {}),
  } as AgentMessageResponse;
  return { id: 2, role: 'agent', response };
}

let chatState: UseAgentChatResult;
vi.mock('../../src/lib/use-agent-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAgentChatModule>();
  return { ...actual, useAgentChat: () => chatState };
});

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

function baseChat(over: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: SESSION,
    sending: false,
    liveSteps: [],
    livePhase: null,
    livePlan: null,
    liveStepIndex: null,
    liveAnswer: null,
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    restoredHistoryCount: 0,
    restoredSessionId: null,
    adopting: false,
    adoptError: null,
    send: vi.fn(() => Promise.resolve(true)),
    lastSendKeptMessage: vi.fn(() => false),
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
    adopt: vi.fn(),
    cancel: vi.fn(),
    ...over,
  };
}

const USER_TURN: ChatTurn = { id: 1, role: 'user', text: 'go to ifconfig.me and tell me the IP' };

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  // The view polls the session lifecycle on mount; without an answer the poll
  // throws inside an effect and every arm fails for a reason unrelated to it.
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
});

describe('B5 — the conversation keeps its identity across a view switch', () => {
  it('writes ONE chat, not a fresh copy per round trip out of the view', async () => {
    // ⛔ The chat now outlives this view, but the view still unmounts on every
    // switch away — so `activeChatId`, `model` and `profileId` seeded by
    // `useState` here re-seeded themselves on the way back. The persist effect
    // then wrote the SAME conversation into the history rail a second time,
    // under a brand-new id and with the default model, and a third time on the
    // next trip. The provider owns them for exactly this reason.
    chatState = baseChat({ turns: [USER_TURN, planTurn()] });
    const shell = (visible: boolean): JSX.Element => (
      <AgentChatProvider>
        {visible ? <AgentChatView /> : <div data-testid="other-view" />}
      </AgentChatProvider>
    );
    const view = render(shell(true));
    await screen.findByText('Plan');
    const firstId = h.upsertChat.mock.calls.at(-1)?.[0].id;
    expect(firstId).toBeTruthy();

    // Away (the view unmounts — that IS the design) and back.
    view.rerender(shell(false));
    expect(screen.getByTestId('other-view')).toBeTruthy();
    view.rerender(shell(true));
    await screen.findByText('Plan');

    const ids = new Set(h.upsertChat.mock.calls.map((c) => c[0].id));
    expect(ids, 'one conversation must persist under one id').toEqual(new Set([firstId]));
    // …and under the picks it actually ran with, not the defaults.
    const models = new Set(h.upsertChat.mock.calls.map((c) => c[0].model));
    expect(models.size).toBe(1);
  });
});

describe('B1 — the answer is the reply', () => {
  it('renders the read-back answer above the step list', () => {
    chatState = baseChat({
      turns: [USER_TURN, planTurn('Your IP address is 203.0.113.7.')],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    const answer = screen.getByText('Your IP address is 203.0.113.7.');
    const heading = screen.getByText('Plan');
    // Above, not merely present: the answer is what was asked for, the plan is
    // the audit trail underneath it.
    expect(answer.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a turn with NO answer exactly as before', () => {
    chatState = baseChat({ turns: [USER_TURN, planTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.queryByText(/Your IP address/)).toBeNull();
  });

  it('does not tell the customer it could do nothing when it in fact answered', () => {
    // An answer with an empty step list is a real shape (the read-back ran, the
    // plan produced no renderable results). The "I couldn't turn that into
    // browser actions" copy would flatly contradict the answer beside it.
    const response = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [],
      results: [],
      ok: true,
      answer: 'Your IP address is 203.0.113.7.',
    } as AgentMessageResponse;
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Your IP address is 203.0.113.7.')).toBeTruthy();
    expect(screen.queryByText(/couldn’t turn that into browser actions/)).toBeNull();
  });
});

describe('B2 — the customer can see what it is doing', () => {
  it('shows the phase caption and the whole plan, marking the step that is running', () => {
    chatState = baseChat({
      turns: [USER_TURN],
      sending: true,
      livePhase: 'Starting the browser…',
      livePlan: { total: 2, labels: ['Opening ifconfig.me', 'Taking a screenshot'] },
      liveStepIndex: 0,
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    expect(screen.getByText(/Starting the browser…/)).toBeTruthy();
    const list = screen.getByTestId('live-plan');
    expect(list.textContent).toContain('Opening ifconfig.me');
    expect(list.textContent).toContain('Taking a screenshot');
    // Exactly one step is marked current, and it is the one the server named.
    const current = list.querySelectorAll('[data-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Opening ifconfig.me');
  });

  it('drops a planned step from the pending list once its result has landed', () => {
    chatState = baseChat({
      turns: [USER_TURN],
      sending: true,
      livePhase: 'Working on your request…',
      livePlan: { total: 2, labels: ['Opening ifconfig.me', 'Taking a screenshot'] },
      liveStepIndex: 1,
      liveSteps: [{ kind: 'success', intent: NAV, summary: 'navigated' }],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const list = screen.getByTestId('live-plan');
    // The finished step renders as a real result above, so leaving its label in
    // the pending list would show the same step twice.
    expect(list.textContent).not.toContain('Opening ifconfig.me');
    expect(list.textContent).toContain('Taking a screenshot');
  });

  it('renders the streamed answer before the turn has settled', () => {
    chatState = baseChat({
      turns: [USER_TURN],
      sending: true,
      livePhase: 'Writing your answer…',
      liveAnswer: 'Your IP address is 203.0.113.7.',
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByTestId('live-answer').textContent).toBe('Your IP address is 203.0.113.7.');
  });

  it('falls back to the old spinner against a server that streams no progress', () => {
    chatState = baseChat({ turns: [USER_TURN], sending: true });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Working on your request…')).toBeTruthy();
    expect(screen.queryByTestId('live-plan')).toBeNull();
  });
});

describe('B6 — an interrupted turn shows what ran', () => {
  it('renders the steps that ran and the reason it stopped', () => {
    chatState = baseChat({
      turns: [
        USER_TURN,
        {
          id: 2,
          role: 'agent',
          interrupted: {
            reason: 'This chat’s session ended while the turn was running.',
            steps: [{ kind: 'success', intent: NAV, summary: 'navigated' }],
          },
        },
      ],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Interrupted — these steps ran')).toBeTruthy();
    expect(screen.getByText('This chat’s session ended while the turn was running.')).toBeTruthy();
    // The customer's own message is still there — it used to be rolled back.
    expect(screen.getByText('go to ifconfig.me and tell me the IP')).toBeTruthy();
  });

  it('does not put the interrupted framing on a turn that completed', () => {
    chatState = baseChat({ turns: [USER_TURN, planTurn('Your IP address is 203.0.113.7.')] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.queryByText('Interrupted — these steps ran')).toBeNull();
  });
});
