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
  type Room,
} from '../lib/livekit';
import { useInputCapture } from '../lib/livekit-input-capture';

export interface AgentSessionPanelProps {
  /** The LiveKit join info returned by the server — either from the
   *  `livekit` field on session-create OR from POST /v1/agent-
   *  sessions/:id/livekit-token. */
  info: LiveKitInfo;
  /** Optional: archetype-driven aspect ratio. Defaults to iPhone 16
   *  Pro (1206×2622 px) since that's the locked archetype
   *  (iphone17_ios18_7_safari26_4) for v1.0 per the orchestrator brief. */
  aspectRatio?: number;
  /** Callback fired on every connection-state transition. LK.6.c
   *  wires the chrome badge to this. */
  onStateChange?: (state: LivekitConnectionState) => void;
  /** W617 — offered when the room connects but NO video track arrives
   *  within NO_PUBLISHER_TIMEOUT_MS (founder-hit: empty LiveKit room on a
   *  deployment with no browser worker → black screen). The parent wires
   *  this to a fallback (e.g. open the polling viewer); rendered as a
   *  button on the no-publisher overlay. */
  onNoPublisher?: () => void;
  /** Simulator mode (the floating-iPhone window): when true, the LK.6.d
   *  input-capture is wired so mouse/keyboard on the video drive the real
   *  device (forwarded over the LiveKit DataChannel to the Mac-side CGEvent
   *  decoder). Default false keeps existing embeds (dashboard / in-app
   *  overlay) subscriber-only. Capture engages only once the customer clicks
   *  into the screen (`engaged`), so it never hijacks the rest of the UI. */
  interactive?: boolean;
  /** Fired once the stream reports its REAL pixel dimensions (video
   *  loadedmetadata). The simulator window uses this to resize itself to the
   *  archetype's true proportions — no hardcoded per-archetype table. */
  onVideoDimensions?: (width: number, height: number) => void;
  /** Night-arc I: surfaces the live <video> element so the simulator
   *  toolbar can grab snapshot frames. Called once the element mounts. */
  onVideoEl?: (el: HTMLVideoElement | null) => void;
  /** Night-arc C: surfaces the connected Room upward so the simulator
   *  cockpit can run the (previously dormant) latency ping. Called with
   *  the room once connected and with null on teardown. */
  onRoom?: (room: Room | null) => void;
}

/** W617 — how long a connected-but-videoless room waits before the panel
 *  declares "no publisher" (a real worker publishes within ~2-5s; 10s is
 *  comfortably past that without feeling stuck). */
export const NO_PUBLISHER_TIMEOUT_MS = 10_000;

const IPHONE_16_PRO_ASPECT_RATIO = 1206 / 2622; // ≈ 0.46

export function AgentSessionPanel({
  info,
  aspectRatio = IPHONE_16_PRO_ASPECT_RATIO,
  onStateChange,
  onNoPublisher,
  interactive = false,
  onVideoDimensions,
  onRoom,
  onVideoEl,
}: AgentSessionPanelProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<LivekitConnectionState>({ kind: 'idle' });
  // Live aspect — the stream's REAL dimensions (loadedmetadata) win over the
  // static prop, so EVERY archetype renders its true proportions (many
  // archetypes incoming; no hardcoded per-device table). The prop/constant
  // stays as the pre-metadata fallback so the box has a sane shape while
  // connecting.
  const [liveAspect, setLiveAspect] = useState<number | null>(null);
  const effectiveAspectRatio = liveAspect ?? aspectRatio;
  // Simulator control: the live LiveKit room is lifted to state so the
  // input-capture hook can publish on its DataChannel. In `interactive` mode
  // (the dedicated floating-iPhone window) capture is on — the window IS the
  // device, so window-focus naturally scopes the keyboard and there's no other
  // UI to hijack. Non-interactive embeds stay subscriber-only.
  const [room, setRoom] = useState<Room | null>(null);
  useInputCapture({ room, videoRef, enabled: interactive });
  // W617 — track whether a video track ever arrived; 'waiting' →
  // 'publishing' on TrackSubscribed, 'waiting' → 'none' on timeout after
  // connect. 'none' renders the honest no-worker overlay.
  const [publisher, setPublisher] = useState<'waiting' | 'publishing' | 'none'>('waiting');
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
    // Expose the room to the input-capture hook (simulator control). Cleared
    // in cleanup so a stale room can't receive input after disconnect.
    setRoom(room);
    onRoom?.(room);
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
      setPublisher('publishing');
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
    setPublisher('waiting');
    // W617 — empty-room detector: connected but no video track within the
    // timeout means no browser worker is publishing on this deployment
    // (founder-hit black screen). Cleared by TrackSubscribed above.
    let noPublisherTimer: ReturnType<typeof setTimeout> | null = null;
    connectToAgentSession(room, info)
      .then(() => {
        if (cancelled) return;
        setS({ kind: 'connected' });
        noPublisherTimer = setTimeout(() => {
          if (cancelled) return;
          setPublisher((p) => (p === 'waiting' ? 'none' : p));
        }, NO_PUBLISHER_TIMEOUT_MS);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'unknown connection error';
        setS({ kind: 'error', message });
      });

    return () => {
      cancelled = true;
      if (noPublisherTimer !== null) clearTimeout(noPublisherTimer);
      setRoom(null);
      onRoom?.(null);
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
      // <video> then fills this iPhone-aspect box exactly. The aspect is the
      // LIVE stream's once metadata arrives (effectiveAspectRatio), so the box
      // tracks the real archetype.
      className="relative h-full max-h-full max-w-full overflow-hidden rounded-lg border border-white/10 bg-black"
      style={{ aspectRatio: effectiveAspectRatio.toString() }}
    >
      <video
        ref={(el) => {
          videoRef.current = el;
          onVideoEl?.(el);
        }}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
        aria-label="Agent session live video stream"
        onLoadedMetadata={(e) => {
          // The stream's real pixel dimensions — the archetype's true screen
          // resolution. Adopt the aspect + tell the parent (the simulator
          // window resizes itself to match).
          const el = e.currentTarget;
          if (el.videoWidth > 0 && el.videoHeight > 0) {
            const next = el.videoWidth / el.videoHeight;
            setLiveAspect((prev) => (prev === next ? prev : next));
            onVideoDimensions?.(el.videoWidth, el.videoHeight);
          }
        }}
      />
      {/* W617 — connected but nothing publishing: waiting spinner first,
          then the honest no-worker overlay with the parent's fallback. */}
      {state.kind === 'connected' && publisher !== 'publishing' && (
        <div
          data-overlay="publisher-state"
          data-state={publisher}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center text-sm text-ink-primary"
        >
          {publisher === 'waiting' ? (
            <>
              <span
                className="h-7 w-7 animate-spin rounded-full border-2 border-white/25 border-t-white/90"
                aria-hidden="true"
              />
              <span>Connected — waiting for the browser to start streaming…</span>
            </>
          ) : (
            <>
              <span>
                No live video — the stream room is up, but no browser worker is publishing on this
                deployment.
              </span>
              {onNoPublisher !== undefined && (
                <button
                  type="button"
                  data-action="open-polling-viewer"
                  onClick={onNoPublisher}
                  className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:bg-white/20"
                >
                  Open in the direct viewer instead
                </button>
              )}
            </>
          )}
        </div>
      )}
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
