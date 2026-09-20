// The timeline grew icons, a rail, chips, a wash and a "now" marker. The words
// a screen reader and three other tests read did not move.
//
// ⛔ THE PIN THIS GUARDS. `a-turn-of-several-segments-renders-as-one-step-list`
// asserts that the `li` textContents of `[data-testid="live-plan"]` are exactly
// `['▶ Typing the search', '· Scrolling down']`. Every decoration stage 2 adds
// to those rows is built so it CANNOT appear there: the glyph is a
// visually-hidden span (in textContent, where the pin reads it), the per-kind
// icon is an `aria-hidden` `<svg>` with no `<title>`, the running wash is an
// empty span, and the word "now" is CSS generated content on `::after`.
//
// That other file would still pass if the decorations were simply ABSENT — a
// row with no icon has nothing to leak. So the arms below assert BOTH halves:
// the exact textContent AND that the decorations are really on the row. Without
// the second half this is a test of an empty room.
//
// The same file guards the other half of stage 2's copy promise: a failed step
// shows plain language, and its CSS selector appears exactly once, inside the
// collapsed "What was tried" line.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
  model: 'claude-sonnet-5',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

/** The selector that must reach the customer exactly once, and only under
 *  "What was tried". Distinctive so a partial leak still trips. */
const SELECTOR = '#add-to-cart-primary';

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

const USER_TURN: ChatTurn = { id: 1, role: 'user', text: 'add the trail shoes to my cart' };

function failedTurn(): ChatTurn {
  const response = {
    kind: 'plan-executed',
    session: SESSION,
    intents: [
      { kind: 'navigate', url: 'https://shop.example.com/' },
      { kind: 'interact', action: 'tap', selector: SELECTOR },
    ],
    results: [
      {
        kind: 'success',
        intent: { kind: 'navigate', url: 'https://shop.example.com/' },
        summary: 'Opened the store',
      },
      {
        kind: 'failure',
        intent: { kind: 'interact', action: 'tap', selector: SELECTOR },
        reason: 'A newsletter pop-up was covering the Add to cart button.',
        diagnosis: { category: 'element_covered', retryable: true },
      },
    ],
    ok: false,
  } as AgentMessageResponse;
  return { id: 2, role: 'agent', response };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
});

describe('the live plan is decorated WITHOUT changing a character of its text', () => {
  function renderRunning(): HTMLElement {
    chatState = baseChat({
      turns: [USER_TURN],
      sending: true,
      livePhase: 'Looking at the page…',
      livePlan: { total: 3, labels: ['Opening the store', 'Typing the search', 'Scrolling down'] },
      liveStepIndex: 1,
      liveSteps: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://shop.example.com/' },
          summary: 'Opened the store',
        },
      ],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    return screen.getByTestId('live-plan');
  }

  it('⛔ the li textContent is still exactly the glyph, a space and the label', () => {
    const list = renderRunning();
    const rows = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['▶ Typing the search', '· Scrolling down']);
  });

  it('…and those rows really ARE decorated — otherwise the arm above is a test of an empty room', () => {
    const list = renderRunning();
    const current = list.querySelector('li[data-current="true"]');
    expect(current).not.toBeNull();
    // an icon drawing, marked hidden so it is neither read aloud nor in text
    const svg = current?.querySelector('svg');
    expect(svg, 'the running row has no icon at all').not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('title'), 'an svg <title> WOULD land in textContent').toBeNull();
    // the sweeping wash, which is an empty element on purpose
    const wash = current?.querySelector('.ai-wash');
    expect(wash, 'the running row has no wash').not.toBeNull();
    expect(wash?.textContent).toBe('');
    // the glyph is a visually-hidden span, not a pseudo-element: the pin reads
    // textContent, and generated content is not in it.
    expect(current?.querySelector('.sr-only')?.textContent).toBe('▶ ');
    // and the row is a real timeline row, not the old bare <li>
    expect(current?.className).toContain('ai-step');
  });

  it('exactly one row is current, and a landed step is not listed twice', () => {
    const list = renderRunning();
    expect(list.querySelectorAll('[data-current="true"]')).toHaveLength(1);
    expect(list.textContent).not.toContain('Opening the store');
  });
});

