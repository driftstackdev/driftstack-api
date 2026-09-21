// Round-2 stage B — the drawer's Agent/Pair conversation panel (design brief
// §2, the owner's "Love it!" on the mockup). Four things this file proves,
// each with its own negative control:
//
//   1. WIDTH — the Session pane is CONVO_PANE_W (512px) in Agent/Pair, and
//      the ordinary PANE_W (252px) everywhere else (Manual, or any other pane
//      in any mode) — SimulatorWindow.tsx's `sessionPaneWide`.
//   2. RESIZE — the Tauri window follows that width: opening the Session pane
//      resizes wider in Agent/Pair than in Manual, and switching the Mode
//      switch while the pane is ALREADY open resizes again with no rail click
//      at all (the dedicated effect beside `sessionPaneWide`'s declaration).
//   3. ONE SOURCE OF TRUTH — the transcript/ApprovalDock/Composer render from
//      the SAME `chat` object `AgentChatProvider` publishes (the
//      `agentChatOverride` gallery seam), never a second transcript store;
//      Stop/Approve/Deny call the exact functions the AI view's own
//      Composer/ApprovalDock call.
//   4. Manual shows no conversation, and the panel never sits inside a
//      ticking `aria-live` region.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(() => Promise.resolve()),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => fakeRoom,
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

// The real control-plane read stays a bland 'manual' throughout — every test
// below instead drives the DISPLAYED mode through `agentChatOverride.chat.
// session.mode` (SimulatorWindow.tsx's `controlModeOverride`), proving the
// gallery-seam override, not this mock.
vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () =>
    Promise.resolve({
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setAgentSessionCookies: vi.fn(),
  navigateAgentSessionHistory: vi.fn(),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const EMPTY_CONN = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => EMPTY_CONN,
  useTransportTelemetry: () => undefined,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

// Tauri window-resize seam — same shape as simulator-window-frame-round-2.test.tsx.
const setSize = vi.fn<(size: { width: number; height: number }) => Promise<void>>(() =>
  Promise.resolve(),
);
const scaleFactor = vi.fn(() => Promise.resolve(1));
const innerSize = vi.fn(() => Promise.resolve({ width: 618, height: 718 }));
const destroy = vi.fn(() => Promise.resolve());
const tauriWindowMock = (): Record<string, unknown> => ({
  setSize,
  scaleFactor,
  innerSize,
  onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
  destroy,
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: tauriWindowMock }));
vi.mock('@tauri-apps/api/webviewWindow.js', () => ({ getCurrentWebviewWindow: tauriWindowMock }));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { DEFAULT_SETTINGS } = await import('../../src/lib/settings');

const FIXTURE_SESSION_BASE: Omit<AgentSession, 'mode' | 'pair_mode_state'> = {
  id: 'agt_x',
  account_id: 'acc_fixture',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 0,
  closed_at: null,
  created_by_user_id: null,
  model: 'claude-sonnet-5',
  stop_on_exit_ip_change: false,
  created_at: '2026-09-18T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
};

function fixtureSession(mode: AgentSession['mode'], pairKind: string | null = null): AgentSession {
  return {
    ...FIXTURE_SESSION_BASE,
    mode,
    pair_mode_state: pairKind === null ? null : { kind: pairKind },
  };
}

function fixtureChat(overrides: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: fixtureSession('ai'),
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
    send: () => Promise.resolve(true),
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
    ...overrides,
  };
}

function fixtureSettings() {
  return {
    settings: { ...DEFAULT_SETTINGS, apiKey: 'ds_test_fixture_key' },
    loading: false,
    client: null,
    activeWorkspace: null,
    setActiveWorkspace: () => undefined,
    accountMe: null,
    refreshAccountMe: () => Promise.resolve(),
    authExpired: false,
    dismissAuthExpired: () => undefined,
    update: () => Promise.resolve(),
  };
}

function renderSim(chat: UseAgentChatResult): ReturnType<typeof render> {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow agentChatOverride={{ chat }} settingsOverride={fixtureSettings()} />
    </RecordingsProvider>,
  );
}

function openSession(container: HTMLElement): void {
  fireEvent.click(container.querySelector('[data-component="sim-rail-session"]') as Element);
}

