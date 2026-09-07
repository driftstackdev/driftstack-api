// SimulatorWindow — a typed navigation keeps the bar on the TYPED url while the box
// is still reporting the page it has not left yet (T-23).
//
// ⛔ Owner item T-23 (#9): "When entering a URL and the page takes a while to load
// (slow proxy), the URL in our simulator doesn't show the new URL … but still the old
// one for a while."
//
// MEASURED mechanism: onNavigate is optimistic (setLiveUrl + the active tab's url), but
// the ~2s page-state POLL only suppressed tabId-LESS frames inside a 2.5s grace. Current
// nodes stamp tabId, so the poll's `url` — the page still current on the box until the
// new load commits — reached writeTabPageState and reverted the tab's url to the OLD
// address within 2s; the bar derives from the tab url, so it showed the old page until
// the box's `loading` frame for the new url landed. The fix holds a frame carrying the
// PRE-navigation url while a GUI-issued navigation is pending (judgePendingNavigationFrame
// in lib/url-bar-inflight.ts); the target, a redirect, an error or the 20s ceiling
// resolves it.
//
// Own file: a controllable poll mock + fake timers + a tab-list capture, kept out of
// the base suites (mirrors a-url-bar-shows-in-flight-on-a-slow-nav.test.tsx).

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
const sendTabListUpdate = vi.fn(() => Promise.resolve());
const sendActivateTab = vi.fn(
  (_room: unknown, _payload: unknown, onRequestId?: (requestId: string) => void) => {
    onRequestId?.('req_1');
    return Promise.resolve('req_1');
  },
);
// Controllable page-state poll — each arm sets what the ~2s poll returns.
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
  sendNavigate: (...a: unknown[]) => sendNavigate(...(a as [])),
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

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

// Fire a page_state frame on the LIVE data channel (the box's authoritative push).
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Advance the fake clock and flush the poll tick(s) it fired + React updates.
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const addressInput = (c: HTMLElement): HTMLInputElement | null =>
  c.querySelector('[data-component="simulator-address-bar"] [aria-label="Address bar"]');
const loadbar = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="simulator-loadbar"]');
const advisory = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="page-load-stalled-banner"]');

type TabRow = { id: string; url: string; title: string };
function lastTabList(): { tabs: TabRow[]; activeTabId: string } {
  const calls = sendTabListUpdate.mock.calls as unknown as Array<
    [unknown, { tabs: TabRow[]; activeTabId: string }]
  >;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('sendTabListUpdate was not called');
  return last[1];
}

const OLD = 'https://old.example/';
const TARGET = 'https://new.example/';

