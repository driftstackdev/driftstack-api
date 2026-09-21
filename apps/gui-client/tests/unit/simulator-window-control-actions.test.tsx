// SimulatorWindow — in-flight control-action feedback + session-swap safety.
//
// Own focused harness because the standalone Simulator swaps its sessionId in place
// (without remounting) and the real AgentSessionPanel requires a live WebRTC room.
//
// Round-2 stage B — the drawer's Agent/Pair composer is no longer this file's
// own `sendMessageMock`/`sendAgentMessage` raw POST: it is the AI view's own
// Composer, driven by the AI view's own `useAgentChat` hook (one source of
// truth — SimulatorAgentChat.tsx's own header explains why `chat.send()`
// replaces it). The two tests that used to exercise that composer through
// `sendMessageMock` now drive it through a FIXTURE `chat` published via
// `SimulatorWindow`'s own `agentChatOverride` gallery-seam prop (the same
// `AgentChatProvider value={…}` pattern `audit-scenes.tsx` uses for the AI
// view) — a hand-built `UseAgentChatResult` with a controllable `send`/
// `adopt`, exactly like `agent-chat-scenes.tsx`'s `baseChat()`. This proves
// SimulatorAgentChat's OWN wiring (it calls `chat.send`/`chat.adopt`
// correctly, clears/restores the draft) without re-proving what the hook
// already tests about itself (`use-agent-chat.test.tsx`,
// `stop-reaches-the-server.test.tsx`, `a-reopened-chat-rejoins-its-live-
// session.test.tsx`, …).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@driftstack/sdk';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sendMessageMock = vi.fn();
const endSessionMock = vi.fn();
const tauriInvoke = vi.fn();

// Capture the relaunch listener so the second test can swap the standalone
// Simulator to a new session without remounting it.
let dsSessionCb: ((event: { payload: string }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (event: { payload: string }) => void) => {
    if (name === 'ds-session') dsSessionCb = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
  },
}));

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'ai', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: (...args: unknown[]) => sendMessageMock(...args) as unknown,
  endAgentSession: (...args: unknown[]) => endSessionMock(...args) as unknown,
  AgentSessionControlError: class extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly kind = 'unknown',
    ) {
      super(message);
    }
  },
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { DEFAULT_SETTINGS } = await import('../../src/lib/settings');

/** A complete `AgentSession`, `mode: 'ai'` — round-2 stage B's `SimulatorWindow`
 *  derives `controlModeOverride` straight from `agentChatOverride.chat.session.
 *  mode` (see that file's own header), so a fixture chat carrying this session
 *  deterministically puts the window in Agent mode without depending on the
 *  mocked `getAgentSession` resolving first. */
const FIXTURE_SESSION: AgentSession = {
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
  mode: 'ai',
  model: 'claude-sonnet-5',
  stop_on_exit_ip_change: false,
  pair_mode_state: null,
  created_at: '2026-09-18T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
};

/** Every field of `UseAgentChatResult`, so a test's override is a COMPLETE
 *  double and not a partial the view has to optional-chain around — mirrors
 *  `agent-chat-scenes.tsx`'s own `baseChat()`. */
