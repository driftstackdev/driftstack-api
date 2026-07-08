// finding #3 — the Live view holds a ONE-SHOT LiveKit token: it only re-fetches on
// a sessionId/retry change and never reacts to the agent session ENDING. So when a
// chat's session is reaped server-side (idle reaper / worker browser closed), the
// pane kept a dead token and AgentSessionPanel fell into its publisher-lost branch,
// surfacing the scary "Couldn't start the session — the proxy may be down" overlay
// — implying broken infra when the session merely ended. The pane now polls the
// session lifecycle and passes `sessionEnded` so the panel's honest "Session ended"
// overlay wins. This test asserts that plumbing.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { AgentSession } from '@driftstack/sdk';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

// Hoisted spies (vitest hoists vi.mock factories — anything they WRITE to must be a
// vi.hoisted spy, never a plain top-level let, or collection deadlocks).
const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
  // captures the sessionEnded prop the live pane hands to AgentSessionPanel
  agentSessionPanel: vi.fn<(props: { sessionEnded?: { reason: string | null } | null }) => void>(),
}));

// A STABLE client/settings (built once) — the mock MUST return the SAME object
// references every render, or AgentChatView's [client]-keyed effects re-run on every
// render and storm into an infinite render loop. The agentSessions methods point at
// the hoisted spies so per-test mockResolvedValue still drives them.
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
  AgentSessionPanel: (props: { sessionEnded?: { reason: string | null } | null }) => {
    h.agentSessionPanel(props);
    return <div data-testid="agent-session-panel" />;
  },
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => Promise.resolve([]),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
}));

const SESSION: AgentSession = {
  id: 'agt_live',
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

const chatState: UseAgentChatResult = {
  turns: [],
  session: SESSION,
  sending: false,
  error: null,
  pendingConfirmation: null,
  deniedTurnIds: new Set<number>(),
  restoredHistoryCount: 0,
  send: vi.fn(() => Promise.resolve(true)),
  approve: vi.fn(() => Promise.resolve()),
  deny: vi.fn(),
  reset: vi.fn(),
  restore: vi.fn(),
  cancel: vi.fn(),
};
vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: () => chatState }));

const { AgentChatView } = await import('../../src/views/AgentChatView');

/** The latest sessionEnded prop the live pane handed the panel. */
function lastSessionEnded(): { reason: string | null } | null | undefined {
  const calls = h.agentSessionPanel.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1]?.[0]?.sessionEnded : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
});

describe('AgentChatView live view — session-ended plumbing (finding #3)', () => {
  it('passes sessionEnded=null to the panel while the session is active', async () => {
    h.getSession.mockResolvedValue(SESSION); // status active, no close fields
    render(<AgentChatView />);
    await waitFor(() => expect(h.agentSessionPanel).toHaveBeenCalled());
    expect(lastSessionEnded()).toBeNull();
  });

  it('latches the terminal end (status=closed) and hands {reason} to the panel', async () => {
    h.getSession.mockResolvedValue({
      ...SESSION,
      status: 'closed',
      closed_reason: 'idle_timeout',
      closed_at: '2026-06-14T01:00:00Z',
    });
    render(<AgentChatView />);
    await waitFor(() => expect(lastSessionEnded()).toEqual({ reason: 'idle_timeout' }));
  });

  it('treats a closed_reason-only session as ended (status may lag at active)', async () => {
    h.getSession.mockResolvedValue({
      ...SESSION,
      status: 'active',
      closed_reason: 'browser-closed',
    });
    render(<AgentChatView />);
    await waitFor(() => expect(lastSessionEnded()).toEqual({ reason: 'browser-closed' }));
  });

  it('a transient GET failure is NOT a terminal end (panel keeps reconnecting)', async () => {
    h.getSession.mockRejectedValue(new Error('network blip'));
    render(<AgentChatView />);
    await waitFor(() => expect(h.agentSessionPanel).toHaveBeenCalled());
    expect(lastSessionEnded()).toBeNull();
  });
});
