// ⛔ THE VIDEO ELEMENT SURVIVES THE LAYOUT.
//
// Stage 4 of the AI-view rebuild (spec §9 stage 4's named test). The stage
// wraps `AgentSessionPanel` — a LiveKit room with a `<video>` in it — in a
// device frame that is keyed on chat state: a room light that changes hue, a
// rim that takes the phase's colour, a Dynamic Island that belongs to the
// product shot, side keys, a caption, a HUD chip, and five reflow tiers that
// re-cut the whole view. Every one of those is a chance to accidentally
// REMOUNT the panel, and a remount is not cosmetic: the panel's connect effect
// depends on `[ws_url, token, retryNonce]`, so the room reconnects and the
// customer watches the video go black and come back. It is the one defect in
// this stage that a screenshot cannot show, because each frame looks right.
//
// React remounts a child when its position among its siblings changes, when its
// key changes, or when a conditional WRAPPER appears or disappears around it.
// So this holds the identity of three elements — the device frame, the screen
// box and the panel itself — across the three things that change beneath them:
//
//   1. a REFLOW (the view crosses a tier boundary),
//   2. a PHASE CHANGE (idle → acting → done, which re-hues the room),
//   3. a COLLAPSE and re-open of the stage.
//
// ⚠️ ONE OF THE THREE IS DELIBERATELY DIFFERENT, and the arm says so: across a
// collapse the FRAME survives but the PANEL does not, because "invisible ⇒ no
// token fetch, no room, no poll" (spec §3.4) is a promise this stage keeps. A
// hidden WebRTC room ran for the length of a whole chat before the 2026-07-08
// audit found it. The frame surviving is what makes re-opening instant; the
// stream not surviving is what makes collapsing worth doing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentIntent, AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  livekitToken: vi.fn<(id: string) => Promise<{ ws_url: string; room: string; token: string }>>(),
  getSession: vi.fn<(id: string) => Promise<unknown>>(),
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
  id: 'agt_stage',
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
function ran(summary: string): AgentIntentResult {
  return { kind: 'success', intent: navigate('https://shop.example.com/'), summary };
}
function doneTurn(): ChatTurn {
  return {
    id: 2,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session: SESSION,
      intents: [navigate('https://shop.example.com/')],
      results: [ran('Opened the store')],
      ok: true,
    },
  };
}

/** A complete hook result, so this file adds nothing to the type census. */
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

/** A ResizeObserver whose observed elements can be RE-SIZED from a test, so the
 *  view can be driven across a tier boundary the way a window resize does. */
