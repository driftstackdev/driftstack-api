// The Simulator window swaps to a new handoff (a relaunch on macOS, a second
// launch on Windows/Linux) through the `ds-session` event — which carries the
// session's control key. It must listen on ITS OWN window: a listener on every
// window would let a handoff for one session re-point another session's window
// (and hand it that session's key). And once taken, the new key is the one its
// control calls use.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const windowListeners = new Map<string, (e: { payload: string }) => void>();
/** Every `ds-session` listener's target, as registered. */
const targets: unknown[] = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, cb: (e: { payload: string }) => void, options?: { target?: unknown }) => {
    if (event === 'ds-session') {
      targets.push(options?.target);
      windowListeners.set(event, cb);
    }
    return Promise.resolve(() => windowListeners.delete(event));
  },
  emitTo: vi.fn(() => Promise.resolve()),
}));
const fakeWindow = (): Record<string, unknown> => ({
  label: 'simulator-agt_x',
  setSize: () => Promise.resolve(),
  setPosition: () => Promise.resolve(),
  setTitle: () => Promise.resolve(),
  scaleFactor: () => Promise.resolve(1),
  innerSize: () => Promise.resolve({ width: 330, height: 718 }),
  outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
  setMaximizable: () => Promise.resolve(),
  onResized: () => Promise.resolve(() => {}),
  onMoved: () => Promise.resolve(() => {}),
  onCloseRequested: () => Promise.resolve(() => {}),
  destroy: () => Promise.resolve(),
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: fakeWindow }));
vi.mock('@tauri-apps/api/window', () => ({
  availableMonitors: () => Promise.resolve([]),
  currentMonitor: () => Promise.resolve(null),
  getAllWindows: () => Promise.resolve([]),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.reject(new Error('no native host in this test')),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
    set(): Promise<void> {
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab: vi.fn(() => Promise.resolve('req_test')),
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
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, []);
    return <div data-component="agent-session-panel-mock" />;
  },
}));
const reads: Array<{ id: string; key: string | null }> = [];
vi.mock('../../src/lib/agent-session-control', () => ({
  resumeChallengedSession: vi.fn(() => Promise.resolve()),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: (id: string, auth: { controlKey?: string | null } | null) => {
    reads.push({ id, key: auth?.controlKey ?? null });
    return Promise.resolve({
      mode: 'manual',
      pairKind: null,
      status: 'active',
      terminal: false,
      capabilityReport: { manual_input_available: true },
    });
  },
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

const OLD_KEY = `gck_${'a'.repeat(32)}`;
const NEW_KEY = `gck_${'b'.repeat(32)}`;

beforeEach(() => {
  reads.length = 0;
  windowListeners.clear();
  targets.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('the Simulator window takes a handoff only for itself', () => {
  it('CRITICAL listens for `ds-session` on its own window, and uses the new key after it', async () => {
    window.history.pushState(
      {},
      '',
      `/?window=simulator&ws=wss://lk&token=tok&session=agt_x&ck=${OLD_KEY}&base=https%3A%2F%2Fapi.example.test`,
    );
    render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    await waitFor(() => expect(windowListeners.has('ds-session')).toBe(true));
    // Heard on this window only — never on every window.
    expect(targets).toEqual([{ kind: 'WebviewWindow', label: 'simulator-agt_x' }]);
    await waitFor(() => expect(reads.some((r) => r.key === OLD_KEY)).toBe(true));
    const handoff = new URLSearchParams({
      window: 'simulator',
      ws: 'wss://lk',
      token: 'fresh-token',
      session: 'agt_x',
      ck: NEW_KEY,
      base: 'https://api.example.test',
    }).toString();
    const before = reads.length;
    act(() => windowListeners.get('ds-session')?.({ payload: btoa(`?${handoff}`) }));
    await waitFor(() => expect(reads.slice(before).some((r) => r.key === NEW_KEY)).toBe(true));
    expect(reads.slice(before).every((r) => r.key === NEW_KEY)).toBe(true);
  });
});
