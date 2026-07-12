// SimulatorWindow — the client-side VIDEO-FREEZE detector ("Video frozen — …").
//
// #3/#6 — the detector keys on the <video> ELEMENT's OWN frame progress (rVFC
// last-frame time + currentTime advancement), NOT decodeFps. A3's idle frame-pump
// down-clock (W2952) drives the publish FPS to ~0 on a static/idle page, so a
// decodeFps===0 heuristic FALSE-FIRES "Video frozen" on a perfectly healthy idle
// stream (the reported "reconnecting, happens too often"). An idle-but-LIVE stream
// still advances currentTime / fires rVFC at the down-clocked rate, so it must NOT
// be flagged; only a TRUE freeze (the element stops producing frames) is.
//
// The badge must NOT fire during a LiveKit transport drop (disconnected/
// reconnecting): the panel's own "The live stream disconnected" overlay is the
// single source of truth there. Own file so the panel→room + connection-stats
// mocks don't leak into the base suite.

import { useEffect, useRef } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

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

// Connection stats are still surfaced (diagnostics) but no longer drive the freeze
// detector — kept here only so the component renders.
const conn = {
  transport: null as string | null,
  relayed: null as boolean | null,
  rttMs: null as number | null,
  packetLossPct: null as number | null,
  jitterMs: null as number | null,
  decodeFps: null as number | null,
  freezeCount: null as number | null,
};
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => conn,
  // #60 transport telemetry is a side-effect-only hook (returns void); stub it as
  // a no-op so SimulatorWindow renders without the real POST.
  useTransportTelemetry: () => undefined,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

// A driveable fake <video> element: the test controls when rVFC fires (a produced
// frame) and the currentTime value (the rVFC-independent fallback). armFpsCounter
// records a frame on every rVFC tick; the freeze detector also samples currentTime.
type FakeVideo = HTMLVideoElement & {
  __fireFrame: () => void;
  __setCurrentTime: (t: number) => void;
};

function makeFakeVideo(): FakeVideo {
  let pending: ((now: number) => void) | null = null;
  let ct = 0;
  const el = {
    // armFpsCounter re-arms per frame; we hold the latest callback and fire it on demand.
    requestVideoFrameCallback: (cb: (now: number) => void) => {
      pending = cb;
      return 1;
    },
    get currentTime() {
      return ct;
    },
    __fireFrame() {
      const cb = pending;
      pending = null;
      cb?.(performance.now());
    },
    __setCurrentTime(t: number) {
      ct = t;
    },
  } as unknown as FakeVideo;
  return el;
}

