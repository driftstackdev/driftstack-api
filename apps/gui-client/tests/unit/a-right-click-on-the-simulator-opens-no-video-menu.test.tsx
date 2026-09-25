// Owner item 4 (2026-09-24): "I can right click on the simulator which I think
// should be removed. which shows options such as; show all controls, save video
// frame as.. … your choice, do as recommended"
//
// ROOT CAUSE: the phone's screen is a <video>, and nothing in the window handled
// `contextmenu`, so a right-click opened the web view's own VIDEO menu (Show All
// Controls, Save Video Frame As…) — and, off the phone, a menu with Reload, which
// reloads the Simulator window and drops its session.
//
// CHOSEN: suppress it everywhere and add nothing (lib/simulator-context-menu.ts
// says why). Text fields keep Cut / Copy / Paste. And a right press is not a
// touch: the input capture never forwards it, so it must not show a tap ripple
// or the "a tapped link may be loading" spinner either.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

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
// The screen as the app draws it: a <video> inside the panel.
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
    return (
      <div data-component="agent-session-panel-mock">
        <video data-testid="phone-video" />
      </div>
    );
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

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
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

function press(container: HTMLElement, button: number): void {
  const host = container.querySelector('[data-component="simulator-screen-host"]');
  if (host === null) throw new Error('no screen host');
  const evt = new Event('pointerdown', { bubbles: true });
  Object.defineProperties(evt, {
    clientX: { value: 80 },
    clientY: { value: 160 },
    pointerId: { value: 1 },
    button: { value: button },
  });
  fireEvent(host, evt);
}

/** `fireEvent` returns false when a handler called preventDefault(). */
const menuOpens = (el: Element): boolean => fireEvent.contextMenu(el);

describe('right-click in the Simulator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("opens no native menu on the phone's video (no Show All Controls / Save Video Frame)", async () => {
    const { getByTestId } = renderSim();
    await flush();
    expect(menuOpens(getByTestId('phone-video'))).toBe(false);
  });

  it('opens no native menu on the frame or toolbar either (no Reload that drops the session)', async () => {
    const { container } = renderSim();
    await flush();
    const host = container.querySelector('[data-component="simulator-screen-host"]') as Element;
    expect(menuOpens(host)).toBe(false);
    const aButton = container.querySelector('button') as Element;
    expect(menuOpens(aButton)).toBe(false);
  });

  it('CONTROL — a text field keeps its Cut / Copy / Paste menu', async () => {
    const { container } = renderSim();
    await flush();
    const address = container.querySelector('[aria-label="Address bar"]');
    expect(address, 'address bar').not.toBeNull();
    expect(menuOpens(address as Element)).toBe(true);
  });

  it('a right press is not a tap: no "page may be loading" spinner', async () => {
    const { container } = renderSim();
    await flush();
    press(container, 2);
    await advance(400);
    expect(container.querySelector('[data-component="simulator-address-inflight"]')).toBeNull();
  });

  it('CONTROL — a left press still is', async () => {
    const { container } = renderSim();
    await flush();
    press(container, 0);
    await advance(400);
    expect(container.querySelector('[data-component="simulator-address-inflight"]')).not.toBeNull();
  });
});
