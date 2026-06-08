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

  useEffect(() => {
    let cancelled = false;
    const room = createLivekitRoom();
    const setS = (next: LivekitConnectionState): void => {
      setState(next);
      onStateChange?.(next);
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
  }, [info, onStateChange]);

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
          className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-ink-primary"
        >
          {state.kind === 'connecting' && 'Connecting…'}
          {state.kind === 'reconnecting' && 'Reconnecting…'}
          {state.kind === 'disconnected' && 'Disconnected.'}
          {state.kind === 'error' && `Error: ${state.message}`}
          {state.kind === 'idle' && ' '}
        </div>
      )}
    </div>
  );
}