// The panel mock surfaces a fake room + driveable connection/publisher state AND a
// fake <video> via onVideoEl so the freeze detector has a real frame-progress source.
// #6 — track the LATEST 'dataReceived' registration (not the first): the onData
// effect can re-subscribe across renders, and a stale early registration would
// silently swallow state updates a test fires against it. Mirrors the proven
// capture pattern in simulator-window-ios-chrome.test.tsx.
let latestDataHandler: ((p: Uint8Array) => void) | null = null;
const fakeRoom = {
  on: vi.fn((event: string, cb: (p: Uint8Array) => void) => {
    if (event === 'dataReceived') latestDataHandler = cb;
  }),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
const panelCbs: {
  onStateChange?: (s: { kind: string }) => void;
  onPublisher?: (p: string) => void;
  video?: FakeVideo;
  // #5/#9 — every distinct recoverAction the simulator pushes down (the panel reacts
  // to each .nonce bump; the test asserts the resubscribe→rebuild sequence).
  recoverActions: Array<{ nonce: number; mode: string }>;
  // P1a — the latest sessionEnded prop the simulator passes (terminal-end signal).
  sessionEnded?: { reason: string | null } | null;
} = { recoverActions: [] };
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown) => void;
    onStateChange?: (s: { kind: string }) => void;
    onPublisher?: (p: string) => void;
    onVideoEl?: (el: HTMLVideoElement | null) => void;
    recoverAction?: { nonce: number; mode: string };
    sessionEnded?: { reason: string | null } | null;
  }) => {
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    panelCbs.sessionEnded = props.sessionEnded ?? null;
    // Record each distinct recoverAction nonce the simulator drives (skip the inert
    // initial nonce 0 / repeats — mirrors the real panel's single-fire-per-nonce).
    const a = props.recoverAction;
    if (a !== undefined && a.nonce !== 0 && panelCbs.recoverActions.at(-1)?.nonce !== a.nonce) {
      panelCbs.recoverActions.push({ nonce: a.nonce, mode: a.mode });
    }
    const ref = useRef<FakeVideo | null>(null);
    if (ref.current === null) {
      ref.current = makeFakeVideo();
      panelCbs.video = ref.current;
    }
    // Fire the initial live state ONCE (empty deps). Re-asserting 'connected' on every
    // render would clobber a test-driven 'reconnecting' transition.
    useEffect(() => {
      props.onRoom?.(fakeRoom);
      props.onVideoEl?.(ref.current);
      props.onStateChange?.({ kind: 'connected' });
      props.onPublisher?.('publishing');
    }, []);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// P1a — getAgentSession is the lifecycle/liveness source. Mutable so a test can flip
// it to a TERMINAL status (the worker browser closed / session destroyed) and assert
// the freeze recovery machinery short-circuits + the terminal overlay shows.
// `error` lets a test force getAgentSession to REJECT (e.g. a 401/403 from an
// expired gui_control_key) instead of resolving — exercising finding #4.
const sessionState = {
  current: {
    mode: 'manual' as const,
    pairKind: null as string | null,
    terminal: false,
    status: 'active' as string | null,
    closedReason: null as string | null,
  },
  error: null as unknown,
};
// A minimal AgentSessionControlError twin carrying `status` (the real one does too) so
// the catch can branch on 401/403.
class FakeControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentSessionControlError';
  }
}
// Spies (not inline arrows) so the poll-stop tests can count invocations.
const getAgentSessionSpy = vi.fn(() => {
  // Local const so TS narrows the rejection reason to Error after the null check
  // (a mutable object property does not narrow inside this closure).
  const err = sessionState.error;
  // err is an Error (AgentSessionControlError) when non-null; the rule's narrowing
  // check is over-strict for a mutable property read into a local, so scope-disable.
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  if (err !== null) return Promise.reject(err);
  return Promise.resolve({ ...sessionState.current });
});
const getAgentSessionPageStateSpy = vi.fn(() => Promise.resolve(null));
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () => getAgentSessionSpy(),
  getAgentSessionPageState: () => getAgentSessionPageStateSpy(),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: FakeControlError,
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

function frozenBadge(c: HTMLElement): Element | null {
  return c.querySelector('[data-component="video-frozen-badge"]');
}

// Advance fake timers in ~1s steps so the detector's 1s interval ticks fire, optionally
// running a per-step action (e.g. keep producing frames to model a live stream).
function advance(seconds: number, onStep?: () => void): void {
  for (let i = 0; i < seconds; i++) {
    act(() => {
      onStep?.();
      vi.advanceTimersByTime(1000);
    });
  }
}

