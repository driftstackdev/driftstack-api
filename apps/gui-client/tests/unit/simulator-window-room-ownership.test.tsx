// SimulatorWindow — exact session/Room ownership for browser-tab controls.
//
// The standalone window swaps sessions in place. These tests keep old panel callbacks
// and a detached old DataReceived listener alive across that swap to prove they cannot
// clear, disable or mutate the replacement session. They also pin the fail-closed
// absent/connecting/publishing gate in both rendered controls and forced DOM events.

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelCallbacks = {
  info: { token: string };
  onRoom?: (room: FakeRoom | null, ownerRoom: FakeRoom) => void;
  onStateChange?: (state: { kind: string }, ownerRoom: FakeRoom) => void;
  onPublisher?: (publisher: 'waiting' | 'publishing' | 'none', ownerRoom: FakeRoom) => void;
  onPublishError?: (ownerRoom: FakeRoom) => void;
  onInputCongestionChange?: (congested: boolean, ownerRoom: FakeRoom) => void;
};

type FakeRoom = {
  name: string;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  localParticipant: { publishData: ReturnType<typeof vi.fn> };
};

const panelByToken = new Map<string, PanelCallbacks>();
const roomDataHandlers = new Map<FakeRoom, (payload: Uint8Array) => void>();
const sendTabListUpdate = vi.fn(() => Promise.resolve());
const sendActivateTab = vi.fn(
  (_room: unknown, _payload: unknown, onRequestId?: (requestId: string) => void) => {
    onRequestId?.('req_room_owner');
    return Promise.resolve('req_room_owner');
  },
);
const tauriInvoke = vi.fn(() => Promise.resolve());
let dsSessionCb: ((event: { payload: string }) => void) | null = null;

function makeRoom(name: string): FakeRoom {
  const room = {
    name,
    on: vi.fn((event: string, callback: (payload: Uint8Array) => void) => {
      if (event === 'dataReceived') roomDataHandlers.set(room, callback);
    }),
    off: vi.fn(),
    localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
  } as FakeRoom;
  return room;
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, callback: (event: { payload: string }) => void) => {
    if (name === 'ds-session') dsSessionCb = callback;
    return Promise.resolve(() => undefined);
  },
}));

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => undefined),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendText: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  sendTabListUpdate,
  sendActivateTab,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
  },
}));

vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: PanelCallbacks) => {
    panelByToken.set(props.info.token, props);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () =>
    Promise.resolve({
      mode: 'manual',
      pairKind: null,
      status: 'active',
      terminal: false,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  navigateAgentSessionHistory: vi.fn(() => Promise.resolve()),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSimulator() {
  window.history.pushState(
    {},
    '',
    '/?window=simulator&ws=wss://room-a&token=token-a&session=agt_a',
  );
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

function tabEls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-component="simulator-tab"]'));
}

function tabStrip(container: HTMLElement): HTMLElement {
  const strip = container.querySelector<HTMLElement>('[data-component="simulator-tab-strip"]');
  if (strip === null) throw new Error('tab strip missing');
  return strip;
}

function panel(token: string): PanelCallbacks {
  const value = panelByToken.get(token);
  if (value === undefined) throw new Error(`panel callbacks missing for ${token}`);
  return value;
}

describe('SimulatorWindow — Room/session ownership', () => {
  beforeEach(() => {
    panelByToken.clear();
    roomDataHandlers.clear();
    sendTabListUpdate.mockClear();
    sendActivateTab.mockClear();
    dsSessionCb = null;
    tauriInvoke.mockClear();
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

  it('keeps tab controls inert until the exact Room is connected and publishing', async () => {
    const { container } = renderSimulator();
    await waitFor(() => expect(panelByToken.has('token-a')).toBe(true));
    const callbacks = panel('token-a');
    const roomA = makeRoom('room-a');
    const newTab = container.querySelector('[aria-label="New tab"]') as HTMLButtonElement;

    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('true');
    expect(newTab.disabled).toBe(true);
    // Forced DOM dispatch still reaches the parent handler in hostile/test code; it
    // must perform no local or wire mutation while there is no owned live Room.
    newTab.removeAttribute('disabled');
    fireEvent.click(newTab);
    expect(tabEls(container)).toHaveLength(1);
    expect(sendTabListUpdate).not.toHaveBeenCalled();
    expect(sendActivateTab).not.toHaveBeenCalled();

    // Even a legacy/hostile one-argument callback must fail closed. The source
    // interface requires an origin Room; this cast deliberately violates it at
    // runtime to prove there is no fallback to the current binding.
    act(() => (callbacks.onRoom as unknown as (room: FakeRoom) => void)?.(roomA));
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('true');
    expect(sendActivateTab).not.toHaveBeenCalled();

    // Bind correctly, then violate each mutation callback independently. This makes
    // a future fallback-to-current-Room regression load-bearing rather than relying
    // only on the absent-binding precondition above.
    act(() => {
      callbacks.onRoom?.(roomA, roomA);
      (callbacks.onStateChange as unknown as (state: { kind: string }) => void)?.({
        kind: 'connected',
      });
      (callbacks.onPublisher as unknown as (publisher: 'publishing') => void)?.('publishing');
      (callbacks.onPublishError as unknown as () => void)?.();
      (callbacks.onInputCongestionChange as unknown as (congested: boolean) => void)?.(true);
    });
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
    expect(container.querySelector('[data-component="input-congestion-badge"]')).toBeNull();

    act(() => {
      callbacks.onStateChange?.({ kind: 'connected' }, roomA);
      callbacks.onPublisher?.('waiting', roomA);
    });
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('true');
    newTab.removeAttribute('disabled');
    fireEvent.click(newTab);
    expect(tabEls(container)).toHaveLength(1);
    expect(sendTabListUpdate).not.toHaveBeenCalled();

    act(() => callbacks.onPublisher?.('publishing', roomA));
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    expect(tabEls(container)).toHaveLength(2);
    expect(sendActivateTab).toHaveBeenCalledWith(
      roomA,
      expect.objectContaining({ sessionId: 'agt_a' }),
      expect.any(Function),
    );
  });

  it('rejects old Room callbacks and detached data after an in-place session replacement', async () => {
    const { container } = renderSimulator();
    await waitFor(() => expect(panelByToken.has('token-a')).toBe(true));
    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    const oldCallbacks = panel('token-a');
    const roomA = makeRoom('room-a');
    act(() => {
      oldCallbacks.onRoom?.(roomA, roomA);
      oldCallbacks.onStateChange?.({ kind: 'connected' }, roomA);
      oldCallbacks.onPublisher?.('publishing', roomA);
    });
    const oldData = roomDataHandlers.get(roomA);
    expect(oldData).toBeDefined();

    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://room-b&token=token-b&session=agt_b'),
      });
    });
    await waitFor(() => expect(panelByToken.has('token-b')).toBe(true));
    const newCallbacks = panel('token-b');
    const roomB = makeRoom('room-b');
    act(() => {
      newCallbacks.onRoom?.(roomB, roomB);
      newCallbacks.onStateChange?.({ kind: 'connected' }, roomB);
      newCallbacks.onPublisher?.('publishing', roomB);
    });
    await waitFor(() => expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false'));

    // Old panel cleanup/events and a queued old-room frame are all inert after B owns
    // the window. In particular they cannot clear B's Room or restore A's tab payload.
    act(() => {
      oldCallbacks.onRoom?.(null, roomA);
      oldCallbacks.onRoom?.(roomA, roomA);
      oldCallbacks.onStateChange?.({ kind: 'disconnected' }, roomA);
      oldCallbacks.onPublisher?.('none', roomA);
      oldCallbacks.onPublishError?.(roomA);
      oldData?.(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'tabListRestore',
            tabs: [
              {
                id: 'old_tab',
                url: 'https://old-session.invalid/private',
                scrollY: 0,
                title: 'OLD SESSION',
              },
            ],
            activeTabId: 'old_tab',
          }),
        ),
      );
    });
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false');
    expect(tabEls(container)).toHaveLength(1);
    expect(container.textContent).not.toContain('OLD SESSION');

    sendActivateTab.mockClear();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    expect(tabEls(container)).toHaveLength(2);
    expect(sendActivateTab).toHaveBeenCalledWith(
      roomB,
      expect.objectContaining({ sessionId: 'agt_b' }),
      expect.any(Function),
    );
    expect(
      sendActivateTab.mock.calls.some(
        ([room, payload]) =>
          room === roomA || (payload as { sessionId?: string }).sessionId === 'agt_a',
      ),
    ).toBe(false);
  });

  it('rejects a stale rendered tab handler in the same turn a Room is detached or replaced', async () => {
    const { container } = renderSimulator();
    await waitFor(() => expect(panelByToken.has('token-a')).toBe(true));
    const callbacks = panel('token-a');
    const roomA = makeRoom('room-a');
    act(() => {
      callbacks.onRoom?.(roomA, roomA);
      callbacks.onStateChange?.({ kind: 'connected' }, roomA);
      callbacks.onPublisher?.('publishing', roomA);
    });
    await waitFor(() => expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false'));

    const staleNewTab = container.querySelector('[aria-label="New tab"]') as HTMLButtonElement;
    sendTabListUpdate.mockClear();
    sendActivateTab.mockClear();
    // handleRoom clears the ref synchronously, while React has not yet replaced the
    // rendered button handler. A forced click in that gap must observe the ref, not
    // the closure's previously connected Room A.
    act(() => {
      callbacks.onRoom?.(null, roomA);
      staleNewTab.removeAttribute('disabled');
      fireEvent.click(staleNewTab);
    });
    expect(tabEls(container)).toHaveLength(1);
    expect(sendTabListUpdate).not.toHaveBeenCalled();
    expect(sendActivateTab).not.toHaveBeenCalled();

    act(() => {
      callbacks.onRoom?.(roomA, roomA);
      callbacks.onStateChange?.({ kind: 'connected' }, roomA);
      callbacks.onPublisher?.('publishing', roomA);
    });
    await waitFor(() => expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false'));
    const roomB = makeRoom('room-b');
    const handlerBoundToA = container.querySelector('[aria-label="New tab"]') as HTMLButtonElement;
    // A same-session Room replacement also publishes synchronously. Until React
    // commits the B render, the A-bound handler must fail its expected-Room check.
    act(() => {
      callbacks.onRoom?.(roomB, roomB);
      handlerBoundToA.removeAttribute('disabled');
      fireEvent.click(handlerBoundToA);
    });
    expect(tabEls(container)).toHaveLength(1);
    expect(sendTabListUpdate).not.toHaveBeenCalled();
    expect(sendActivateTab).not.toHaveBeenCalled();
  });

  it('fences every late same-session callback by its originating Room', async () => {
    const { container } = renderSimulator();
    await waitFor(() => expect(panelByToken.has('token-a')).toBe(true));
    const callbacks = panel('token-a');
    const roomA = makeRoom('room-a');
    const roomB = makeRoom('room-b');
    act(() => {
      callbacks.onRoom?.(roomA, roomA);
      callbacks.onStateChange?.({ kind: 'connected' }, roomA);
      callbacks.onPublisher?.('publishing', roomA);
    });
    await waitFor(() => expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false'));

    act(() => {
      callbacks.onRoom?.(roomB, roomB);
      callbacks.onStateChange?.({ kind: 'connected' }, roomB);
      callbacks.onPublisher?.('publishing', roomB);
      callbacks.onInputCongestionChange?.(false, roomB);
    });
    await waitFor(() => expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false'));

    // Cleanup and late events from retired A carry A explicitly. They cannot detach
    // B, degrade its readiness, raise its control badge or apply congestion to it.
    act(() => {
      callbacks.onRoom?.(null, roomA);
      callbacks.onStateChange?.({ kind: 'disconnected' }, roomA);
      callbacks.onPublisher?.('none', roomA);
      callbacks.onPublishError?.(roomA);
      callbacks.onInputCongestionChange?.(true, roomA);
    });
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false');
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
    expect(container.querySelector('[data-component="input-congestion-badge"]')).toBeNull();

    // A real B congestion transition owns B. The old A cleanup(false) cannot clear
    // it; only B's own drain callback restores the tab controls.
    act(() => callbacks.onInputCongestionChange?.(true, roomB));
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('true');
    act(() => callbacks.onInputCongestionChange?.(false, roomA));
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('true');
    act(() => callbacks.onInputCongestionChange?.(false, roomB));
    expect(tabStrip(container).getAttribute('aria-disabled')).toBe('false');
  });
});