describe('a failed step says what went wrong; its selector is behind "What was tried"', () => {
  function renderFailed(): void {
    chatState = baseChat({ turns: [USER_TURN, failedTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
  }

  it('⛔ the selector appears EXACTLY ONCE in the whole view, and it is the <code> under "What was tried"', () => {
    renderFailed();
    // Every LEAF element (no element children) that carries the selector in its
    // own text. Leaves, so an ancestor is not counted once per generation.
    const carriers = [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && (el.textContent ?? '').includes(SELECTOR),
    );
    expect(carriers, 'the selector is rendered in more than one place').toHaveLength(1);
    const only = carriers[0];
    expect(only?.tagName).toBe('CODE');
    expect(only?.closest('details')?.querySelector('summary')?.textContent).toBe('What was tried');
    expect(only?.textContent).toBe(`tap · ${SELECTOR}`);
    // …and the visible step label is plain language, not the selector.
    expect(screen.getByText('Tap something on the page')).toBeTruthy();
  });

  it('CONTROL — the sweep above is not blind: a selector planted in the answer IS found', () => {
    // Without this, "exactly one carrier" would also be true of a view that
    // rendered the selector nowhere at all and a <code> that happened to match.
    const planted = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'interact', action: 'tap', selector: SELECTOR }],
      results: [
        {
          kind: 'failure',
          intent: { kind: 'interact', action: 'tap', selector: SELECTOR },
          reason: `The page moved ${SELECTOR} while it was being tapped.`,
          diagnosis: { category: 'element_covered', retryable: true },
        },
      ],
      ok: false,
    } as AgentMessageResponse;
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response: planted }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const carriers = [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && (el.textContent ?? '').includes(SELECTOR),
    );
    // Two: the <code>, and the server's own sentence — which the view renders
    // VERBATIM by design. The sweep sees both, so it can see a leak.
    expect(carriers.length).toBeGreaterThanOrEqual(2);
  });

  it('the diagnosis names the failure in the customer’s language, with the server’s own sentence under it', () => {
    renderFailed();
    expect(screen.getByText('Something was covering it')).toBeTruthy();
    expect(screen.getByText('worth retrying')).toBeTruthy();
    expect(
      screen.getByText(/A newsletter pop-up was covering the Add to cart button\./),
    ).toBeTruthy();
    // The steps above it finished — said in words, so the column of ticks above
    // a red row does not read as "these failed too".
    expect(screen.getByText(/The step above finished; nothing after this one ran\./)).toBeTruthy();
  });

  // ⛔ THE OTHER ROW THAT USED TO SHOW A SELECTOR. A step waiting for approval
  // takes its words from the pinned `describeResult`, which leads with
  // `intentLabel(intent)`. `PlanStep` renders those words as an `sr-only` span
  // — invisible, therefore invisible to the text-quality gate and to the
  // gallery's privacy scan too, and read aloud to a blind customer. The sweep
  // above only ever rendered a FAILED turn, so it could not see this one.
  it('⛔ a GATED step carries the selector nowhere either — not even in its visually-hidden line', () => {
    const gated = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'interact', action: 'tap', selector: SELECTOR }],
      results: [
        {
          kind: 'confirmation_required',
          intent: { kind: 'interact', action: 'tap', selector: SELECTOR },
          category: 'purchase',
          matchedText: 'Place order · $104.00',
        },
      ],
      ok: false,
    } as AgentMessageResponse;
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response: gated }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const carriers = [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && (el.textContent ?? '').includes(SELECTOR),
    );
    expect(
      carriers.map((el) => el.textContent),
      'a gated row leaks the selector',
    ).toHaveLength(0);
    // …and the row still SAYS what it is waiting for, in both channels: the
    // pinned outcome for a screen reader, plain words for the eye. Without
    // this the arm above would pass on a row that rendered nothing.
    const hidden = [...document.querySelectorAll('.sr-only')].map((el) => el.textContent);
    expect(hidden).toContain('confirmation required (“Place order · $104.00”)');
    expect(screen.getByText('A purchase — waiting for your approval below')).toBeTruthy();
  });

  it('CONTROL — a turn with no failure renders no diagnosis card at all', () => {
    const okResponse = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'navigate', url: 'https://shop.example.com/' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://shop.example.com/' },
          summary: 'Opened the store',
        },
      ],
      ok: true,
    } as AgentMessageResponse;
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response: okResponse }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(document.querySelector('.ai-diag')).toBeNull();
    expect(screen.queryByText('Something was covering it')).toBeNull();
  });
});