describe('SimulatorWindow — client video-freeze detector', () => {
  beforeEach(() => {
    conn.decodeFps = null;
    panelCbs.recoverActions = [];
    panelCbs.sessionEnded = null;
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    sessionState.error = null;
    getAgentSessionSpy.mockClear();
    getAgentSessionPageStateSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT false-freeze an IDLE-but-live stream (currentTime keeps advancing) even with decodeFps at 0', () => {
    vi.useFakeTimers();
    conn.decodeFps = 0; // the idle down-clock drives the reported decode fps to ~0
    const { container } = renderSim();
    let t = 1;
    // Model an idle-but-LIVE stream: currentTime keeps advancing each second (the
    // down-clocked frame pump), but no rVFC frames flow. The detector must stay clear.
    advance(8, () => {
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    expect(frozenBadge(container)).toBeNull();
  });

  it('does NOT false-freeze a live stream that fires rVFC at the down-clocked rate', () => {
    vi.useFakeTimers();
    conn.decodeFps = 0;
    const { container } = renderSim();
    // rVFC fires once per ~second (down-clocked) — the element IS producing frames.
    advance(8, () => {
      panelCbs.video?.__fireFrame();
    });
    expect(frozenBadge(container)).toBeNull();
  });

  it('flags a TRUE freeze: the element stops producing frames (no rVFC, currentTime pinned) for ~4s', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    // First: real frames flow (arm the detector), currentTime advancing.
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    expect(frozenBadge(container)).toBeNull();
    // Now a TRUE freeze: no more rVFC, currentTime pinned. After ~4s the badge shows.
    advance(6);
    expect(frozenBadge(container)).not.toBeNull();
  });

  it('does NOT flag a freeze when the connection itself dropped (panel overlay owns that)', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    // The transport drops — frame progress naturally stops, but the connection is no
    // longer 'connected'. The freeze badge must stay suppressed (the panel's
    // disconnected overlay is the single source of truth).
    act(() => {
      panelCbs.onStateChange?.({ kind: 'reconnecting' });
    });
    advance(6);
    expect(frozenBadge(container)).toBeNull();
  });

  // #5/#9 — a SUSTAINED true freeze (while connected) must actively recover, not just
  // show a badge: first toggle the remote subscription (resubscribe → fresh keyframe),
  // then escalate ONCE to a Room rebuild if frame-progress still hasn't resumed. The
  // badge copy reflects reality (plain "Video frozen" until a recovery is in flight).
  it('drives resubscribe then escalates to rebuild on a sustained freeze that never recovers', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    // Arm the detector with real frames, then freeze (no rVFC, currentTime pinned).
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    expect(frozenBadge(container)).toBeNull();
    // FREEZE_AFTER_MS (4s) → the badge shows; while it's only being SHOWN (no recovery
    // yet) the copy is the plain "Video frozen", never claiming to be recovering.
    advance(5);
    const badge = frozenBadge(container);
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-recovering')).toBe('false');
    expect(badge?.textContent).toMatch(/^Video frozen$/);
    expect(panelCbs.recoverActions).toHaveLength(0);
    // SUSTAINED_FREEZE_MS (8s) after the badge → stage 1: a resubscribe is driven and
    // the copy flips to "— recovering" (now it's actually true).
    advance(9);
    expect(panelCbs.recoverActions.map((r) => r.mode)).toEqual(['resubscribe']);
    const recoveringBadge = frozenBadge(container);
    expect(recoveringBadge?.getAttribute('data-recovering')).toBe('true');
    expect(recoveringBadge?.textContent).toMatch(/recovering/i);
    // RESUBSCRIBE_GRACE_MS (4s) later, still frozen → stage 2: escalate ONCE to a
    // Room rebuild. Exactly one escalation, then no further actions.
    advance(5);
    expect(panelCbs.recoverActions.map((r) => r.mode)).toEqual(['resubscribe', 'rebuild']);
    advance(5);
    expect(panelCbs.recoverActions.map((r) => r.mode)).toEqual(['resubscribe', 'rebuild']);
  });

  // A3 freeze-recovery cross-cycle cap (2026-07-11): a stage-2 rebuild churns connState
  // (reconnecting→connected), which the detector force-clears `videoFrozen` on — so a
  // budget keyed on `!videoFrozen` would reset on the rebuild's OWN blip → the ladder
  // re-escalates → infinite ~16s rebuild thrash. The budget must reset ONLY on SUSTAINED
  // frame progress (N consecutive currentTime advances). This models a stream that
  // delivers ONE frame per reconnect then re-freezes (never sustains) and asserts the
  // ladder caps at MAX_FREEZE_REBUILDS instead of rebuilding forever.
  it('caps the rebuild ladder across connState-blip cycles (no infinite ~16s thrash)', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    renderSim();
    let t = 1;
    const frame = (): void => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    };
    // Arm with real frames, then freeze → resubscribe → rebuild #1.
    advance(2, frame);
    advance(5); // FREEZE_AFTER_MS → frozen
    advance(9); // SUSTAINED_FREEZE_MS → resubscribe
    advance(5); // RESUBSCRIBE_GRACE_MS → rebuild #1
    expect(panelCbs.recoverActions.filter((r) => r.mode === 'rebuild')).toHaveLength(1);

    // Each cycle = the connState blip a rebuild causes → ONE frame on reconnect (arms the
    // detector but < SUSTAINED_PROGRESS_TICKS, so NOT genuine recovery — the cap must
    // survive) → re-freeze → next rebuild. Without the cap this repeats forever.
    const cycle = (): void => {
      act(() => panelCbs.onStateChange?.({ kind: 'reconnecting' }));
      advance(1);
      act(() => panelCbs.onStateChange?.({ kind: 'connected' }));
      advance(1, frame); // ONE frame on reconnect, then it re-freezes
      advance(5); // re-detect the freeze
      advance(9); // resubscribe
      advance(5); // rebuild
    };
    cycle(); // rebuild #2
    cycle(); // rebuild #3
    cycle(); // cap hit (3 >= MAX_FREEZE_REBUILDS) → NO rebuild #4

    const rebuilds = panelCbs.recoverActions.filter((r) => r.mode === 'rebuild');
    expect(rebuilds).toHaveLength(3); // capped — the ladder stopped thrashing the Room
  });

  // overlay audit wsob9ma70 — once the rebuild budget is exhausted the ladder goes
  // quiescent (correct), but the founder must not be stranded at a passive "Video frozen"
  // pill. The badge exposes a Reconnect affordance that earns a fresh budget + fires a
  // full Room reconnect.
  it('offers a working Reconnect on the frozen badge once the rebuild cap is exhausted', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    let t = 1;
    const frame = (): void => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    };
    advance(2, frame);
    advance(5);
    advance(9);
    advance(5); // rebuild #1
    const cycle = (): void => {
      act(() => panelCbs.onStateChange?.({ kind: 'reconnecting' }));
      advance(1);
      act(() => panelCbs.onStateChange?.({ kind: 'connected' }));
      advance(1, frame);
      advance(5);
      advance(9);
      advance(5);
    };
    cycle(); // #2
    cycle(); // #3
    cycle(); // cap hit → exhausted latched, no #4
    // The passive frozen pill is now an actionable Reconnect.
    const badge = frozenBadge(container);
    expect(badge?.getAttribute('data-exhausted')).toBe('true');
    const reconnect = container.querySelector('[data-component="video-frozen-reconnect"]');
    expect(reconnect).not.toBeNull();
    // Clicking it fires a FRESH full rebuild (deliberate human action earns a new budget).
    const before = panelCbs.recoverActions.filter((r) => r.mode === 'rebuild').length;
    act(() => {
      fireEvent.click(reconnect as Element);
    });
    expect(panelCbs.recoverActions.filter((r) => r.mode === 'rebuild').length).toBe(before + 1);
  });

  // GUI UX pass (Wave 1) — the founder must not be stranded through the multi-cycle
  // ~16s auto-recovery ladder with no action. The manual "Reconnect now" affordance
  // appears as soon as a recovery is actually IN FLIGHT (recovering) — not only after
  // the whole ladder exhausts — and firing it drives a fresh full rebuild immediately.
  it('offers "Reconnect now" mid-ladder once a recovery is in flight (not only after exhaustion)', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    // Detect the freeze — while merely SHOWN (not yet recovering) there's no button
    // (a sub-8s blip usually self-clears; the manual escape would be premature).
    advance(5);
    expect(frozenBadge(container)).not.toBeNull();
    expect(container.querySelector('[data-component="video-frozen-reconnect"]')).toBeNull();
    // SUSTAINED_FREEZE_MS → a resubscribe fires (recovering=true): now the manual
    // escape hatch is available, well before the ~48s exhaustion.
    advance(9);
    const badge = frozenBadge(container);
    expect(badge?.getAttribute('data-recovering')).toBe('true');
    expect(badge?.getAttribute('data-exhausted')).toBe('false');
    const reconnect = container.querySelector('[data-component="video-frozen-reconnect"]');
    expect(reconnect).not.toBeNull();
    // Clicking it short-circuits the ladder with an immediate fresh rebuild.
    const before = panelCbs.recoverActions.filter((r) => r.mode === 'rebuild').length;
    act(() => {
      fireEvent.click(reconnect as Element);
    });
    expect(panelCbs.recoverActions.filter((r) => r.mode === 'rebuild').length).toBe(before + 1);
  });

  // #5/#9 — if the resubscribe restores frame-progress before the escalation window,
  // the rebuild must NOT fire and the badge clears (frames are flowing again).
  it('does NOT escalate to rebuild if frame-progress resumes after the resubscribe', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    // Freeze long enough to reach stage 1 (4s detect + 8s sustained + margin).
    advance(13);
    expect(panelCbs.recoverActions.map((r) => r.mode)).toEqual(['resubscribe']);
    // Frames resume (the resubscribe worked) BEFORE the escalation window → the
    // machine resets: no rebuild, and the badge clears.
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    expect(frozenBadge(container)).toBeNull();
    // Keep advancing — the escalation must never fire now.
    advance(6);
    expect(panelCbs.recoverActions.map((r) => r.mode)).toEqual(['resubscribe']);
  });

  // P1a — terminal-status-stops-reconnect-and-shows-ended. When the CP reports the
  // session terminally ended (the worker browser closed), the ~5s status poll latches
  // sessionEnded → it's passed to the panel AND the freeze recovery machine
  // short-circuits (a frozen "last frame" of an ended session must NOT trigger
  // resubscribe→rebuild against a session that's gone).
  it('P1a: a terminal session status stops freeze recovery and surfaces sessionEnded to the panel', async () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    expect(container).toBeTruthy();
    // Arm the detector with real frames first.
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    expect(panelCbs.sessionEnded).toBeNull();
    // The session ends on the worker (browser closed). The ~5s poll picks it up.
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: true,
      status: 'closed',
      closedReason: 'idle_timeout',
    };
    // Advance the 5s status poll, then flush the async getAgentSession().then().
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
    });
    // The terminal-end signal reached the panel (it shows "Session ended", not reconnecting).
    expect(panelCbs.sessionEnded).toEqual({ reason: 'idle_timeout' });
    // Now the frame stream freezes (the ended session's last frame is pinned). Even
    // across the full sustained-freeze + escalation window, NO recovery is driven.
    advance(20);
    expect(panelCbs.recoverActions).toHaveLength(0);
  });

  // P1a (finding #7) — the toolbar's pulsing green "Live" indicator must CLEAR the
  // instant the session terminally ends, so it can't read as Live while the panel
  // shows the "Session ended" overlay (the "running after the browser closed"
  // confusion). The running indicator is gated on `running = sessionId !== '' &&
  // sessionEnded === null`.
  it('P1a: the toolbar "Live" running indicator clears once the session terminally ends', async () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    const liveCue = (): Element | null =>
      container.querySelector('[data-component="simulator-running-indicator"]');
    // A bound, still-live session shows the Live cue.
    expect(liveCue()).not.toBeNull();
    // The session terminally ends on the worker (browser closed); the ~5s poll latches it.
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: true,
      status: 'closed',
      closedReason: 'idle_timeout',
    };
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(panelCbs.sessionEnded).toEqual({ reason: 'idle_timeout' });
    // The Live cue is gone — it no longer contradicts the "Session ended" overlay.
    expect(liveCue()).toBeNull();
  });

  // P1a guard — a transient freeze on a LIVE session (status stays 'active') STILL
  // recovers; the terminal gate must not break the existing recovery path.
  it('P1a guard: a freeze on a still-LIVE session still drives recovery (terminal gate is precise)', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    let t = 1;
    advance(2, () => {
      panelCbs.video?.__fireFrame();
      panelCbs.video?.__setCurrentTime(t);
      t += 1;
    });
    // Status poll runs, session stays live (terminal=false).
    act(() => {
      vi.advanceTimersByTime(5_100);
    });
    expect(panelCbs.sessionEnded).toBeNull();
    expect(container).toBeTruthy();
    // A sustained freeze still escalates resubscribe→rebuild (existing behavior intact).
    advance(20);
    expect(panelCbs.recoverActions.map((r) => r.mode)).toEqual(['resubscribe', 'rebuild']);
  });
});