const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
function installResizeObserver(): void {
  class DrivableResizeObserver {
    private readonly entry: { cb: ResizeObserverCallback; targets: Element[] };
    constructor(cb: ResizeObserverCallback) {
      this.entry = { cb, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element): void {
      this.entry.targets.push(target);
    }
    unobserve(): void {
      /* nothing to stop */
    }
    disconnect(): void {
      this.entry.targets.length = 0;
    }
  }
  vi.stubGlobal('ResizeObserver', DrivableResizeObserver);
}

/** Report `width x height` to every live observer — one resize frame. */
function resizeTo(width: number, height: number): void {
  act(() => {
    for (const o of observers) {
      for (const target of o.targets) {
        o.cb(
          [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
    }
  });
}

function frame(): Element | null {
  return document.querySelector('.ai-device');
}
function screenBox(): Element | null {
  return document.querySelector('.ai-device-screen');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  observers.length = 0;
  h.livekitToken.mockResolvedValue({ ws_url: 'ws://x', room: 'r', token: 't' });
  h.getSession.mockResolvedValue(SESSION);
  chatState = baseChat();
});
afterEach(cleanup);

describe('the iPhone does not remount when the window does', () => {
  it('⛔ holds the frame, the screen and the panel across a REFLOW', async () => {
    installResizeObserver();
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByTestId('agent-session-panel')).toBeTruthy());

    // A 1600x1000 window, then the 960x600 minimum: across the narrow boundary,
    // which re-cuts the rail, the bar, the stage width and the phone's size.
    resizeTo(1376, 964);
    const beforeFrame = frame();
    const beforeScreen = screenBox();
    const beforePanel = screen.getByTestId('agent-session-panel');
    expect(document.querySelector('[data-ai-narrow]')).toBeNull();

    resizeTo(736, 564);

    // The tier really did change — without this the arm below is vacuous.
    expect(document.querySelector('[data-ai-narrow]')).not.toBeNull();
    expect(frame()).toBe(beforeFrame);
    expect(screenBox()).toBe(beforeScreen);
    expect(screen.getByTestId('agent-session-panel')).toBe(beforePanel);
    // …and the stream was fetched ONCE, for one session.
    expect(h.livekitToken).toHaveBeenCalledTimes(1);
  });

  it('⛔ holds them across a PHASE CHANGE, which re-hues the whole room', async () => {
    const { rerender } = render(<AgentChatView />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByTestId('agent-session-panel')).toBeTruthy());
    const beforeFrame = frame();
    const beforeScreen = screenBox();
    const beforePanel = screen.getByTestId('agent-session-panel');
    expect(document.querySelector('[data-ai-phase]')?.getAttribute('data-ai-phase')).toBe('idle');

    // idle → acting: the room breathes, the rim takes the accent, the caption
    // becomes "Now · …" and the HUD chip becomes LIVE.
    chatState = baseChat({
      sending: true,
      liveStepIndex: 1,
      livePlan: { labels: ['Opened the store', 'Searched the store'], total: 2 },
      liveSteps: [ran('Opened the store')],
    });
    rerender(<AgentChatView />);
    expect(document.querySelector('[data-ai-phase]')?.getAttribute('data-ai-phase')).toBe('acting');

    // acting → done: the green bloom, a different caption again.
    chatState = baseChat({ turns: [doneTurn()] });
    rerender(<AgentChatView />);
    await waitFor(() =>
      expect(document.querySelector('[data-ai-phase]')?.getAttribute('data-ai-phase')).toBe('done'),
    );

    expect(frame()).toBe(beforeFrame);
    expect(screenBox()).toBe(beforeScreen);
    expect(screen.getByTestId('agent-session-panel')).toBe(beforePanel);
    expect(h.livekitToken).toHaveBeenCalledTimes(1);
  });

  it('⛔ holds the FRAME across a collapse and re-open — and drops the STREAM, on purpose', async () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByTestId('agent-session-panel')).toBeTruthy());
    const beforeFrame = frame();
    const beforeScreen = screenBox();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle live view' }));

    // Collapsed: the frame is still THERE (it is `hidden`, not unmounted), and
    // the stream is gone — no room, no poll, nothing running behind a pane
    // nobody can see.
    expect(frame()).toBe(beforeFrame);
    expect(screenBox()).toBe(beforeScreen);
    expect(screen.queryByTestId('agent-session-panel')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle live view' }));
    await waitFor(() => expect(screen.getByTestId('agent-session-panel')).toBeTruthy());

    // The frame never moved, so re-opening is a paint, not a rebuild…
    expect(frame()).toBe(beforeFrame);
    expect(screenBox()).toBe(beforeScreen);
    // …and the token WAS fetched again, which is the honest cost of having
    // stopped the stream. (Two calls: one per visible window.)
    expect(h.livekitToken).toHaveBeenCalledTimes(2);
  });

  it('⛔ a WebView with no `cq` units still gets a phone, from the same arithmetic', async () => {
    // Spec §1's fallback. `.ai-fit` sizes the device with `100cqw` / `100cqh`,
    // and two shipping WebViews (macOS 12 WKWebView, the oldest WebKitGTK) have
    // no container-query units at all — there the `min()` resolves to nothing
    // usable and the phone would collapse. `use-device-fit` writes
    // `--ai-phone-w` instead, and the `var()` fallback never runs.
    //
    // jsdom has no `CSS.supports`, which is exactly the "cannot do cq units"
    // case, so this is that path.
    installResizeObserver();
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByTestId('agent-session-panel')).toBeTruthy());
    resizeTo(348, 600); // the `.ai-fit` box at the 1280x800 default
    const fit = document.querySelector('.ai-fit');
    // 348 - 36 gutter = 312 by width; (600 - 8) / 2.0943 = 282.6 by height.
    expect(fit?.getAttribute('style')).toContain('--ai-phone-w: 282.6');
  });

  it('the device frame is never conditional: the island and the keys are always in the DOM', async () => {
    render(<AgentChatView />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByTestId('agent-session-panel')).toBeTruthy());
    // With a stream mounted the island is not DRAWN (CSS keys it on
    // `data-ai-rig="rest"`) — but it is still a slot beside the screen, because
    // a sibling that comes and goes is how a video gets remounted.
    expect(document.querySelector('.ai-island')).not.toBeNull();
    expect(document.querySelectorAll('.ai-key')).toHaveLength(4);
    expect(document.querySelector('[data-ai-rig="rest"]')).toBeNull();
  });
});
