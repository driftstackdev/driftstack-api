// §7 (stage 3) — A TURN WITHOUT TIMING RENDERS NO CLOCK AND NO ZEROS.
//
// Stage 3 puts four new things on the timeline: a duration beside each step, an
// elapsed clock on the flight strip, a drawing on each step that has not run
// yet, and the row that says the agent looked at the page and made a new plan.
//
// All four come from data only THIS client can produce, by watching the stream.
// So all four are absent for a turn it did not watch — a chat reopened from
// disk, a chat written by a build older than this one, a response the server
// replayed whole. That is the dangerous case, because it is the invisible one:
// the code that renders a duration is exercised constantly, and the code that
// renders NO duration is exercised only by a customer whose chat is a week old.
//
// ⛔ So every arm below is a PAIR. The same turn is rendered with the timing and
// without it, and the without-it render must be the one the app drew before §7
// existed: no clock, no durations, no "0.0s", no trailing separator on a meta
// line that now has nothing after it.
//
// The DOM pins are watched here too: the re-plan row is a `div` (the
// `stopped-turn` receipt counts `li`s and they must still equal the steps that
// ran), and the live plan's `li` textContent is still exactly `'▶ ' + label`
// with the icons in place.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentIntent, AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { ChatTurn, TurnTiming, UseAgentChatResult } from '../../src/lib/use-agent-chat';

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

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.example.com/' };
const TYPE: AgentIntent = { kind: 'interact', action: 'type', selector: '#q', value: 'shoes' };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#add-to-cart' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

const RESULTS: ReadonlyArray<AgentIntentResult> = [
  { kind: 'success', intent: NAV, summary: 'Opened the store' },
  { kind: 'success', intent: TYPE, summary: 'Searched the store' },
  { kind: 'success', intent: SHOT, summary: 'Took a screenshot' },
];

const LABELS = ['Open the store', 'Search the store', 'Screenshot the product page'];
const KINDS = ['navigate', 'type', 'capture'];

const USER: ChatTurn = { id: 1, role: 'user', text: 'find me trail running shoes' };

/** The same settled turn, with whatever §7 data an arm wants to give it. */
function settled(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: 2,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session: SESSION,
      intents: [NAV, TYPE, SHOT],
      results: RESULTS,
      ok: true,
      answer: 'The Ridgeline Trail 2 is $104.00 and US 10 is in stock.',
    },
    ...over,
  };
}

const TIMING: TurnTiming = { elapsedMs: 41_000, stepMs: [3100, 1400, 5200] };

function show(turns: ReadonlyArray<ChatTurn>, over: Partial<UseAgentChatResult> = {}): HTMLElement {
  chatState = baseChat({ turns, ...over });
  return render(<AgentChatView />, { wrapper: AgentChatProvider }).container;
}

function durations(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.ai-dur')].map((e) => e.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
});

describe('a settled turn shows its clock and its step durations — when it has them', () => {
  it('puts the time each step took beside it, and the turn’s own clock on the end of the meta line', () => {
    const container = show([USER, settled({ timing: TIMING })]);
    expect(durations(container)).toEqual(['3.1s', '1.4s', '5.2s']);
    expect(screen.getByText('Finished · 3 of 3 steps · 0:41')).toBeTruthy();
  });

  it('⛔ AND THE SAME TURN WITHOUT TIMING RENDERS NEITHER — no durations, no clock, no trailing separator', () => {
    const container = show([USER, settled()]);
    expect(durations(container)).toEqual([]);
    // Exactly the sentence this line said before §7: no "· 0:00", and no
    // dangling "·" where the clock would have been.
    expect(screen.getByText('Finished · 3 of 3 steps')).toBeTruthy();
    expect(container.textContent).not.toMatch(/0\.0s/);
    expect(container.textContent).not.toMatch(/·\s*0:0/);
  });

  it('⛔ a step the client never timed shows NOTHING, while the steps around it keep their numbers', () => {
    const container = show([
      USER,
      settled({ timing: { elapsedMs: 41_000, stepMs: [3100, null, 5200] } }),
    ]);
    expect(durations(container)).toEqual(['3.1s', '5.2s']);
    // Three rows, two durations — the missing one is a gap, not a zero.
    expect(container.querySelectorAll('.ai-plan > li')).toHaveLength(3);
  });

  it('a turn timed but with no per-step numbers still shows its own clock', () => {
    const container = show([USER, settled({ timing: { elapsedMs: 19_000 } })]);
    expect(durations(container)).toEqual([]);
    expect(screen.getByText('Finished · 3 of 3 steps · 0:19')).toBeTruthy();
  });
});

