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
  /** Fired on every publisher-state transition (waiting → publishing → none).
   *  The simulator gates the address bar / back-forward / reload on a video
   *  track actually arriving ('publishing'), so a URL typed while the box
   *  renderer isn't up yet can't silently no-op. */
  onPublisher?: (publisher: 'waiting' | 'publishing' | 'none') => void;
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
  /** Fired (at most once per connection) when an input publish fails — the
   *  control data channel is effectively dead, so taps/keys aren't reaching the
   *  device. The simulator surfaces this as a small non-fatal badge. */
  onPublishError?: () => void;
  /** Legacy no-op (kept for prop-plumbing compatibility). It USED to mask the freed
   *  iOS-Safari chrome bands (a ~110px bottom + ~50px top band the old fork baked
   *  into the capture when it hid the URL bar but kept the 714px web-view inside an
   *  838px window). The content-only per-archetype fork (A3 84de32ad4d, box
   *  mac-macstadium-us-001) drops those bands entirely — the captured video == the
   *  web content edge-to-edge — so masking now covers REAL content (founder's "black
   *  space at the bottom + content cut off at the top"). The masks are removed; this
   *  prop is retained as an inert flag so existing callers don't break. */
  coverChromeBand?: boolean;
  /** The live captured-frame logical device-CSS-px dims the Mac touch injector
   *  addresses (per-archetype, A3 84de32ad4d). Forwarded to the input-capture hook
   *  so the coordinate mapping adapts to the dispatched device. The simulator
   *  computes it from the <video>'s first full-res natural size ÷ dpr; undefined
   *  falls back to the launch archetype (402×874) inside the hook. */
  inputLogical?: { width: number; height: number };
}

/** W617 / #59 — how long a connected-but-videoless room waits before the panel
 *  declares the launch failed (no publisher). A WARM worker publishes in ~2-5s,
 *  but a COLD session spawn (the worker launches a fresh browser fork → loads the
 *  page → joins LiveKit → first frame) routinely takes longer — 10s flipped to a
 *  discouraging "no video" right as the stream was about to appear (founder's
 *  first real launch, 2026-06-18). 30s comfortably covers a cold spawn while still
 *  bounding the indefinite "connecting…" the founder hit when a launch silently
 *  failed (proxy down → the box never started → the room stays empty forever, #59);
 *  the spinner + reassuring copy keep it from feeling stuck in the meantime, and on
 *  timeout the overlay offers Retry. Cleared the instant a video track arrives, so a
 *  slow-but-working start never trips it. */
export const NO_PUBLISHER_TIMEOUT_MS = 30_000;

/** Map raw livekit-client connection errors to customer-friendly copy. The raw
 *  messages leak transport jargon into the overlay — e.g. "could not establish
 *  signal connection: invalid authorization token" (founder saw it 2026-06-18).
 *  Keeps the raw text as a fallback for anything unrecognized. */
export function friendlyConnectError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/authorization token|permission|unauthorized|\b401\b|expired/i.test(raw)) {
    // HONEST copy (edge-errors review): the standalone Simulator captured its token at
    // open and CANNOT mint a fresh one, so Reconnect would just replay the same dead
    // token and loop. Tell the founder to relaunch the profile (which mints a new token)
    // rather than promising Reconnect fetches a fresh one.
    return "This session's video link expired — relaunch the profile to continue.";
  }
  if (
    /signal connection|could not connect|websocket|network|timeout|ECONN|getaddrinfo|dns/i.test(raw)
  ) {
    return "Couldn't reach the live-stream server — check your connection, then Reconnect.";
  }
  if (/closed|disconnect/i.test(raw)) {
    return 'The live connection closed — Reconnect, or close this window if the session ended.';
  }
  return raw.length > 0 ? raw : 'Could not connect to the live stream.';
}

/** True when the connect error is an expired/invalid token. For these, Reconnect can't
 *  help in the standalone Simulator (no path to mint a fresh token), so the overlay
 *  drops the Reconnect button and shows the relaunch instruction instead of looping. */
