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
  it('falls back to the raw text for unrecognized errors, else a generic line', () => {
    expect(friendlyConnectError(new Error('weird thing'))).toBe('weird thing');
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
      expect(overlay?.textContent).toMatch(/couldn’t start the session/i);
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
});