describe('a failed or gated row says what the agent SAID it was doing, when that was kept', () => {
  const failed: ReadonlyArray<AgentIntentResult> = [
    { kind: 'success', intent: NAV, summary: 'Opened the store' },
    {
      kind: 'failure',
      intent: TAP,
      reason: 'A newsletter pop-up was covering the Add to cart button.',
      diagnosis: { category: 'element_covered', retryable: true },
    },
  ];
  function troubled(over: Partial<ChatTurn> = {}): ChatTurn {
    return {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: SESSION,
        intents: [NAV, TAP, SHOT],
        results: failed,
        ok: false,
      },
      ...over,
    };
  }

  it('prefers the server’s own caption for the step that failed', () => {
    show([
      USER,
      troubled({ plan: { labels: ['Open the store', 'Add it to the cart', 'Screenshot'] } }),
    ]);
    expect(screen.getByText('Add it to the cart')).toBeTruthy();
    expect(screen.queryByText('Tap something on the page')).toBeNull();
  });

  it('⛔ and falls back to the derived words — never to the selector — when no caption was kept', () => {
    const container = show([USER, troubled()]);
    expect(screen.getByText('Tap something on the page')).toBeTruthy();
    // The selector still lives in exactly one place: under "What was tried".
    const revealed = container.querySelector('details code')?.textContent ?? '';
    expect(revealed).toContain('#add-to-cart');
    const visible = [...container.querySelectorAll('.ai-step-label')]
      .map((e) => e.textContent ?? '')
      .join(' | ');
    expect(visible).not.toContain('#add-to-cart');
  });

  it('counts a kept plan that is longer than the results into "later steps didn’t run"', () => {
    show([
      USER,
      troubled({
        plan: {
          labels: ['Open the store', 'Add it to the cart', 'Screenshot', 'Read the total'],
        },
      }),
    ]);
    // Four planned, two ran — and the plan knew about a step `intents` did not.
    expect(screen.getByText('2 later steps didn’t run')).toBeTruthy();
  });
});