function fixtureChat(overrides: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: FIXTURE_SESSION,
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

function renderSimulator(opts: { chat?: UseAgentChatResult } = {}) {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  const { chat } = opts;
  return render(
    <RecordingsProvider>
      <SimulatorWindow
        {...(chat !== undefined
          ? {
              agentChatOverride: { chat },
              // aiReady gate: SimulatorAgentChat's Composer refuses to send
              // with no API key, same as the AI view's own. Only the two
              // rewritten tests below pass `chat`; every other test in this
              // file renders the bare (no-override) window, unaffected.
              settingsOverride: {
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
              },
            }
          : {})}
      />
    </RecordingsProvider>,
  );
}

function openSessionControls(container: HTMLElement): void {
  fireEvent.click(container.querySelector('[data-component="sim-rail-session"]') as Element);
}

describe('SimulatorWindow — control actions', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    endSessionMock.mockReset();
    dsSessionCb = null;
    tauriInvoke.mockReset();
    tauriInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:window|scale_factor') return Promise.resolve(1);
      if (command === 'plugin:window|inner_size') {
        return Promise.resolve({ width: 430, height: 820 });
      }
      return Promise.resolve();
    });
    // The in-place relaunch listener registers only in the Tauri environment.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'simulator' },
        currentWebview: { label: 'simulator' },
      },
      invoke: tauriInvoke,
    };
  });
  // No per-test teardown of __TAURI_INTERNALS__ — deliberately. A control chain
  // still settling when a test returns (End's credential-cleanup race, the
  // aspect-lock debounce) re-enters Tauri AFTER the hook ran; a deleted stub
  // turns that straggler into a thrown TypeError -> the swallow guard's
  // console.warn -> the warn's rpc forward lands after vitest's rpcDone
  // snapshot and the worker rejects it: "Closing rpc while onUserConsoleLog
  // was pending" (V-2138's 1-in-2 full-suite flake; mechanism + deterministic
  // probe in V-2141). The stub lives for the whole file; jsdom isolation
  // discards it with the environment.

  it('clears a sent draft immediately through chat.send, and restores it (trimmed, like every AI view send) when the turn fails', async () => {
    const send = deferred<boolean>();
    const chatSend = vi.fn(() => send.promise);
    const { container } = renderSimulator({
      chat: fixtureChat({ send: chatSend, lastSendKeptMessage: () => false }),
    });
    openSessionControls(container);

    // The AI view's OWN Composer — not the old drawer's one-line box, which
    // no longer renders once the wide Agent/Pair panel takes its place
    // (SessionControlSection's `hideComposer`).
    const input = await waitFor(() => {
      const el = screen.getByLabelText('Message Driftstack AI');
      expect(el).not.toBeNull();
      return el;
    });
    expect(container.querySelector('[aria-label="Tell the agent"]')).toBeNull();

    // Untrimmed on the way in, same as AgentChatView.submit() — SimulatorAgentChat's
    // own submit() is a deliberate copy of that function, trim included, so the
    // restored draft below is the TRIMMED text, not the padded original.
    const typedDraft = '  keep my wording  ';
    fireEvent.change(input, { target: { value: typedDraft } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The wiring this test exists to prove: SimulatorAgentChat's submit()
    // calls the CHAT HOOK'S send — never sendAgentMessage/sendMessageMock,
    // which this file still mocks (see the unrelated End-session tests below)
    // but which a real Agent/Pair send no longer reaches.
    expect(chatSend).toHaveBeenCalledWith(typedDraft.trim());
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(input).toHaveValue('');

    // UseAgentChatResult.send resolves `false` on a failed turn (it never
    // rejects — see that field's own doc comment); `false` + a message the
    // hook did NOT keep in the transcript is exactly when submit() restores
    // the draft, mirroring AgentChatView's own submit().
    act(() => {
      send.resolve(false);
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Message Driftstack AI')).toHaveValue(typedDraft.trim());
    });
  });

  it('NEGATIVE CONTROL — a KEPT failed message does not also restore the draft (would show the same text twice)', async () => {
    const send = deferred<boolean>();
    const chatSend = vi.fn(() => send.promise);
    const { container } = renderSimulator({
      chat: fixtureChat({ send: chatSend, lastSendKeptMessage: () => true }),
    });
    openSessionControls(container);
    const input = await waitFor(() => screen.getByLabelText('Message Driftstack AI'));
    fireEvent.change(input, { target: { value: 'kept on failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(input).toHaveValue('');
    act(() => {
      send.resolve(false);
    });
    // Give any (incorrect) restore a chance to land, then assert it didn't.
    await Promise.resolve();
    expect(screen.getByLabelText('Message Driftstack AI')).toHaveValue('');
  });

  it('disarms a first-click End confirmation when ds-session swaps in a new session', async () => {
    const { container } = renderSimulator();

    const endButton = container.querySelector('[aria-label="End session"]') as HTMLButtonElement;
    expect(endButton).not.toBeNull();
    fireEvent.click(endButton);
    expect(container.querySelector('[aria-label="Confirm — end session"]')).not.toBeNull();
    expect(endSessionMock).not.toHaveBeenCalled();

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="End session"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Confirm — end session"]')).toBeNull();
      expect(container.textContent).not.toMatch(/click End again/i);
    });
    expect(endSessionMock).not.toHaveBeenCalled();
  });

  it('does not destroy the newly bound window when an old End request settles after a swap', async () => {
    const end = deferred<void>();
    endSessionMock.mockReturnValue(end.promise);
    const { container } = renderSimulator();

    fireEvent.click(container.querySelector('[aria-label="End session"]') as Element);
    fireEvent.click(container.querySelector('[aria-label="Confirm — end session"]') as Element);
    expect(endSessionMock).toHaveBeenCalledWith('agt_x', null);
    expect(container.querySelector('[aria-label="Ending session"]')).not.toBeNull();

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });
    await waitFor(() =>
      expect(container.querySelector('[aria-label="End session"]')).not.toBeNull(),
    );

    await act(async () => {
      end.resolve();
      await end.promise;
    });

    expect(tauriInvoke.mock.calls.some(([command]) => command === 'plugin:window|destroy')).toBe(
      false,
    );
  });

  it('cancels the failed-End close fallback when a new session arrives during its grace period', async () => {
    endSessionMock.mockRejectedValue(new Error('control API unavailable'));
    const { container } = renderSimulator();

    fireEvent.click(container.querySelector('[aria-label="End session"]') as Element);
    fireEvent.click(container.querySelector('[aria-label="Confirm — end session"]') as Element);
    expect(
      await screen.findByText('Ending — closing the window. The session will stop shortly.'),
    ).not.toBeNull();

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });
    await waitFor(() =>
      expect(container.querySelector('[aria-label="End session"]')).not.toBeNull(),
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    });
    expect(tauriInvoke.mock.calls.some(([command]) => command === 'plugin:window|destroy')).toBe(
      false,
    );
  });

  it('re-adopts the session — never a second copy of the old one — when ds-session swaps the simulator in place', async () => {
    // Round-2 stage B — SimulatorAgentChat stays MOUNTED across a ds-session
    // swap (the standalone Simulator changes `sessionId` in place, per this
    // file's own header) and re-runs `chat.adopt(sessionId)` on the new id.
    // The OLD test here drove this same swap through `sendMessageMock`'s
    // per-session ownership (`beginControlAction`'s ownership guard for a
    // `kind: 'message'` action) — a mechanism the wide Agent/Pair panel no
    // longer reaches at all (its composer calls `chat.send`, not
    // `sendAgentMessage`). The equivalent safety net now lives entirely
    // inside `useAgentChat`'s own cancel-generation guard, already proven by
    // `a-reopened-chat-rejoins-its-live-session.test.tsx` and its siblings;
    // what is left for THIS file to prove is that SimulatorAgentChat asks it
    // to adopt the right session, in the right order, every time.
    const adopt = vi.fn<(sessionId: string) => void>();
    const { container } = renderSimulator({ chat: fixtureChat({ adopt }) });
    openSessionControls(container);

    await waitFor(() => expect(adopt).toHaveBeenCalledWith('agt_x'));

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });

    await waitFor(() => expect(adopt).toHaveBeenLastCalledWith('agt_y'));
    // NEGATIVE CONTROL — a re-adopt, not a leak: 'agt_x' is asked for exactly
    // once, never again after the swap (the old-session-leaks-in defect the
    // test this replaces was written to catch, restated for the new path).
    expect(adopt.mock.calls.map((call) => call[0])).toEqual(['agt_x', 'agt_y']);
  });

  it('V-2141 pin — no simulator-window family file tears down its Tauri stub mid-file', () => {
    // The pin asserts the absence of the deletion, not that absence is
    // sufficient — the mechanism it protects is documented where the
    // afterEach used to be. open-simulator.test.tsx is excluded: its inline
    // delete is a test SUBJECT (the non-Tauri branch), not teardown.
    const here = dirname(fileURLToPath(import.meta.url));
    const family = [
      'simulator-window-control-actions.test.tsx',
      'simulator-window-room-ownership.test.tsx',
      'simulator-window-tauri.test.tsx',
    ];
    // Token-split so this pin's own source cannot satisfy it, and comments
    // stripped so prose about the deletion never trips it — only code can.
    const deletion = new RegExp('delete[^\\n]*__TAURI_' + 'INTERNALS__');
    for (const name of family) {
      const src = readFileSync(join(here, name), 'utf8');
      const code = src
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(code, name).not.toMatch(deletion);
    }
  });
});