// Finding #4 — an expired per-session gui_control_key (24h TTL) 401/403s every
// terminal session-end poll, silently disabling ended-session detection. Surface it via
// the always-visible controlUnreachable badge so the operator knows live-status
// detection is degraded and to reopen the session.
describe('SimulatorWindow — gui_control_key expiry surfaces controlUnreachable', () => {
  beforeEach(() => {
    panelCbs.sessionEnded = null;
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    sessionState.error = null;
    getAgentSessionSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const badge = (c: HTMLElement): Element | null =>
    c.querySelector('[data-component="control-unreachable-badge"]');

  it('raises the controlUnreachable badge when the session-end poll gets a 401', async () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    expect(badge(container)).toBeNull();
    // The per-session key ages out → every getAgentSession 401s.
    sessionState.error = new FakeControlError('expired', 401);
    await act(async () => {
      vi.advanceTimersByTime(5_100); // the ~5s session-end poll fires
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(badge(container)).not.toBeNull();
  });

  it('raises the controlUnreachable badge on a 403 too', async () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    sessionState.error = new FakeControlError('forbidden', 403);
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(badge(container)).not.toBeNull();
  });

  it('does NOT raise the badge for a transient/network error (status 0 → silent retry)', async () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    // A bare Error (no status) models a network blip — must NOT read as a degraded key.
    sessionState.error = new Error('network');
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(badge(container)).toBeNull();
  });

  // GUI UX pass (Wave 1) — the badge was an informational dead-end ("control may not be
  // reaching the device" with nothing to do). It now carries a working Reconnect that
  // fires a full Room rebuild (re-establishing the data channel control rides on).
  it('offers a working Reconnect on the controlUnreachable badge (no longer a dead-end)', async () => {
    vi.useFakeTimers();
    panelCbs.recoverActions = [];
    const { container } = renderSim();
    sessionState.error = new FakeControlError('expired', 401);
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(badge(container)).not.toBeNull();
    const reconnect = container.querySelector('[data-component="control-unreachable-reconnect"]');
    expect(reconnect).not.toBeNull();
    const before = panelCbs.recoverActions.filter((r) => r.mode === 'rebuild').length;
    act(() => {
      fireEvent.click(reconnect as Element);
    });
    expect(panelCbs.recoverActions.filter((r) => r.mode === 'rebuild').length).toBe(before + 1);
  });
});

// Finding #5 — once the session terminally ends (one-way latch), the background polls
// must stop hammering / mutating UI on the dead session. Both effects gain a
// `sessionEnded !== null` early-return + a sessionEnded dep so they tear their interval
// down the moment the terminal end latches.
describe('SimulatorWindow — polls stop after the session terminally ends', () => {
  beforeEach(() => {
    panelCbs.sessionEnded = null;
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    sessionState.error = null;
    getAgentSessionSpy.mockClear();
    getAgentSessionPageStateSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the session-end poll AND the page-state poll once the session ends', async () => {
    vi.useFakeTimers();
    renderSim();
    // The session ends — the next ~5s poll latches it.
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: true,
      status: 'closed',
      closedReason: 'idle_timeout',
    };
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(panelCbs.sessionEnded).toEqual({ reason: 'idle_timeout' });

    // Both polls must now be quiescent: snapshot the call counts, advance well past
    // several of BOTH intervals (2s page-state, 5s session-end), and assert no growth.
    const endCallsAfterLatch = getAgentSessionSpy.mock.calls.length;
    const pageCallsAfterLatch = getAgentSessionPageStateSpy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getAgentSessionSpy.mock.calls.length).toBe(endCallsAfterLatch);
    expect(getAgentSessionPageStateSpy.mock.calls.length).toBe(pageCallsAfterLatch);
  });

  it('keeps BOTH polls running while the session is still live (the gate is precise)', async () => {
    vi.useFakeTimers();
    renderSim();
    // Session stays live (terminal=false) — let the polls run for a while.
    await act(async () => {
      vi.advanceTimersByTime(11_000); // ≥2 session-end ticks + ≥5 page-state ticks
      await Promise.resolve();
      await Promise.resolve();
    });
    const endCalls = getAgentSessionSpy.mock.calls.length;
    const pageCalls = getAgentSessionPageStateSpy.mock.calls.length;
    expect(endCalls).toBeGreaterThan(1);
    expect(pageCalls).toBeGreaterThan(1);
    // Keep advancing — a live session must keep polling.
    await act(async () => {
      vi.advanceTimersByTime(11_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getAgentSessionSpy.mock.calls.length).toBeGreaterThan(endCalls);
    expect(getAgentSessionPageStateSpy.mock.calls.length).toBeGreaterThan(pageCalls);
  });
});

// AI-mode view-only affordances + live pair-state refresh (GUI-issue batch 2026-06-30).
// In AI mode input capture is off, so the on-screen cues must say so honestly: no false
// tap-ripple (it signals "it worked" on a no-op) and a persistent "Agent is driving"
// badge over the video. The ~5s session-end poll also refreshes the live pair state.
describe('SimulatorWindow — AI-mode view-only cues + live pair-state', () => {
  beforeEach(() => {
    panelCbs.sessionEnded = null;
    sessionState.current = {
      mode: 'ai',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    sessionState.error = null;
    getAgentSessionSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Finding #7 — with input off in AI mode, a persistent badge over the video tells the
  // founder the agent has control (the only other cue lives in the collapsed drawer).
  it('shows the "Agent is driving" badge over the video in AI mode', async () => {
    const { container } = renderSim();
    const badge = await waitFor(() => {
      const b = container.querySelector('[data-component="ai-driving-badge"]');
      if (b === null) throw new Error('not yet');
      return b;
    });
    expect(badge.textContent).toContain('Agent is driving');
  });

  // Finding #6 — the tap-ripple must NOT bloom in AI mode (the tap is never sent, so a
  // "it worked" ripple is a false positive). It DOES bloom in manual mode (covered in the
  // base suite); here we assert the AI-mode suppression.
  it('does NOT bloom a tap-ripple on a screen tap in AI mode', async () => {
    const { container } = renderSim();
    // Wait for controlMode to settle to 'ai' (the driving badge proves the fetch landed).
    await waitFor(() => {
      if (container.querySelector('[data-component="ai-driving-badge"]') === null)
        throw new Error('not yet');
    });
    const host = container.querySelector('[data-component="simulator-screen-host"]');
    expect(host).not.toBeNull();
    (host as HTMLElement).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 600 }) as DOMRect;
    fireEvent.pointerDown(host as Element, { clientX: 120, clientY: 240 });
    expect(container.querySelector('[data-component="tap-ripple"]')).toBeNull();
  });

  // Finding #11 — the ~5s session-end poll already carries the live pairKind/mode; apply
  // them so the "who is driving" indicator + Take/Hand-back action stay truthful when the
  // agent grabs/releases control server-side. Here the server flips ai → manual.
  it('refreshes controlMode from the 5s poll when the server mode changes (ai → manual)', async () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    // Initial fetch (mount refreshControl) → AI badge present. Flush the resolved
    // getAgentSession microtasks (no waitFor — it polls on real timers, which deadlocks
    // under fake timers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-component="ai-driving-badge"]')).not.toBeNull();
    // The server hands control back to manual; the next ~5s session-end poll carries the
    // fresh mode (finding #11) and must apply it.
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The AI-driving badge is gone (controlMode is now manual).
    expect(container.querySelector('[data-component="ai-driving-badge"]')).toBeNull();
  });
});

// #6 (founder 2026-06-30) — the on-screen keyboard auto-shows/hides from the box's
// real DOM focus state (page_state.inputFocused), like a real iPhone, and must NOT
// pop for the AGENT's own typing in AI mode.
describe('SimulatorWindow — keyboard auto-show from inputFocused (#6)', () => {
  beforeEach(() => {
    sessionState.current = {
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    sessionState.error = null;
    getAgentSessionSpy.mockClear();
  });

  function dataHandler(): ((p: Uint8Array) => void) | null {
    return latestDataHandler;
  }
  function pushPageState(frame: Record<string, unknown>): void {
    act(() => {
      dataHandler()?.(new TextEncoder().encode(JSON.stringify(frame)));
    });
  }
  function keyboardToggle(container: HTMLElement): Element | null {
    return container.querySelector('[data-component="simulator-keyboard-toggle"]');
  }

  it('shows the keyboard the instant a field is focused (manual mode) and hides it on blur', async () => {
    const { container } = renderSim();
    await waitFor(() => expect(dataHandler()).not.toBeNull());
    expect(keyboardToggle(container)?.getAttribute('aria-pressed')).toBe('false');
    pushPageState({ state: 'loaded', url: 'https://example.com/', inputFocused: true });
    expect(keyboardToggle(container)?.getAttribute('aria-pressed')).toBe('true');
    pushPageState({ state: 'loaded', url: 'https://example.com/', inputFocused: false });
    expect(keyboardToggle(container)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a frame with no inputFocused field leaves the current visibility untouched', async () => {
    const { container } = renderSim();
    await waitFor(() => expect(dataHandler()).not.toBeNull());
    pushPageState({ state: 'loaded', url: 'https://example.com/', inputFocused: true });
    expect(keyboardToggle(container)?.getAttribute('aria-pressed')).toBe('true');
    pushPageState({ state: 'loading', url: 'https://example.com/next' });
    expect(keyboardToggle(container)?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does NOT auto-show for the agent`s own field focus in AI mode', async () => {
    sessionState.current = {
      mode: 'ai',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    };
    const { container } = renderSim();
    await waitFor(() => {
      if (container.querySelector('[data-component="ai-driving-badge"]') === null)
        throw new Error('not yet');
    });
    pushPageState({ state: 'loaded', url: 'https://example.com/', inputFocused: true });
    expect(keyboardToggle(container)?.getAttribute('aria-pressed')).toBe('false');
  });
});
