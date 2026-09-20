// The composer is five rows on an empty screen and three in a conversation —
// and `rows` is 5 in both.
//
// Coordinator's §12 D1, from the owner on 2026-08-31 ("the text bar should be
// larger"): an empty chat opens a five-row box because the composer IS the
// page; a chat with turns rests at three, because the transcript above it is
// now the thing to read, and opens back to five the moment the caret lands in
// it; a customer WATCHING (a run in flight, or an approval waiting) with
// nothing typed gets two, because they are not writing. D6 gives the fifth row
// back to the templates in a window too short to spare it.
//
// ⛔ ALL OF IT IS STYLE. `rows={COMPOSER_ROWS}` stays 5 in every state, because
// `rows` is the height a browser falls back to when CSS says nothing — and the
// autogrow has to measure from `0px` rather than `auto` for exactly that
// reason: `auto` on a textarea resolves to the `rows` height, so a three-row
// composer measured from `auto` reports five rows of content it does not have
// and snaps open on the first keystroke. jsdom has no layout, so the rest
// heights are measured as the DATA that drives them (`data-rest`) and the
// autogrow is measured by watching WHICH height it reads `scrollHeight` at.
//
// NEGATIVE CONTROLS (each run, each seen red, each restored):
//  · put `'auto'` back in `growComposerToFit` → the measure-from-0px arm reds.
//  · delete the empty-draft height reset effect → the "a sent message does not
//    leave the box tall" arm reds.
//  · make the caption chain show 'enter-to-send' while sending → the Stop
//    sentence arm reds.
//  · put `&& !confirmationPending` back on the Stop button → the "a send
//    started instead of approving can still be stopped" arm reds while the
//    halted arm stays green.
//  · (stage-5 review) put the duplicated `  ⏎ to send · ⇧⏎ for a new line` tail
//    back on `EMPTY_CHAT_PROMPT` → the "does not tell the customer how to send
//    twice" arm reds on three assertions, and both of its CONTROLS stay green.
//  · (stage-5 review) move `confirmationPending` back above the two proxy arms
//    in `composerCaption` → the "never invites a send the button is refusing"
//    arm reds on both blockers, while its CONTROL (a healthy proxy) stays green.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
  upsertChat: vi.fn<(chat: { id: string; model: string }, now: number) => Promise<unknown[]>>(),
}));

