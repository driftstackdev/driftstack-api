// The one moment a customer is asked to trust an automation with their money.
//
// Spec §3.6. The old gate said "The agent wants to perform a purchase: “Place
// order · $104.00”" in one 12px line beside the buttons that spend the money,
// and answered none of the three questions a customer actually has:
//
//   what is about to happen?  → a category-specific sentence, in the voice size
//   to what, and where?       → the matched control, as a replica, "on <host>"
//   has it already happened?  → "Nothing has been bought." — the calm line
//
// This file holds the copy to those three answers, per category, and to the two
// rules that keep the gate honest under the hood: nothing here may name HOW the
// step was selected, and the ticking wait may not reach the accessibility tree.
//
// NEGATIVE CONTROLS (each run, each seen red, each restored):
//  · drop the `sessionActive &&` from the calm line's second sentence in
//    ApprovalDock → "the iPhone stays on this page" is promised about a session
//    that ended; the CLOSED-SESSION arm reds and the live-session arm stays green.
//  · make `confirmationHost` return the raw URL instead of the hostname → the
//    host arm reds; make it return a host for a chat that navigated nowhere →
//    the "no host, no clause" arm reds.
//  · drop the `result.kind !== 'success'` guard from `confirmationHost` (the
//    stage-5 review repair) → the two "did not arrive" arms red with the host of
//    a page the browser never reached, while both CONTROL arms stay green.
//  · take `aria-hidden` off the paused clock → the spoken-text arm reds.
//  · focus the dock unconditionally → the DRAFT arm reds while the two
//    take-focus arms stay green.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type {
  ChatTurn,
  PendingConfirmation,
  UseAgentChatResult,
} from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
  upsertChat: vi.fn<(chat: { id: string; model: string }, now: number) => Promise<unknown[]>>(),
}));

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
      settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
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
const { approvalVoice, approvalCalm, confirmationHost, gatedStepTaps } =
  await import('../../src/views/agent-chat/ApprovalDock');

// ─── fixtures ────────────────────────────────────────────────────────────────

function went(url: string, summary: string): AgentIntentResult {
  return { kind: 'success', intent: { kind: 'navigate', url }, summary };
}

/** A navigation that did NOT arrive. The browser is still on the page it was on
 *  before this step, so this host is precisely where the phone is not. */
function couldNotGo(url: string, reason: string): AgentIntentResult {
  return { kind: 'failure', intent: { kind: 'navigate', url }, reason };
}

/** A navigation the executor halted before dispatching — it never ran either. */
function gatedNavigate(url: string, matchedText: string): AgentIntentResult {
  return {
    kind: 'confirmation_required',
    intent: { kind: 'navigate', url },
    category: 'purchase',
    matchedText,
  };
}

/** The step the gate is holding. `selector` is the thing that must never reach
 *  the card: the customer is being asked about a purchase, not about a CSS
 *  selector, and naming it would be the product explaining how it is built. */
function gated(
  matchedText: string,
  category: string,
  action: 'tap' | 'type' | 'scroll' = 'tap',
): AgentIntentResult {
  return {
    kind: 'confirmation_required',
    intent: { kind: 'interact', action, selector: '#place-order' },
    category,
    matchedText,
  };
}

function haltedTurn(results: ReadonlyArray<AgentIntentResult>): ChatTurn {
  return {
    id: 2,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session: SESSION,
      intents: results.map((r) => r.intent),
      results,
      ok: false,
    },
  };
}

function baseChat(): UseAgentChatResult {
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
  };
}

/** A chat halted on a consequential step, with the navigation that got there. */
function halted(
  category: string,
  matchedText = 'Place order · $104.00',
  opts: {
    action?: 'tap' | 'type' | 'scroll';
    navigated?: boolean;
    session?: AgentSession | null;
  } = {},
): UseAgentChatResult {
  const steps: AgentIntentResult[] = [
    ...(opts.navigated === false
      ? []
      : [went('https://shop.example.com/checkout', 'Opened the checkout')]),
    gated(matchedText, category, opts.action ?? 'tap'),
  ];
  const confirmation: PendingConfirmation = { turnId: 2, category, matchedText };
  return {
    ...baseChat(),
    session: opts.session === undefined ? SESSION : opts.session,
    turns: [{ id: 1, role: 'user', text: 'Buy the shoes' }, haltedTurn(steps)],
    pendingConfirmation: confirmation,
  };
}

