// SimulatorWindow — page-state POLL grace gate (Finding #7). The 2s page-state poll
// reads a server-side page-state store with no per-navigation correlation. Right after
// an operator navigate (or "Try again") — which clears the error overlay and re-arms the
// before-loaded gate — the NEXT poll can still read a STALE 'errored' from the store
// (the box hasn't re-reported the in-flight navigate yet) and re-pop the overlay on top
// of the now-loading page (the founder's "network-error overlay reappears even though the
// page loaded"). The fix gates the RAISE on the post-navigate/-switch grace window; a
// stale 'errored' is DEFERRED (not lost) until grace expires, while a genuine error still
// raises immediately via the live data-channel push. Own file so the controllable poll
// mock + fake timers don't leak into the base suites.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
// Controllable page-state poll — each test sets what the ~2s poll returns.
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
let panelRenderCount = 0;
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    panelRenderCount += 1;
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

const resumeChallengedSessionMock = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/agent-session-control', () => ({
  resumeChallengedSession: (...args: unknown[]) => resumeChallengedSessionMock(...args),
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

// Fire a page_state frame on the data channel (the live, ungated push path).
function fireDataFrame(obj: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  fakeRoom.on.mock.calls
    .filter((c) => c[0] === 'dataReceived')
    .forEach((c) => {
      try {
        (c[1] as (p: Uint8Array) => void)(payload);
      } catch {
        /* the latency-ping subscriber ignores a non-ping frame */
      }
    });
}

// Let pending promises (the poll result) resolve + React flush, under fake timers.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Advance the fake clock by `ms` and flush the resulting poll tick + React updates.
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const overlay = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="page-error-overlay"]');

const ERRORED = {
  state: 'errored',
  url: 'https://nope.invalid/',
  error: { kind: 'dns', message: 'lookup failed' },
};

describe('SimulatorWindow — page-state poll error grace gate (Finding #7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    panelRenderCount = 0;
    sendNavigate.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('a stale "errored" poll does NOT re-raise the overlay during the post-navigate grace window', async () => {
    const { container } = renderSim();
    await flush();
    expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);

    // A real top-level navigation failure raises the overlay (live data-channel push).
    act(() => {
      fireDataFrame({ state: 'loading', url: 'https://nope.invalid/' });
      fireDataFrame(ERRORED);
    });
    expect(overlay(container)).not.toBeNull();

    // The operator hits Try again / navigates: clears the overlay + opens the grace
    // window (lastNavAtRef = now, before-loaded gate re-armed).
    const addr = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(addr, { target: { value: 'https://nope.invalid/' } });
      fireEvent.submit(addr.closest('form') as HTMLFormElement);
    });
    expect(sendNavigate).toHaveBeenCalled();
    expect(overlay(container)).toBeNull(); // dismissed

    // The box hasn't re-reported the in-flight navigate yet, so the store still holds
    // the prior 'errored'. Advance ONE poll tick (2s) — still inside the 2.5s grace.
    pageStateMock.mockResolvedValue(ERRORED);
    await advance(2000);
    // The stale error must NOT re-pop the overlay during grace (the founder's bug).
    expect(overlay(container)).toBeNull();
  });

  it('once the grace window expires, a still-"errored" store DOES raise (deferred, not lost)', async () => {
    const { container } = renderSim();
    await flush();

    // Navigate to open the grace window.
    const addr = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(addr, { target: { value: 'https://nope.invalid/' } });
      fireEvent.submit(addr.closest('form') as HTMLFormElement);
    });
    expect(overlay(container)).toBeNull();

    // The store keeps reporting a genuine top-level 'errored'.
    pageStateMock.mockResolvedValue(ERRORED);
    await advance(2000); // tick #1 — still in grace → suppressed
    expect(overlay(container)).toBeNull();
    await advance(2000); // ~4s elapsed → out of grace → raises (deferred, never dropped)
    expect(overlay(container)).not.toBeNull();
  });

  it('a non-error poll state still clears a showing overlay (self-heal preserved)', async () => {
    const { container } = renderSim();
    await flush();

    // Raise a real overlay via the live push (before any loaded → honored).
    act(() => {
      fireDataFrame({ state: 'loading', url: 'https://x/' });
      fireDataFrame({ state: 'errored', url: 'https://x/', error: { kind: 'net', message: 'x' } });
    });
    expect(overlay(container)).not.toBeNull();

    // A later poll reports the page is loading/loaded again → the overlay clears
    // unconditionally (the grace gate only blocks RAISING, never clearing).
    pageStateMock.mockResolvedValue({ state: 'loaded', url: 'https://x/' });
    await advance(2000);
    expect(overlay(container)).toBeNull();
  });

  it('repeated identical live error and timeout-stall frames preserve parent snapshots', async () => {
    renderSim();
    await flush();

    const errorFrame = {
      state: 'errored',
      url: 'https://same-error.invalid/',
      error: { kind: 'dns', message: 'lookup failed' },
    };
    act(() => fireDataFrame(errorFrame));
    const rendersAfterError = panelRenderCount;
    act(() => fireDataFrame(errorFrame));
    expect(panelRenderCount).toBe(rendersAfterError);

    const stallFrame = {
      state: 'stalled',
      url: 'https://same-stall.invalid/',
      error: { kind: 'timeout', message: 'navigation is still pending' },
    };
    act(() => fireDataFrame(stallFrame));
    const rendersAfterStall = panelRenderCount;
    act(() => fireDataFrame(stallFrame));
    expect(panelRenderCount).toBe(rendersAfterStall);
  });
});