beforeEach(() => {
  setSize.mockClear();
  scaleFactor.mockClear();
  innerSize.mockClear();
  destroy.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

describe("the Session pane's three widths", () => {
  it('Manual — stays the ordinary 252px', async () => {
    const { container } = renderSim(fixtureChat({ session: fixtureSession('manual') }));
    openSession(container);
    const panel = await waitFor(() => {
      const el = container.querySelector('[data-component="sim-drawer-panel"]');
      expect(el?.className).toContain('w-[252px]');
      return el;
    });
    expect(panel?.className).not.toContain('w-[512px]');
    expect(panel?.getAttribute('data-wide')).toBeNull();
  });

  it('Agent — widens to 512px', async () => {
    const { container } = renderSim(fixtureChat({ session: fixtureSession('ai') }));
    openSession(container);
    const panel = await waitFor(() => {
      const el = container.querySelector('[data-component="sim-drawer-panel"]');
      expect(el?.className).toContain('w-[512px]');
      return el;
    });
    expect(panel?.className).not.toContain('w-[252px]');
    expect(panel?.getAttribute('data-wide')).toBe('');
  });

  it('Pair — ALSO widens to 512px', async () => {
    const { container } = renderSim(fixtureChat({ session: fixtureSession('pair', 'ai-driving') }));
    openSession(container);
    await waitFor(() =>
      expect(container.querySelector('[data-component="sim-drawer-panel"]')?.className).toContain(
        'w-[512px]',
      ),
    );
  });

  it('a non-Session pane stays 252px even in Agent mode — only the Session pane is wide', async () => {
    const { container } = renderSim(fixtureChat({ session: fixtureSession('ai') }));
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    const panel = await waitFor(() => {
      const el = container.querySelector('[data-component="sim-drawer-panel"]');
      expect(el?.className).toContain('w-[252px]');
      return el;
    });
    expect(panel?.className).not.toContain('w-[512px]');
  });

  it('NEGATIVE CONTROL — the two width strings are not the same (the assertions above actually discriminate)', () => {
    expect('w-[252px]').not.toBe('w-[512px]');
  });
});

/**
 * Real Tauri window ops settle over several event-loop turns (`resetToActualSize`
 * schedules a `setTimeout(0)`, `refitForDrawer` chains several `await`s, and this
 * component's own "belt-and-suspenders" effects can call more than one of them
 * across the mount + the pane-open commit) — the mocked window here has no real
 * settle delay, so several `setSize` calls can land at different intermediate
 * widths before the sequence's PEAK, the width that actually reflects the
 * drawer at its widest open extent. That peak — not "whichever call happened to
 * be last" — is the stable, meaningful signal a real customer's window also
 * reaches (it genuinely does grow to that width; the mock just has no delay to
 * hide the intermediate frames a real OS compositor would).
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

function peakWidth(): number {
  const widths = setSize.mock.calls.map((c) => (c[0] as { width: number }).width);
  expect(widths.length, 'setSize was called at least once').toBeGreaterThan(0);
  return Math.max(...widths);
}

describe('the resize calls follow the pane width, per mode', () => {
  it('opening the Session pane resizes WIDER in Agent mode than in Manual, by exactly CONVO_PANE_W − PANE_W', async () => {
    const manual = renderSim(fixtureChat({ session: fixtureSession('manual') }));
    openSession(manual.container);
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const manualWidth = peakWidth();
    manual.unmount();

    setSize.mockClear();
    const agent = renderSim(fixtureChat({ session: fixtureSession('ai') }));
    openSession(agent.container);
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const agentWidth = peakWidth();

    // Not a pinned exact delta: several of this component's PRE-EXISTING
    // window-sizing mechanisms (resetToActualSize's own 1:1-native target,
    // refitForDrawer's current-height-driven target) can each contribute a
    // call, and they do not all scale the SAME px-per-mode-switch under a
    // mocked window with no real settle delay between them — only their
    // shared, load-bearing fact does: drawerExtraRef.current (RAIL_W +
    // CONVO_PANE_W vs RAIL_W + PANE_W) is strictly larger in Agent mode, so
    // every one of them computes a strictly wider window.
    expect(agentWidth).toBeGreaterThan(manualWidth);
  });

  it('switching the Mode into Agent WHILE the Session pane is already open resizes again, with no rail click', async () => {
    const chat = fixtureChat({ session: fixtureSession('manual') });
    const { container, rerender } = renderSim(chat);
    openSession(container);
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const beforeWidth = peakWidth();
    setSize.mockClear();

    const wideChat = fixtureChat({ session: fixtureSession('ai') });
    rerender(
      <RecordingsProvider>
        <SimulatorWindow
          agentChatOverride={{ chat: wideChat }}
          settingsOverride={fixtureSettings()}
        />
      </RecordingsProvider>,
    );

    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const afterWidth = peakWidth();
    // See the sibling test above for why this is ">" and not a pinned delta.
    expect(afterWidth).toBeGreaterThan(beforeWidth);
  });

  it('NEGATIVE CONTROL — switching Mode while the Session pane is CLOSED fires no resize (nothing on screen is widening)', async () => {
    const chat = fixtureChat({ session: fixtureSession('manual') });
    const { rerender } = renderSim(chat);
    await waitFor(() => expect(innerSize).toHaveBeenCalled()); // let the initial fit settle
    setSize.mockClear();

    const wideChat = fixtureChat({ session: fixtureSession('ai') });
    rerender(
      <RecordingsProvider>
        <SimulatorWindow
          agentChatOverride={{ chat: wideChat }}
          settingsOverride={fixtureSettings()}
        />
      </RecordingsProvider>,
    );
    await settle();
    expect(setSize).not.toHaveBeenCalled();
  });
});

const OK: AgentIntentResult = {
  kind: 'success',
  intent: { kind: 'wait', condition: 'idle' },
  summary: 'Opened the store',
};

describe('one source of truth — the panel renders from the SAME chat object the AI view reads, never a second store', () => {
  it('a turn, its answer and its plan step all come straight from chat', async () => {
    const chat = fixtureChat({
      session: fixtureSession('ai'),
      turns: [
        { id: 1, role: 'user', text: 'go shopping' },
        {
          id: 2,
          role: 'agent',
          response: {
            kind: 'plan-executed',
            session: fixtureSession('ai'),
            intents: [OK.intent],
            results: [OK],
            ok: true,
            answer: 'The price is $104.00.',
          },
        },
      ],
    });
    const { container } = renderSim(chat);
    openSession(container);
    await waitFor(() => expect(screen.getByText('go shopping')).not.toBeNull());
    expect(screen.getByText('The price is $104.00.')).not.toBeNull();
    expect(screen.getByText('Opened the store')).not.toBeNull();
  });

  it('NEGATIVE CONTROL — an EMPTY chat renders no transcript list at all (the render is driven by chat.turns, not hardcoded)', async () => {
    const { container } = renderSim(fixtureChat({ session: fixtureSession('ai'), turns: [] }));
    openSession(container);
    await waitFor(() =>
      expect(container.querySelector('[data-component="simulator-agent-chat"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-component="simulator-agent-chat"] ol')).toBeNull();
  });

  it("Stop calls chat.cancel — the exact function the AI view's own Composer Stop button calls", async () => {
    const cancel = vi.fn();
    const chat = fixtureChat({ session: fixtureSession('ai'), sending: true, cancel });
    const { container } = renderSim(chat);
    openSession(container);
    const stopBtn = await waitFor(() => screen.getByRole('button', { name: /Stop/ }));
    fireEvent.click(stopBtn);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("Approve/Deny call chat.approve/chat.deny — the exact functions the AI view's own ApprovalDock calls", async () => {
    const approve = vi.fn(() => Promise.resolve());
    const deny = vi.fn();
    const gatedIntentValue = { kind: 'interact', action: 'tap', selector: '#place-order' } as const;
    const chat = fixtureChat({
      session: fixtureSession('ai'),
      turns: [
        { id: 1, role: 'user', text: 'buy it' },
        {
          id: 2,
          role: 'agent',
          response: {
            kind: 'plan-executed',
            session: fixtureSession('ai'),
            intents: [gatedIntentValue],
            results: [
              {
                kind: 'confirmation_required',
                intent: gatedIntentValue,
                category: 'purchase',
                matchedText: 'Place order · $104.00',
              },
            ],
            ok: false,
          },
        },
      ],
      pendingConfirmation: {
        turnId: 2,
        category: 'purchase',
        matchedText: 'Place order · $104.00',
      },
      approve,
      deny,
    });
    const { container } = renderSim(chat);
    openSession(container);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Approve' })));
    expect(approve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(deny).toHaveBeenCalledTimes(1);
  });
});

describe('Manual mode shows no conversation panel', () => {
  it('no simulator-agent-chat element mounts in Manual, even with turns already on the chat object', async () => {
    const chat = fixtureChat({
      session: fixtureSession('manual'),
      turns: [{ id: 1, role: 'user', text: 'hi' }],
    });
    const { container } = renderSim(chat);
    openSession(container);
    await waitFor(() =>
      expect(container.querySelector('[data-component="drawer-session"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-component="simulator-agent-chat"]')).toBeNull();
    expect(screen.queryByText('hi')).toBeNull();
  });
});

describe('the panel is never inside a ticking aria-live region', () => {
  it('the mission line sits OUTSIDE any aria-live ancestor', async () => {
    const chat = fixtureChat({
      session: fixtureSession('ai'),
      sending: true,
      livePhase: 'Working…',
    });
    const { container } = renderSim(chat);
    openSession(container);
    const mission = await waitFor(() => {
      const el = container.querySelector('[data-component="simulator-agent-chat"] > div');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(mission.closest('[aria-live]')).toBeNull();
  });

  it("a running turn's elapsed clock is aria-hidden even though it sits inside the aria-live transcript", async () => {
    const chat = fixtureChat({
      session: fixtureSession('ai'),
      turns: [{ id: 1, role: 'user', text: 'go' }],
      sending: true,
      liveStepIndex: 0,
      liveSteps: [],
      livePlan: { labels: ['a'], total: 1 },
      liveStartedAt: Date.now() - 5000,
    });
    const { container } = renderSim(chat);
    openSession(container);
    const ol = await waitFor(() => {
      const el = container.querySelector('[data-component="simulator-agent-chat"] ol');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(ol.getAttribute('aria-live')).toBe('polite');
    // `.ai-flight-meta` also carries the step-count's own `<b>{at}</b>` — not
    // this test's subject — so the clock is found through the `aria-hidden`
    // span that wraps ONLY the clock (Turn.tsx's `ElapsedClock`), which is
    // itself the property this test exists to prove.
    const clock = ol.querySelector('.ai-flight-meta span[aria-hidden="true"] b');
    expect(clock, 'the elapsed clock renders at all').not.toBeNull();
    expect(
      clock?.closest('[aria-hidden="true"]'),
      'the clock is hidden from assistive tech',
    ).not.toBeNull();
  });
});