export function isAuthConnectError(message: string): boolean {
  return /video link expired/i.test(message);
}

const IPHONE_16_PRO_ASPECT_RATIO = 1206 / 2622; // ≈ 0.46

export function AgentSessionPanel({
  info,
  aspectRatio = IPHONE_16_PRO_ASPECT_RATIO,
  onStateChange,
  onPublisher,
  onNoPublisher,
  interactive = false,
  onVideoDimensions,
  onRoom,
  onVideoEl,
  onPublishError,
  // Legacy no-op — the content-only fork (A3 84de32ad4d) emits NO chrome bands, so
  // the old bezel-black masks are gone (they covered real content otherwise). The
  // prop is destructured (default off) only to keep the call-site shape stable.
  coverChromeBand: _coverChromeBand = false,
  inputLogical,
}: AgentSessionPanelProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The video element as STATE (not just the ref) so useInputCapture re-runs
  // when it mounts — a ref's `.current` is mutated without re-rendering, so an
  // effect keyed on the ref would attach to the stale (null) element.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [state, setState] = useState<LivekitConnectionState>({ kind: 'idle' });
  // Box aspect = the FIXED canonical device aspect (402:874 ≡ 1206/2622), NOT the
  // live track aspect. Founder 2026-06-23 "iPhone rendered smaller for no reason"
  // + A3 W2840: the SFU downscales the published 402×874 track to a not-exactly-
  // 402:874 EVEN resolution, so `videoWidth/videoHeight` ≈ but ≠ 402:874. Driving
  // the box from that drifted live aspect, while `fitWindow` sizes the screen-host
  // to EXACTLY 402:874, made the box `object-contain` letterbox a few px INSIDE
  // its area → a slightly-shrunken view. Locking the box to the canonical aspect
  // makes box == host; the tiny SFU drift is absorbed sub-pixel by the <video>'s
  // object-contain. The real dims still drive the one-time WINDOW resize via
  // onVideoDimensions below — that path is unchanged.
  const effectiveAspectRatio = aspectRatio;
  // Simulator control: the live LiveKit room is lifted to state so the
  // input-capture hook can publish on its DataChannel. In `interactive` mode
  // (the dedicated floating-iPhone window) capture is on — the window IS the
  // device, so window-focus naturally scopes the keyboard and there's no other
  // UI to hijack. Non-interactive embeds stay subscriber-only.
  const [room, setRoom] = useState<Room | null>(null);
  useInputCapture({
    room,
    videoElement: videoEl,
    enabled: interactive,
    onPublishError,
    // Per-archetype captured-frame logical dims so the tap/scroll mapping matches the
    // dispatched device's content-only frame (A3 84de32ad4d); undefined → 402×874.
    logical: inputLogical,
  });
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
  // Surface publisher transitions upward (same ref-decoupling rationale as
  // onStateChange) so the simulator can gate navigation on a video track actually
  // arriving. Keyed on the publisher VALUE so it fires on every real change.
  const onPublisherRef = useRef(onPublisher);
  useEffect(() => {
    onPublisherRef.current = onPublisher;
  }, [onPublisher]);
  useEffect(() => {
    onPublisherRef.current?.(publisher);
  }, [publisher]);

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
      // Minimize the receiver-side jitter buffer for the interactive simulator:
      // a deep buffer trades latency for jitter-smoothing, but this is a live
      // control surface where input→pixel lag matters most. Pairs with the
      // publisher's real-time config + adaptiveStream:false. Guarded — an older
      // livekit-client without setPlayoutDelay just no-ops.
      try {
        track.setPlayoutDelay?.(0);
      } catch {
        /* setPlayoutDelay unsupported — ignore */
      }
      setPublisher('publishing');
    });
    // Reverse of TrackSubscribed: the publishing worker (the Mac browser fork) crashes or
    // restarts → the SFU drops its video track while OUR signal connection stays UP, so
    // RoomEvent.Disconnected never fires. Without this the last frame freezes with no overlay
    // and no recovery path (founder-hit class). Flip back to 'none' so the W617 "no live
    // video" overlay + the recovery affordance surface; TrackSubscribed restores 'publishing'
    // if it comes back. (#145)
    const onPublisherLost = (): void => {
      if (cancelled) return;
      setPublisher((p) => (p === 'publishing' ? 'none' : p));
    };
    (room as any).on(RoomEvent.TrackUnsubscribed, (track: any) => {
      if (track?.kind === 'video') onPublisherLost();
    });
    (room as any).on(RoomEvent.ParticipantDisconnected, onPublisherLost);
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
    // W617 / #59 — empty-room detector: connected but no video track within the
    // timeout means the launch never produced a stream (no worker publishing /
    // proxy down so the box never started → an indefinite "connecting…"). Flips
    // to 'none' → the launch-failed overlay + Retry. Cleared by TrackSubscribed.
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
        setS({ kind: 'error', message: friendlyConnectError(err) });
      });

    return () => {
      cancelled = true;
      if (noPublisherTimer !== null) clearTimeout(noPublisherTimer);
      setRoom(null);
      onRoom?.(null);
      // .catch the teardown: disconnect() can reject on a teardown race with a
      // message OUTSIDE main.tsx's benign allowlist (aborted reconnect / signal
      // socket error), which would otherwise blank the app via the fatal overlay.
      void (room as any).disconnect()?.catch?.(() => undefined);
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
      // No white border (founder 2026-06-23 "white border around the view, looks
      // bad" + A3 W2827): when the live aspect makes the <video> object-contain
      // SMALLER than this box, a white rim outlined the shrunken view. bg-black +
      // no border → the iPhone view sits flush in bezel-black; any object-contain
      // margin reads as bezel, not a light frame.
      className="relative h-full max-h-full max-w-full overflow-hidden rounded-lg bg-black"
      style={{ aspectRatio: effectiveAspectRatio.toString() }}
    >
      <video
        ref={(el) => {
          videoRef.current = el;
          setVideoEl(el);
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
            // Real dims drive ONLY the one-time window resize (not the box aspect,
            // which is the fixed canonical 402:874 — see effectiveAspectRatio).
            onVideoDimensions?.(el.videoWidth, el.videoHeight);
          }
        }}
      />
      {/* Chrome-band masks REMOVED (A3 84de32ad4d content-only per-archetype fork on
          box mac-macstadium-us-001): the old fork baked a ~110px bottom + ~50px top
          bezel-black band into the capture (it hid the iOS-Safari URL bar but kept the
          714px web-view inside an 838px window → scalesToFit letterbox + freed-chrome
          reserve). The new fork sizes the captured window PER archetype so the web
          content fills the frame edge-to-edge with NO bands — masking it now covers
          REAL content (founder's "black space at the bottom + content cut off at the
          top"). `coverChromeBand` is kept as an inert prop for call-site compatibility. */}
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
              <span>Connected — starting the browser… a cold start can take a few seconds.</span>
            </>
          ) : (
            <>
              <span>
                Couldn’t start the session — the proxy or connection may be down. The stream room
                connected, but no live video arrived.
              </span>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {/* #59 — a no-stream launch can recover on a fresh connect (the worker
                    was slow, the proxy came back, a transient SFU hiccup), so always
                    offer Retry. It bumps retryNonce → the connect effect re-runs (new
                    Room + reconnect + a fresh NO_PUBLISHER_TIMEOUT_MS window). */}
                <button
                  type="button"
                  data-action="retry-launch"
                  onClick={() => {
                    setRetryNonce((n) => n + 1);
                  }}
                  className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:bg-white/20"
                >
                  Retry
                </button>
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
              </div>
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
          {/* Reconnect retries the SAME captured token, so it's offered for a transport
              drop (disconnected) and non-auth errors — but NOT an expired-token error,
              where it can only loop on the dead token (the copy already tells the founder
              to relaunch the profile, which mints a fresh token). */}
          {(state.kind === 'disconnected' ||
            (state.kind === 'error' && !isAuthConnectError(state.message))) && (
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
