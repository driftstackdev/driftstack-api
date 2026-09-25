// Owner item 2 (2026-09-24): "Simulator page load, usually stays at like 85%
// loading, even tho page is already fully loaded. URL scrolling thing goes with
// it when scrolling down, keep spinning."
//
// Two indicators, two root causes (lib/simulator-load-indicators.ts):
//
//   LOAD BAR — the 2 s page-state POLL replays the server's stored copy of the
//   phone's page state, which lags the live data channel by up to two minutes
//   (the phone forwards it only when the server next talks to it). Each replayed
//   `loading` re-armed the bar after the live channel had said `loaded`, parking
//   its trickle under 90% over a finished page — and when the page rewrote its
//   address while scrolling, the replay looked like a new page and restarted it.
//
//   SPINNER — the address bar's "a tapped link may be loading" spinner was armed
//   on every pointer DOWN (the first half of a scroll too) and held for 20 s
//   waiting for a page state a scroll never produces.
//
// Each arm has its control: the poll still starts the bar when the live channel
// has said nothing, and a real tap still shows the spinner.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

const pageStateMock = vi.fn(() => Promise.resolve<unknown>(null));
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
  getAgentSessionPageState: () => pageStateMock(),
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
const { TAP_NAVIGATION_CONFIRM_MS } = await import('../../src/lib/simulator-load-indicators');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

function fireDataFrame(obj: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  fakeRoom.on.mock.calls
    .filter((c) => c[0] === 'dataReceived')
    .forEach((c) => {
      try {
        (c[1] as (p: Uint8Array) => void)(payload);
      } catch {
        /* a non-page_state subscriber ignores this frame */
      }
    });
}

function firePointer(container: HTMLElement, type: string, x: number, y: number): void {
  const host = container.querySelector('[data-component="simulator-screen-host"]');
  if (host === null) throw new Error('no screen host');
  const evt = new Event(type, { bubbles: true });
  Object.defineProperties(evt, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
  });
  fireEvent(host, evt);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const loadBar = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[data-component="simulator-loadbar"]');
/** The bar is showing a load in progress: mounted and not yet at its 100% fade. */
const barIsLoading = (c: HTMLElement): boolean => {
  const el = loadBar(c);
  return el !== null && el.style.opacity !== '0';
};
const inFlightSpinner = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="simulator-address-inflight"]');

const PAGE = 'https://shop.example/catalog';

describe('the load bar ends when the page has loaded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("a replayed 'loading' from the poll never restarts the bar after the live channel said 'loaded'", async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loading', url: PAGE, progress: 0 }));
    await advance(10);
    expect(barIsLoading(container), 'precondition: the load is showing').toBe(true);

    act(() => fireDataFrame({ state: 'loaded', url: PAGE, progress: 1 }));
    await advance(400);
    expect(loadBar(container), 'the finished load faded out').toBeNull();

    // The server's stored copy still says the page is loading, and the poll
    // replays it every 2 s.
    pageStateMock.mockResolvedValue({ state: 'loading', url: PAGE });
    for (let i = 0; i < 5; i += 1) {
      await advance(2000);
      expect(barIsLoading(container), `poll tick ${String(i + 1)}`).toBe(false);
    }
  });

  it('a page that rewrites its address while scrolling does not restart the bar', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loading', url: PAGE, progress: 0 }));
    act(() => fireDataFrame({ state: 'loaded', url: PAGE, progress: 1 }));
    // Scrolling a feed: the page moves its own address (history.replaceState),
    // which the phone reports as `loaded` for the new address.
    act(() => fireDataFrame({ state: 'loaded', url: `${PAGE}?page=2`, progress: 1 }));
    await advance(400);
    expect(loadBar(container)).toBeNull();

    pageStateMock.mockResolvedValue({ state: 'loading', url: PAGE });
    await advance(2000);
    await advance(2000);
    expect(barIsLoading(container)).toBe(false);
  });

  it('a focus change is not a page load: tapping into a field never restarts the bar', async () => {
    const { container } = renderSim();
    await flush();
    // A load the phone never finished reporting (cancelled), ended here by the poll.
    act(() => fireDataFrame({ state: 'loading', url: PAGE, progress: 0 }));
    pageStateMock.mockResolvedValue({ state: 'loaded', url: PAGE });
    await advance(3000);
    await advance(400);
    expect(barIsLoading(container), 'precondition: the bar ended').toBe(false);
    pageStateMock.mockResolvedValue(null);
    // The customer taps the search box: the phone sends its focus change with
    // its LAST recorded page state attached — still `loading` — and no url.
    act(() => fireDataFrame({ state: 'loading', inputFocused: true }));
    await advance(10);
    expect(barIsLoading(container)).toBe(false);
  });

  it('CONTROL — with nothing from the live channel yet, a polled loading still shows the bar', async () => {
    const { container } = renderSim();
    await flush();
    pageStateMock.mockResolvedValue({ state: 'loading', url: PAGE });
    await advance(2000);
    await advance(10);
    expect(barIsLoading(container)).toBe(true);
  });

  it('CONTROL — the poll still ENDS a load the live channel never finished', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loading', url: PAGE, progress: 0 }));
    await advance(10);
    expect(barIsLoading(container)).toBe(true);
    pageStateMock.mockResolvedValue({ state: 'loaded', url: PAGE });
    await advance(3000);
    await advance(400);
    expect(barIsLoading(container)).toBe(false);
  });
});

describe('the address-bar spinner is for taps, never scrolls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('a scroll (press, drag, release) never shows the spinner', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loaded', url: PAGE }));
    act(() => firePointer(container, 'pointerdown', 80, 300));
    act(() => firePointer(container, 'pointermove', 80, 250));
    act(() => firePointer(container, 'pointermove', 80, 150));
    act(() => firePointer(container, 'pointerup', 80, 150));
    await advance(400);
    expect(inFlightSpinner(container)).toBeNull();
    await advance(3000);
    expect(inFlightSpinner(container)).toBeNull();
  });

  it('a slow scroll that started as a hold stops the spinner the moment it moves', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loaded', url: PAGE }));
    act(() => firePointer(container, 'pointerdown', 80, 300));
    await advance(400);
    expect(inFlightSpinner(container), 'precondition: a held press may be a tap').not.toBeNull();
    act(() => firePointer(container, 'pointermove', 80, 240));
    expect(inFlightSpinner(container)).toBeNull();
  });

  it('a tap that does not navigate stops spinning within a few seconds, not twenty', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loaded', url: PAGE }));
    act(() => firePointer(container, 'pointerdown', 80, 300));
    act(() => firePointer(container, 'pointerup', 80, 300));
    await advance(400);
    expect(inFlightSpinner(container), 'CONTROL: a tap shows the spinner').not.toBeNull();
    await advance(TAP_NAVIGATION_CONFIRM_MS);
    expect(inFlightSpinner(container)).toBeNull();
  });

  it('CONTROL — a press that wobbles within the tap slop is still a tap', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loaded', url: PAGE }));
    act(() => firePointer(container, 'pointerdown', 80, 300));
    act(() => firePointer(container, 'pointermove', 84, 305));
    act(() => firePointer(container, 'pointerup', 84, 305));
    await advance(400);
    expect(inFlightSpinner(container)).not.toBeNull();
  });
});
