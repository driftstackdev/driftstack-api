// SimulatorWindow — the URL bar shows an explicit IN-FLIGHT state on a slow tap-nav.
//
// ⛔ Owner item T-10: "URL Bar not always updating to new website. Especially when
// proxy slow, it's very annoying, we still need a lot more improvements."
//
// MEASURED mechanism: the address bar (liveUrl) is DERIVED from the active tab's
// stored url, which is written ONLY by a box-confirmed page_state — a data-channel
// frame or the ~2s poll. An ADDRESS-BAR navigate is optimistic (onNavigate sets the
// url itself, because the operator typed it). But a TAPPED link / redirect is NOT:
// the GUI cannot know a tap's destination, so on a slow proxy the bar keeps showing
// the OLD url until the box's first page_state arrives seconds later, with nothing
// saying work is happening. The fix makes that WAIT visible without EVER fabricating
// a url the GUI does not know:
//   1. a forwarded tap with no page_state within ~300ms → a loading indicator + the
//      (stale) url is DIMMED, never replaced;
//   2. the next page_state for that tab (loading/loaded/errored) clears it;
//   3. an 'errored' page_state → an inline "didn't load" line on the bar.
//
// VACUITY CONTROL: an address-bar navigate is optimistic and must show NO in-flight
// indicator — it already knows the url. That the SAME harness arms on a tap but not
// on onNavigate is what makes the indicator meaningful rather than always-on.
//
// Own file so the controllable page-state poll mock + fake timers don't leak into the
// base suites (mirrors simulator-window-pagestate-poll.test.tsx's harness).

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
const pageStateMock = vi.fn(() => Promise.resolve<unknown>(null));
// A synchronous thenable so getAgentSession resolves during the initial render's
// control-read effect — the path that confirms manual input (humanInputEnabled), the
// gate a forwarded tap must pass. Mirrors simulator-window-pagestate-poll.test.tsx.
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

// Fire a forwarded TAP on the device screen. Input is positively owned in this harness
// (manual mode + connected + publishing), so onPointerDownCapture={showTap} is armed
// and the tap is forwarded — exactly the signal the in-flight watch keys on.
function fireTap(container: HTMLElement): void {
  const host = container.querySelector('[data-component="simulator-screen-host"]');
  if (host === null) throw new Error('no screen host to tap');
  // jsdom has no PointerEvent constructor; build a bubbling event with finite coords
  // (the production handler rejects non-finite geometry) as simulator-window.test.tsx does.
  const evt = new Event('pointerdown', { bubbles: true });
  Object.defineProperties(evt, { clientX: { value: 80 }, clientY: { value: 160 } });
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

const bar = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="simulator-address-bar"]');
const inFlightSpinner = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="simulator-address-inflight"]');
const addressInput = (c: HTMLElement): HTMLInputElement | null =>
  c.querySelector('[data-component="simulator-address-bar"] [aria-label="Address bar"]');
const loadErrorLine = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="simulator-bar-load-error"]');

describe('SimulatorWindow — URL bar in-flight on a slow tap-navigation (T-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    sendNavigate.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('arm 1: a forwarded tap with no page_state within ~300ms shows the indicator over the DIMMED, unchanged stale url', async () => {
    const { container } = renderSim();
    await flush();
    // The device is on a real page — the bar shows its url (the "stale" url a tap can't predict).
    act(() => fireDataFrame({ state: 'loaded', url: 'https://stale.example/' }));
    expect(bar(container), 'browser-mode address bar renders').not.toBeNull();
    expect(addressInput(container)?.value).toBe('stale.example');
    // No indicator before any tap.
    expect(inFlightSpinner(container)).toBeNull();

    // The operator taps a link. The box (slow proxy) sends NO page_state for ~300ms.
    act(() => fireTap(container));
    await advance(320);

    // Property: the in-flight indicator renders.
    expect(inFlightSpinner(container)).not.toBeNull();
    // Property: the stale url is DIMMED (the bar admits it may be out of date)…
    expect(addressInput(container)?.getAttribute('data-inflight')).toBe('true');
    // Property: …but it is NEVER replaced with a fabricated destination.
    expect(addressInput(container)?.value).toBe('stale.example');
  });

  it('arm 2: the next box page_state (a loading frame) CLEARS the indicator and the bar tracks the target url', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'loaded', url: 'https://stale.example/' }));
    act(() => fireTap(container));
    await advance(320);
    expect(inFlightSpinner(container), 'precondition: in flight').not.toBeNull();

    // The box confirms the tapped page over the live data channel.
    act(() => fireDataFrame({ state: 'loading', url: 'https://target.example/page' }));

    // Property: the indicator clears the moment a page_state confirms.
    expect(inFlightSpinner(container)).toBeNull();
    // Property: the bar now tracks the box-reported target url (no longer dimmed/stale).
    expect(addressInput(container)?.value).toContain('target.example');
  });

  it('arm 3: an errored page_state surfaces the inline "didn\'t load" line on the bar', async () => {
    const { container } = renderSim();
    await flush();
    expect(loadErrorLine(container), 'no error line before any failure').toBeNull();

    // A top-level navigation the box reports as failed (before the page ever loaded).
    act(() => {
      fireDataFrame({ state: 'loading', url: 'https://blocked.example/' });
      fireDataFrame({
        state: 'errored',
        url: 'https://blocked.example/',
        error: { kind: 'connection', message: 'proxy refused' },
      });
    });

    // Property: the bar says the page didn't load, in plain words, instead of silence.
    const line = loadErrorLine(container);
    expect(line).not.toBeNull();
    expect(line?.textContent).toMatch(/didn't load/i);
  });

  it('VACUITY CONTROL: an address-bar navigate is optimistic — it shows NO in-flight indicator', async () => {
    const { container } = renderSim();
    await flush();
    const input = addressInput(container);
    expect(input, 'address bar present').not.toBeNull();

    // Type an address and submit (the optimistic path — the GUI KNOWS this destination).
    act(() => {
      fireEvent.change(input as HTMLInputElement, { target: { value: 'https://typed.example/' } });
      fireEvent.submit((input as HTMLInputElement).closest('form') as HTMLFormElement);
    });
    expect(sendNavigate, 'the navigate was actually issued').toHaveBeenCalled();
    // Wait past the arm window a TAP would have used.
    await advance(320);

    // Property: an optimistic navigate never arms the in-flight indicator.
    expect(inFlightSpinner(container)).toBeNull();
    // Property: it optimistically shows the typed destination (not dimmed/stale).
    expect(addressInput(container)?.getAttribute('data-inflight')).toBeNull();
    expect(addressInput(container)?.value).toContain('typed.example');
  });
});
