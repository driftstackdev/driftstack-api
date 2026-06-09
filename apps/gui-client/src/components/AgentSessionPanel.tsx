// LK.6.b — AgentSessionPanel React component.
//
// Subscribes to the LiveKit room hosting an agent session's video
// stream and renders the remote video in an <video> element.
//
// Lifecycle:
//   - On mount: createLivekitRoom() + connect(info.ws_url, info.token).
//   - On TrackSubscribed RemoteVideoTrack event: attach to the <video>.
//   - On unmount / beforeunload: room.disconnect().
//
// Connection state is surfaced for the chrome UI (LK.6.c will render
// a badge above the video reading from the `state` prop callback).
//
// Input capture (LK.6.d) + latency measurement (LK.6.e) land in
// follow-up sub-slices; the panel stays subscriber-only at LK.6.b.

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from 'react';
import type { LiveKitInfo } from '@driftstack/sdk';
import {
  RoomEvent,
  connectToAgentSession,
  createLivekitRoom,
  type LivekitConnectionState,
} from '../lib/livekit';

export interface AgentSessionPanelProps {
  /** The LiveKit join info returned by the server — either from the
   *  `livekit` field on session-create OR from POST /v1/agent-
   *  sessions/:id/livekit-token. */
  info: LiveKitInfo;
  /** Optional: archetype-driven aspect ratio. Defaults to iPhone 16
   *  Pro (1206×2622 px) since that's the locked archetype
   *  (iphone16pro_ios18_7_safari26_4) for v1.0 per the orchestrator brief. */
  aspectRatio?: number;
  /** Callback fired on every connection-state transition. LK.6.c
   *  wires the chrome badge to this. */
  onStateChange?: (state: LivekitConnectionState) => void;
}

const IPHONE_16_PRO_ASPECT_RATIO = 1206 / 2622; // ≈ 0.46

export function AgentSessionPanel({
  info,
  aspectRatio = IPHONE_16_PRO_ASPECT_RATIO,
  onStateChange,
}: AgentSessionPanelProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<LivekitConnectionState>({ kind: 'idle' });
  // Manual reconnect: bumping this re-runs the connect effect (new Room +
  // reconnect). Lets the customer recover from an error/disconnect without
  // reloading the whole app. Only bumped on the Reconnect button — not a
  // render-driven dep, so it can't cause reconnect-thrash.
  const [retryNonce, setRetryNonce] = useState(0);

  // Keep the latest onStateChange in a ref so the connect effect does NOT
  // depend on the callback's identity. onStateChange exists for consumers (the
  // LK.6.c badge) to hook connection state, and the natural usage is an inline
  // `onStateChange={...}` arrow — a fresh ref every render. If the connect
  // effect depended on it, every parent re-render would disconnect + re-create
  // + reconnect the LiveKit room (streaming reconnect-thrash). The ref decouples
  // the callback identity from the effect lifecycle.
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    let cancelled = false;
    const room = createLivekitRoom();
    const setS = (next: LivekitConnectionState): void => {
      setState(next);
      onStateChangeRef.current?.(next);
    };

    // RoomEvent wire-up. `as any` casts are scoped to the
    // livekit-client surface where exact typing isn't worth the
    // import-churn — the runtime contract is documented in the
    // wrapper's RoomEvent re-export.
    (room as any).on(RoomEvent.TrackSubscribed, (track: any) => {
      if (cancelled) return;
      if (track.kind !== 'video') return;
      const el = videoRef.current;
      if (el !== null) track.attach(el);
    });
    (room as any).on(RoomEvent.Disconnected, () => {
      if (!cancelled) setS({ kind: 'disconnected' });
    });
    (room as any).on(RoomEvent.Reconnecting, () => {
      if (!cancelled) setS({ kind: 'reconnecting' });
    });
    (room as any).on(RoomEvent.Reconnected, () => {
      if (!cancelled) setS({ kind: 'connected' });
    });

    setS({ kind: 'connecting' });
    connectToAgentSession(room, info)
      .then(() => {
        if (!cancelled) setS({ kind: 'connected' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'unknown connection error';
        setS({ kind: 'error', message });
      });

    return () => {
      cancelled = true;
      void (room as any).disconnect();
    };
    // Reconnect only when the connection identity (ws_url + token) changes, NOT
    // on every new `info` object ref — info is stable per session, and a fresh
    // ref with the same ws_url/token must not churn the room. connectToAgentSession
    // only reads ws_url + token, so the captured `info` staying put is safe.
    // `retryNonce` re-runs the effect on a manual Reconnect (intentional, not a
    // render-thrash — it changes only on the button click).
  }, [info.ws_url, info.token, retryNonce]);

  return (
    <div
      data-component="agent-session-panel"
      // Scale-to-fit the iPhone screen, NOT fill the window. The aspect ratio is
      // portrait (~0.46), so `w-full` made height = width × 2.17 → an enormous
      // tall box on a wide desktop window (the "stretched, unrealistic large"
      // view). Fill the available HEIGHT instead and let width derive from the
      // aspect ratio (narrow portrait), capped at the container width; the parent
      // (items-center justify-center) centers the result. object-contain on the
      // <video> then fills this iPhone-aspect box exactly.
      className="relative h-full max-h-full max-w-full overflow-hidden rounded-lg border border-white/10 bg-black"
      style={{ aspectRatio: aspectRatio.toString() }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
        aria-label="Agent session live video stream"
      />
      {state.kind !== 'connected' && (
        <div
          data-overlay="connection-state"
          data-state={state.kind}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center text-sm text-ink-primary"
        >
          {(state.kind === 'connecting' ||
            state.kind === 'reconnecting' ||
            state.kind === 'idle') && (
            <span
              className="h-7 w-7 animate-spin rounded-full border-2 border-white/25 border-t-white/90"
              aria-hidden="true"
            />
          )}
          {(state.kind === 'disconnected' || state.kind === 'error') && (
            <svg
              viewBox="0 0 24 24"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-glow-red"
              aria-hidden="true"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4M4 5l16 12" />
            </svg>
          )}
          <span>
            {state.kind === 'idle' && 'Waiting for the session…'}
            {state.kind === 'connecting' && 'Connecting to the live stream…'}
            {state.kind === 'reconnecting' && 'Connection dropped — reconnecting…'}
            {state.kind === 'disconnected' && 'The live stream disconnected.'}
            {state.kind === 'error' && `Couldn’t connect: ${state.message}`}
          </span>
          {(state.kind === 'disconnected' || state.kind === 'error') && (
            <button
              type="button"
              data-action="reconnect-stream"
              onClick={() => {
                setRetryNonce((n) => n + 1);
              }}
              className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:bg-white/20"
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