function dock(): HTMLElement {
  return screen.getByRole('alert');
}

/** What a screen reader gets from the card: its text with every `aria-hidden`
 *  subtree removed. `role="alert"` is atomic, so this is one announcement. */
function spoken(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => {
    n.remove();
  });
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
  chatState = baseChat();
});

describe('the approval gate says what is about to happen, and what has not', () => {
  it('names the consequence in a sentence, quotes the control, and says where', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });

    const card = dock();
    expect(card.textContent).toContain('Confirm before continuing');
    expect(screen.getByText('The AI wants to make a purchase.')).toBeTruthy();
    expect(card.textContent).toContain('Its next step taps');

    // The replica is the control on the phone, not a control here: it carries a
    // `title` because it is allowed to ellipsis, and it is not a button.
    const replica = screen.getByTitle('Place order · $104.00');
    expect(replica.textContent).toBe('Place order · $104.00');
    expect(replica.tagName).toBe('SPAN');

    expect(card.textContent).toContain('on shop.example.com');
  });

  it('⛔ answers "has it already happened?" before it asks for a decision', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Nothing has been bought.')).toBeTruthy();
    expect(dock().textContent).toContain('The iPhone stays on this page until you decide.');
  });

  it('⛔ drops the "stays on this page" promise once the session has gone', () => {
    // The phone is not sitting on that page any more. The first sentence is
    // still true; the second would be a promise about something that ended.
    chatState = halted('purchase', 'Place order · $104.00', { session: null });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Nothing has been bought.')).toBeTruthy();
    expect(dock().textContent).not.toContain('The iPhone stays on this page');
  });

  it('keeps Deny and Approve under exactly those names, in that order, with one line each', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const deny = screen.getByRole('button', { name: 'Deny' });
    const approve = screen.getByRole('button', { name: 'Approve' });
    // DOM order is focus order: Deny before Approve.
    expect(deny.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dock().textContent).toContain(
      'Approve runs this one step and carries on. Deny stops the task here.',
    );
    expect(deny).toBeEnabled();
    expect(approve).toBeEnabled();
  });

  it('disables both while a send is in flight — the decision has already been taken', () => {
    chatState = { ...halted('purchase'), sending: true };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('⛔ never names how the step was selected', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const card = dock();
    expect(card.textContent ?? '').not.toContain('#place-order');
    expect(card.textContent ?? '').not.toContain('selector');
    // …and no attribute smuggles it in either (the replica's own `title` is the
    // matched text, which is what the customer sees on the phone).
    for (const el of card.querySelectorAll('*')) {
      for (const attr of ['title', 'aria-label', 'data-selector']) {
        expect(el.getAttribute(attr) ?? '').not.toContain('#place-order');
      }
    }
  });

  it('⛔ the ticking wait never reaches the ear — `role="alert"` is atomic', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const card = dock();
    // The eye reads it…
    expect(card.textContent).toContain('paused');
    // …and it is inside an aria-hidden subtree, so a tick once a second does not
    // re-announce the whole card once a second.
    expect(spoken(card)).not.toContain('paused');
    expect(spoken(card)).toContain('The AI wants to make a purchase.');
  });

  it('says "Its next step:" when the held step is not a press', () => {
    chatState = halted('payment', 'Confirm payment', { action: 'type' });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(dock().textContent).toContain('Its next step:');
    expect(dock().textContent).not.toContain('Its next step taps');
  });

  it('⛔ omits the whole "on <host>" clause when nothing navigable is known', () => {
    // A wrong host beside a purchase is a claim about where the money is going.
    chatState = halted('purchase', 'Place order · $104.00', { navigated: false });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    // ⚠️ Measured on the ELEMENT, not on a ' on ' substring: the calm line says
    // "stays on this page" and the hint says "carries on", so a substring
    // assertion here passes for the wrong reason and fails for another.
    expect(dock().querySelector('.ai-dock-site')).toBeNull();
    expect(dock().textContent ?? '').not.toContain('example.com');
    // CONTROL — the rest of the card is unchanged, so this is measuring the
    // clause and not a card that failed to render.
    expect(screen.getByText('The AI wants to make a purchase.')).toBeTruthy();
  });

  it('⛔ names the page the phone reached, never the one it failed to reach', () => {
    // REVIEW REPAIR, stage 5, through the REAL view — so the wiring is measured
    // too, not just the pure function.
    chatState = {
      ...baseChat(),
      turns: [
        { id: 1, role: 'user', text: 'Buy the shoes' },
        haltedTurn([
          went('https://shop.example.com/cart', 'Opened the cart'),
          couldNotGo('https://checkout.other.example.com/pay', 'The page did not load'),
          gated('Place order · $104.00', 'purchase'),
        ]),
      ],
      pendingConfirmation: {
        turnId: 2,
        category: 'purchase',
        matchedText: 'Place order · $104.00',
      },
    };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const site = dock().querySelector('.ai-dock-site');
    expect(site?.textContent).toContain('shop.example.com');
    expect(dock().textContent ?? '').not.toContain('checkout.other.example.com');
  });
});

