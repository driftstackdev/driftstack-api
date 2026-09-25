// Owner item 3 (2026-09-24): "Simulator view, should expand more to match
// screen, assuming we auto scale and the original resolution stays the same and
// not change with the browser, and only for local more easily viewed, should be
// make larger to match nicely with the screen. And remember previous positions
// from user to auto reopen the same kind of way."
//
// ROOT CAUSE (lib/simulator-window-placement.ts): every fit capped the phone at
// the device's 1:1 size, so a big screen got a small phone and a phone the
// customer enlarged was shrunk back on the next open and on every browser-bar
// toggle; and nothing remembered where the window was or on which screen.
//
// This renders the real window against a fake native window (position, size,
// monitors, move events) and a real in-memory store, and proves:
//   1. a fresh open with nothing remembered scales the phone UP on a big screen;
//   2. a remembered placement reopens at that position and size, on that screen;
//   3. …but not when that screen is gone, and not on top of another open phone;
//   4. moving the window remembers where it was left, with its screen;
//   5. a browser-bar toggle keeps a phone that is larger than 1:1.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

// ── the in-memory store (every LazyStore file, including settings.json) ──────
const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private readonly file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(stores.get(this.file)?.get(key) as T | undefined);
    }
    set(key: string, value: unknown): Promise<void> {
      stores.get(this.file)?.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
    delete(key: string): Promise<boolean> {
      return Promise.resolve(stores.get(this.file)?.delete(key) ?? false);
    }
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.reject(new Error('no native host in this test')),
}));

// ── the fake native window ───────────────────────────────────────────────────
interface Rect {
  width: number;
  height: number;
}
const MONITOR_A = {
  name: 'Built-in Retina Display',
  position: { x: 0, y: 0 },
  size: { width: 2560, height: 1600 },
  workArea: { position: { x: 0, y: 25 }, size: { width: 2560, height: 1575 } },
  scaleFactor: 1,
};
const MONITOR_B = {
  name: 'Studio Display',
  position: { x: 2560, y: 0 },
  size: { width: 2560, height: 1440 },
  workArea: { position: { x: 2560, y: 0 }, size: { width: 2560, height: 1440 } },
  scaleFactor: 1,
};
const native = {
  label: 'sim-agt_x',
  size: { width: 330, height: 718 },
  position: { x: 120, y: 120 },
  monitors: [MONITOR_A, MONITOR_B] as (typeof MONITOR_A)[],
  others: [] as string[],
  current: MONITOR_A,
  onMoved: null as null | (() => void),
};
const setSize = vi.fn((s: Rect) => {
  native.size = { width: s.width, height: s.height };
  return Promise.resolve();
});
const setPosition = vi.fn((p: { x: number; y: number }) => {
  native.position = { x: p.x, y: p.y };
  return Promise.resolve();
});
const fakeWindow = (): Record<string, unknown> => ({
  label: native.label,
  setSize,
  setPosition,
  scaleFactor: () => Promise.resolve(1),
  innerSize: () => Promise.resolve({ ...native.size }),
  outerPosition: () => Promise.resolve({ ...native.position }),
  setMaximizable: () => Promise.resolve(),
  setAlwaysOnTop: () => Promise.resolve(),
  onResized: () => Promise.resolve(() => {}),
  onMoved: (cb: () => void) => {
    native.onMoved = cb;
    return Promise.resolve(() => {
      native.onMoved = null;
    });
  },
  onCloseRequested: () => Promise.resolve(() => {}),
  destroy: () => Promise.resolve(),
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: fakeWindow }));
vi.mock('@tauri-apps/api/window', () => ({
  availableMonitors: () => Promise.resolve(native.monitors),
  currentMonitor: () => Promise.resolve(native.current),
  getAllWindows: () =>
    Promise.resolve([native.label, ...native.others].map((label) => ({ label }))),
}));

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
    }, [props]);
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

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { SIMULATOR_PLACEMENT_STORE_FILE, resetPlacementStoreForTests } =
  await import('../../src/lib/simulator-window-placement');

function setScreen(availWidth: number, availHeight: number): void {
  Object.defineProperty(window.screen, 'availWidth', { configurable: true, value: availWidth });
  Object.defineProperty(window.screen, 'availHeight', { configurable: true, value: availHeight });
}

