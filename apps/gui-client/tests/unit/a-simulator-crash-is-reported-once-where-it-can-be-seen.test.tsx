// A Simulator crash must be reported where someone can see it (from the audit
// of the owner's developer logs).
//
// The separate macOS Simulator app writes its flight record into ITS OWN data
// folder (dev.driftstack.simulator), and only the main app's window read
// records — from the main app's folder — so a Simulator crash was reported
// nowhere. The separate app's window now reports its own previous run at
// start-up: ONE WARN entry per record whose line says what it means, and the
// clean-exit mark (written by the store plugin's save-on-exit) decides, so a
// normal quit is not reported as a crash. The in-process window (Windows,
// Linux) shares the main app's folder, where the main window already reports
// it — it must not report it twice.
//
// Each test is a fresh process (the modules are re-evaluated): the exit mark is
// read once per JavaScript context and remembered, as it must be.

import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type * as SimulatorWindowModule from '../../src/views/SimulatorWindow';
import type * as RecordingsModule from '../../src/lib/recordings';
import type * as LogBufferModule from '../../src/lib/log-buffer';

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

// The store file names (constants; the same in every fresh module registry).
const SIMULATOR_FLIGHT_STORE_FILE = 'diagnostics-simulator.json';
const SIMULATOR_EXIT_MARK_FILE = 'diagnostics-simulator-exit.json';

/**
 * Each test is a fresh PROCESS: the exit mark is read once per JavaScript
 * context and remembered (as it must be — arming it must never be observed by
 * the reader), so the modules are re-evaluated for every test.
 */
let mod: {
  SimulatorWindow: typeof SimulatorWindowModule.SimulatorWindow;
  RecordingsProvider: typeof RecordingsModule.RecordingsProvider;
  getLogEntries: typeof LogBufferModule.getLogEntries;
};
async function freshProcess(): Promise<void> {
  vi.resetModules();
  const detector = await import('../../src/lib/main-thread-stall-detector');
  expect(detector.SIMULATOR_FLIGHT_STORE_FILE).toBe(SIMULATOR_FLIGHT_STORE_FILE);
  expect(detector.SIMULATOR_EXIT_MARK_FILE).toBe(SIMULATOR_EXIT_MARK_FILE);
  mod = {
    SimulatorWindow: (await import('../../src/views/SimulatorWindow')).SimulatorWindow,
    RecordingsProvider: (await import('../../src/lib/recordings')).RecordingsProvider,
    getLogEntries: (await import('../../src/lib/log-buffer')).getLogEntries,
  };
}

const LAST_RUN = {
  at: Date.parse('2026-09-24T11:58:40.000Z'),
  census: {
    blockedMs: 0,
    videoElements: 1,
    documentChildren: 5400,
    tabCount: 2,
    pendingReceipts: 3,
    heapUsedMiB: 212,
  },
  onStall: false,
  window: 'simulator',
};

function renderSim(): ReturnType<typeof render> {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  const { SimulatorWindow, RecordingsProvider } = mod;
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

const flightWarnings = (): string[] =>
  mod
    .getLogEntries()
    .filter((e) => e.text.includes('[flight-recorder]'))
    .map((e) => `${e.level}: ${e.text}`);

beforeEach(async () => {
  files.clear();
  await freshProcess();
  app.identifier = 'dev.driftstack.simulator';
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('the separate Simulator app reports its own previous run', () => {
  it('a run that died is reported ONCE, at WARN, in words that say what it means — and shown', async () => {
    files.set(SIMULATOR_FLIGHT_STORE_FILE, new Map<string, unknown>([['lastRun', LAST_RUN]]));
    files.set(SIMULATOR_EXIT_MARK_FILE, new Map<string, unknown>([['exitedNormally', false]]));
    renderSim();
    await waitFor(() => expect(flightWarnings().length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const lines = flightWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^warn: \[flight-recorder\] \[simulator\] previous run ended without shutting down \(it crashed, was force-quit, or froze\)/,
    );
    expect(screen.getByText(/The Simulator closed unexpectedly last time/)).toBeTruthy();
    // Reported once: the live record is cleared, the history keeps it.
    expect(files.get(SIMULATOR_FLIGHT_STORE_FILE)?.get('lastRun')).toBeNull();
  });

  it('a normal quit is not a crash: the clean-exit mark says so, and nothing is reported', async () => {
    files.set(SIMULATOR_FLIGHT_STORE_FILE, new Map<string, unknown>([['lastRun', LAST_RUN]]));
    files.set(SIMULATOR_EXIT_MARK_FILE, new Map<string, unknown>([['exitedNormally', true]]));
    renderSim();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(flightWarnings()).toEqual([]);
  });

  it('CONTROL — the in-process window leaves it to the main window, which reads the same folder', async () => {
    app.identifier = 'dev.driftstack.gui';
    files.set(SIMULATOR_FLIGHT_STORE_FILE, new Map<string, unknown>([['lastRun', LAST_RUN]]));
    files.set(SIMULATOR_EXIT_MARK_FILE, new Map<string, unknown>([['exitedNormally', false]]));
    renderSim();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(flightWarnings()).toEqual([]);
    expect(files.get(SIMULATOR_FLIGHT_STORE_FILE)?.get('lastRun')).toEqual(LAST_RUN);
  });
});