describe('the gate takes focus without stealing a draft', () => {
  it('takes focus when nothing had it — the next Tab reaches Deny', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(document.activeElement).toBe(dock());
    expect(dock().getAttribute('tabindex')).toBe('-1');
  });

  it('never lands on Approve', () => {
    chatState = halted('purchase');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Approve' }));
  });

  it('takes focus from an EMPTY composer — that caret was not being used', () => {
    // The chat is running, nothing is typed, and the customer's caret is parked
    // in the box. This is the ordinary case: Send leaves focus in the composer.
    const { rerender } = render(<AgentChatView />, { wrapper: AgentChatProvider });
    const composer = screen.getByLabelText('Message Driftstack AI');
    composer.focus();
    expect(document.activeElement).toBe(composer);
    chatState = halted('purchase');
    rerender(<AgentChatView />);
    expect(document.activeElement).toBe(dock());
  });

  it('⛔ leaves the caret alone when the customer is part-way through typing', () => {
    const { rerender } = render(<AgentChatView />, { wrapper: AgentChatProvider });
    const composer = screen.getByLabelText<HTMLTextAreaElement>('Message Driftstack AI');
    composer.focus();
    // ⚠️ Through the EVENT, not `composer.value = …`: the textarea is
    // controlled, so an imperative write is wiped by the next render and the
    // dock would then see an empty composer — the arm would pass for the
    // opposite reason to the one it is written for.
    fireEvent.change(composer, { target: { value: 'actually, use the other card' } });
    expect(composer.value).toBe('actually, use the other card');
    chatState = halted('purchase');
    rerender(<AgentChatView />);
    expect(document.activeElement).toBe(composer);
    expect(composer.value, 'the draft survives the gate').toBe('actually, use the other card');
    // CONTROL — the gate really is up; this is not a render that never happened.
    expect(screen.getByText('The AI wants to make a purchase.')).toBeTruthy();
  });
});

