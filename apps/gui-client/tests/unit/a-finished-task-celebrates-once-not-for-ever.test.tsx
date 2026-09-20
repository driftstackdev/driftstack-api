// `data-ai-fresh` is the view saying "a task JUST finished here". The room
// blooms once on it (`ds-ai-bloom`, 1400ms, one iteration).
//
// ⛔ WHAT WAS WRONG. Stage 4 set the flag when the phase went acting → done
// while the view was mounted — which is right, and is why reopening a finished
// chat from the rail does not celebrate someone else's success a second time —
// but nothing ever cleared it. A chat left open for an hour still carried
// `data-ai-fresh`, so an attribute whose entire meaning is "just now" was
// permanently true, and every style recalculation that re-evaluated the rule
// (a theme flip, a tier change, a later stage hanging a second selector off it)
// was a chance to replay a celebration for a task nobody was watching. Stage
// 4's own review recorded it as "make it a moment, not a state".
//
// ⛔ WHY CLEARING IT CHANGES NO PIXEL, which is what makes this safe.
// `ds-ai-bloom` ends at `opacity: 0.66; transform: scale(1)`, and
// `[data-ai-phase='done'] .ai-aura` — the rule left standing once the attribute
// goes — is `opacity: 0.66`. The aura is in exactly the place the animation put
// it. This file therefore pins the LIFETIME, not a look.
//
// NEGATIVE CONTROL: delete the clearing effect in AgentChatView (the one that
// `setTimeout`s `setFresh(false)`) and the third arm reds with the attribute
// still present after the bloom; the first two stay green, which is the point —
// they are what a fix that simply never set the flag would also have to pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentIntent, AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<AgentSession>>(),
}));

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        iterate: function* iterate(): Generator<{ id: string; name: string }, void, void> {
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
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
}));

const SESSION: AgentSession = {
  id: 'agt_bloom',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  closed_at: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  stop_on_exit_ip_change: false,
  pair_mode_state: null,
  created_at: '2026-06-15T06:00:00.000Z',
  updated_at: '2026-06-15T06:40:00.000Z',
};

function navigate(url: string): AgentIntent {
  return { kind: 'navigate', url };
}

function success(summary: string): AgentIntentResult {
  return { kind: 'success', intent: navigate('https://shop.example.com/'), summary };
}

/** A turn where every step succeeded — `missionPhase` reads this as `done`. */
function finishedTurn(): ChatTurn {
  const results = [success('Opened the store')];
  return {
    id: 2,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session: SESSION,
      intents: results.map((r) => r.intent),
      results,
      ok: true,
    },
  };
}

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
    send: () => Promise.resolve(false),
    lastSendKeptMessage: () => false,
    approve: () => Promise.resolve(),
    deny: () => undefined,
    reset: () => undefined,
    cancel: () => undefined,
    stopping: false,
    stoppedTurnStillRunning: false,
    restore: () => undefined,
    adopt: () => undefined,
    adopting: false,
    adoptError: null,
    restoredHistoryCount: 0,
    restoredSessionId: null,
    ...over,
  };
}

let chatState: UseAgentChatResult = baseChat();
vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: () => chatState }));

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

/** The view root, which is where the flag lives. */
function view(): Element {
  const root = document.querySelector('.ai-view');
  if (root === null) throw new Error('the AI view did not render');
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('a task that finishes while you watch blooms once', () => {
  it('⛔ does NOT bloom for a chat that was already finished when it opened', () => {
    // Reopening a finished chat from the rail. The turn succeeded, so the phase
    // is `done` — but not on this mount's watch, and the room must not
    // celebrate it again. (Stage 4's rule; held here because the timer added in
    // final QA must not become a reason to set the flag more often.)
    chatState = baseChat({ turns: [finishedTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(view().hasAttribute('data-ai-fresh')).toBe(false);
  });

  it('POSITIVE CONTROL — blooms when the task finishes under this mount', () => {
    chatState = baseChat({ sending: true, livePhase: 'Looking at the page…' });
    const rendered = render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(view().hasAttribute('data-ai-fresh')).toBe(false);

    chatState = baseChat({ turns: [finishedTurn()] });
    rendered.rerender(<AgentChatView />);
    expect(view().hasAttribute('data-ai-fresh')).toBe(true);
  });

  it('⛔ and stops claiming to be fresh once the bloom is over', () => {
    chatState = baseChat({ sending: true, livePhase: 'Looking at the page…' });
    const rendered = render(<AgentChatView />, { wrapper: AgentChatProvider });
    chatState = baseChat({ turns: [finishedTurn()] });
    rendered.rerender(<AgentChatView />);
    expect(view().hasAttribute('data-ai-fresh')).toBe(true);

    // Still true halfway through: the flag must outlive the animation it drives,
    // or the bloom would be cut off partway and the aura would jump.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(view().hasAttribute('data-ai-fresh')).toBe(true);

    // `ds-ai-bloom` is 1400ms and the flag is held for 1500.
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(
      view().hasAttribute('data-ai-fresh'),
      'a chat left open still says a task just finished',
    ).toBe(false);
  });

  it('…and the chat is still `done` afterwards, so only the MOMENT expired', () => {
    // The phase is the standing fact and must survive; `fresh` is the moment.
    // Without this arm a "fix" that reset the phase would also pass the arm
    // above, and the room would go back to its idle light under a finished task.
    chatState = baseChat({ sending: true, livePhase: 'Looking at the page…' });
    const rendered = render(<AgentChatView />, { wrapper: AgentChatProvider });
    chatState = baseChat({ turns: [finishedTurn()] });
    rendered.rerender(<AgentChatView />);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(view().getAttribute('data-ai-phase')).toBe('done');
  });
});