vi.mock('../../src/lib/SettingsContext', () => {
  const client = {
    profiles: {
      iterate: function* () {
        /* no profiles — proxyState settles to 'none' */
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
const { COMPOSER_MAX_HEIGHT_PX, COMPOSER_ROWS, growComposerToFit, composerRest, composerCaption } =
  await import('../../src/views/agent-chat/Composer');

// ─── fixtures ────────────────────────────────────────────────────────────────

function gated(matchedText: string): AgentIntentResult {
  return {
    kind: 'confirmation_required',
    intent: { kind: 'interact', action: 'tap', selector: '#place-order' },
    category: 'purchase',
    matchedText,
  };
}

function turns(results: ReadonlyArray<AgentIntentResult>): ChatTurn[] {
  return [
    { id: 1, role: 'user', text: 'Buy the shoes' },
    {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: SESSION,
        intents: results.map((r) => r.intent),
        results,
        ok: false,
      },
    },
  ];
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

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>('Message Driftstack AI');
}

function restOf(): string | null {
  return document.querySelector('.ai-cmd')?.getAttribute('data-rest') ?? null;
}

/** A ResizeObserver that reports ONE height, synchronously, on observe(). jsdom
 *  has none at all, which is the "not measured" case the hook defaults to. */
function fakeResizeObserver(height: number): typeof ResizeObserver {
  class FakeResizeObserver {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      const entry = {
        target,
        contentRect: { height, width: 800 },
      } as unknown as ResizeObserverEntry;
      this.cb([entry], this);
    }
    unobserve(): void {
      /* nothing to stop */
    }
    disconnect(): void {
      /* nothing to stop */
    }
  }
  return FakeResizeObserver;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  h.upsertChat.mockResolvedValue([]);
  chatState = baseChat();
});

describe('the composer rests at the height the moment deserves', () => {
  it('an empty chat gets the whole box — and `rows` is still 5', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(restOf()).toBe('idle');
    expect(composer().getAttribute('rows')).toBe(String(COMPOSER_ROWS));
    expect(COMPOSER_ROWS).toBe(5);
  });

  it('a chat with turns rests smaller, so the transcript keeps the room', () => {
    chatState = { ...baseChat(), turns: turns([gated('Place order · $104.00')]) };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(restOf()).toBe('chat');
    // ⛔ THE ATTRIBUTE DOES NOT MOVE. If a future stage "fixes" the rest height
    // by changing `rows`, the autogrow's measurement floor moves with it.
    expect(composer().getAttribute('rows')).toBe(String(COMPOSER_ROWS));
  });

  it('a customer WATCHING with nothing typed gets the smallest box', () => {
    chatState = { ...baseChat(), turns: turns([gated('Place order · $104.00')]), sending: true };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(restOf()).toBe('watch');
  });

  it('an approval waiting is watching too — until the customer starts typing', () => {
    chatState = {
      ...baseChat(),
      turns: turns([gated('Place order · $104.00')]),
      pendingConfirmation: {
        turnId: 2,
        category: 'purchase',
        matchedText: 'Place order · $104.00',
      },
    };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(restOf()).toBe('watch');
    // "Or send a new instruction instead of approving." — the moment they take
    // that path the box is for writing again.
    fireEvent.change(composer(), { target: { value: 'use the other card instead' } });
    expect(restOf()).toBe('chat');
  });

  it('D6 — a short view gives the fifth row back to the templates', () => {
    vi.stubGlobal('ResizeObserver', fakeResizeObserver(600));
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(document.querySelector('.ai-cmd')?.hasAttribute('data-short')).toBe(true);
  });

  it('⛔ a tall view carries NO data-short — the attribute is valueless', () => {
    // `data-short={false}` renders as the string 'false', which a valueless
    // `[data-short]` selector still matches. It has to be absent, not false.
    vi.stubGlobal('ResizeObserver', fakeResizeObserver(764));
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const cmd = document.querySelector('.ai-cmd');
    expect(cmd?.hasAttribute('data-short')).toBe(false);
    expect(cmd?.getAttribute('data-short')).toBeNull();
  });

  it('nothing to measure with is NOT short — an unmeasured view keeps the tall layout', () => {
    // jsdom has no ResizeObserver. A WebView without one must not get the
    // 600px-window layout on a 1600px window.
    expect(typeof ResizeObserver).toBe('undefined');
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(document.querySelector('.ai-cmd')?.hasAttribute('data-short')).toBe(false);
  });
});

describe('the composer grows from what is in it, not from its rows attribute', () => {
  it('⛔ measures scrollHeight at height 0, never at `auto`', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const el = composer();
    const readAt: string[] = [];
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get() {
        readAt.push(el.style.height);
        return 120;
      },
    });
    growComposerToFit(el);
    // `auto` here resolves to the FIVE-row attribute height, so a three-row
    // composer would measure five rows of content it does not have.
    expect(readAt).toEqual(['0px']);
    expect(el.style.height).toBe('120px');
  });

  it('never grows past the one shared ceiling', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const el = composer();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 9999 });
    growComposerToFit(el);
    expect(el.style.height).toBe(`${String(COMPOSER_MAX_HEIGHT_PX)}px`);
  });

  it('⛔ a sent message does not leave the box the height of the message', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const el = composer();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 300 });
    fireEvent.change(el, { target: { value: 'go to example.com and read me the price' } });
    expect(el.style.height, 'the autogrow ran').toBe('300px');
    // Send clears the draft PROGRAMMATICALLY — no `onChange` fires — so without
    // the reset the box keeps 300px for ever and "rests at three rows" is true
    // only until the first send.
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(el.value).toBe('');
    expect(el.style.height, 'an empty box rests at its CSS height').toBe('');
  });
});