describe('the gate copy, per category, without a DOM', () => {
  it('names the consequence a customer can decide about', () => {
    expect(approvalVoice('purchase')).toBe('The AI wants to make a purchase.');
    expect(approvalVoice('payment')).toBe('The AI wants to make a payment.');
    expect(approvalVoice('account_deletion')).toBe('The AI wants to delete an account.');
  });

  it('⛔ a category this build has never heard of still produces a sentence', () => {
    // A newer server can send one. "confirmation_required: subscription_change"
    // is not English, and an empty card is worse than an awkward one.
    expect(approvalVoice('subscription_change')).toBe(
      'The AI wants to do something that needs your OK: subscription_change.',
    );
  });

  it('the calm line is in the perfect tense, negative, and never over-claims', () => {
    expect(approvalCalm('purchase')).toBe('Nothing has been bought.');
    expect(approvalCalm('payment')).toBe('Nothing has been paid.');
    expect(approvalCalm('account_deletion')).toBe('Nothing has been deleted.');
    // An unknown category may not be a purchase at all, so it says the weakest
    // true thing rather than the most reassuring one.
    expect(approvalCalm('subscription_change')).toBe('Nothing has happened yet.');
  });

  it('the host is the LAST navigation anywhere in the chat, and the hostname only', () => {
    const turns: ChatTurn[] = [
      haltedTurn([went('https://first.example.com/a', 'one')]),
      {
        ...haltedTurn([
          went('https://shop.example.com/', 'two'),
          went('https://shop.example.com/checkout?session=abc123', 'three'),
        ]),
        id: 4,
      },
    ];
    expect(confirmationHost(turns)).toBe('shop.example.com');
    // Nothing navigable at all, and nothing this build can parse, are the same
    // answer: an absence.
    expect(confirmationHost([])).toBeUndefined();
    expect(confirmationHost([haltedTurn([gated('Place order', 'purchase')])])).toBeUndefined();
    expect(confirmationHost([haltedTurn([went('not a url', 'four')])])).toBeUndefined();
  });

  it('⛔ a navigation that did not arrive is not where the phone is', () => {
    // REVIEW REPAIR, stage 5. A turn genuinely continues past a failure (the
    // server re-plans after a replannable one), so the LAST navigate intent in
    // the transcript and the page the browser is actually on come apart exactly
    // when a step went wrong — which is the moment this clause is read beside an
    // Approve button. Only a navigation that SUCCEEDED counts.
    const failedThenGated = [
      haltedTurn([
        went('https://shop.example.com/cart', 'Opened the cart'),
        couldNotGo('https://checkout.other.example.com/pay', 'The page did not load'),
        gated('Place order · $104.00', 'purchase'),
      ]),
    ];
    expect(confirmationHost(failedThenGated)).toBe('shop.example.com');
    // …and a navigation the executor never dispatched is the same absence.
    expect(
      confirmationHost([
        haltedTurn([
          went('https://shop.example.com/cart', 'Opened the cart'),
          gatedNavigate('https://checkout.other.example.com/pay', 'Pay now'),
        ]),
      ]),
    ).toBe('shop.example.com');
    // CONTROL — the same two hosts with the LATER one succeeding, and the later
    // one is named. So this pair is measuring `kind`, not the order of the list.
    expect(
      confirmationHost([
        haltedTurn([
          went('https://shop.example.com/cart', 'Opened the cart'),
          went('https://checkout.other.example.com/pay', 'Opened the payment page'),
          gated('Place order · $104.00', 'purchase'),
        ]),
      ]),
    ).toBe('checkout.other.example.com');
    // CONTROL — a failure is not simply skipped into silence either: with
    // nothing successful behind it there is no clause at all.
    expect(
      confirmationHost([
        haltedTurn([couldNotGo('https://checkout.other.example.com/pay', 'The page did not load')]),
      ]),
    ).toBeUndefined();
  });

  it('only a press or a tap earns the word "taps"', () => {
    const turns = [haltedTurn([gated('Place order', 'purchase', 'tap')])];
    expect(gatedStepTaps(turns, 2)).toBe(true);
    expect(gatedStepTaps([haltedTurn([gated('Place order', 'purchase', 'type')])], 2)).toBe(false);
    expect(gatedStepTaps([haltedTurn([gated('Place order', 'purchase', 'scroll')])], 2)).toBe(
      false,
    );
    // A turn id that is not in the list answers false rather than throwing.
    expect(gatedStepTaps(turns, 99)).toBe(false);
  });
});