function renderSim(): ReturnType<typeof render> {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

/** Let the first-open fit (a setTimeout(0), then several awaited window ops and
 *  its 90 ms read-back) run to the end. */
async function settle(ms = 300): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function actualSizeHeight(): Promise<number> {
  setSize.mockClear();
  await act(async () => {
    fireEvent.keyDown(document, { key: '0', code: 'Digit0', metaKey: true });
    await Promise.resolve();
  });
  await settle();
  const h = setSize.mock.calls[0]?.[0]?.height;
  expect(h, 'Cmd+0 sized the window').toBeDefined();
  return h as number;
}

beforeEach(() => {
  stores.clear();
  resetPlacementStoreForTests();
  setSize.mockClear();
  setPosition.mockClear();
  native.size = { width: 330, height: 718 };
  native.position = { x: 120, y: 120 };
  native.monitors = [MONITOR_A, MONITOR_B];
  native.others = [];
  native.current = MONITOR_A;
  native.onMoved = null;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  setScreen(2560, 1415);
});
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('the phone scales to the screen', () => {
  it('a fresh open with nothing remembered is LARGER than 1:1 on a big screen', async () => {
    renderSim();
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const opened = setSize.mock.calls[0]?.[0]?.height as number;
    const oneToOne = await actualSizeHeight();
    expect(opened).toBeGreaterThan(oneToOne);
    // …and still leaves the screen's edge free.
    expect(opened).toBeLessThanOrEqual(1415 - 24);
  });

  it('a size the customer left LARGER than 1:1 is the size it reopens at (not shrunk back)', async () => {
    // T-12's per-screen size, with no placement: the window was dragged large on
    // this screen last time.
    stores.set(
      'settings.json',
      new Map([
        ['driftstack', { simulatorWindowSize: { '2560x1415': { width: 560, height: 1250 } } }],
      ]),
    );
    renderSim();
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    expect(setSize.mock.calls[0]?.[0]?.height).toBe(1250);
  });

  it('CONTROL — on a small laptop screen the fresh open still fits the screen', async () => {
    setScreen(1440, 875);
    renderSim();
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const opened = setSize.mock.calls[0]?.[0]?.height as number;
    expect(opened).toBeLessThanOrEqual(Math.round(875 * 0.82));
  });

  it('a browser-bar toggle keeps a phone that is larger than 1:1', async () => {
    const { container } = renderSim();
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    const opened = native.size.height;
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    await settle(400);
    const toggle = Array.from(container.querySelectorAll('button')).find((b) =>
      /Browser mode/.test(b.textContent ?? ''),
    );
    expect(toggle, 'browser-mode toggle').toBeDefined();
    setSize.mockClear();
    fireEvent.click(toggle as HTMLButtonElement);
    await settle(400);
    expect(setSize).toHaveBeenCalled();
    // The toggle adds or removes the address-bar rows (~40-70 px); it must not
    // snap the phone back to 1:1, which is hundreds of px shorter here.
    expect(Math.abs(native.size.height - opened)).toBeLessThan(120);
  });
});

describe('the window reopens where it was left', () => {
  const REMEMBERED = {
    v: 1,
    x: 3100,
    y: 140,
    width: 560,
    height: 1150,
    monitor: { name: 'Studio Display', x: 2560, y: 0, width: 2560, height: 1440 },
  };

  it('on the remembered screen, at the remembered position and size', async () => {
    stores.set(SIMULATOR_PLACEMENT_STORE_FILE, new Map([['placement', REMEMBERED]]));
    renderSim();
    await waitFor(() => expect(setPosition).toHaveBeenCalled());
    await settle();
    expect(setPosition.mock.calls[0]?.[0]).toMatchObject({ x: 3100, y: 140 });
    expect(setSize.mock.calls[0]?.[0]?.height).toBe(1150);
  });

  it('a remembered spot that now hangs off its screen is pulled back onto it', async () => {
    stores.set(
      SIMULATOR_PLACEMENT_STORE_FILE,
      new Map([['placement', { ...REMEMBERED, x: 5000, y: 900 }]]),
    );
    renderSim();
    await waitFor(() => expect(setPosition).toHaveBeenCalled());
    const pos = setPosition.mock.calls[0]?.[0] as { x: number; y: number };
    expect(pos.x).toBeLessThan(2560 + 2560);
    expect(pos.y + 1150).toBeLessThanOrEqual(1440);
  });

  it('not when that screen is no longer connected', async () => {
    stores.set(SIMULATOR_PLACEMENT_STORE_FILE, new Map([['placement', REMEMBERED]]));
    native.monitors = [MONITOR_A];
    renderSim();
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    expect(setPosition).not.toHaveBeenCalled();
  });

  it('not on top of another phone that is already open', async () => {
    stores.set(SIMULATOR_PLACEMENT_STORE_FILE, new Map([['placement', REMEMBERED]]));
    native.others = ['main'];
    renderSim();
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    await settle();
    expect(setPosition).not.toHaveBeenCalled();
  });

  it('moving the window remembers where it was left, with its screen', async () => {
    renderSim();
    await waitFor(() => expect(native.onMoved).not.toBeNull());
    await settle();
    native.position = { x: 2900, y: 60 };
    native.current = MONITOR_B;
    await act(async () => {
      native.onMoved?.();
      await Promise.resolve();
    });
    await settle(600);
    const saved = stores.get(SIMULATOR_PLACEMENT_STORE_FILE)?.get('placement') as
      | typeof REMEMBERED
      | undefined;
    expect(saved).toMatchObject({
      x: 2900,
      y: 60,
      monitor: { name: 'Studio Display', x: 2560, y: 0, width: 2560, height: 1440 },
    });
  });
});
