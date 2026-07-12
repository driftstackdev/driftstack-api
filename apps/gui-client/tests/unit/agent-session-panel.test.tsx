// AgentSessionPanel overlay UX — the connection-state overlay (spinner while
// connecting, and a Reconnect affordance that recovers from an error/disconnect
// without reloading). Mocks only the livekit-client wrapper so we drive the
// connection state machine deterministically.

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import {
  AgentSessionPanel,
  friendlyConnectError,
  isAuthConnectError,
  NO_PUBLISHER_TIMEOUT_MS,
  PUBLISHER_LOST_GRACE_MS,
  AUTO_RECONNECT_BACKOFF_MS,
} from '../../src/components/AgentSessionPanel';

const connectMock = vi.fn();
// A vi.fn() (not a plain arrow) so individual tests can override the room it
// returns — e.g. to capture the TrackSubscribed handler and fire a real track.
const createRoomMock = vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() }));

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: (...args: unknown[]) => createRoomMock(...args) as unknown,
  connectToAgentSession: (...args: unknown[]) => connectMock(...args) as unknown,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    ParticipantDisconnected: 'participantDisconnected',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DCBufferStatusChanged: 'dcBufferStatusChanged',
  },
}));

const INFO = { ws_url: 'wss://lk', token: 'tok' } as never;

describe('friendlyConnectError — raw LiveKit errors → customer copy', () => {
  it('maps an invalid/expired token to an HONEST relaunch message (Reconnect cannot mint a fresh token)', () => {
    const m = friendlyConnectError(
      new Error('could not establish signal connection: invalid authorization token'),
    );
    // Honest copy: relaunch the profile (mints a new token) — NOT "Reconnect to get a
    // fresh one", which would just loop on the same dead token.
    expect(m).toMatch(/expired — relaunch the profile/i);
    expect(m).not.toMatch(/authorization token/i); // raw jargon hidden
    expect(isAuthConnectError(m)).toBe(true);
  });
  it('maps a transport/signal failure to a connection-check message', () => {
    expect(friendlyConnectError(new Error('could not establish signal connection'))).toMatch(
      /reach the live-stream server/i,
    );
    expect(friendlyConnectError(new Error('WebSocket connection timeout'))).toMatch(
      /reach the live-stream server/i,
    );
  });
  it('maps a closed/disconnect to a close-or-reconnect message', () => {
    expect(friendlyConnectError(new Error('room closed'))).toMatch(/connection closed/i);
  });
  it('returns a generic friendly line for unrecognized errors (never leaks raw transport text)', () => {
    // Unrecognized transport strings (e.g. a cryptic -1004) must NOT reach the
    // overlay — they collapse to a friendly generic line (founder: no raw codes).
    expect(friendlyConnectError(new Error('weird thing'))).toMatch(/could not connect/i);
    expect(friendlyConnectError(new Error('weird thing'))).not.toMatch(/weird thing/);
    expect(friendlyConnectError(null)).toMatch(/could not connect/i);
  });
});