// The stalled badge has the same dual-source race as the error overlay: the data
// channel is the live source, the ~2s poll reads an un-TTL'd store. After the box
// RECOVERS (data channel pushes a non-stalled state → badge cleared) a poll can still
// read the STALE 'stalled' record and re-raise the "Reconnecting — page unresponsive"
// badge — which then stays lit for the full TTL because every poll re-stamps it. The
// fix defers the poll's stall flip to a fresher data-channel frame.
// V-2168 — page_state{state:'capture_stalled'} is a DISTINCT diagnosis from
// 'stalled': the renderer is alive and the page is fine, but the box's SCStream
// capture died and it is restarting it (seconds, self-healing). Before this the
// state was not even in the recognised set, so it fell through to the
// unknown-frame breadcrumb and the operator saw a frozen picture with no
// explanation. It became reachable in production only when the fleet's
// streaming health probe was armed.
// V-2170 — the bot-challenge auto-pause. The box detects a captcha, pauses the
// session, and publishes challengeDetected on the SAME room data channel as
// page_state. Before this the GUI had NO surface at all: the harness queued the
// event only to the CONTROL PLANE, so nothing reached the channel this window
// listens on. The operator saw the last frame, the agent had silently stopped,
// and no part of the UI said so.
describe('SimulatorWindow — a detected bot challenge is visible and resumable', () => {
  const badge = (c: HTMLElement): Element | null =>
    c.querySelector('[data-component="challenge-paused-badge"]');

  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    resumeChallengedSessionMock.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('⛔ raises the badge, naming the challenge, when the box reports one', async () => {
    const { container } = renderSim();
    await flush();
    expect(badge(container), 'no challenge yet').toBeNull();
    act(() =>
      fireDataFrame({
        type: 'challengeDetected',
        sessionId: 'agt_x',
        challengeId: 'chal_1',
        challenge: { type: 'recaptcha', confidence: 0.97, detail: 'https://x.invalid/' },
      }),
    );
    const b = badge(container);
    expect(b).not.toBeNull();
    expect(b?.textContent).toMatch(/recaptcha/);
    expect(b?.textContent).toMatch(/agent is stopped/i);
  });

  it('⛔ ROUND-TRIPS the challengeId on resume — a minted id would be rejected and stay paused', async () => {
    const { container } = renderSim();
    await flush();
    act(() =>
      fireDataFrame({
        type: 'challengeDetected',
        challengeId: 'chal_round_trip',
        challenge: { type: 'datadome' },
      }),
    );
    const btn = container.querySelector('[data-action="resume-after-challenge"]');
    expect(btn).not.toBeNull();
    act(() => {
      (btn as HTMLElement).click();
    });
    await flush();
    expect(resumeChallengedSessionMock).toHaveBeenCalledTimes(1);
    expect(resumeChallengedSessionMock.mock.calls[0]?.[1]).toBe('chal_round_trip');
  });

  it('⛔ A3 blind-spot arm: a render test cannot see whether the frame ARRIVES — pin the subscription', async () => {
    // A3 found that their own frame-contract and queue-state tests both stayed
    // green when the publish call itself was deleted. The client twin of that
    // blind spot: asserting the badge given a synthetic frame proves nothing
    // about whether this window is listening at all. So assert the listener.
    renderSim();
    await flush();
    expect(
      fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived'),
      'the window never subscribed to the room data channel — no box frame could reach it',
    ).toBe(true);
  });

  it('a frame without a challengeId is ignored rather than raising an unactionable badge', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ type: 'challengeDetected', challenge: { type: 'recaptcha' } }));
    expect(
      badge(container),
      'no id means no resume is possible, so the badge would be a dead end',
    ).toBeNull();
  });
});

