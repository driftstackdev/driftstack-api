// AgentSessionPanel overlay UX — the connection-state overlay (spinner while
// connecting, and a Reconnect affordance that recovers from an error/disconnect
// without reloading). Mocks only the livekit-client wrapper so we drive the
// connection state machine deterministically.

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import {
  AgentSessionPanel,
  friendlyConnectError,
  isAuthConnectError,
  NO_PUBLISHER_TIMEOUT_MS,
  PUBLISHER_LOST_GRACE_MS,
  SLOW_START_NOTICE_MS,
  AUTO_RECONNECT_BACKOFF_MS,
} from '../../src/components/AgentSessionPanel';
import {
  TUNNEL_SETUP_TIMEOUT_ROUTED_COPY,
  VPN_BRINGUP_END_COPY,
  isTypedBringupReason,
  preferTypedEndReason,
  vpnBringupEndCopy,
  vpnBringupPhaseRoute,
} from '../../src/lib/session-end-reason';
import type { LiveKitInfo } from '@driftstack/sdk';

const connectMock = vi.fn();
const sendInputEventMock = vi.fn(() => Promise.resolve());
// A vi.fn() (not a plain arrow) so individual tests can override the room it
// returns — e.g. to capture the TrackSubscribed handler and fire a real track.
const createRoomMock = vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() }));

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: (...args: unknown[]) => createRoomMock(...args) as unknown,
  connectToAgentSession: (...args: unknown[]) => connectMock(...args) as unknown,
  sendInputEvent: (...args: unknown[]) => sendInputEventMock(...args) as unknown,
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

/**
 * ⛔ A COMPLETE LiveKitInfo, not `{ws_url, token}`.
 *
 * These fixtures used to carry two fields and an `as never`, encoding the exact
 * belief V-1611 disproved in `SimulatorWindow`: that "the panel reads
 * ws_url/token only". It does not — `AgentSessionPanel` reads `info.room` as
 * the identity key for its session-timing reset, so a two-field fixture is a
 * fixture for a shape that never reaches this component.
 */
function liveKitInfo(over: Partial<LiveKitInfo> = {}): LiveKitInfo {
  return {
    ws_url: 'wss://lk',
    room: 'room-a',
    token: 'tok',
    participant_identity: 'participant-a',
    expires_at: '2026-08-25T13:00:00.000Z',
    ...over,
  };
}

