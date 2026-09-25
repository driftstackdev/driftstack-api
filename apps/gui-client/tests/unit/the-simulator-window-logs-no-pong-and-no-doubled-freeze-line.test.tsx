// Two lines the Simulator window logged that it should not have (from the
// audit of the owner's developer logs):
//
//   1. "unrecognized data frame pong" at WARN every ~10 s. A pong is the phone
//      answering the window's own keep-alive ping: expected, handled silently.
//   2. The freeze line printed its counts twice (the line already carries the
//      census; the census object was logged beside it). The main window's copy
//      was fixed the same way.

import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type * as SimulatorWindowModule from '../../src/views/SimulatorWindow';
import type * as RecordingsModule from '../../src/lib/recordings';
import type * as StallDetectorModule from '../../src/lib/main-thread-stall-detector';

// ── in-memory store files (plugin-store), keyed by file name ─────────────────
const files = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private readonly file: string;
    constructor(file: string) {
      this.file = file;
      if (!files.has(file)) files.set(file, new Map());
    }
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(files.get(this.file)?.get(key) as T | undefined);
    }
    set(key: string, value: unknown): Promise<void> {
      files.get(this.file)?.set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
    delete(key: string): Promise<boolean> {
      return Promise.resolve(files.get(this.file)?.delete(key) ?? false);
    }
  },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 1 },
  mkdir: () => Promise.resolve(),
  writeTextFile: () => Promise.resolve(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.reject(new Error('no native host in this test')),
}));
const app = { identifier: 'dev.driftstack.simulator' };
vi.mock('@tauri-apps/api/app', () => ({
  getIdentifier: () => Promise.resolve(app.identifier),
}));
const fakeWindow = (): Record<string, unknown> => ({
  label: 'main',
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
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

// Capture the stall watch's callback so the freeze line can be driven directly.
const stall: { onStall: ((line: string, census: unknown) => void) | null } = { onStall: null };
vi.mock('../../src/lib/main-thread-stall-detector', async (importOriginal) => {
  const real = await importOriginal<typeof StallDetectorModule>();
  return {
    ...real,
    startStallWatch: (onStall: (line: string, census: unknown) => void) => {
      stall.onStall = onStall;
      return () => undefined;
    },
  };
});

// ── the session plumbing (no network, no LiveKit) ────────────────────────────
function immediateControl<T>(value: T): Promise<T> {
  return {
    then: (onfulfilled: (resolved: T) => unknown) => {
      try {
        return Promise.resolve(onfulfilled(value));
      } catch (err: unknown) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  } as unknown as Promise<T>;
}
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
let latestDataHandler: ((p: Uint8Array) => void) | null = null;
const fakeRoom = {
  on: vi.fn((event: string, cb: (p: Uint8Array) => void) => {
    if (event === 'dataReceived') latestDataHandler = cb;
  }),
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
vi.mock('../../src/lib/agent-session-control', () => ({
  resumeChallengedSession: vi.fn(() => Promise.resolve()),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () =>
    immediateControl({
      mode: 'manual',
      pairKind: null,
      status: 'active',
      terminal: false,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

/** Each test gets fresh modules: the unrecognized-frame warning is throttled
 *  per module, and one test's warning must not silence the next test's. */
let mod: {
  SimulatorWindow: typeof SimulatorWindowModule.SimulatorWindow;
  RecordingsProvider: typeof RecordingsModule.RecordingsProvider;
};
async function freshProcess(): Promise<void> {
  vi.resetModules();
  mod = {
    SimulatorWindow: (await import('../../src/views/SimulatorWindow')).SimulatorWindow,
    RecordingsProvider: (await import('../../src/lib/recordings')).RecordingsProvider,
  };
}

function renderSim(): ReturnType<typeof render> {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  const { SimulatorWindow, RecordingsProvider } = mod;
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

beforeEach(async () => {
  files.clear();
  await freshProcess();
  latestDataHandler = null;
  stall.onStall = null;
  app.identifier = 'dev.driftstack.simulator';
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe("the phone's answer to the keep-alive ping", () => {
  it('a pong is handled silently — never an "unrecognized data frame" warning', async () => {
    const warn = vi.spyOn(console, 'warn');
    renderSim();
    await waitFor(() => expect(latestDataHandler).not.toBeNull());
    act(() => {
      latestDataHandler?.(new TextEncoder().encode(JSON.stringify({ type: 'pong', timestamp: 1 })));
    });
    const unrecognized = (): unknown[][] =>
      warn.mock.calls.filter((c) => String(c[0]).includes('unrecognized data frame'));
    expect(unrecognized()).toEqual([]);
    // CONTROL — a frame the window genuinely does not know is still flagged.
    act(() => {
      latestDataHandler?.(
        new TextEncoder().encode(JSON.stringify({ type: 'mysteryFrame', state: 'odd' })),
      );
    });
    expect(unrecognized()).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('a freeze is logged once', () => {
  it('the freeze line is printed alone — its counts are not repeated beside it', async () => {
    const warn = vi.spyOn(console, 'warn');
    renderSim();
    await waitFor(() => expect(stall.onStall).not.toBeNull());
    const census = {
      blockedMs: 4200,
      videoElements: 1,
      documentChildren: 5400,
      tabCount: 2,
      pendingReceipts: 3,
      heapUsedMiB: 212,
    };
    const line =
      '[stall] main thread blocked 4200ms video=1 dom=5400 tabs=2 receipts=3 heap=212MiB';
    act(() => stall.onStall?.(line, census));
    const calls = warn.mock.calls.filter((c) => c[0] === line);
    expect(calls).toEqual([[line]]);
    warn.mockRestore();
  });
});