describe('the composer says what is available, and why, in one line', () => {
  it('the pinned caption is one text node, and still the default', () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeTruthy();
  });

  it('the placeholder still matches the regex six test files look it up by', () => {
    const { rerender } = render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByPlaceholderText(/Describe a task in plain English/i)).toBeTruthy();
    // …and in a conversation, where it becomes an invitation to follow up.
    chatState = { ...baseChat(), turns: turns([gated('Place order · $104.00')]) };
    rerender(<AgentChatView />);
    const followUp = screen.getByPlaceholderText(/Describe a task in plain English/i);
    expect(followUp.getAttribute('placeholder')).toBe(
      'Ask a follow-up, or describe a task in plain English…',
    );
  });

  it('⛔ does not tell the customer how to send twice in one box', () => {
    // REVIEW REPAIR, stage 5. Today's placeholder ended `…screenshot the
    // result.”  ⏎ to send · ⇧⏎ for a new line`, written when the foot had no
    // caption of its own; the foot now says the same thing in words thirty
    // pixels below it. The mockup — the decided design — ends the placeholder at
    // `result.”` and leaves the hint to the foot alone.
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const box = screen.getByPlaceholderText(/Describe a task in plain English/i);
    const prompt = box.getAttribute('placeholder') ?? '';
    expect(prompt).not.toContain('to send');
    expect(prompt).not.toContain('new line');
    expect(prompt).not.toContain('⏎');
    expect(prompt.endsWith('screenshot the result.”'), prompt.slice(-30)).toBe(true);
    // CONTROL ONE — the example prompt itself, the part the "verbatim" rule was
    // protecting, is untouched. Without this the arm passes for an empty box.
    expect(prompt).toBe(
      'Describe a task in plain English — e.g. “Go to example.com, accept the cookie banner, then search for ‘pricing’ and screenshot the result.”',
    );
    // CONTROL TWO — the instruction did not disappear from the screen, it moved
    // to the one place that owns it.
    expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeTruthy();
  });

  it('⛔ while a turn runs it says what Stop actually does', () => {
    chatState = { ...baseChat(), turns: turns([gated('Place order · $104.00')]), sending: true };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(
      screen.getByText(
        'Stop ends the task after the current step. What already ran stays in the chat.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Enter to send · Shift+Enter for a new line')).toBeNull();
  });

  it('⛔ while the gate is up it offers the other path out', () => {
    chatState = {
      ...baseChat(),
      turns: turns([gated('Place order · $104.00')]),
      pendingConfirmation: {
        turnId: 2,
        category: 'purchase',
        matchedText: 'Place order · $104.00',
      },
    };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByText('Or send a new instruction instead of approving.')).toBeTruthy();
  });

  it('shows Send while the turn is halted — there is nothing to stop', () => {
    chatState = {
      ...baseChat(),
      turns: turns([gated('Place order · $104.00')]),
      pendingConfirmation: {
        turnId: 2,
        category: 'purchase',
        matchedText: 'Place order · $104.00',
      },
    };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^stop$/i })).toBeNull();
  });

  it('⛔ a send started INSTEAD of approving can still be stopped', () => {
    // The gate is up and a new instruction is running. `pendingConfirmation` is
    // still set (the halted turn is still the last AGENT turn), and a Stop here
    // is a real Stop — suppressing it takes away the only way to end the run.
    chatState = {
      ...baseChat(),
      turns: turns([gated('Place order · $104.00')]),
      pendingConfirmation: {
        turnId: 2,
        category: 'purchase',
        matchedText: 'Place order · $104.00',
      },
      sending: true,
    };
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const stop = screen.getByRole('button', { name: /^stop$/i });
    expect(stop.textContent, 'the icon inside it is aria-hidden and adds no word').toBe('Stop');
    fireEvent.click(stop);
    expect(chatState.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('the caption and the rest height, without a DOM', () => {
  const noProxy = { kind: 'none' } as const;
  const idle = {
    sending: false,
    stopping: false,
    stoppedTurnStillRunning: false,
    adopting: false,
    aiReady: true,
    confirmationPending: false,
    proxy: noProxy,
  };

  it('keeps today’s four notices ahead of the three new ones', () => {
    expect(composerCaption({ ...idle, sending: true, stopping: true }).kind).toBe('stopping');
    expect(composerCaption({ ...idle, stoppedTurnStillRunning: true }).kind).toBe(
      'still-finishing',
    );
    expect(composerCaption({ ...idle, adopting: true }).kind).toBe('adopting');
    expect(composerCaption({ ...idle, aiReady: false }).kind).toBe('not-connected');
    // …and an adopt with no key is still the key, exactly as before this stage.
    expect(composerCaption({ ...idle, aiReady: false, adopting: true }).kind).toBe('not-connected');
  });

  it('⛔ the blocked-proxy reason is the caption itself, so the id points at something real', () => {
    const blocked = composerCaption({
      ...idle,
      proxy: {
        kind: 'blocked',
        reason: 'This profile is set to use a proxy that no longer exists.',
      },
    });
    expect(blocked.kind).toBe('proxy-blocked');
    expect(blocked.kind === 'proxy-blocked' ? blocked.reason : '').toContain('no longer exists');
    expect(composerCaption({ ...idle, proxy: { kind: 'pending' } }).kind).toBe('proxy-pending');
    // A more urgent notice wins, and then the `aria-describedby` must NOT be
    // set — which is exactly what one decision, read twice, guarantees.
    expect(composerCaption({ ...idle, sending: true, proxy: { kind: 'pending' } }).kind).toBe(
      'stop-sentence',
    );
  });

  it('⛔ never invites a send the button is refusing', () => {
    // REVIEW REPAIR, stage 5. `proxy: blocked` and `proxy: pending` are both in
    // the Send button's own disabled list, so "Or send a new instruction instead
    // of approving." under one of them is the composer offering a control the
    // product has switched off, with the reason left in a hover title. A blocker
    // outranks an invitation — the same rank `not-connected` already had.
    const gateUp = { ...idle, confirmationPending: true };
    expect(composerCaption(gateUp).kind, 'nothing in the way: the invitation').toBe('approval');
    expect(
      composerCaption({
        ...gateUp,
        proxy: {
          kind: 'blocked',
          reason: 'This profile is set to use a proxy that no longer exists.',
        },
      }).kind,
    ).toBe('proxy-blocked');
    expect(composerCaption({ ...gateUp, proxy: { kind: 'pending' } }).kind).toBe('proxy-pending');
    // …and the no-key blocker still outranks both of them, as it always did.
    expect(composerCaption({ ...gateUp, aiReady: false }).kind).toBe('not-connected');
    // CONTROL — a proxy that is fine does not displace the invitation, so this
    // arm is measuring the blocker and not the presence of a `proxy` field.
    expect(composerCaption({ ...gateUp, proxy: { kind: 'ready' } }).kind).toBe('approval');
  });

  it('the rest height is decided by what the customer is doing, in that order', () => {
    expect(
      composerRest({
        sending: false,
        confirmationPending: false,
        hasTurns: false,
        draftEmpty: true,
      }),
    ).toBe('idle');
    expect(
      composerRest({
        sending: false,
        confirmationPending: false,
        hasTurns: true,
        draftEmpty: true,
      }),
    ).toBe('chat');
    expect(
      composerRest({ sending: true, confirmationPending: false, hasTurns: true, draftEmpty: true }),
    ).toBe('watch');
    expect(
      composerRest({ sending: false, confirmationPending: true, hasTurns: true, draftEmpty: true }),
    ).toBe('watch');
    // A draft outranks watching: they are writing, so give them the room.
    expect(
      composerRest({ sending: true, confirmationPending: true, hasTurns: true, draftEmpty: false }),
    ).toBe('chat');
  });
});