const INFO = liveKitInfo();
const INPUT_AUTHORITY_EPOCH = 29;

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
  it('tags connection, publisher and teardown callbacks with the exact effect-owned Room', () => {
    connectMock.mockReset();
    connectMock.mockImplementation(() => new Promise(() => {}));
    createRoomMock.mockClear();
    const handlersA: Record<string, (...args: unknown[]) => void> = {};
    const handlersB: Record<string, (...args: unknown[]) => void> = {};
    const roomA = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        {
          // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
          // congestion effect subscribing 'reconnected' alongside the panel's own
          // handler, and real livekit delivers to every listener. A single-slot
          // mock silently dropped whichever registered first.
          const prev = handlersA[event];
          handlersA[event] =
            prev === undefined
              ? handler
              : (...args: unknown[]) => {
                  prev(...args);
                  handler(...args);
                };
        }
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    };
    const roomB = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        {
          // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
          // congestion effect subscribing 'reconnected' alongside the panel's own
          // handler, and real livekit delivers to every listener. A single-slot
          // mock silently dropped whichever registered first.
          const prev = handlersB[event];
          handlersB[event] =
            prev === undefined
              ? handler
              : (...args: unknown[]) => {
                  prev(...args);
                  handler(...args);
                };
        }
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    };
    createRoomMock.mockReturnValueOnce(roomA).mockReturnValueOnce(roomB);
    const onRoom = vi.fn();
    const onStateChange = vi.fn();
    const onPublisher = vi.fn();
    const { rerender } = render(
      <AgentSessionPanel
        info={INFO}
        onRoom={onRoom}
        onStateChange={onStateChange}
        onPublisher={onPublisher}
      />,
    );
    expect(onRoom).toHaveBeenCalledWith(roomA, roomA);
    expect(onStateChange).toHaveBeenCalledWith({ kind: 'connecting' }, roomA);
    expect(onPublisher).toHaveBeenCalledWith('waiting', roomA);

    rerender(
      <AgentSessionPanel
        info={liveKitInfo({ ws_url: 'wss://lk-b', room: 'room-b', token: 'tok-b' })}
        onRoom={onRoom}
        onStateChange={onStateChange}
        onPublisher={onPublisher}
      />,
    );
    expect(onRoom).toHaveBeenCalledWith(null, roomA);
    expect(onRoom).toHaveBeenCalledWith(roomB, roomB);
    expect(onStateChange).toHaveBeenCalledWith({ kind: 'connecting' }, roomB);
    expect(onPublisher).toHaveBeenCalledWith('waiting', roomB);

    const stateCalls = onStateChange.mock.calls.length;
    const publisherCalls = onPublisher.mock.calls.length;
    act(() => {
      handlersA.reconnected?.();
      handlersA.trackSubscribed?.({ kind: 'video', attach: vi.fn() }, {});
    });
    expect(onStateChange).toHaveBeenCalledTimes(stateCalls);
    expect(onPublisher).toHaveBeenCalledTimes(publisherCalls);

    act(() => {
      handlersB.reconnected?.();
      handlersB.trackSubscribed?.({ kind: 'video', attach: vi.fn() }, {});
    });
    expect(onStateChange).toHaveBeenLastCalledWith({ kind: 'connected' }, roomB);
    expect(onPublisher).toHaveBeenLastCalledWith('publishing', roomB);
  });

  it('keeps replacement Room B publication authority when a late Room A unsubscribe arrives', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      connectMock.mockResolvedValue(undefined);
      createRoomMock.mockClear();
      const handlersA: Record<string, (...args: unknown[]) => void> = {};
      const handlersB: Record<string, (...args: unknown[]) => void> = {};
      const roomA = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          {
            // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
            // congestion effect subscribing 'reconnected' alongside the panel's own
            // handler, and real livekit delivers to every listener. A single-slot
            // mock silently dropped whichever registered first.
            const prev = handlersA[event];
            handlersA[event] =
              prev === undefined
                ? handler
                : (...args: unknown[]) => {
                    prev(...args);
                    handler(...args);
                  };
          }
        }),
        off: vi.fn(),
        disconnect: vi.fn(),
      };
      const roomB = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          {
            // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
            // congestion effect subscribing 'reconnected' alongside the panel's own
            // handler, and real livekit delivers to every listener. A single-slot
            // mock silently dropped whichever registered first.
            const prev = handlersB[event];
            handlersB[event] =
              prev === undefined
                ? handler
                : (...args: unknown[]) => {
                    prev(...args);
                    handler(...args);
                  };
          }
        }),
        off: vi.fn(),
        disconnect: vi.fn(),
      };
      createRoomMock.mockReturnValueOnce(roomA).mockReturnValueOnce(roomB);
      const onPublisher = vi.fn();
      const { rerender } = render(<AgentSessionPanel info={INFO} onPublisher={onPublisher} />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        handlersA.trackSubscribed?.({ kind: 'video', attach: vi.fn() }, { setSubscribed: vi.fn() });
      });
      await act(async () => {
        rerender(
          <AgentSessionPanel
            info={liveKitInfo({ ws_url: 'wss://lk-b', room: 'room-b', token: 'tok-b' })}
            onPublisher={onPublisher}
          />,
        );
        await Promise.resolve();
      });

      const setSubscribedB = vi.fn();
      act(() => {
        handlersB.trackSubscribed?.(
          { kind: 'video', attach: vi.fn() },
          { setSubscribed: setSubscribedB },
        );
      });
      expect(onPublisher).toHaveBeenLastCalledWith('publishing', roomB);

      // A callback already queued by LiveKit can arrive after the effect cleanup.
      // It must not null the component-wide publication ref now owned by Room B.
      act(() => {
        handlersA.trackUnsubscribed?.({ kind: 'video' });
        rerender(
          <AgentSessionPanel
            info={liveKitInfo({ ws_url: 'wss://lk-b', room: 'room-b', token: 'tok-b' })}
            onPublisher={onPublisher}
            recoverAction={{ nonce: 1, mode: 'resubscribe' }}
          />,
        );
      });
      expect(setSubscribedB).toHaveBeenCalledWith(false);
      expect(setSubscribedB).not.toHaveBeenCalledWith(true);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(setSubscribedB.mock.calls).toEqual([[false], [true]]);
      expect(onPublisher).toHaveBeenLastCalledWith('publishing', roomB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels Room A pending resubscribe before replacement Room B takes ownership', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      connectMock.mockResolvedValue(undefined);
      createRoomMock.mockClear();
      const handlersA: Record<string, (...args: unknown[]) => void> = {};
      const handlersB: Record<string, (...args: unknown[]) => void> = {};
      const roomA = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          {
            // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
            // congestion effect subscribing 'reconnected' alongside the panel's own
            // handler, and real livekit delivers to every listener. A single-slot
            // mock silently dropped whichever registered first.
            const prev = handlersA[event];
            handlersA[event] =
              prev === undefined
                ? handler
                : (...args: unknown[]) => {
                    prev(...args);
                    handler(...args);
                  };
          }
        }),
        off: vi.fn(),
        disconnect: vi.fn(),
      };
      const roomB = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          {
            // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
            // congestion effect subscribing 'reconnected' alongside the panel's own
            // handler, and real livekit delivers to every listener. A single-slot
            // mock silently dropped whichever registered first.
            const prev = handlersB[event];
            handlersB[event] =
              prev === undefined
                ? handler
                : (...args: unknown[]) => {
                    prev(...args);
                    handler(...args);
                  };
          }
        }),
        off: vi.fn(),
        disconnect: vi.fn(),
      };
      createRoomMock.mockReturnValueOnce(roomA).mockReturnValueOnce(roomB);
      const { rerender } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });

      const setSubscribedA = vi.fn();
      act(() => {
        handlersA.trackSubscribed?.(
          { kind: 'video', attach: vi.fn() },
          { setSubscribed: setSubscribedA },
        );
        rerender(
          <AgentSessionPanel info={INFO} recoverAction={{ nonce: 1, mode: 'resubscribe' }} />,
        );
      });
      expect(setSubscribedA.mock.calls).toEqual([[false]]);

      await act(async () => {
        rerender(
          <AgentSessionPanel
            info={liveKitInfo({ ws_url: 'wss://lk-b', room: 'room-b', token: 'tok-b' })}
            recoverAction={{ nonce: 1, mode: 'resubscribe' }}
          />,
        );
        await Promise.resolve();
      });
      expect(handlersB.trackSubscribed).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // The delayed `true` belongs to A's publication and must never cross the
      // connection replacement boundary, even though its nonce remains rendered.
      expect(setSubscribedA.mock.calls).toEqual([[false]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale Room A congestion drain while Room B remains congested', async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockClear();
    const handlersA: Record<string, (...args: unknown[]) => void> = {};
    const handlersB: Record<string, (...args: unknown[]) => void> = {};
    const roomA = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        {
          // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
          // congestion effect subscribing 'reconnected' alongside the panel's own
          // handler, and real livekit delivers to every listener. A single-slot
          // mock silently dropped whichever registered first.
          const prev = handlersA[event];
          handlersA[event] =
            prev === undefined
              ? handler
              : (...args: unknown[]) => {
                  prev(...args);
                  handler(...args);
                };
        }
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    };
    const roomB = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        {
          // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
          // congestion effect subscribing 'reconnected' alongside the panel's own
          // handler, and real livekit delivers to every listener. A single-slot
          // mock silently dropped whichever registered first.
          const prev = handlersB[event];
          handlersB[event] =
            prev === undefined
              ? handler
              : (...args: unknown[]) => {
                  prev(...args);
                  handler(...args);
                };
        }
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    };
    createRoomMock.mockReturnValueOnce(roomA).mockReturnValueOnce(roomB);
    let currentRoom = roomA;
    const canSendInput = (ownerRoom: unknown, epoch: number): boolean =>
      ownerRoom === currentRoom && epoch === INPUT_AUTHORITY_EPOCH;
    const onInputCongestionChange = vi.fn();
    const { container, rerender } = render(
      <AgentSessionPanel
        info={INFO}
        interactive
        inputAuthorityEpoch={INPUT_AUTHORITY_EPOCH}
        canSendInput={canSendInput}
        onInputCongestionChange={onInputCongestionChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const staleRoomADrain = handlersA.dcBufferStatusChanged;

    await act(async () => {
      currentRoom = roomB;
      rerender(
        <AgentSessionPanel
          info={liveKitInfo({ ws_url: 'wss://lk-b', room: 'room-b', token: 'tok-b' })}
          interactive
          inputAuthorityEpoch={INPUT_AUTHORITY_EPOCH}
          canSendInput={canSendInput}
          onInputCongestionChange={onInputCongestionChange}
        />,
      );
      await Promise.resolve();
    });
    act(() => {
      handlersB.dcBufferStatusChanged?.(false, 0);
    });
    expect(onInputCongestionChange).toHaveBeenLastCalledWith(true, roomB);

    const video = container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);

    onInputCongestionChange.mockClear();
    act(() => {
      // This is the old listener's late "buffer low" callback. It may update A's
      // Room-owned latch, but must not clear B's panel-local eligibility gate.
      staleRoomADrain?.(true, 0);
    });
    expect(onInputCongestionChange).not.toHaveBeenCalled();
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);

    act(() => {
      handlersB.dcBufferStatusChanged?.(true, 0);
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(onInputCongestionChange).toHaveBeenLastCalledWith(false, roomB);
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(1);
  });

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

  // Item 2 (owner 2026-09-16, "stays on connecting forever … closed it after 33 seconds")
  // — the FIRST half of the pre-pixel wait. "Connected — starting the browser… this can
  // take a few seconds." repeated that same promise for the full 30s give-up window with
  // nothing ever said. Past SLOW_START_NOTICE_MS it must say plainly that the wait has
  // gone long, say what the customer can do, and OFFER those actions — while cancelling
  // nothing (still 'waiting', no reconnect of its own, no Room torn down).
  it('Item 2: the "starting the browser" wait says it is taking longer after the deadline and offers Retry — cancelling nothing', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      connectMock.mockResolvedValue(undefined);
      const onClose = vi.fn();
      const onNoPublisher = vi.fn();
      const { container } = render(
        <AgentSessionPanel info={INFO} onClose={onClose} onNoPublisher={onNoPublisher} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const connectCallsAtStart = connectMock.mock.calls.length;
      // BEFORE the deadline — the ORIGINAL sentence, no notice, no action offered.
      act(() => {
        vi.advanceTimersByTime(SLOW_START_NOTICE_MS - 1_000);
      });
      let overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-slow')).toBe('false');
      expect(overlay?.textContent).toMatch(/starting the browser/i);
      expect(overlay?.textContent).not.toMatch(/taking longer than expected/i);
      expect(container.querySelector('[data-action="retry-launch"]')).toBeNull();
      // AFTER the deadline — the honest sentence, the "what you can do" line, and the
      // actions that already exist in this component.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-slow')).toBe('true');
      expect(overlay?.textContent).toMatch(/taking longer than expected/i);
      // ⛔ NON-CAUSAL. The panel observes "no video track has been subscribed on this
      // Room yet" — set unconditionally at connect start and equally produced by a
      // publish failure, an SFU delivery gap, or a subscribe failure on our side. It
      // receives NO box/harness signal, so it may not say the browser hasn't started
      // (in the owner's own incident the node reported normally throughout, and that
      // sentence would have been a false cause). It reports the wait, not a diagnosis.
      expect(overlay?.textContent).toMatch(/live view still hasn.t arrived/i);
      expect(overlay?.textContent).not.toMatch(/browser still hasn.t started/i);
      // …and it is THIS half's sentence, not the other half's (mutation: swap the two
      // half-sentences and this arm reds).
      expect(overlay?.textContent).not.toMatch(/shown a frame/i);
      expect(overlay?.textContent).not.toMatch(/this can take a few seconds/i);
      // Item 2 (a11y) — "unbounded and silent" includes silent to a screen reader: the
      // copy is swapped IN PLACE inside a container that must be a live region.
      expect(overlay?.getAttribute('role')).toBe('status');
      // Says what the customer can do…
      expect(overlay?.textContent).toMatch(/press Retry to reconnect the live view/i);
      expect(overlay?.textContent).toMatch(/relaunch the profile from the main Driftstack/i);
      // …but NOT "you can keep waiting" on this half: NO_PUBLISHER_TIMEOUT_MS flips this
      // very overlay to the give-up verdict 15s from now, so that advice is one the panel
      // itself overrules. (It stands on the 'publishing' half, where the timer is inert.)
      expect(overlay?.textContent).not.toMatch(/keep waiting/i);
      // …and offers it.
      expect(container.querySelector('[data-action="retry-launch"]')).not.toBeNull();
      expect(container.querySelector('[data-action="open-polling-viewer"]')).not.toBeNull();
      expect(container.querySelector('[data-action="close-slow-session"]')).not.toBeNull();
      // ⛔ THE DEADLINE CANCELS NOTHING. Still 'waiting' (not flipped to the
      // launch-failed 'none'), no reconnect fired on its own, no close on the
      // customer's behalf — it changed only what is SAID.
      expect(overlay?.getAttribute('data-state')).toBe('waiting');
      expect(connectMock.mock.calls.length).toBe(connectCallsAtStart);
      expect(onClose).not.toHaveBeenCalled();
      expect(onNoPublisher).not.toHaveBeenCalled();
      // The offered Retry is real: it re-runs the connect effect.
      act(() => {
        fireEvent.click(container.querySelector('[data-action="retry-launch"]') as HTMLElement);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(connectMock.mock.calls.length).toBeGreaterThan(connectCallsAtStart);
      // …and the notice's OWN primary action gets a CLEAN slate. The fresh attempt is
      // one second old, so it must show the original sentence again — not the 15s
      // verdict inherited from the attempt the customer just abandoned. (Mutation:
      // delete `setSlowStart(false)` from the connect effect and this arm reds; without
      // it every retry renders "taking longer than expected" the instant it connects.)
      overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-slow')).toBe('false');
      expect(overlay?.textContent).toMatch(/starting the browser/i);
      expect(overlay?.textContent).not.toMatch(/taking longer than expected/i);
      expect(container.querySelector('[data-action="retry-launch"]')).toBeNull();
      // The retry's own deadline is armed fresh — it arrives on ITS schedule, not the
      // old timer's (which the effect cleanup cleared).
      act(() => {
        vi.advanceTimersByTime(SLOW_START_NOTICE_MS - 1_000);
      });
      expect(
        container.querySelector('[data-overlay="publisher-state"]')?.getAttribute('data-slow'),
      ).toBe('false');
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(
        container.querySelector('[data-overlay="publisher-state"]')?.getAttribute('data-slow'),
      ).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  // Item 2 — the SECOND half, which had NO bound at all: once TrackSubscribed fires,
  // NO_PUBLISHER_TIMEOUT_MS is inert (it only fires while publisher is still 'waiting'),
  // so a track that subscribes and never paints spins on "Almost there…" forever. Same
  // deadline; and a frame arriving LATE must still clear it and leave the session normal.
  it('Item 2: the "video stream is arriving" wait gets the same deadline, and a frame arriving AFTER it still works', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const handlers: Record<string, (arg: unknown) => void> = {};
      const roomOn = vi.fn((evt: string, cb: (arg: unknown) => void) => {
        handlers[evt] = cb;
      });
      const disconnect = vi.fn();
      createRoomMock.mockReturnValueOnce({ on: roomOn, disconnect });
      connectMock.mockResolvedValue(undefined);
      const { container } = render(<AgentSessionPanel info={INFO} />);
      await act(async () => {
        await Promise.resolve();
      });
      const connectCallsAtStart = connectMock.mock.calls.length;
      // The track subscribes promptly — but no frame ever decodes.
      act(() => {
        handlers['trackSubscribed']?.({ kind: 'video', attach: vi.fn() });
      });
      let overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-state')).toBe('publishing');
      expect(overlay?.textContent).toMatch(/almost there/i);
      // BEFORE the deadline — the original sentence stands.
      // ⛔ LITERAL milliseconds here, not `SLOW_START_NOTICE_MS - 1_000`: an arm that
      // advances relative to the constant passes for ANY value of it, so the deadline
      // could drift to 28s (2s before the panel gives up, 5s before the owner closed
      // the window) with a green suite. 14_000 / 16_000 pin the magnitude itself —
      // moving the number now takes a deliberate edit to this guard too. The bounds and
      // the reasoning behind 15s are asserted in "the deadline's magnitude" below.
      act(() => {
        vi.advanceTimersByTime(14_000);
      });
      overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-slow')).toBe('false');
      expect(overlay?.textContent).toMatch(/almost there/i);
      expect(overlay?.textContent).not.toMatch(/taking longer than expected/i);
      // AFTER — the honest sentence names THIS half, and Retry is offered.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-slow')).toBe('true');
      expect(overlay?.textContent).toMatch(/taking longer than expected/i);
      // Both halves report only what was observed — here TrackSubscribed fired and
      // videoWidth is still 0, which is exactly what this sentence says.
      expect(overlay?.textContent).toMatch(/hasn.t shown a frame/i);
      expect(overlay?.textContent).not.toMatch(/live view still hasn.t arrived/i);
      expect(overlay?.textContent).not.toMatch(/almost there/i);
      expect(overlay?.getAttribute('role')).toBe('status');
      // "You can keep waiting" is TRUE on this half and nothing retracts it: once
      // publisher is 'publishing', NO_PUBLISHER_TIMEOUT_MS is inert.
      expect(overlay?.textContent).toMatch(/keep waiting/i);
      expect(container.querySelector('[data-action="retry-launch"]')).not.toBeNull();
      // SURFACE-NEUTRAL copy. This render passes no onClose — the shape AgentChatView
      // mounts, a 300px column inside the MAIN window, where there is no window to close
      // and no profile to relaunch. The copy must not name an action the surface cannot
      // offer. (Mutation: un-gate the close/relaunch clause and this arm reds.)
      expect(overlay?.textContent).not.toMatch(/close this window/i);
      expect(overlay?.textContent).not.toMatch(/relaunch the profile/i);
      expect(container.querySelector('[data-action="close-slow-session"]')).toBeNull();
      // ⛔ Nothing was cancelled: same Room, same connect, still 'publishing'.
      expect(disconnect).not.toHaveBeenCalled();
      expect(connectMock.mock.calls.length).toBe(connectCallsAtStart);
      expect(overlay?.getAttribute('data-state')).toBe('publishing');
      // A frame that finally paints LONG after the deadline clears the overlay
      // outright — the slow session still becomes a working one.
      act(() => {
        const video = container.querySelector('video') as HTMLVideoElement;
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 393 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: 790 });
        video.dispatchEvent(new Event('loadeddata'));
      });
      expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
      expect(container.querySelector('[data-action="retry-launch"]')).toBeNull();
      // …and stays cleared past the give-up window (the notice armed no give-up).
      act(() => {
        vi.advanceTimersByTime(NO_PUBLISHER_TIMEOUT_MS + 5_000);
      });
      expect(container.querySelector('[data-overlay="publisher-state"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Item 2 — the deadline's MAGNITUDE, asserted absolutely rather than relative to
  // itself. Both behavioural arms above could pass with SLOW_START_NOTICE_MS at 28s —
  // firing 2s before the panel gives up and 5s after the owner had already closed the
  // window, i.e. the item's entire purpose defeated with a green suite. The number was
  // the part of this change that had to come from evidence, so it gets its own guard.
  it('Item 2: the deadline’s magnitude sits between the recorded cold-start false alarm and the give-up point', () => {
    // LOWER bound, from NO_PUBLISHER_TIMEOUT_MS's own recorded measurement: 10s fired
    // "right as the stream was about to appear" on a cold spawn, so a notice at or
    // under 10s calls a HEALTHY start slow.
    expect(SLOW_START_NOTICE_MS).toBeGreaterThan(10_000);
    // UPPER bound: the notice exists so the customer learns the wait has gone long
    // while there is still time to act. Past the halfway point of the give-up window
    // it is telling them something they are about to be told anyway — and the owner
    // (who left at 33s) would have seen nothing until the verdict.
    expect(SLOW_START_NOTICE_MS).toBeLessThanOrEqual(NO_PUBLISHER_TIMEOUT_MS / 2);
    // It must be a NOTICE before a VERDICT, never the other way round.
    expect(SLOW_START_NOTICE_MS).toBeLessThan(NO_PUBLISHER_TIMEOUT_MS);
  });

  // Item 2 — the notice must not hand the customer an affordance and then take it away.
  // The 'waiting' half LANDS in the give-up branch NO_PUBLISHER_TIMEOUT_MS later; the
  // Close button lived only in the slow branch, so it silently vanished at exactly the
  // moment the copy turned into a failure verdict.
  it('Item 2: the give-up overlay keeps the Close the notice offered, and reads as a continuation of it', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      connectMock.mockResolvedValue(undefined);
      const onClose = vi.fn();
      const { container } = render(<AgentSessionPanel info={INFO} onClose={onClose} />);
      await act(async () => {
        await Promise.resolve();
      });
      // Past the notice: Close is offered.
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(container.querySelector('[data-action="close-slow-session"]')).not.toBeNull();
      // Past the give-up point: the verdict branch — and Close is STILL offered.
      act(() => {
        vi.advanceTimersByTime(NO_PUBLISHER_TIMEOUT_MS - 16_000 + 100);
      });
      const overlay = container.querySelector('[data-overlay="publisher-state"]');
      expect(overlay?.getAttribute('data-state')).toBe('none');
      expect(overlay?.textContent).toMatch(/couldn’t show the live view/i);
      expect(container.querySelector('[data-action="close-failed-session"]')).not.toBeNull();
      expect(container.querySelector('[data-action="retry-launch"]')).not.toBeNull();
      // …and it continues the notice rather than retracting it: "nothing has been
      // cancelled" was true at 15s and is still true here — a late TrackSubscribed
      // flips this overlay straight back to 'publishing'.
      expect(overlay?.textContent).toMatch(/nothing here was cancelled/i);
      expect(overlay?.textContent).toMatch(/arrives late still appears/i);
      // Nothing was closed on the customer's behalf at either deadline.
      expect(onClose).not.toHaveBeenCalled();
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
    ['proxy_connection_failed', 'Proxy connection failed', 'could not connect through its proxy'],
    ['egress_unreachable', 'Proxy connection failed', 'could not connect through its proxy'],
    ['launch_timeout', 'Browser could not start', 'try starting it again'],
    ['webdriver_connect_failed', 'Browser could not start', 'try starting it again'],
    ['session_config_invalid', 'Session configuration unavailable', 'current configuration'],
    ['node-restarted', 'Session stopped unexpectedly', 'on our side stopped this session'],
    ['session-ended', 'Session completed', 'ended normally'],
    // A3's typed VPN bring-up reasons. The POINT of each is where it sends the
    // customer, so the assertion is on the destination words, not the label.
    ['remote_unresolved', 'Proxy address not found', 'supplies the proxy'],
    ['remote_refused', 'Proxy refused the connection', 'whoever supplies it'],
    ['remote_unreachable', 'Proxy did not respond', 'unreachable'],
    ['remote_closed_during_setup', 'Proxy hung up during setup', 'whoever supplies it'],
    ['tls_handshake_failed', 'Proxy security handshake failed', 'certificate or tls-auth key'],
    ['config_rejected', 'Proxy config was rejected', 're-paste its config'],
    ['auth_failed', 'Proxy rejected the credentials', 'username or password'],
    ['no_output', 'Tunnel could not be started', 'ours, not yours'],
    // The five that reached the generic sentence until 2026-09-16. Each is matched
    // as a WHOLE TOKEN; `renderer_crashed` in particular is NOT covered by the
    // `/^(launch_|render_|…)/` branch, because `render_` is not a prefix of
    // `renderer_` — the near-miss this row exists to hold still.
    ['browser_exited', 'Browser shut down', 'Starting a new session'],
    ['session_resource_overuse', 'The page used too much memory', 'one heavy page'],
    ['renderer_crashed', 'The page stopped unexpectedly', 'could not be recovered'],
    ['intent_deadline_exceeded', 'A step took too long', 'smaller steps'],
    ['reaped_during_provisioning', 'Stopped before it finished starting', 'never became usable'],
    // Found by the same audit that corrected the population above.
    ['control_plane_unreachable', 'Contact with the phone was lost', 'ours, not yours'],
    ['vpn_bringup_failed', 'VPN connection could not be started', 'not enough detail'],
    ['vpn_bringup_no_active_state', 'VPN connection could not be started', 'not enough detail'],
    ['archetype_not_supported', 'This device is not available', 'Choosing another device'],
    ['unknown_error', 'Session stopped unexpectedly', 'Something went wrong'],
    // A refusal whose fault is OURS. Distinct from the proxy-failure sentence
    // below it, and the distinction is the point: the customer's proxy answered.
    [
      'egress_verification_unavailable',
      'Could not confirm your proxy was carrying traffic',
      'nothing to fix at your end',
    ],
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

  /**
   * ⛔ THE POPULATION ARM. The rows above say "this token renders that sentence";
   * this one says "no REACHABLE token renders the blank one", which is the claim a
   * new close reason can actually break.
   *
   * ⚠️ THIS LIST IS A LOWER BOUND, NOT THE POPULATION, and the first version of
   * this comment claimed otherwise. It said "eleven", derived by scanning literal
   * arguments at the daemon's two known emit sinks. Adversarial review put the real
   * figure at 28+ for the daemon alone: the scan could not see a value passed
   * through a forwarding function (two of them terminate in those same sinks), and
   * could not see a DEFAULT argument at all — a default appears at zero call sites,
   * so no search of the calls can ever surface it, and one of them is used bare at
   * about nine places.
   *
   * So the guarantee here is one-directional and worth stating plainly: every token
   * listed renders a real sentence. It does NOT say these are all of them.
   *
   * ⚠️ Nor can it. This repo does not build the daemon, so nothing here can read its
   * sources at test time, and the vocabulary is not even one set — the panel is fed
   * `preferTypedEndReason(errorEvent.code, closedReason)`, so it sees error codes
   * and close reasons interleaved. When a new one is added over there, add it here.
   * The cost of forgetting is one customer-visible blank sentence, not a red build.
   */
  const REACHABLE_CLOSED_REASONS = [
    'archetype_not_supported',
    'browser_crashed',
    'browser_exited',
    'control_plane_unreachable',
    'egress_verification_unavailable',
    'egress_lost',
    'idle_timeout',
    'intent_deadline_exceeded',
    'launch_timeout',
    'max_duration',
    'node_shutting_down',
    'reaped_during_provisioning',
    'renderer_crashed',
    'session_resource_overuse',
    'unknown_error',
    'vpn_bringup_failed',
    'vpn_bringup_no_active_state',
  ] as const;

  async function outcomeFor(reason: string): Promise<string> {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const { container, unmount } = render(
      <AgentSessionPanel info={INFO} sessionEnded={{ reason }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const text = container.querySelector('[data-overlay="session-ended"]')?.textContent ?? '';
    unmount();
    return text;
  }

  it.each(REACHABLE_CLOSED_REASONS)(
    'CRITICAL %s does not fall through to the sentence that says nothing',
    async (reason) => {
      const text = await outcomeFor(reason);
      // The fallback, verbatim. Matching the sentence rather than a flag is what
      // makes this survive a refactor that moves the branches around.
      expect(text).not.toMatch(/This session has stopped\./);
      expect(text).not.toMatch(/^\s*Session closed\s*$/);
      // ⛔ And it must not reflect the raw token either — unknown reasons may carry
      // internal diagnostics, and the rule is that none of them reach the DOM.
      expect(text).not.toContain(reason);
    },
  );

  it('CRITICAL the unverifiable refusal is NOT reported as a proxy failure', async () => {
    // ⛔ THE ORDERING IS THE FIX. `egress_verification_unavailable` begins with
    // `egress_`, so the `/^(proxy_|egress_)/` prefix branch would swallow it and
    // return "could not connect through its proxy" — the exact falsehood the new
    // branch exists to stop. Same near-miss shape as `render_` failing to match
    // `renderer_crashed`, except here the prefix matches when it must not.
    //
    // Measured on the fleet: the case that produces this had a checker answer
    // HTTP 503 with an empty body, which PROVES the request travelled through the
    // customer's proxy. Their proxy carried traffic. Telling them it did not
    // connect sends them to debug something that works, and they cannot disprove
    // it from where they sit.
    const text = await outcomeFor('egress_verification_unavailable');
    expect(text).not.toMatch(/could not connect through its proxy/i);
    expect(text).toMatch(/Could not confirm your proxy was carrying traffic/);
    // ⚠️ And no retry promise. The path is already wrapped in transient retry, so
    // every observed refusal had ALREADY failed every automatic attempt — telling
    // someone "try again and it usually works" would be a second falsehood told
    // to a person who has by then retried and failed.
    expect(text).not.toMatch(/usually works|try again/i);
  });

  it('CONTROL — a genuine proxy failure still says so, and still points at them', async () => {
    // Without this, the arm above would pass against a build that had softened
    // EVERY egress failure into "ours". A proxy that genuinely did not carry
    // traffic must keep telling the customer to act, or the change buries the
    // failures they actually can fix.
    const text = await outcomeFor('proxy_connection_failed');
    expect(text).toMatch(/could not connect through its proxy/i);
  });

  it('VACUITY CONTROL — an unknown reason still DOES render the generic sentence', async () => {
    // Without this, the arm above would pass just as happily against a component
    // that had stopped rendering the overlay at all, or one whose fallback wording
    // had been changed so the regexes could never match. A guard that cannot
    // produce its own negative is not measuring anything.
    const text = await outcomeFor('a_reason_no_build_has_ever_emitted');
    expect(text).toMatch(/This session has stopped\./);
    expect(text).not.toContain('a_reason_no_build_has_ever_emitted');
  });

  /* ⛔ THE COARSE CODES COLLAPSE, AND THIS IS THE ARM THAT SAYS SO. The typed
   * bring-up work arrived with the claim that provider-versus-config comes free
   * from the coarse ErrorEvent code. It does not, at the only place a customer
   * reads it: `proxy_connection_failed` hits the `/^proxy_/` branch and
   * `egress_bind_failed` hits `/^egress_/`, and both return the SAME sentence.
   * If that ever stops being true this arm should be rewritten, not deleted —
   * but while it holds, the fine reason is the only thing carrying the errand. */
  it('CONTROL — the coarse codes really are indistinguishable, which is why the fine ones exist', async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const read = async (reason: string): Promise<string> => {
      const { container } = render(<AgentSessionPanel info={INFO} sessionEnded={{ reason }} />);
      await act(async () => {
        await Promise.resolve();
      });
      const text = `${container.querySelector('[data-summary="session-outcome"]')?.textContent ?? ''}|${
        container.querySelector('[data-overlay="session-ended"]')?.textContent ?? ''
      }`;
      cleanup();
      return text;
    };
    const provider = await read('proxy_connection_failed');
    const config = await read('egress_bind_failed');
    expect(
      provider,
      'a provider fault and a config fault read identically at the coarse level',
    ).toBe(config);
    // …and the fine reasons for those same two situations do NOT.
    const fineProvider = await read('remote_unresolved');
    const fineConfig = await read('config_rejected');
    expect(fineProvider).not.toBe(fineConfig);
    expect(fineProvider).toContain('supplies the proxy');
    expect(fineConfig).toContain('re-paste its config');
  });

  it('an unknown VPN reason is never routed — it falls back to the generic copy', async () => {
    // A3 owns the enum and will add to it. A value this build does not know must
    // NOT borrow the nearest destination: sending someone to their provider for
    // our bug is worse than saying nothing. Matched as whole tokens for the same
    // reason — `remote_unresolved_v2` must not inherit `remote_unresolved`.
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    // `constructor` is the prototype-chain trap: a bare index into the copy table
    // returned Object.prototype.constructor as the copy, and the recap went blank.
    for (const unknown of ['remote_unresolved_v2', 'tunnel_wedged', 'remote_', 'constructor']) {
      const { container } = render(
        <AgentSessionPanel info={INFO} sessionEnded={{ reason: unknown }} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const overlay = container.querySelector('[data-overlay="session-ended"]');
      expect(overlay, unknown).toHaveTextContent('This session has stopped.');
      expect(overlay?.textContent, unknown).not.toMatch(/supplies the proxy|re-paste its config/);
      cleanup();
    }
  });

  /* ⛔ THE SELECTOR, AND WHY THE TABLE WOULD HAVE BEEN DEAD WITHOUT IT. A failed
   * VPN bring-up emits BOTH reasons: the coarse code on the error event, and the
   * fine typed reason on the status frame. The shipped call sites read
   * `errorEvent?.code ?? closedReason`, which prefers the coarse one — so the
   * coarse value would have shadowed the fine one every single time, the ten
   * sentences above would never have rendered once, and every test in this file
   * would still have passed because they hand the reason in directly.
   * Caught only by reading how the caller picks. */
  it('CRITICAL the fine bring-up reason beats the coarse code, which is emitted alongside it', () => {
    expect(preferTypedEndReason('proxy_connection_failed', 'remote_unresolved')).toBe(
      'remote_unresolved',
    );
    expect(preferTypedEndReason('egress_bind_failed', 'config_rejected')).toBe('config_rejected');
    // …and nothing else changes: a coarse code with no typed reason still wins
    // over a vaguer close reason, exactly as before.
    expect(preferTypedEndReason('browser_crashed', 'session_errored')).toBe('browser_crashed');
    expect(preferTypedEndReason(null, 'idle_timeout')).toBe('idle_timeout');
    expect(preferTypedEndReason(undefined, undefined)).toBeNull();
    // An unknown reason must not be treated as typed — it would steal priority
    // from a coarse code that at least maps to something.
    expect(preferTypedEndReason('browser_crashed', 'remote_unresolved_v2')).toBe('browser_crashed');
    expect(isTypedBringupReason('remote_unresolved')).toBe(true);
    expect(isTypedBringupReason('remote_unresolved_v2')).toBe(false);
    expect(isTypedBringupReason(null)).toBe(false);
  });

  const ROUTE_WORDS = ['supplies the proxy', 'check its config', 'ours, not yours'] as const;
  const ROUTELESS_HEDGE =
    'There is not enough to say yet whether that is the endpoint or the configuration.';

  /* A `tunnel_setup_timeout` is the one code with no errand of its own, and the
   * one thing that can honestly give it one is the phase the bring-up stalled
   * in. Each route is asserted on its DESTINATION words and on the absence of
   * the other two — the label is the same for all three because what changed is
   * whose errand it is, not what happened. */
  it.each([
    ['resolving', 'supplies the proxy'],
    ['connecting', 'supplies the proxy'],
    ['handshaking', 'check its config'],
    ['assigning_address', 'ours, not yours'],
    ['configuring_routes', 'ours, not yours'],
    ['starting_proxy', 'ours, not yours'],
    ['verifying', 'ours, not yours'],
    // Settled with A3 2026-09-14: the tunnel was up (today's tunnel-up frame is
    // the last detail) and the browser never came — ours, beside the four.
    ['vpn_egress_active', 'ours, not yours'],
  ])('tunnel_setup_timeout stalled in %s routes to "%s"', async (lastPhase, destination) => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const { container } = render(
      <AgentSessionPanel
        info={INFO}
        sessionEnded={{ reason: 'tunnel_setup_timeout', summary: null, lastPhase }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const overlay = container.querySelector('[data-overlay="session-ended"]');
    expect(container.querySelector('[data-summary="session-outcome"]')).toHaveTextContent(
      'Tunnel did not finish connecting',
    );
    expect(overlay).toHaveTextContent(destination);
    for (const other of ROUTE_WORDS.filter((w) => w !== destination)) {
      expect(overlay?.textContent, `${lastPhase} leaked "${other}"`).not.toContain(other);
    }
    // …and never the routeless hedge, which would contradict the route it just gave.
    expect(overlay?.textContent).not.toContain(ROUTELESS_HEDGE);
  });

  it('tunnel_setup_timeout with an absent or unknown last phase keeps the routeless sentence', async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    // `up` is CONCEPTUAL — never an emitted token (the emitted tunnel-up detail
    // is `vpn_egress_active`, which IS routed) — so a caller handing it over is
    // aliasing and must not route. The rest are spellings A3 does not emit: a
    // `vpn_` prefix on a bare phase, a prefix of a real token, a case variant, a
    // suffixed variant, trailing whitespace, and a prototype member. Every one
    // of them must fall to the routeless sentence.
    const unknownPhases: Array<string | null | undefined> = [
      null,
      undefined,
      '',
      'up',
      'vpn_connecting',
      'connect',
      'Connecting',
      'resolving_v2',
      'handshaking ',
      'constructor',
    ];
    for (const lastPhase of unknownPhases) {
      const { container } = render(
        <AgentSessionPanel
          info={INFO}
          sessionEnded={{ reason: 'tunnel_setup_timeout', summary: null, lastPhase }}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const overlay = container.querySelector('[data-overlay="session-ended"]');
      expect(overlay, String(lastPhase)).toHaveTextContent(ROUTELESS_HEDGE);
      for (const word of ROUTE_WORDS) {
        expect(overlay?.textContent, `${String(lastPhase)} routed to "${word}"`).not.toContain(
          word,
        );
      }
      cleanup();
    }
    // A `{ reason }`-only caller (the chat view latches exactly that) reads the same.
    const { container } = render(
      <AgentSessionPanel info={INFO} sessionEnded={{ reason: 'tunnel_setup_timeout' }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-overlay="session-ended"]')).toHaveTextContent(
      ROUTELESS_HEDGE,
    );
  });

  it('a last phase never re-routes a code that already has a destination', async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    const read = async (reason: string, lastPhase: string | null): Promise<string> => {
      const { container } = render(
        <AgentSessionPanel info={INFO} sessionEnded={{ reason, summary: null, lastPhase }} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const text = `${container.querySelector('[data-summary="session-outcome"]')?.textContent ?? ''}|${
        container.querySelector('[data-overlay="session-ended"]')?.textContent ?? ''
      }`;
      cleanup();
      return text;
    };
    // Each pairs a code with a phase whose route DISAGREES with the code's own
    // destination; the overlay must read byte-for-byte as it does with no phase.
    for (const [reason, lastPhase, own] of [
      ['remote_unresolved', 'verifying', 'supplies the proxy'],
      ['remote_unresolved', 'handshaking', 'supplies the proxy'],
      ['remote_refused', 'assigning_address', 'whoever supplies it'],
      ['tls_handshake_failed', 'resolving', 'certificate or tls-auth key'],
      ['config_rejected', 'connecting', 're-paste its config'],
      ['auth_failed', 'starting_proxy', 'username or password'],
      ['no_output', 'handshaking', 'ours, not yours'],
      ['idle_timeout', 'verifying', 'period of inactivity'],
      ['proxy_connection_failed', 'resolving', 'could not connect through its proxy'],
    ] as const) {
      const withPhase = await read(reason, lastPhase);
      const withoutPhase = await read(reason, null);
      expect(withPhase, `${reason} + ${lastPhase}`).toBe(withoutPhase);
      expect(withPhase, `${reason} + ${lastPhase}`).toContain(own);
    }
  });

  it("renders A3's host-free summary verbatim under the explanation, and nothing when it is absent", async () => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    createRoomMock.mockReturnValue({ on: vi.fn(), disconnect: vi.fn() });
    // Realistic host-free detail, plus characters that would betray a paraphrase,
    // a trim, or an HTML-escaping slip: leading/trailing punctuation, `<>&`.
    for (const [reason, lastPhase, summary] of [
      [
        'tunnel_setup_timeout',
        'handshaking',
        'TLS key negotiation did not complete within 60s — the server never answered the handshake.',
      ],
      ['browser_crashed', null, '(worker exited: <signal 9> & no core written) '],
    ] as const) {
      // ⛔ `onClose` IS LOAD-BEARING FOR THIS ARM (stage 7), not decoration.
      // The ordering this test holds — detail AFTER the explanation, BEFORE the
      // close-and-relaunch instruction — needs that instruction to be on screen,
      // and it now renders only where there IS a window to close. This is the
      // standalone simulator's shape; the chat's (no `onClose`, no instruction)
      // is held in the-live-panel-fits-the-phone-it-is-drawn-in.test.tsx.
      const { container } = render(
        <AgentSessionPanel
          info={INFO}
          sessionEnded={{ reason, summary, lastPhase }}
          onClose={() => undefined}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const overlay = container.querySelector('[data-overlay="session-ended"]');
      const detail = overlay?.querySelector('[data-summary="session-end-detail"]');
      expect(detail, reason).not.toBeNull();
      // Verbatim: equality, not containment — no trim, no rewording, no escaping.
      expect(detail?.textContent, reason).toBe(summary);
      expect(detail?.children.length, `${reason}: the detail is a single text line`).toBe(0);
      // UNDER the explanation: the explanation comes first in document order,
      // and the detail sits inside the ended overlay, not somewhere else.
      const text = overlay?.textContent ?? '';
      const explanationAt = text.indexOf(
        reason === 'browser_crashed'
          ? 'The browser running this session'
          : 'handshake with the proxy endpoint never completed',
      );
      expect(explanationAt, `${reason}: explanation present`).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(summary), `${reason}: detail after explanation`).toBeGreaterThan(
        explanationAt,
      );
      // …and BEFORE the relaunch instruction: a quieter second line under the
      // explanation, not a footnote after the call to action.
      const relaunchAt = text.indexOf('Close this window, then relaunch');
      expect(relaunchAt, `${reason}: relaunch instruction present`).toBeGreaterThanOrEqual(0);
      expect(relaunchAt, `${reason}: detail before the relaunch instruction`).toBeGreaterThan(
        text.indexOf(summary),
      );
      cleanup();
    }
    // Absent → not in the DOM at all (no empty element), for null, undefined,
    // an empty string, whitespace, and a `{ reason }`-only caller.
    for (const summary of [null, undefined, '', '   ']) {
      const { container } = render(
        <AgentSessionPanel
          info={INFO}
          sessionEnded={{ reason: 'tunnel_setup_timeout', summary, lastPhase: 'handshaking' }}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-summary="session-end-detail"]'),
        JSON.stringify(summary),
      ).toBeNull();
      expect(container.querySelector('[data-overlay="session-ended"]')).toHaveTextContent(
        'check its config',
      );
      cleanup();
    }
    const { container } = render(
      <AgentSessionPanel info={INFO} sessionEnded={{ reason: 'browser_crashed' }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-summary="session-end-detail"]')).toBeNull();
  });

  it('vpnBringupPhaseRoute is an own-key, exact-spelling lookup over the eight routable phases, and the copy refinement is scoped to the timeout code alone', () => {
    expect(vpnBringupPhaseRoute('resolving')).toBe('provider');
    expect(vpnBringupPhaseRoute('connecting')).toBe('provider');
    expect(vpnBringupPhaseRoute('handshaking')).toBe('config');
    expect(vpnBringupPhaseRoute('assigning_address')).toBe('ours');
    expect(vpnBringupPhaseRoute('configuring_routes')).toBe('ours');
    expect(vpnBringupPhaseRoute('starting_proxy')).toBe('ours');
    expect(vpnBringupPhaseRoute('verifying')).toBe('ours');
    // Settled 2026-09-14: the tunnel-up frame as last detail = tunnel up, browser never came.
    expect(vpnBringupPhaseRoute('vpn_egress_active')).toBe('ours');
    // `up` is conceptual, never emitted; the rest are not A3's spellings.
    for (const bad of [
      'up',
      null,
      undefined,
      '',
      'vpn_connecting',
      'Connecting',
      'connecting ',
      'resolv',
      'resolving_v2',
      'constructor',
      'toString',
    ]) {
      expect(vpnBringupPhaseRoute(bad), String(bad)).toBeNull();
    }
    // Refinement: the timeout code follows the phase; every other code ignores it.
    expect(vpnBringupEndCopy('tunnel_setup_timeout', 'handshaking')).toBe(
      TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.config,
    );
    expect(vpnBringupEndCopy('tunnel_setup_timeout', 'resolving')).toBe(
      TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.provider,
    );
    expect(vpnBringupEndCopy('tunnel_setup_timeout', 'verifying')).toBe(
      TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.ours,
    );
    expect(vpnBringupEndCopy('tunnel_setup_timeout', 'up')).toBe(
      VPN_BRINGUP_END_COPY.tunnel_setup_timeout,
    );
    expect(vpnBringupEndCopy('tunnel_setup_timeout', null)).toBe(
      VPN_BRINGUP_END_COPY.tunnel_setup_timeout,
    );
    expect(vpnBringupEndCopy('remote_unresolved', 'handshaking')).toBe(
      VPN_BRINGUP_END_COPY.remote_unresolved,
    );
    expect(vpnBringupEndCopy('no_output', 'resolving')).toBe(VPN_BRINGUP_END_COPY.no_output);
    // The REASON keeps its existing normalisation (case, hyphens); the PHASE does not.
    expect(vpnBringupEndCopy('TUNNEL-SETUP-TIMEOUT', 'verifying')).toBe(
      TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.ours,
    );
    expect(vpnBringupEndCopy('tunnel_setup_timeout', 'VERIFYING')).toBe(
      VPN_BRINGUP_END_COPY.tunnel_setup_timeout,
    );
    // Not a typed code → undefined, including prototype members.
    expect(vpnBringupEndCopy('constructor', 'verifying')).toBeUndefined();
    expect(vpnBringupEndCopy('browser_crashed', 'verifying')).toBeUndefined();
    expect(vpnBringupEndCopy(null, 'verifying')).toBeUndefined();
    // The three routed sentences are pairwise distinct and each carries only its own errand.
    const routed = Object.values(TUNNEL_SETUP_TIMEOUT_ROUTED_COPY).map((c) => c.explanation);
    expect(new Set(routed).size).toBe(3);
    expect(TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.provider.explanation).toContain('supplies the proxy');
    expect(TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.config.explanation).toContain('check its config');
    expect(TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.ours.explanation).toContain('ours, not yours');
    // Honesty pins — each sentence claims only what its phase supports:
    // "ours" covers `vpn_egress_active`, where the tunnel DID come up, so it
    // must not say the tunnel was what did not finish…
    expect(TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.ours.explanation).not.toContain(
      'setting up the tunnel',
    );
    // …and at `handshaking` nothing is known about a reply (UDP: a dead endpoint
    // and a dropped key are the same silence), so config must not claim one.
    expect(TUNNEL_SETUP_TIMEOUT_ROUTED_COPY.config.explanation).not.toContain('endpoint answered');
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
    expect(ended).toHaveTextContent('Session stopped unexpectedly');
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
      const room = { on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
      createRoomMock.mockReturnValueOnce(room);
      const { container } = render(
        <AgentSessionPanel
          info={INFO}
          interactive
          inputAuthorityEpoch={INPUT_AUTHORITY_EPOCH}
          canSendInput={(ownerRoom, epoch) =>
            // `room` is the mock the panel was handed; widen for the identity
            // check rather than typing the literal, which would propagate Room
            // through every other use of it in this file.
            (ownerRoom as unknown) === (room as unknown) && epoch === INPUT_AUTHORITY_EPOCH
          }
        />,
      );
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

  it('fails closed for optimistic feedback when authority is omitted or denied', () => {
    connectMock.mockReset();
    connectMock.mockReturnValue(new Promise(() => {}));
    const roomA = { on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
    const roomB = { on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
    createRoomMock.mockReturnValueOnce(roomA).mockReturnValueOnce(roomB);
    const omitted = render(<AgentSessionPanel info={INFO} interactive />);
    const omittedVideo = omitted.container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(
        omittedVideo,
        new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }),
      );
    });
    expect(omitted.container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
    omitted.unmount();

    const denied = render(
      <AgentSessionPanel
        info={liveKitInfo({ ws_url: 'wss://lk-denied', room: 'room-denied', token: 'tok-denied' })}
        interactive
        inputAuthorityEpoch={INPUT_AUTHORITY_EPOCH}
        canSendInput={() => false}
      />,
    );
    const deniedVideo = denied.container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(
        deniedVideo,
        new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }),
      );
    });
    expect(denied.container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
  });

  it('clears an accepted ripple on epoch replacement and rejects the retained stale owner', () => {
    connectMock.mockReset();
    connectMock.mockReturnValue(new Promise(() => {}));
    const room = { on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
    createRoomMock.mockReturnValueOnce(room);
    let currentEpoch = INPUT_AUTHORITY_EPOCH;
    const canSendInput = (ownerRoom: unknown, epoch: number): boolean =>
      ownerRoom === room && epoch === currentEpoch;
    const { container, rerender } = render(
      <AgentSessionPanel
        info={INFO}
        interactive
        inputAuthorityEpoch={INPUT_AUTHORITY_EPOCH}
        canSendInput={canSendInput}
      />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(1);

    currentEpoch += 1;
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 70 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(1);

    rerender(
      <AgentSessionPanel
        info={INFO}
        interactive
        inputAuthorityEpoch={currentEpoch}
        canSendInput={canSendInput}
      />,
    );
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
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
    const room = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        {
          // V-2168 — FAN OUT, do not overwrite: the hook now has a room-scoped
          // congestion effect subscribing 'reconnected' alongside the panel's own
          // handler, and real livekit delivers to every listener. A single-slot
          // mock silently dropped whichever registered first.
          const prev = handlers[event];
          handlers[event] =
            prev === undefined
              ? handler
              : (...args: unknown[]) => {
                  prev(...args);
                  handler(...args);
                };
        }
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    };
    createRoomMock.mockReturnValueOnce(room);
    const onInputCongestionChange = vi.fn();
    const { container } = render(
      <AgentSessionPanel
        info={INFO}
        interactive
        inputAuthorityEpoch={INPUT_AUTHORITY_EPOCH}
        canSendInput={(ownerRoom, epoch) =>
          // `room` is the mock the panel was handed; widen for the identity
          // check rather than typing the literal, which would propagate Room
          // through every other use of it in this file.
          (ownerRoom as unknown) === (room as unknown) && epoch === INPUT_AUTHORITY_EPOCH
        }
        onInputCongestionChange={onInputCongestionChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => handlers.dcBufferStatusChanged?.(false, 0));
    expect(onInputCongestionChange).toHaveBeenLastCalledWith(true, room);

    const video = container.querySelector('video') as HTMLVideoElement;
    act(() => {
      fireEvent(video, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(container.querySelectorAll('[data-tap-ripple]')).toHaveLength(0);
  });
});
