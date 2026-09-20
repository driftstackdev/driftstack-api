// The first screen has a budget, and a gate card spends it.
//
// Spec §3.8: the idle hero is a label, a headline, one sentence, THREE BEATS
// and the four templates. When something stands between the customer and a
// working chat — no API key, or a preview deployment — a card goes ABOVE the
// hero and "takes the three beats' place, so the first screen never scrolls".
//
// The beats and the gate card answer the same question ("what is this, and what
// do I do next"), and the card's answer is the more urgent one. Showing both
// pushes the templates — the only thing on this screen that can be CLICKED —
// below the fold, which is exactly the defect the redesign started from: at the
// 960x600 minimum window the old empty state put 0 of 4 templates on screen.
//
// jsdom has no layout, so this measures the CAUSE (what is rendered) rather
// than the pixels; the geometry is checked by screenshot at 960x600.
//
// NEGATIVE CONTROL: drop `gated` from `<IdleHero>` in AgentChatView (or the
// `!gated` from the beats' condition in IdleHero.tsx) and the first arm reds
// with the three beats present beside the gate, while the connected CONTROL
// arm — which proves the beats exist at all — stays green.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentSession } from '@driftstack/sdk';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => {
  /** Flipped per arm: null is a customer who has not connected a key yet. */
  const settings: { apiKey: string | null } = { apiKey: 'sk-test' };
  return {
    livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
    getSession: vi.fn<(id: string) => Promise<unknown>>(),
    upsertChat: vi.fn<(chat: { id: string; model: string }, now: number) => Promise<unknown[]>>(),
    settings,
  };
});

vi.mock('../../src/lib/SettingsContext', () => {
  const client = {
    profiles: {
      iterate: function* () {
        /* no profiles */
      },
    },
    agentSessions: { livekitToken: h.livekitToken, get: h.getSession },
  };
  return {
    useSettings: () => ({
      client,
      settings: { apiKey: h.settings.apiKey, baseUrl: 'https://api.example.test' },
    }),
  };
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
  transcript_length: 0,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

let chatState: UseAgentChatResult;
vi.mock('../../src/lib/use-agent-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAgentChatModule>();
  return { ...actual, useAgentChat: () => chatState };
});

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

function idleChat(): UseAgentChatResult {
  return {
    turns: [],
    session: null,
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
    stoppedTurnStillRunning: false,
  };
}

/** The three beats, by the numbers that head them. */
function beatsOnScreen(): number {
  return document.querySelectorAll('.ai-beats li').length;
}

/** The four built-in templates, by the grid they sit in. */
function templatesOnScreen(): number {
  return document.querySelectorAll('.ai-tpl button').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.apiKey = 'sk-test';
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
  chatState = idleChat();
});

describe('the first screen spends its room on ONE answer at a time', () => {
  it('CONTROL — a connected customer gets the three beats and the four templates', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(beatsOnScreen()).toBe(3);
    expect(templatesOnScreen()).toBe(4);
    expect(screen.queryByText('Connect your API key to run automations')).toBeNull();
  });

  it('⛔ with no API key the gate card takes the beats’ place — the templates stay', () => {
    h.settings.apiKey = null;
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Connect your API key to run automations')).toBeTruthy();
    expect(beatsOnScreen(), 'the gate and the beats are both spending the first screen').toBe(0);
    expect(templatesOnScreen()).toBe(4);
  });

  it('the gate is still the app’s own one — role, data-component, copy and button unchanged', () => {
    h.settings.apiKey = null;
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    // agent-chat-save-recipe reads `getByRole('status')` with NO name in this
    // very state, so exactly one live region may exist here.
    const live = screen.getAllByRole('status');
    expect(live).toHaveLength(1);
    expect(live[0]?.getAttribute('data-component')).toBe('ai-api-key-gate');
    expect(screen.getByText(/You can explore templates and draft a task now\./)).toBeTruthy();
  });

  it('the headline and the promise survive the gate — it is a card above the hero, not a replacement', () => {
    h.settings.apiKey = null;
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Watch it happen.')).toBeTruthy();
    expect(screen.getByText(/runs them on a real iPhone you can watch/)).toBeTruthy();
  });
});