describe('AgentSessionPanel overlay UX', () => {
  it('shows a connecting spinner (no Reconnect button) before connect resolves', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {})); // never resolves → stays connecting
    const { container } = render(<AgentSessionPanel info={INFO} />);
    const overlay = container.querySelector('[data-overlay="connection-state"]');
    expect(overlay?.getAttribute('data-state')).toBe('connecting');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('[data-action="reconnect-stream"]')).toBeNull();
  });

  it('keeps the FIXED canonical box aspect on loadedmetadata (NOT the SFU-drifted live aspect) + still reports real dims for the window resize (A3 W2840)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const dims: Array<[number, number]> = [];
    const { container } = render(
      <AgentSessionPanel info={INFO} onVideoDimensions={(w, h) => dims.push([w, h])} />,
    );
    const panel = container.querySelector('[data-component="agent-session-panel"]') as HTMLElement;
    const video = container.querySelector('video') as HTMLVideoElement;
    // The box aspect is the fixed canonical device aspect (402:874 ≡ 1206/2622).
    expect(panel.style.aspectRatio).toBe((1206 / 2622).toString());
    // Simulate metadata arriving with a SFU-downscaled, slightly-off resolution.
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1320 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 2868 });
    fireEvent.loadedMetadata(video);
    // Founder 2026-06-23 / A3 W2840: the box must NOT adopt the drifted live aspect
    // (that letterboxed the view inside the exactly-402:874 host → "iPhone smaller").
    // It stays the canonical aspect; the <video> object-contain absorbs the drift.
    // The real dims still flow to the parent's one-time WINDOW resize.
    expect(panel.style.aspectRatio).toBe((1206 / 2622).toString());
    expect(dims).toEqual([[1320, 2868]]);
  });

  // Aspect-track — the <video> intrinsic can CHANGE after the first loadedmetadata frame
  // (the worker first publishes one aspect, then the content-only steady state settles a
  // beat later at the real aspect). The media element fires a native `resize` event each
  // time; the panel must FORWARD that to onVideoDimensions so the simulator re-fits the
  // screen-host to the live aspect (the founder's TOP black band: the host stayed sized to
  // the stale first-frame aspect → letterbox).
  it('forwards LATER intrinsic changes via the video `resize` event (steady-state aspect)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const dims: Array<[number, number]> = [];
    const { container } = render(
      <AgentSessionPanel info={INFO} onVideoDimensions={(w, h) => dims.push([w, h])} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    // First frame (loadedmetadata) at one aspect…
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 393 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 790 });
    fireEvent.loadedMetadata(video);
    // …then the steady-state intrinsic settles to a DIFFERENT aspect and fires `resize`.
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 268 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 452 });
    act(() => {
      video.dispatchEvent(new Event('resize'));
    });
    // Both the first-frame dims AND the later steady-state dims reach the parent.
    expect(dims).toEqual([
      [393, 790],
      [268, 452],
    ]);
  });

  it('ignores a `resize` that reports zero intrinsics (pre-metadata noise)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const dims: Array<[number, number]> = [];
    const { container } = render(
      <AgentSessionPanel info={INFO} onVideoDimensions={(w, h) => dims.push([w, h])} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 0 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 0 });
    act(() => {
      video.dispatchEvent(new Event('resize'));
    });
    expect(dims).toEqual([]);
  });

  it('keeps the live video ref attached across routine re-renders (no null/node churn)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const onVideoEl = vi.fn();
    const { container, rerender, unmount } = render(
      <AgentSessionPanel info={INFO} onVideoEl={onVideoEl} switching={false} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(onVideoEl).toHaveBeenCalledTimes(1);
    expect(onVideoEl).toHaveBeenLastCalledWith(video);

    // A normal state/prop render must not detach + reattach the unchanged media node.
    rerender(<AgentSessionPanel info={INFO} onVideoEl={onVideoEl} switching />);
    expect(container.querySelector('video')).toBe(video);
    expect(onVideoEl).toHaveBeenCalledTimes(1);

    // A real unmount still clears the parent handle exactly once.
    unmount();
    expect(onVideoEl).toHaveBeenCalledTimes(2);
    expect(onVideoEl).toHaveBeenLastCalledWith(null);
  });

  // P1b — the panel box uses the `aspectRatio` prop (the simulator drives it with the
  // LIVE content aspect, e.g. 402/714) so box == screen-host == <video> → no bottom
  // black band. Passing the content aspect must set the box's style aspectRatio to it.
  it('P1b: the box adopts the passed (live content) aspectRatio so the video fills it edge-to-edge', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const contentAspect = 402 / 714; // content-only frame (NOT the full-device 402/874)
    const { container } = render(<AgentSessionPanel info={INFO} aspectRatio={contentAspect} />);
    const panel = container.querySelector('[data-component="agent-session-panel"]') as HTMLElement;
    expect(panel.style.aspectRatio).toBe(contentAspect.toString());
    // NOT the old hardcoded full-device 402:874 box (which letterboxed the content).
    expect(panel.style.aspectRatio).not.toBe((1206 / 2622).toString());
  });

  it('shows an about:blank placeholder over the video while switching tabs; a terminal end wins (founder #5)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValue(new Promise(() => {}));
    const { container, rerender } = render(<AgentSessionPanel info={INFO} switching={false} />);
    expect(container.querySelector('[data-overlay="tab-switching"]')).toBeNull();
    // A switch in flight → the blank placeholder covers the (stale) old-tab video.
    rerender(<AgentSessionPanel info={INFO} switching={true} />);
    expect(container.querySelector('[data-overlay="tab-switching"]')).not.toBeNull();
    // A terminal "Session ended" takes priority over the switching placeholder.
    rerender(<AgentSessionPanel info={INFO} switching={true} sessionEnded={{ reason: null }} />);
    expect(container.querySelector('[data-overlay="tab-switching"]')).toBeNull();
    expect(container.querySelector('[data-overlay="session-ended"]')).not.toBeNull();
  });

  it('on a connect error shows a Reconnect button that re-triggers the connect', async () => {
    connectMock.mockReset();
    connectMock.mockRejectedValueOnce(new Error('boom')).mockReturnValue(new Promise(() => {})); // the retry stays connecting (no churn)
    const { container } = render(<AgentSessionPanel info={INFO} />);
    const btn = await waitFor(() => {
      const b = container.querySelector('[data-action="reconnect-stream"]');
      if (b === null) throw new Error('reconnect button not rendered yet');
      return b as HTMLButtonElement;
    });
    const callsBeforeClick = connectMock.mock.calls.length;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(connectMock.mock.calls.length).toBeGreaterThan(callsBeforeClick);
    });
  });

  it('on an EXPIRED-TOKEN error shows the relaunch instruction and NO Reconnect button (it cannot mint a fresh token)', async () => {
    connectMock.mockReset();
    connectMock.mockRejectedValueOnce(
      new Error('could not establish signal connection: invalid authorization token'),
    );
    const { container } = render(<AgentSessionPanel info={INFO} />);
    await waitFor(() => {
      const overlay = container.querySelector('[data-overlay="connection-state"]');
      if (overlay?.getAttribute('data-state') !== 'error') throw new Error('not errored yet');
    });
    // Honest relaunch copy, and NO Reconnect button (it would loop on the dead token).
    expect(container.textContent).toMatch(/expired — relaunch the profile/i);
    expect(container.querySelector('[data-action="reconnect-stream"]')).toBeNull();
  });

  // #59 — a launch that connects the room but never publishes a video track
  // (proxy down / the box never started) must NOT spin forever: after the
  // no-publisher timeout the overlay flips to a launch-failed state with Retry.
  it('#59: a connected-but-videoless room flips to a launch-failed overlay + Retry after the timeout', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      // Connect resolves (room joins LiveKit) but no TrackSubscribed ever fires.
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      // Let the connect promise settle → 'connected', publisher still 'waiting'.
      await act(async () => {
        await Promise.resolve();
      });
      // Before the timeout: the waiting spinner, no launch-failed copy / Retry.
      expect(container.querySelector('[data-action="retry-launch"]')).toBeNull();
      // Advance past the no-publisher window → publisher flips to 'none'.
      act(() => {
        vi.advanceTimersByTime(NO_PUBLISHER_TIMEOUT_MS + 100);
      });
      const overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-state')).toBe('none');
      expect(overlay?.textContent).toMatch(/couldn’t show the live view/i);
      const retry = container.querySelector('[data-action="retry-launch"]');
      expect(retry).not.toBeNull();
      // Retry re-runs the connect effect (new Room + a fresh attempt).
      const callsBefore = connectMock.mock.calls.length;
      act(() => {
        fireEvent.click(retry as HTMLButtonElement);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(connectMock.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  // #59 false-positive guard — a slow-but-working start (track arrives before the
  // timeout) must clear the timer and never show the launch-failed overlay.
  it('#59: a video track arriving before the timeout clears the timer — no launch-failed overlay', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      // Capture the TrackSubscribed handler so the test can fire it like a real track.
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      // Override the room JUST for this render so we can drive TrackSubscribed.
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      // A video track arrives well before the timeout.
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() });
      });
      // #153 first-frame gate (ww5k0xkmx): the publisher-state overlay clears only
      // once a real frame paints (videoWidth > 0), not on TrackSubscribed alone.
      act(() => {
        const video = container.querySelector('video') as HTMLVideoElement;
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 393 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: 790 });
        video.dispatchEvent(new Event('loadeddata'));
      });
      // Advance PAST the timeout — the cleared timer must not fire a 'none' state.
      act(() => {
        vi.advanceTimersByTime(NO_PUBLISHER_TIMEOUT_MS + 5_000);
      });
      expect(container.querySelector('[data-action="retry-launch"]')).toBeNull();
      // publisher === 'publishing' → no publisher-state overlay at all.
      expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // #1 — a transient track drop that RE-SUBSCRIBES within the grace window must show
  // only the calm "reconnecting…" pill (over the last frame) and NEVER the scary
  // launch-failed overlay. This is the founder's "reconnecting, happens too often"
  // (A3 idle frame-pump down-clock / brief SFU re-negotiation).
  it('#1: a transient track unsubscribe → re-subscribe shows a calm pill, NOT the launch-failed alarm', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      // Track arrives → publishing, no overlays.
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() });
      });
      // #153 first-frame gate (ww5k0xkmx): the overlay clears only once a real
      // frame paints (videoWidth > 0), not on TrackSubscribed alone. Sticky for
      // the rest of this connection, so the drop→re-subscribe below stays clear.
      act(() => {
        const video = container.querySelector('video') as HTMLVideoElement;
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 393 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: 790 });
        video.dispatchEvent(new Event('loadeddata'));
      });
      expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
      // The SFU drops the video track.
      act(() => {
        handlers['trackUnsubscribed']?.({ kind: 'video' });
      });
      // Within the grace: the calm pill shows, NOT the scary launch-failed overlay.
      expect(container.querySelector('[data-overlay="publisher-reconnecting"]')).not.toBeNull();
      expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
      // The track re-arrives BEFORE the grace expires.
      act(() => {
        vi.advanceTimersByTime(PUBLISHER_LOST_GRACE_MS - 500);
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() });
      });
      // Everything cleared — no pill, no alarm, ever.
      act(() => {
        vi.advanceTimersByTime(PUBLISHER_LOST_GRACE_MS + 1_000);
      });
      expect(container.querySelector('[data-overlay="publisher-reconnecting"]')).toBeNull();
      expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // #1 escalation — a track drop that does NOT recover within the grace must escalate
  // to the honest launch-failed overlay (the publisher really is gone).
  it('#1: a track drop with NO re-subscribe escalates to the launch-failed overlay after the grace', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() });
        handlers['trackUnsubscribed']?.({ kind: 'video' });
      });
      // Grace expires with no re-subscribe → 'none' overlay surfaces.
      act(() => {
        vi.advanceTimersByTime(PUBLISHER_LOST_GRACE_MS + 100);
      });
      expect(container.querySelector('[data-overlay="publisher-reconnecting"]')).toBeNull();
      const overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-state')).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  // #5/#9 — a recoverAction(mode:'resubscribe') toggles the remote video
  // publication's subscription off→on (forcing a fresh keyframe via the browser's
  // auto-PLI). The off fires immediately; the on fires after the short re-subscribe
  // beat so the SFU registers the unsubscribe first.
  it("#5/#9: recoverAction 'resubscribe' toggles the publication subscription off then on", async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (...a: unknown[]) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { rerender } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      // A video track arrives WITH its publication (the 2nd TrackSubscribed arg).
      // Model the REAL livekit-client side-effect: setSubscribed(false) unsubscribes
      // the track, which fires RoomEvent.TrackUnsubscribed (the panel's handler then
      // nulls its internal publication ref). The re-subscribe leg must NOT depend on
      // that nulled ref — it must drive setSubscribed(true) on the SAME publication.
      const setSubscribed = vi.fn((sub: boolean) => {
        if (sub === false) handlers['trackUnsubscribed']?.({ kind: 'video' });
      });
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() }, { setSubscribed });
      });
      // Drive a resubscribe recovery from the parent.
      act(() => {
        rerender(
          <AgentSessionPanel info={INFO} recoverAction={{ nonce: 1, mode: 'resubscribe' }} />,
        );
      });
      // Off fires immediately; on fires after the ~250ms beat.
      expect(setSubscribed).toHaveBeenCalledWith(false);
      expect(setSubscribed).not.toHaveBeenCalledWith(true);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // The re-subscribe must still land even though the unsubscribe nulled the ref.
      expect(setSubscribed).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // #5/#9 — a recoverAction(mode:'rebuild') is the single escalation: it bumps
  // retryNonce → the connect effect re-runs (a fresh Room + connect), tearing down +
  // reconnecting the whole stream.
  it("#5/#9: recoverAction 'rebuild' re-runs the connect effect (a fresh connect call)", async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const { rerender } = render(<AgentSessionPanel info={INFO} />);
    await act(async () => {
      await Promise.resolve();
    });
    const callsBefore = connectMock.mock.calls.length;
    act(() => {
      rerender(<AgentSessionPanel info={INFO} recoverAction={{ nonce: 1, mode: 'rebuild' }} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectMock.mock.calls.length).toBeGreaterThan(callsBefore);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
  });

  // #5/#9 — the SAME nonce re-render (a parent re-render that doesn't change the
  // recovery trigger) must NOT re-fire the action; only a DISTINCT nonce does.
  it('#5/#9: a re-render with the same recoverAction nonce does not re-fire the recovery', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (...a: unknown[]) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const action = { nonce: 1, mode: 'resubscribe' as const };
      const { rerender } = render(<AgentSessionPanel info={INFO} recoverAction={action} />);
      await act(async () => {
        await Promise.resolve();
      });
      const setSubscribed = vi.fn();
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() }, { setSubscribed });
      });
      // The initial render already consumed nonce 1 (before the track arrived → no-op,
      // and lastRecoverNonceRef is now 1). A re-render with the SAME nonce must not
      // toggle the (now-present) publication.
      act(() => {
        rerender(<AgentSessionPanel info={INFO} recoverAction={action} />);
        vi.advanceTimersByTime(300);
      });
      expect(setSubscribed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // #8 — an UNEXPECTED transport Disconnected auto-retries with backoff (it bumps the
  // connect effect via retryNonce → a fresh connect call) before falling back to the
  // manual Reconnect button. A brief network blip recovers itself.
  it('#8: an unexpected Disconnected auto-reconnects with backoff before the manual button', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      // Every render returns a room whose `on` re-captures into the same handlers map,
      // so the latest Disconnected handler is always the live one.
      createRoomMock.mockReturnValue({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeDrop = connectMock.mock.calls.length;
      // Transport drops unexpectedly.
      act(() => {
        handlers['disconnected']?.(undefined);
      });
      // It shows reconnecting (auto), NOT the manual disconnected overlay yet.
      const overlay = container.querySelector('[data-overlay="connection-state"]');
      expect(overlay?.getAttribute('data-state')).toBe('reconnecting');
      expect(container.querySelector('[data-action="reconnect-stream"]')).toBeNull();
      // After the first backoff the effect re-runs → another connect attempt.
      await act(async () => {
        vi.advanceTimersByTime(AUTO_RECONNECT_BACKOFF_MS[0] + 50);
        await Promise.resolve();
      });
      expect(connectMock.mock.calls.length).toBeGreaterThan(callsBeforeDrop);
    } finally {
      vi.useRealTimers();
      createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    }
  });

  // P1a — when the parent reports the session terminally ended, the panel shows a
  // clear "Session ended" overlay (with a Close action) and suppresses every
  // reconnecting/launch-failed/disconnected overlay. This is the founder's bug:
  // the GUI must NOT show "reconnecting" against a session that's gone.
  it('P1a: a terminally-ended session shows the "Session ended" overlay + Close, not reconnecting', async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const onClose = vi.fn();
    const { container } = render(
      <AgentSessionPanel info={INFO} sessionEnded={{ reason: null }} onClose={onClose} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const ended = container.querySelector('[data-overlay="session-ended"]');
    expect(ended).not.toBeNull();
    expect(ended?.textContent).toMatch(/session ended/i);
    expect(container.querySelector('[data-component="session-end-recap"]')).not.toBeNull();
    expect(container.querySelector('[data-summary="session-duration"]')?.textContent).toMatch(
      /less than a minute/i,
    );
    expect(container.querySelector('[data-summary="session-outcome"]')?.textContent).toMatch(
      /session closed/i,
    );
    // Finding #8 — the standalone Simulator can't relaunch in place (no account
    // API key / SDK client to mint a fresh session+token; that lives in the main
    // app), so the overlay must give the concrete next step instead of a dead-end
    // "Relaunch the profile to start a new one" with only a Close button.
    expect(ended?.textContent).toMatch(/relaunch the profile from the main Driftstack window/i);
    // No competing overlays.
    expect(container.querySelector('[data-overlay="connection-state"]')).toBeNull();
    expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
    expect(container.querySelector('[data-overlay="publisher-reconnecting"]')).toBeNull();
    // Close fires the parent callback (closes the window).
    fireEvent.click(
      container.querySelector('[data-action="close-ended-session"]') as HTMLButtonElement,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('recaps the elapsed live-view time and maps close reasons to friendly copy', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
      connectMock.mockReset();
      connectMock.mockResolvedValue(undefined);
      createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
      const { container, rerender } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });

      vi.setSystemTime(new Date('2026-07-12T13:07:00Z'));
      rerender(<AgentSessionPanel info={INFO} sessionEnded={{ reason: 'orphaned-lifetime' }} />);

      expect(container.querySelector('[data-summary="session-duration"]')?.textContent).toMatch(
        /1 hr 7 min/i,
      );
      expect(container.querySelector('[data-summary="session-outcome"]')?.textContent).toMatch(
        /session time limit reached/i,
      );
      expect(container.querySelector('[data-overlay="session-ended"]')?.textContent).not.toMatch(
        /orphaned-lifetime/i,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['max_duration', 'Session time limit reached', 'maximum running time'],
    ['budget-exhausted', 'Usage limit reached', 'configured usage limit'],
    ['customer-closed', 'Closed by you', 'closed from Driftstack'],
    ['browser_crashed', 'Browser stopped unexpectedly', 'stopped unexpectedly'],
    ['node-restarted', 'Live worker unavailable', 'live worker stopped'],
    ['session-ended', 'Session completed', 'ended normally'],
  ])('renders truthful bounded recap copy for %s', async (reason, outcome, explanation) => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const { container } = render(<AgentSessionPanel info={INFO} sessionEnded={{ reason }} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-summary="session-outcome"]')).toHaveTextContent(outcome);
    expect(container.querySelector('[data-overlay="session-ended"]')).toHaveTextContent(
      explanation,
    );
  });

  it('does not reflect an unknown internal close reason into the rendered overlay', async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const internalReason = 'worker_failed_direct=10.0.0.8_secret=abc';
    const { container } = render(
      <AgentSessionPanel info={INFO} sessionEnded={{ reason: internalReason }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const ended = container.querySelector('[data-overlay="session-ended"]');
    expect(ended).toHaveTextContent('Live worker unavailable');
    expect(ended?.outerHTML).not.toContain(internalReason);
  });

  // P1a — a Disconnected AFTER the session ended must NOT schedule the bounded
  // auto-reconnect (the founder-reported "reconnecting forever"). It shows the
  // terminal overlay and stays there — no fresh connect attempts on the backoff.
  it('P1a: a terminal-ended Disconnected does NOT auto-reconnect (no fresh connect on backoff)', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValue({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(
        <AgentSessionPanel info={INFO} sessionEnded={{ reason: 'idle_timeout' }} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeDrop = connectMock.mock.calls.length;
      // The transport drops (expected — the session ended).
      act(() => {
        handlers['disconnected']?.(undefined);
      });
      // Advance well past every backoff window: NO new connect attempt is scheduled.
      await act(async () => {
        vi.advanceTimersByTime(AUTO_RECONNECT_BACKOFF_MS.reduce((a, b) => a + b, 0) + 1_000);
        await Promise.resolve();
      });
      expect(connectMock.mock.calls.length).toBe(callsBeforeDrop);
      // The terminal overlay is shown — never the looping reconnecting/Reconnect UI.
      expect(container.querySelector('[data-overlay="session-ended"]')).not.toBeNull();
      expect(container.querySelector('[data-action="reconnect-stream"]')).toBeNull();
    } finally {
      vi.useRealTimers();
      createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    }
  });

  // P1a — a track drop after the session ended must NOT show the calm "reconnecting"
  // pill (the publisher is gone for good); the terminal overlay is the only thing.
  it('P1a: a track drop after the session ended shows the terminal overlay, not the reconnecting pill', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container, rerender } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      // Track was up, then the session ends (parent latches sessionEnded).
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() });
      });
      act(() => {
        rerender(<AgentSessionPanel info={INFO} sessionEnded={{ reason: null }} />);
      });
      // The SFU drops the video track AFTER the end.
      act(() => {
        handlers['trackUnsubscribed']?.({ kind: 'video' });
      });
      // No calm pill; the terminal overlay covers it.
      expect(container.querySelector('[data-overlay="publisher-reconnecting"]')).toBeNull();
      expect(container.querySelector('[data-overlay="session-ended"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
      createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    }
  });

  // P1a transient guard — a Disconnected while the session is STILL LIVE (sessionEnded
  // null) keeps the existing bounded auto-reconnect (the gate must not break the
  // transient-drop path).
  it('P1a guard: a transient Disconnected (session still live) STILL auto-reconnects', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      createRoomMock.mockReturnValue({ on: roomOn, disconnect: vi.fn() });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeDrop = connectMock.mock.calls.length;
      act(() => {
        handlers['disconnected']?.(undefined);
      });
      expect(
        container.querySelector('[data-overlay="connection-state"]')?.getAttribute('data-state'),
      ).toBe('reconnecting');
      await act(async () => {
        vi.advanceTimersByTime(AUTO_RECONNECT_BACKOFF_MS[0] + 50);
        await Promise.resolve();
      });
      expect(connectMock.mock.calls.length).toBeGreaterThan(callsBeforeDrop);
    } finally {
      vi.useRealTimers();
      createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    }
  });
});