describe('the row that says the agent looked at the page and made a new plan', () => {
  it('sits between the two plans, once, with the later steps under it', () => {
    const container = show([
      USER,
      settled({ plan: { labels: LABELS, replanAt: [2] }, timing: TIMING }),
    ]);
    const rows = [...container.querySelectorAll('.ai-replan')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe('Looked at the page and updated the plan');
    // Two lists, cut where the plan changed: two steps above, one below.
    const lists = [...container.querySelectorAll('ol.ai-plan')];
    expect(lists.map((l) => l.querySelectorAll('li').length)).toEqual([2, 1]);
  });

  it('⛔ is a DIV, so the step count a stopped turn is measured by does not move', () => {
    const container = show([
      USER,
      settled({ plan: { labels: LABELS, replanAt: [2] }, timing: TIMING }),
    ]);
    expect(container.querySelector('.ai-replan')?.tagName).toBe('DIV');
    // Three results ⇒ three `li`, whatever else the turn draws around them.
    const items = [...container.querySelectorAll('ol.ai-plan > li')];
    expect(items).toHaveLength(RESULTS.length);
  });

  it('⛔ AND A TURN WITHOUT ONE RENDERS A SINGLE LIST, exactly as it did before §7', () => {
    const container = show([USER, settled({ plan: { labels: LABELS } })]);
    expect(container.querySelectorAll('.ai-replan')).toHaveLength(0);
    expect(container.querySelectorAll('ol.ai-plan')).toHaveLength(1);
  });
});

describe('the turn that is still running', () => {
  function live(over: Partial<UseAgentChatResult> = {}): HTMLElement {
    return show([USER], {
      sending: true,
      livePhase: 'Looking at the page…',
      livePlan: { labels: LABELS, total: 3, kinds: KINDS },
      liveSteps: [RESULTS[0] as AgentIntentResult],
      liveStepIndex: 1,
      ...over,
    });
  }

  it('shows an elapsed clock beside the step count', () => {
    // ⛔ Restored in the same test, not left to a global hook: `clearAllMocks`
    // in beforeEach does NOT undo a spy's implementation, so a frozen Date.now
    // would leak into every arm below this one — the order-dependence class
    // that tests/setup.ts's timer note is about.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_048_000);
    try {
      const container = live({ liveStartedAt: 1_700_000_000_000 });
      expect(container.querySelector('.ai-flight-meta')?.textContent).toBe('Step 2 of 3 · 0:48');
    } finally {
      now.mockRestore();
    }
  });

  it('⛔ AND SHOWS NO CLOCK AT ALL when nothing timed the turn — not "0:00"', () => {
    const container = live();
    expect(container.querySelector('.ai-flight-meta')?.textContent).toBe('Step 2 of 3');
  });

  it('⛔ draws each pending step’s kind without changing the words a screen reader hears', () => {
    const container = live();
    const items = [...container.querySelectorAll('[data-testid="live-plan"] li')];
    // The pinned textContent: the glyph, a space, and the label. The icons are
    // aria-hidden `<svg>` with no `<title>`, so none of them is in here.
    expect(items.map((li) => li.textContent)).toEqual([
      '▶ Search the store',
      '· Screenshot the product page',
    ]);
    // …and every one of those rows really has a drawing on it now.
    expect(items.every((li) => li.querySelector('.ai-node svg') !== null)).toBe(true);
  });

  it('a plan with no kinds keeps the hollow nodes it had before — a guessed icon is a claim', () => {
    const container = live({ livePlan: { labels: LABELS, total: 3 } });
    const pending = container.querySelectorAll(
      '[data-testid="live-plan"] li:not([data-current]) .ai-node svg',
    );
    expect(pending).toHaveLength(0);
  });

  it('shows the durations of the steps that have already landed', () => {
    const container = live({ liveStepMs: [3100] });
    expect(durations(container)).toEqual(['3.1s']);
  });

  it('shows the "this is not finished" notice as soon as it is streamed, under its own testid', () => {
    const NOTICE = 'I did the steps above, but the task needs more steps than one message runs.';
    const container = live({ liveNotice: NOTICE });
    expect(screen.getByTestId('live-turn-notice').textContent).toBe(NOTICE);
    // ⛔ NOT `turn-notice`: that is the settled turn's, and a settled turn
    // higher in the log can be showing one at the same time.
    expect(screen.queryByTestId('turn-notice')).toBeNull();
    expect(container.querySelectorAll('[data-testid="live-turn-notice"]')).toHaveLength(1);
  });

  it('renders no notice when none has been streamed, and none for an empty one', () => {
    const none = show([USER], {
      sending: true,
      livePhase: 'Looking at the page…',
      livePlan: { labels: LABELS, total: 3 },
      liveSteps: [],
      liveStepIndex: 0,
      liveNotice: null,
    });
    expect(none.querySelectorAll('[data-testid="live-turn-notice"]')).toHaveLength(0);
    // A whitespace-only sentence is not a sentence: an empty card would read
    // as a notice the customer failed to see rather than as one that is absent.
    const blank = live({ liveNotice: '   ' });
    expect(blank.querySelectorAll('[data-testid="live-turn-notice"]')).toHaveLength(0);
  });

  it('draws the re-plan row between the steps that ran and the ones still to come', () => {
    const container = live({
      livePlan: { labels: LABELS, total: 3, kinds: KINDS, replanAt: [1] },
    });
    const rows = [...container.querySelectorAll('.ai-replan')];
    expect(rows).toHaveLength(1);
    // Above it: the landed step. Below it: the live plan's pending rows.
    const replan = rows[0] as HTMLElement;
    const livePlan = screen.getByTestId('live-plan');
    expect(
      replan.compareDocumentPosition(livePlan) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ─── REVIEW REPAIRS (stage 3) ────────────────────────────────────────────────

/** What a screen reader is left with: the text minus every `aria-hidden`
 *  subtree. `textContent` is what the EYE gets; this is what the EAR gets, and
 *  the two arms below exist because they must differ here and match there. */
function spoken(el: Element): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const hidden of [...copy.querySelectorAll('[aria-hidden="true"]')]) hidden.remove();
  return copy.textContent ?? '';
}

describe('the clock of a RUNNING turn is read once, not once a second', () => {
  it('⛔ ticks inside a live region, so it is hidden from it — and takes its separator with it', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_048_000);
    try {
      const container = show([USER], {
        sending: true,
        livePhase: 'Looking at the page…',
        livePlan: { labels: LABELS, total: 3 },
        liveSteps: [RESULTS[0] as AgentIntentResult],
        liveStepIndex: 1,
        liveStartedAt: 1_700_000_000_000,
      });

      // THE PREMISE, asserted rather than assumed: the in-flight turn is a
      // polite live region with no `aria-relevant`, and the default is
      // "additions text" — so a leaf that rewrites itself every second is
      // ANNOUNCED every second, for as long as the turn runs.
      const body = container.querySelector('li.ai-body');
      expect(body?.getAttribute('aria-live')).toBe('polite');
      expect(body?.getAttribute('aria-relevant')).toBeNull();

      const meta = container.querySelector('.ai-flight-meta');
      expect(meta).toBeTruthy();
      // The eye reads the clock…
      expect(meta?.textContent).toBe('Step 2 of 3 · 0:48');
      // …and the ear is left with the step count and NO trailing separator.
      // (Spec §5: "clocks additionally carry aria-hidden, with the elapsed time
      // available in the settled meta" — the next arm is that other half.)
      expect(spoken(meta as Element)).toBe('Step 2 of 3');
    } finally {
      now.mockRestore();
    }
  });

  it('while a SETTLED turn says its elapsed time out loud, because that text never changes again', () => {
    const container = show([USER, settled({ timing: TIMING })]);
    const meta = [...container.querySelectorAll('.ai-flight-meta')].at(-1);
    expect(meta?.textContent).toBe('Finished · 3 of 3 steps · 0:41');
    // ⛔ NOT hidden: it is written once, when the turn lands, and it is the
    // only place a screen-reader user is told how long the turn took.
    expect(spoken(meta as Element)).toBe('Finished · 3 of 3 steps · 0:41');
  });
});

describe('the re-plan row arrives with the rows around it', () => {
  it('⛔ joins the reveal cascade in the slot it sits in, rather than popping in at full opacity', () => {
    const container = show([
      USER,
      settled({ plan: { labels: LABELS, replanAt: [2] }, timing: TIMING }),
    ]);
    const replan = container.querySelector('.ai-replan');
    expect(replan).toBeTruthy();
    // The same arrival every step row gets (motion #9), and the same opt-in
    // stagger variable — so a six-row plan reveals as ONE cascade.
    expect(replan?.classList.contains('ai-step-in')).toBe(true);
    expect((replan as HTMLElement).style.getPropertyValue('--i')).toBe('2');
    // It is STILL a div: the `stopped-turn` receipt counts `li`s.
    expect(replan?.tagName).toBe('DIV');
    // And the row it sits above is the one it was numbered for.
    const rows = [...container.querySelectorAll('.ai-plan > li')];
    expect(rows).toHaveLength(3);
    expect(rows[2]?.textContent).toContain('Took a screenshot');
  });

  it('a boundary that lands mid-stream arrives alone — no stagger to wait for', () => {
    const container = show([USER], {
      sending: true,
      livePhase: 'Looking at the page…',
      livePlan: { labels: LABELS, total: 3, replanAt: [1] },
      liveSteps: [RESULTS[0] as AgentIntentResult],
      liveStepIndex: 1,
    });
    const replan = container.querySelector('.ai-replan');
    expect(replan?.classList.contains('ai-step-in')).toBe(true);
    // No `--i`: a streamed row has no siblings arriving with it, so waiting
    // 45ms per row above it would delay it for no reason (`var(--i, 0)`).
    expect((replan as HTMLElement).style.getPropertyValue('--i')).toBe('');
  });
});