describe('a finished turn can put its steps away', () => {
  function doneTurn(): ChatTurn {
    const response = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'capture', capture: 'screenshot' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'capture', capture: 'screenshot' },
          summary: 'Took a screenshot of the product page',
        },
      ],
      ok: true,
      answer: 'The Ridgeline Trail 2 costs $104.00.',
    } as AgentMessageResponse;
    return { id: 2, role: 'agent', response };
  }

  it('Hide steps collapses the region it names, and says so with aria-expanded', () => {
    chatState = baseChat({ turns: [USER_TURN, doneTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    const button = screen.getByRole('button', { name: 'Hide steps' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const regionId = button.getAttribute('aria-controls') ?? '';
    const region = document.getElementById(regionId);
    expect(region, 'aria-controls names nothing').not.toBeNull();
    expect(region?.hasAttribute('hidden')).toBe(false);
    expect(
      within(region as HTMLElement).getByText('Took a screenshot of the product page'),
    ).toBeTruthy();

    fireEvent.click(button);
    const again = screen.getByRole('button', { name: 'Show steps' });
    expect(again.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(regionId)?.hasAttribute('hidden')).toBe(true);
    // ⛔ The ANSWER is what survives the collapse — that is the whole point of
    // the control at the 600px-tall minimum window.
    expect(screen.getByText('The Ridgeline Trail 2 costs $104.00.')).toBeTruthy();
  });

  it('CONTROL — a turn with no answer has no Hide steps: there is nothing the steps are hiding behind', () => {
    const noAnswer = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'capture', capture: 'screenshot' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'capture', capture: 'screenshot' },
          summary: 'Took a screenshot of the product page',
        },
      ],
      ok: true,
    } as AgentMessageResponse;
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response: noAnswer }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.queryByRole('button', { name: 'Hide steps' })).toBeNull();
    expect(screen.getByText('Took a screenshot of the product page')).toBeTruthy();
  });
});

describe('Copy confirms what actually happened', () => {
  function answerTurn(): ChatTurn {
    const response = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'navigate', url: 'https://shop.example.com/p/1' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://shop.example.com/p/1' },
          summary: 'Opened the product page',
        },
      ],
      ok: true,
      answer: 'The Ridgeline Trail 2 costs $104.00.',
    } as AgentMessageResponse;
    return { id: 2, role: 'agent', response };
  }

  function withClipboard(writeText: () => Promise<void>): void {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  }

  it('says "Copied" once the write RESOLVED, and copies the answer itself', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard(writeText);
    chatState = baseChat({ turns: [USER_TURN, answerTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    // The write is DEFERRED through a promise chain on purpose — a WebView
    // whose `clipboard` getter throws must not take the click handler with it —
    // so the call lands a microtask later, not inside the event.
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('The Ridgeline Trail 2 costs $104.00.');
  });

  it('⛔ NEGATIVE — a WebView that refuses the clipboard is not told it copied', async () => {
    // A confirmation of something that did not happen is worse than none: the
    // customer pastes nothing and does not know why.
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    withClipboard(writeText);
    chatState = baseChat({ turns: [USER_TURN, answerTurn()] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('the answer names the page it was read from, and only when one is known', () => {
    withClipboard(() => Promise.resolve());
    chatState = baseChat({ turns: [USER_TURN, answerTurn()] });
    const view = render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Read from the page')).toBeTruthy();
    expect(screen.getByText('shop.example.com')).toBeTruthy();
    view.unmount();

    // CONTROL — a turn that navigated nowhere omits the whole clause rather
    // than printing an empty provenance line.
    const noNav = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'capture', capture: 'screenshot' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'capture', capture: 'screenshot' },
          summary: 'Took a screenshot',
        },
      ],
      ok: true,
      answer: 'The Ridgeline Trail 2 costs $104.00.',
    } as AgentMessageResponse;
    chatState = baseChat({ turns: [USER_TURN, { id: 2, role: 'agent', response: noNav }] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.queryByText('Read from the page')).toBeNull();
  });
});
