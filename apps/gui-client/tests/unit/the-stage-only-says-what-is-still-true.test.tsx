// The stage stands beside a live video of the thing it is describing, so a
// sentence it gets wrong is visibly wrong.
//
// Stage 4 review. Two claims this file holds the view to, both of which it was
// making falsely when the stage first landed:
//
//   1. ⛔ "THE IPHONE IS STILL ON THIS PAGE" IS A CLAIM ABOUT A LIVE DEVICE.
//      The caption was fed `sessionActive`, which means only "a `session`
//      object exists on this chat" — true for the whole life of a chat whose
//      browser shut half an hour ago. Worse, the chip beside it read the 10s
//      poll's record ALONE (`liveSession`), which is `null` until the poll has
//      answered and after any transient GET failure, so a chat whose only
//      record said `status: 'closed'` lit the stage `SESSION OPEN` while the
//      bar three inches above it said `Ended`. Two derivations of one fact,
//      disagreeing on screen — the failure `stage-copy.ts`'s own header says it
//      exists to prevent.
//
//   2. ⛔ A RING IS AN ACTION THAT HAPPENED. `.ai-pulse` carried `is-firing`
//      unconditionally, so the one-shot played on every MOUNT: opening the view
//      or reopening a finished chat from the rail flashed an action ring out of
//      the bezel for a tap nobody made. Spec §4 item 7 fires it "per `onStep`".
//
// The positive controls matter as much as the arms: an OPEN session still says
// the phone is on the page, and a step that really landed still rings. A fix
// that just deleted both sentences would pass an arms-only version of this file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const OPEN_SESSION: AgentSession = {
  id: 'agt_truth',
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

/** The same session after the browser shut — the shape a chat holds once the
 *  device is gone and the poll has nothing newer to say. */
const CLOSED_SESSION: AgentSession = {
  ...OPEN_SESSION,
  status: 'closed',
  closed_reason: 'browser-closed',
  closed_at: '2026-06-15T06:41:00.000Z',
};

function navigate(url: string): AgentIntent {
  return { kind: 'navigate', url };
}

function success(summary: string): AgentIntentResult {
  return { kind: 'success', intent: navigate('https://shop.example.com/'), summary };
}

/** A turn that finished cleanly, so `missionPhase` is `done` and the caption is
 *  the one that names the page the phone is on. */
function finishedTurn(session: AgentSession): ChatTurn {
  const results = [success('Opened the store')];
  return {
    id: 2,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session,
      intents: results.map((r) => r.intent),
      results,
      ok: true,
    },
  };
}

function baseChat(over: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: OPEN_SESSION,
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

/** What the stage's chip says right now, as one word (or two). */
function chipText(): string {
  const chip = document.querySelector('.ai-chip-state');
  if (chip === null) throw new Error('the stage has no state chip');
  return (chip.textContent ?? '').trim();
}

/** The caption under the phone. */
function captionText(): string {
  const caption = document.querySelector('.ai-now');
  return (caption?.textContent ?? '').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  // ⛔ THE POLL NEVER ANSWERS IN THESE ARMS, WHICH IS THE POINT. A pending
  // promise is exactly the first frame after a send, and exactly what is left
  // after a transient GET failure — the window in which the chat's own record
  // is the only record there is.
  h.getSession.mockReturnValue(new Promise<AgentSession>(() => undefined));
});
afterEach(cleanup);