describe('AgentSessionPanel optimistic tap ripple (#124 perceived-latency)', () => {
  it('spawns a ripple on pointerdown over the live video when interactive, and clears it after the timeout', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {})); // stays connecting; room is still created on mount
    vi.useFakeTimers();
    try {
      const { container } = render(<AgentSessionPanel info={INFO} interactive />);
      const video = container.querySelector('video') as HTMLVideoElement;
      // jsdom's PointerEvent drops clientX/Y; a MouseEvent typed 'pointerdown'
      // carries finite coords AND still triggers React's onPointerDown.
      act(() => {
        fireEvent(
          video,
          new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }),
        );
      });
      // An instant visual pulse appears the moment the pointer goes down —
      // masking the input→inject→re-encode→publish round-trip.
      expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(1);
      // …and it auto-clears so ripples never accumulate.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT spawn a ripple when the panel is non-interactive (subscriber-only embed — no real tap is sent)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const { container } = render(<AgentSessionPanel info={INFO} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
  });

  it('does NOT show false optimistic success while reliable input is congested', async () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    createRoomMock.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    });
    const onInputCongestionChange = vi.fn();
    const { container } = render(
      <AgentSessionPanel
        info={INFO}
        interactive
        onInputCongestionChange={onInputCongestionChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => handlers.dcBufferStatusChanged?.(false, 0));
    expect(onInputCongestionChange).toHaveBeenLastCalledWith(true);

    const video = container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
  });
});
