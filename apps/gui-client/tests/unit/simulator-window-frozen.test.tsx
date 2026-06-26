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
import { render, act } from '@testing-library/react';

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
const fakeRoom = {
  on: vi.fn(),
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
} = { recoverActions: [] };
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown) => void;
    onStateChange?: (s: { kind: string }) => void;
    onPublisher?: (p: string) => void;
    onVideoEl?: (el: HTMLVideoElement | null) => void;
    recoverAction?: { nonce: number; mode: string };
  }) => {
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
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

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
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
});