describe('the stage does not promise a device that has gone', () => {
  it('⛔ says ENDED, not SESSION OPEN, when the only record says the session closed', () => {
    chatState = baseChat({
      session: CLOSED_SESSION,
      turns: [finishedTurn(CLOSED_SESSION)],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(chipText()).toBe('ENDED');
  });

  it("⛔ and stops claiming the iPhone is still on the page once it isn't", () => {
    chatState = baseChat({
      session: CLOSED_SESSION,
      turns: [finishedTurn(CLOSED_SESSION)],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    // Spec §3.4: "Finished · the iPhone is still on this page" is used ONLY
    // while the session is active; otherwise the caption is "Finished" alone.
    expect(captionText()).toContain('Finished');
    expect(captionText()).not.toContain('still on this page');
  });

  it("agrees with the bar, which read the chat's record all along", () => {
    // The disagreement was the tell: one derivation took `liveSession ?? chat.session`
    // and the other took `liveSession` alone. Whatever the stage says, the pill
    // beside it has to be saying the same thing about the same session.
    chatState = baseChat({
      session: CLOSED_SESSION,
      turns: [finishedTurn(CLOSED_SESSION)],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const pill = document.querySelector('[data-component="agent-status-pill"]');
    expect((pill?.textContent ?? '').trim()).toContain('Ended');
    expect(chipText()).toBe('ENDED');
  });

  it('POSITIVE CONTROL — an open session still says the iPhone is on the page', async () => {
    // Without this arm the two above pass on a build that deleted the sentence.
    //
    // It has to WAIT, and the wait is itself the shape of the state: with a
    // session open the panel fetches a token, so the stage is `STARTING` for a
    // tick — and while it is starting the start-up strip legitimately replaces
    // the caption (spec §3.4). The claim under test is what the stage says once
    // the stream is up, which is the `done` scene the gallery renders.
    chatState = baseChat({
      session: OPEN_SESSION,
      turns: [finishedTurn(OPEN_SESSION)],
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    await waitFor(() => {
      expect(chipText()).toBe('SESSION OPEN');
    });
    expect(captionText()).toContain('the iPhone is still on this page');
  });
});

describe('the action ring fires for an action, and only for an action', () => {
  it('⛔ does not ring on mount when nothing has run', () => {
    chatState = baseChat();
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const pulse = document.querySelector('.ai-pulse');
    // The element is ALWAYS in the DOM — a sibling of the rig that came and
    // went is how a video gets remounted. Only its firing class is conditional.
    expect(pulse).not.toBeNull();
    expect(pulse?.className).not.toContain('is-firing');
  });

  it('POSITIVE CONTROL — rings once a step has actually landed', () => {
    chatState = baseChat({
      sending: true,
      liveSteps: [success('Opened the store')],
      liveStepIndex: 1,
      livePhase: 'Looking at the page…',
    });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    expect(document.querySelector('.ai-pulse')?.className).toContain('is-firing');
  });

  it('and the ring re-keys per step, so each action gets its own', () => {
    // A one-shot animation only replays if the element is new. The key is the
    // step count; two renders at the same count must NOT produce a new element,
    // or every unrelated re-render would flash a ring.
    chatState = baseChat({
      sending: true,
      liveSteps: [success('Opened the store')],
      liveStepIndex: 1,
    });
    const view = render(<AgentChatView />, { wrapper: AgentChatProvider });
    const first = document.querySelector('.ai-pulse');
    chatState = baseChat({
      sending: true,
      liveSteps: [success('Opened the store')],
      liveStepIndex: 1,
      livePhase: 'Reading the page…',
    });
    view.rerender(<AgentChatView />);
    expect(document.querySelector('.ai-pulse')).toBe(first);

    chatState = baseChat({
      sending: true,
      liveSteps: [success('Opened the store'), success('Accepted the cookie banner')],
      liveStepIndex: 2,
    });
    view.rerender(<AgentChatView />);
    expect(document.querySelector('.ai-pulse')).not.toBe(first);
    expect(document.querySelector('.ai-pulse')?.className).toContain('is-firing');
  });
});

describe('nothing in the stage is a live region — it duplicates the log', () => {
  it('the chip and the caption announce nothing on their own', () => {
    // The chip and caption both rewrite themselves as a run proceeds. If either
    // were a live region a screen-reader user would hear every phase twice:
    // once from the log's `aria-live` and once from here. (Re-checked after the
    // chip's wording moved in this review.)
    chatState = baseChat({ session: CLOSED_SESSION, turns: [finishedTurn(CLOSED_SESSION)] });
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    const stage = screen.getByRole('region', { name: 'Live view' });
    expect(stage.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(stage.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
  });
});