describe('SimulatorWindow — capture_stalled says "restoring video", not "page unresponsive"', () => {
  const captureBadge = (c: HTMLElement): Element | null =>
    c.querySelector('[data-component="capture-stalled-badge"]');
  const stalledBadge = (c: HTMLElement): Element | null =>
    c.querySelector('[data-component="page-stalled-badge"]');

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

  it('⛔ raises its OWN badge — the page is healthy, so the unresponsive copy must not show', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'capture_stalled', url: 'https://x.invalid/' }));
    expect(captureBadge(container)).not.toBeNull();
    expect(captureBadge(container)?.textContent).toMatch(/Restoring video/);
    expect(stalledBadge(container), 'the page is not unresponsive').toBeNull();
  });

  it('clears as soon as the capture publishes again', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'capture_stalled', url: 'https://x.invalid/' }));
    expect(captureBadge(container)).not.toBeNull();
    act(() => fireDataFrame({ state: 'loaded', url: 'https://x.invalid/' }));
    expect(captureBadge(container)).toBeNull();
  });

  it('a renderer stall still reads as "page unresponsive" — the two diagnoses stay distinct', async () => {
    const { container } = renderSim();
    await flush();
    act(() => fireDataFrame({ state: 'stalled', url: 'https://x.invalid/' }));
    expect(stalledBadge(container)).not.toBeNull();
    expect(captureBadge(container)).toBeNull();
  });
});

describe('SimulatorWindow — page-stalled badge poll-re-raise gate', () => {
  const stalledBadge = (c: HTMLElement): Element | null =>
    c.querySelector('[data-component="page-stalled-badge"]');

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

  it('a stale "stalled" poll does NOT re-raise the badge right after the live channel cleared it', async () => {
    const { container } = renderSim();
    await flush();
    expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);

    // The renderer hung, then recovered — both reported over the live data channel.
    act(() => {
      fireDataFrame({ state: 'stalled', url: 'https://app.example' });
    });
    expect(stalledBadge(container)).not.toBeNull();
    act(() => {
      fireDataFrame({ state: 'loaded', url: 'https://app.example' });
    });
    expect(stalledBadge(container)).toBeNull();

    // The un-TTL'd store still holds the prior 'stalled'. A poll tick lands within the
    // grace window of the fresh data-channel 'loaded' → it must NOT re-raise the badge.
    pageStateMock.mockResolvedValue({ state: 'stalled', url: 'https://app.example' });
    await advance(2000);
    expect(stalledBadge(container)).toBeNull();
  });

  it('a genuine ongoing stall STILL raises from the poll when no fresher live frame exists', async () => {
    const { container } = renderSim();
    await flush();

    // No data-channel frame at all — the poll is the only source. A real 'stalled'
    // store read must light the badge (poll-as-fallback is preserved).
    pageStateMock.mockResolvedValue({ state: 'stalled', url: 'https://app.example' });
    await advance(2000);
    expect(stalledBadge(container)).not.toBeNull();
  });

  it('a page_state frame carrying logicalContentWidth/Height is processed normally (A3 W3005 dims reader is additive — never drops the frame or its state)', async () => {
    const { container } = renderSim();
    await flush();
    // A loading→errored sequence whose frames ALSO carry the fixed logical dims must
    // still raise the error overlay — proving the dims reader (which runs first) does
    // not drop or short-circuit the frame's state handling.
    act(() => {
      fireDataFrame({
        state: 'loading',
        url: 'https://dims.example/',
        logicalContentWidth: 402,
        logicalContentHeight: 678,
      });
      fireDataFrame({
        state: 'errored',
        url: 'https://dims.example/',
        error: { kind: 'dns', message: 'lookup failed' },
        logicalContentWidth: 402,
        logicalContentHeight: 678,
      });
    });
    expect(overlay(container)).not.toBeNull();
  });
});
