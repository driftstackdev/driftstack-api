// B6 — A TURN OF SEVERAL SEGMENTS RENDERS AS ONE STEP LIST.
//
// A turn is a loop now — look, plan as far as it can see, act, look again — and
// each pass sends its own `plan` frame. The chat was written when a turn had
// exactly one, and REPLACED the live plan with each frame. The view, correctly,
// hides every planned step whose result has already landed (`i < liveSteps
// .length`), in the TURN's index space; the replaced plan was in the SEGMENT's.
// So from the second segment on, the first `liveSteps.length` steps of every new
// plan were treated as done and vanished, and the "now running" marker pointed
// past the end of the list. Nothing crashed: the customer simply watched a
// four-step segment show one step, or none.
//
// The fix keeps ONE list for the turn and folds each frame into it at the offset
// the server states.

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
    // P6 — a stopped turn still running on the server. False here: these
    // doubles describe a chat nobody pressed Stop on.
    stoppedTurnStillRunning: false,
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

const { mergeLivePlan, phaseCaptionFor } = await import('../../src/lib/use-agent-chat');

const SCROLL = { kind: 'scroll', direction: 'down' } as const;

describe('mergeLivePlan — one list for the whole turn', () => {
  it('a first frame is the plan, exactly as it always was', () => {
    expect(mergeLivePlan(null, { labels: ['Opening the site', 'Waiting'], total: 2 })).toEqual({
      labels: ['Opening the site', 'Waiting'],
      total: 2,
    });
  });

  it('⛔ a LATER frame is placed at its offset — the earlier steps keep their captions and the new ones are not mistaken for them', () => {
    const first = mergeLivePlan(null, { labels: ['Opening the site', 'Waiting'], total: 2 });
    const second = mergeLivePlan(first, {
      labels: ['Typing the search', 'Pressing Enter'],
      total: 4,
      offset: 2,
    });
    expect(second).toEqual({
      labels: ['Opening the site', 'Waiting', 'Typing the search', 'Pressing Enter'],
      total: 4,
    });
  });

  it('a server that sends no offset is read the way its cumulative `total` implies — the existing re-plan frames were already of this shape', () => {
    const first = mergeLivePlan(null, { labels: ['Opening the site', 'Tapping'], total: 2 });
    // A re-plan after step 2 failed: two steps ran, the new plan has one.
    expect(mergeLivePlan(first, { labels: ['Tapping the right button'], total: 3 })).toEqual({
      labels: ['Opening the site', 'Tapping', 'Tapping the right button'],
      total: 3,
    });
  });

  it('a segment that stopped EARLY does not leave its unrun captions in the list — the next frame overwrites from where the turn actually is', () => {
    // Five steps were planned, two ran, the third failed (three results), and
    // the re-plan starts at index 3.
    const first = mergeLivePlan(null, { labels: ['a', 'b', 'c', 'd', 'e'], total: 5 });
    expect(mergeLivePlan(first, { labels: ['c again', 'd'], total: 5, offset: 3 })).toEqual({
      labels: ['a', 'b', 'c', 'c again', 'd'],
      total: 5,
    });
  });

  it('a frame whose predecessor never arrived still lines up: the missing slots hold a neutral caption, never the wrong one', () => {
    expect(mergeLivePlan(null, { labels: ['Taking a screenshot'], total: 4, offset: 3 })).toEqual({
      labels: ['Working', 'Working', 'Working', 'Taking a screenshot'],
      total: 4,
    });
  });

  it('a nonsense offset is ignored in favour of the total', () => {
    const first = mergeLivePlan(null, { labels: ['a'], total: 1 });
    expect(mergeLivePlan(first, { labels: ['b'], total: 2, offset: -4 }).labels).toEqual([
      'a',
      'b',
    ]);
    expect(mergeLivePlan(first, { labels: ['b'], total: 2, offset: 0.5 }).labels).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('phaseCaptionFor — the customer sees the agent LOOKING and CONTINUING', () => {
  it('a first pass reads exactly as it did', () => {
    expect(phaseCaptionFor('planning', undefined)).toBe('Planning…');
    expect(phaseCaptionFor('reading_page', undefined)).toBe('Reading the page…');
  });

  it('a later pass says what it is: carrying on is not starting over, and is not something having gone wrong', () => {
    expect(phaseCaptionFor('reading_page', 'continue')).toBe('Looking at the page…');
    expect(phaseCaptionFor('planning', 'continue')).toBe('Continuing…');
    expect(phaseCaptionFor('planning', 'replan')).toBe('Working out another way…');
    // The other phases are unaffected by a cause.
    expect(phaseCaptionFor('executing', 'continue')).toBe('Working on your request…');
  });

  it('an unknown cause or phase degrades to what an older server would have produced', () => {
    expect(phaseCaptionFor('planning', 'something-new')).toBe('Planning…');
    expect(phaseCaptionFor('a-phase-from-the-future', 'continue')).toBeNull();
  });
});

describe('the view renders a second segment without dropping or duplicating a step', () => {
  it('⛔ with the first segment’s two steps done, the second segment’s two steps are BOTH pending — and the one the server named is the one marked running', () => {
    const merged = mergeLivePlan(
      mergeLivePlan(null, { labels: ['Opening the site', 'Waiting for the page'], total: 2 }),
      { labels: ['Typing the search', 'Scrolling down'], total: 4, offset: 2 },
    );
    chatState = baseChat({
      turns: [USER_TURN],
      sending: true,
      livePhase: 'Continuing…',
      livePlan: merged,
      liveStepIndex: 2,
      liveSteps: [
        { kind: 'success', intent: NAV, summary: 'navigated' },
        { kind: 'success', intent: SCROLL, summary: 'waited' },
      ],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    const pending = [...screen.getByTestId('live-plan').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    // Not dropped: both of the new segment's steps are there.
    expect(pending).toEqual(['▶ Typing the search', '· Scrolling down']);
    // Not duplicated: the finished steps render once, as results, and their
    // captions are gone from the pending list.
    expect(screen.getByTestId('live-plan').textContent).not.toContain('Opening the site');
    expect(screen.getByText(/Continuing…/)).toBeTruthy();
  });

  it('and this is the list the OLD behaviour produced for the same frames — the new segment’s steps hidden as if already done', () => {
    // Replacing instead of merging: the second frame's labels at indices 0 and 1,
    // under two landed results.
    chatState = baseChat({
      turns: [USER_TURN],
      sending: true,
      livePlan: { labels: ['Typing the search', 'Scrolling down'], total: 4 },
      liveStepIndex: 2,
      liveSteps: [
        { kind: 'success', intent: NAV, summary: 'navigated' },
        { kind: 'success', intent: SCROLL, summary: 'waited' },
      ],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    // The defect, stated as what it is, so nobody "simplifies" the merge away.
    expect(screen.getByTestId('live-plan').querySelectorAll('li')).toHaveLength(0);
  });
});

/**
 * A settled turn carrying the `notice` field the server now sends. The field is
 * newer than the SDK's response type, so it is added through a type that says
 * so, rather than asserted onto one that does not have it.
 */
function withNotice(notice: unknown): AgentMessageResponse {
  const base = planTurn().response;
  if (base === undefined) throw new Error('planTurn() built no response');
  const response: AgentMessageResponse & { notice?: unknown } = { ...base, notice };
  return response;
}

describe('a turn that stopped short SAYS so', () => {
  const NOTICE =
    'I did the steps above, but this task needs more steps than I take in one message, so it is not finished yet. Send “continue” and I will carry on from this page.';

  it('renders the notice with the settled turn — every step below it is a tick, so it is the only thing that says the task is unfinished', () => {
    const response = withNotice(NOTICE);
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const notice = screen.getByTestId('turn-notice');
    expect(notice.textContent).toBe(NOTICE);
    // Above the step list, where the answer goes: it is the reply, not a footnote.
    const heading = screen.getByText('Plan');
    expect(notice.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a turn with no notice renders none — a server that never sends the field changes nothing', () => {
    chatState = baseChat({ turns: [USER_TURN, planTurn('Your IP address is 203.0.113.7.')] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.queryByTestId('turn-notice')).toBeNull();
  });

  it('an empty or non-string notice is not rendered as an empty paragraph', () => {
    for (const bad of ['', '   ', 42, null]) {
      const response = withNotice(bad);
      chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response }] });
      const view = render(<AgentChatView />, { wrapper: AgentChatProvider });
      expect(screen.queryByTestId('turn-notice')).toBeNull();
      view.unmount();
    }
  });
});