// The device is on OLD, and the operator types TARGET.
async function onOldPageTypeTarget(container: HTMLElement): Promise<string> {
  await flush();
  act(() => fireDataFrame({ state: 'loaded', url: OLD, title: 'Old page' }));
  expect(addressInput(container)?.value, 'precondition: the bar shows the old page').toBe(
    'old.example',
  );
  const activeId = lastTabList().activeTabId;
  const input = addressInput(container) as HTMLInputElement;
  act(() => {
    fireEvent.change(input, { target: { value: TARGET } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
  });
  expect(sendNavigate, 'the navigate was actually issued').toHaveBeenCalled();
  expect(addressInput(container)?.value).toContain('new.example');
  return activeId;
}

describe('SimulatorWindow — a typed navigation outranks a stale page_state (T-23)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    sendNavigate.mockClear();
    sendTabListUpdate.mockClear();
    sendActivateTab.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('arm 1: the poll still reports the OLD url at 2.6s (tabId-stamped) and 4.1s (legacy, past grace) — the bar keeps the typed target and the load chrome stays up', async () => {
    const { container } = renderSim();
    const activeId = await onOldPageTypeTarget(container);

    // The box has not left the old page yet; the poll says so, stamped with the tab.
    pageStateMock.mockResolvedValue({
      state: 'loaded',
      url: OLD,
      title: 'Old page',
      tabId: activeId,
    });
    await advance(2_600);
    // Property: the typed destination is NOT written back to the old address.
    expect(addressInput(container)?.value).toContain('new.example');
    expect(lastTabList().tabs.find((t) => t.id === activeId)?.url).toBe(TARGET);
    // Property: the stale frame did not read as "the new page finished".
    expect(loadbar(container)).not.toBeNull();

    // The legacy (tabId-less) shape past the 2.5s grace is the same stale frame.
    pageStateMock.mockResolvedValue({ state: 'loaded', url: OLD, title: 'Old page' });
    await advance(1_500);
    expect(addressInput(container)?.value).toContain('new.example');

    // The advisory ladder is unaffected by the held frames: the 9s rung shows.
    await advance(6_000);
    expect(advisory(container)).toHaveTextContent(/still loading/i);
  });

  it('VACUITY CONTROL: the poll reports the TARGET → the pending navigation resolves, the frame writes through, and nothing is held afterwards', async () => {
    const { container } = renderSim();
    const activeId = await onOldPageTypeTarget(container);

    pageStateMock.mockResolvedValue({
      state: 'loaded',
      url: TARGET,
      title: 'Arrived',
      tabId: activeId,
    });
    await advance(2_600);
    expect(addressInput(container)?.value).toContain('new.example');
    // The write went through (a held frame could not have set this title).
    expect(lastTabList().tabs.find((t) => t.id === activeId)?.title).toBe('Arrived');

    // Resolved means resolved: a later old-url frame is the box's truth, not stale.
    pageStateMock.mockResolvedValue({
      state: 'loaded',
      url: OLD,
      title: 'Old page',
      tabId: activeId,
    });
    await advance(2_000);
    expect(addressInput(container)?.value).toBe('old.example');
  });

  it('redirect: a `loading` frame for a THIRD url is shown (the box went somewhere else on purpose)', async () => {
    const { container } = renderSim();
    await onOldPageTypeTarget(container);
    act(() => fireDataFrame({ state: 'loading', url: 'https://third.example/landing' }));
    expect(addressInput(container)?.value).toContain('third.example');
  });

  it('ceiling: with no confirming frame for 20s the old url is allowed back, and the advisory path is the one it always was', async () => {
    const { container } = renderSim();
    const activeId = await onOldPageTypeTarget(container);
    pageStateMock.mockResolvedValue({
      state: 'loaded',
      url: OLD,
      title: 'Old page',
      tabId: activeId,
    });

    // Before the ceiling: held (and the ladder's 9s rung is up regardless).
    await advance(19_500);
    expect(addressInput(container)?.value).toContain('new.example');
    expect(advisory(container)).toHaveTextContent(/still loading/i);

    // The tick past the 20s ceiling admits the frame: the bar follows the box again,
    // and — unchanged from before this fix — an admitted `loaded` retires the load
    // chrome exactly as it would have for any other terminal frame.
    await advance(1_100);
    expect(addressInput(container)?.value).toBe('old.example');
    expect(advisory(container)).toBeNull();
    // The bar snaps to 100% and fades over 300ms before it unmounts.
    await advance(400);
    expect(loadbar(container)).toBeNull();
  });

  it('another tab: a frame for a BACKGROUND tab is untouched — even with the very url the pending tab would hold', async () => {
    const { container } = renderSim();
    await flush();
    // Two tabs. The seed tab becomes the background; the new tab is where we navigate.
    act(() => {
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    });
    act(() => fireDataFrame({ type: 'activateTabResult', requestId: 'req_1', ok: true }));
    const { activeTabId: activeId, tabs } = lastTabList();
    const bgId = tabs.map((t) => t.id).find((id) => id !== activeId);
    if (bgId === undefined) throw new Error('expected a background tab');
    // The active (new) tab is on OLD; the operator types TARGET there.
    act(() => fireDataFrame({ tabId: activeId, state: 'loaded', url: OLD, title: 'Old page' }));
    expect(addressInput(container)?.value).toBe('old.example');
    const input = addressInput(container) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: TARGET } });
      fireEvent.submit(input.closest('form') as HTMLFormElement);
    });
    expect(addressInput(container)?.value).toContain('new.example');

    // A frame for the background tab carrying OLD writes that tab as usual.
    act(() =>
      fireDataFrame({ tabId: bgId, state: 'loaded', url: OLD, title: 'Background moved here' }),
    );
    const bg = lastTabList().tabs.find((t) => t.id === bgId);
    expect(bg?.url).toBe(OLD);
    expect(bg?.title).toBe('Background moved here');
    expect(addressInput(container)?.value).toContain('new.example');

    // Same frame for the PENDING tab: held (the only thing that differs is the tabId).
    act(() => fireDataFrame({ tabId: activeId, state: 'loaded', url: OLD, title: 'Old page' }));
    expect(addressInput(container)?.value).toContain('new.example');
    expect(lastTabList().tabs.find((t) => t.id === activeId)?.url).toBe(TARGET);
  });
});
