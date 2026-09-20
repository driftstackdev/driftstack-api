// The transcript is memoized, and stage 2 nearly un-memoized it.
//
// ⛔ WHY THIS EXISTS. `TurnRow` is `React.memo` for one reason, written on the
// component itself: the transcript is mapped inside the component that owns the
// composer's `draft` state, so without the memo EVERY keystroke re-renders
// EVERY turn — the input lag a 2026-07-08 audit found in a long chat. `memo`
// compares props shallowly, so it only holds while every prop keeps its
// identity between renders. Stage 2 added an `actions` prop; an object literal
// built in the view's body is a NEW object on every render, which makes the
// shallow compare fail for every row, on every keystroke, forever — and nothing
// about the screen looks different, so no screenshot and no other test can see
// it.
//
// HOW IT IS MEASURED. A leaf inside a settled turn (`CaptureThumbnail`, which a
// finished screenshot step renders) counts its own renders. Type one character
// into the composer: the view re-renders, and the count must NOT move. The
// count is a real render count, not a proxy for one — the stub is the component
// React calls.
//
// NEGATIVE CONTROL: pass a fresh `{...}` as `actions` in AgentChatView (or drop
// `memo` from TurnRow) and the second arm goes red with the count doubled,
// while the first arm — that the turn rendered at all — stays green.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentIntentResult, AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type * as CaptureThumbnailModule from '../../src/components/CaptureThumbnail';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
  upsertChat: vi.fn<(chat: { id: string; model: string }, now: number) => Promise<unknown[]>>(),
  /** How many times the leaf inside the settled turn has been rendered. */
  thumbRenders: { n: 0 },
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

// The counting leaf. `captureIdOf` stays the real one — it is what decides that
// this turn HAS a screenshot, and faking it would fake the thing being counted.
vi.mock('../../src/components/CaptureThumbnail', async (importOriginal) => {
  const actual = await importOriginal<typeof CaptureThumbnailModule>();
  return {
    ...actual,
    CaptureThumbnail: (): JSX.Element => {
      h.thumbRenders.n += 1;
      return <img data-testid="counted-thumb" alt="Screenshot the agent captured on this step" />;
    },
  };
});

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
    stoppedTurnStillRunning: false,
    ...over,
  };
}

const USER_TURN: ChatTurn = { id: 1, role: 'user', text: 'find me trail running shoes' };

/** A finished turn with an answer and a captured screenshot — the shape whose
 *  re-render costs the most, because it carries the answer card and the whole
 *  timeline under it. */
function settledTurn(): ChatTurn {
  const response = {
    kind: 'plan-executed',
    session: SESSION,
    intents: [
      { kind: 'navigate', url: 'https://shop.example.com/' },
      { kind: 'capture', capture: 'screenshot' },
    ],
    results: [
      {
        kind: 'success',
        intent: { kind: 'navigate', url: 'https://shop.example.com/' },
        summary: 'Opened the store',
      },
      {
        kind: 'success',
        intent: { kind: 'capture', capture: 'screenshot' },
        summary: 'Took a screenshot of the product page',
        captureId: 'cap_1',
      },
    ],
    answer: 'The Ridgeline Trail 2 is $104.00 and US size 10 is in stock.',
    ok: true,
  } as AgentMessageResponse;
  return { id: 2, role: 'agent', response };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.thumbRenders.n = 0;
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
});

/** One landed step of a turn that is still running. `navigate` and not
 *  `capture`, so nothing inside the LIVE turn renders a thumbnail and the count
 *  below is only ever the SETTLED turn's. */
function liveStep(summary: string): AgentIntentResult {
  return {
    kind: 'success',
    intent: { kind: 'navigate', url: 'https://shop.example.com/' },
    summary,
  };
}

describe('typing a message does not re-render the turns above it', () => {
  function renderSettled(): HTMLTextAreaElement {
    chatState = baseChat({ turns: [USER_TURN, settledTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    return screen.getByPlaceholderText(/Describe a task in plain English/i);
  }

  it('the settled turn renders its screenshot at all — otherwise the count below is of nothing', () => {
    renderSettled();
    expect(screen.getAllByTestId('counted-thumb').length).toBeGreaterThan(0);
    expect(h.thumbRenders.n).toBeGreaterThan(0);
  });

  it('⛔ a keystroke in the composer re-renders NO finished turn', () => {
    const composer = renderSettled();
    const before = h.thumbRenders.n;
    fireEvent.change(composer, { target: { value: 'a' } });
    fireEvent.change(composer, { target: { value: 'ad' } });
    fireEvent.change(composer, { target: { value: 'add' } });
    expect(
      h.thumbRenders.n,
      'TurnRow.memo no longer bails on a keystroke — an unstable prop is being passed to it',
    ).toBe(before);
  });

  it('…and the composer really did change, so the arm above is not measuring a dead input', () => {
    const composer = renderSettled();
    fireEvent.change(composer, { target: { value: 'add three items' } });
    expect(composer.value).toBe('add three items');
  });

  // ⛔ THE OTHER RE-RENDER FIRE-HOSE, AND THE ONE THAT COSTS MORE. A keystroke
  // is the customer's own pace; a running turn streams a step every few
  // seconds for up to ~50 minutes, and each one re-renders the view that owns
  // the transcript. If `TurnRow.memo` stops bailing, every finished turn above
  // the live one re-renders on every streamed step — a long chat, at exactly
  // the moment the customer is watching the phone. The keystroke arms above
  // cannot see this: the view re-renders for a DIFFERENT reason (`liveSteps`,
  // not `draft`), and stage 4 added a second component (`Stage`) between the
  // two that now re-renders per step as well.
  // ⚠️ THE TURNS ARE BUILT ONCE AND REUSED, and that is the whole measurement.
  // `TurnRow` is `React.memo`, which compares props by identity: handing it a
  // freshly-built `turn` object on every rerender makes the compare fail for a
  // reason that has nothing to do with the view, and the arm would then be
  // measuring the test's own churn. The real hook keeps a settled turn's object
  // identity across a streamed step — these two constants are that fact.
  const STREAM_TURNS: ReadonlyArray<ChatTurn> = [USER_TURN, settledTurn()];
  const STREAMED: ReadonlyArray<ReadonlyArray<AgentIntentResult>> = [
    [liveStep('Opened the checkout')],
    [liveStep('Opened the checkout'), liveStep('Filled in the delivery address')],
    [
      liveStep('Opened the checkout'),
      liveStep('Filled in the delivery address'),
      liveStep('Chose standard shipping'),
    ],
  ];

  function renderStreaming(steps: ReadonlyArray<AgentIntentResult>): UseAgentChatResult {
    return baseChat({
      turns: STREAM_TURNS,
      sending: true,
      livePhase: 'Looking at the page…',
      liveSteps: steps,
      liveStepIndex: steps.length === 0 ? null : steps.length,
    });
  }

  it('⛔ a streamed step re-renders NO finished turn either', () => {
    chatState = renderStreaming([]);
    const view = render(<AgentChatView />, { wrapper: AgentChatProvider });
    const before = h.thumbRenders.n;
    expect(before, 'the settled turn rendered its screenshot at all').toBeGreaterThan(0);

    for (const steps of STREAMED) {
      chatState = renderStreaming(steps);
      view.rerender(<AgentChatView />);
    }

    expect(
      h.thumbRenders.n,
      'TurnRow.memo no longer bails while a turn streams — an unstable prop is reaching it',
    ).toBe(before);
  });

  it('…and the live turn really did advance, so the arm above is not measuring a frozen view', () => {
    chatState = renderStreaming([]);
    const view = render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.queryByText('Chose standard shipping')).toBeNull();
    for (const steps of STREAMED) {
      chatState = renderStreaming(steps);
      view.rerender(<AgentChatView />);
    }
    expect(screen.getByText('Chose standard shipping')).toBeTruthy();
  });
});
