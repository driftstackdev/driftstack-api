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
import { parseConnectionStats } from '../lib/livekit-connection-stats';
import { nextPlayoutDelay } from '../lib/livekit-adaptive-playout';

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
  /** #5/#9 — recovery lever for a sustained TRUE video freeze. The simulator's
   *  frame-progress detector decides WHEN to recover (it owns the <video> element's
   *  frame signal); the panel performs the recovery because it holds the remote
   *  publication + the connect-effect retryNonce in scope. Each distinct `nonce`
   *  bump triggers exactly one action: `'resubscribe'` toggles the remote video
   *  subscription off→on (the browser then auto-sends a PLI → the SFU/encoder
   *  pushes a fresh keyframe), and `'rebuild'` tears down + reconnects the whole
   *  Room (bumps retryNonce). nonce 0 is the inert initial value (no recovery). */
  recoverAction?: { nonce: number; mode: 'resubscribe' | 'rebuild' };
  /** P1a — the box session TERMINALLY ended (the worker browser closed, the
   *  session was destroyed/errored, or the orphan sweeper reaped it — the parent's
   *  ~5s status poll detected status='closed' / closed_at / closed_reason). When
   *  set, the panel STOPS all reconnect/resubscribe/rebuild/publisher-grace
   *  machinery (those would loop "reconnecting" against a session that's gone) and
   *  shows a clear "Session ended" terminal overlay with a Close action instead.
   *  `reason` is the server close-reason for honest copy (null when unknown). A
   *  transient transport drop leaves this undefined so the bounded auto-reconnect
   *  still runs. */
  sessionEnded?: { reason: string | null } | null;
  /** True while a tab switch is in flight (the box hasn't published the new tab's page
   *  yet). Shows an about:blank-style placeholder over the video so the OLD tab doesn't
   *  linger during the switch latency (founder #5 2026-06-30 "keeps showing old tab"). */
  switching?: boolean;
  /** P1a — invoked by the terminal "Session ended" overlay's Close button. The
   *  simulator wires this to closing the floating-iPhone window. */
  onClose?: () => void;
}

/** #1 — grace window after the SFU drops the video track (TrackUnsubscribed /
 *  ParticipantDisconnected) before the panel declares the publisher gone and shows
 *  the scary launch-failed overlay. A3's idle frame-pump down-clock (W2952) +
 *  routine encoder restarts / brief SFU re-negotiations momentarily drop and
 *  re-add the track; flipping to 'none' instantly slammed the full-screen
 *  "Couldn't start the session…" alarm over the last good frame for a stream that
 *  recovers within a second or two (founder's "reconnecting, happens too often").
 *  During the window a calm "reconnecting…" pill shows over the last frame; if a
 *  TrackSubscribed re-arrives the grace is cancelled and nothing scary ever shows.
 *  2s comfortably covers a normal re-publish while still bounding a true loss. */
export const PUBLISHER_LOST_GRACE_MS = 2_000;

/** #8 — bounded auto-reconnect schedule for an UNEXPECTED transport Disconnected
 *  (the signal socket dropped without a deliberate teardown). Exponential backoff
 *  ~1s/3s/9s, capped at 3 attempts, before falling back to the manual Reconnect
 *  button — so a brief network blip recovers itself instead of stranding the
 *  founder on the disconnected overlay. A deliberate teardown (unmount / window
 *  close) sets the cancelled flag and never schedules a retry. */
export const AUTO_RECONNECT_BACKOFF_MS = [1_000, 3_000, 9_000] as const;

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
  // Unrecognized — a generic friendly line rather than raw transport jargon
  // (founder: no raw codes/strings like -1004 in the overlay). The raw text still
  // reaches the dev logs via the caller's error logging.
  return 'Could not connect to the live stream — Reconnect to try again.';
}

/** True when the connect error is an expired/invalid token. For these, Reconnect can't
 *  help in the standalone Simulator (no path to mint a fresh token), so the overlay
 *  drops the Reconnect button and shows the relaunch instruction instead of looping. */
export function isAuthConnectError(message: string): boolean {
  return /video link expired/i.test(message);
}

function formatSessionDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return 'Less than a minute';
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function friendlySessionEndReason(reason: string | null): string {
  if (reason === 'idle_timeout') return 'Closed after inactivity';
  if (reason === 'browser-closed') return 'Browser closed';
  if (reason === 'orphaned-lifetime') return 'Session time limit reached';
  return 'Session closed';
}

const IPHONE_16_PRO_ASPECT_RATIO = 1206 / 2622; // ≈ 0.46

/**
 * Optimistic local tap feedback — a soft pulse rendered at the touch point the
 * INSTANT the pointer goes down, so a tap FEELS immediate while the real input
 * makes its round-trip (pointerdown → data channel → box harness inject → fork
 * repaint → encode → publish → decode). Founder 2026-07-02: "browser/GUI can be
 * very unresponsive, delayed taps/clicks". This is PURELY visual — it does NOT
 * synthesize or alter the InputEvent sent to the device (useInputCapture owns
 * the real tap); it only masks the perceived latency. Self-removes when its
 * animation finishes. Falls back to a no-op if Web Animations is unavailable
 * (the parent's timeout still clears the ripple from state).
 */
function TapRipple({ x, y }: { x: number; y: number }): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof el.animate !== 'function') return;
    const anim = el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.35)', opacity: 0.5 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
      ],
      { duration: 450, easing: 'cubic-bezier(0.2, 0.65, 0.3, 1)' },
    );
    return () => anim.cancel();
  }, []);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-tap-ripple=""
      className="pointer-events-none absolute z-[15] block h-11 w-11 rounded-full"
      style={{
        left: x,
        top: y,
        background: 'radial-gradient(circle, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 70%)',
        willChange: 'transform, opacity',
      }}
    />
  );
}

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
  recoverAction,
  sessionEnded = null,
  switching = false,
  onClose,
}: AgentSessionPanelProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Wave 2 recap — the terminal poll currently exposes only the close reason (no
  // billing/cost metadata), while tab count belongs to the parent simulator. Track
  // this panel's live-view lifetime locally and latch the end timestamp so the recap
  // stays stable across any final transport/cleanup re-renders.
  const sessionTimingRef = useRef<{
    identity: string;
    startedAtMs: number;
    endedAtMs: number | null;
  }>({ identity: info.room, startedAtMs: Date.now(), endedAtMs: null });
  if (sessionTimingRef.current.identity !== info.room) {
    sessionTimingRef.current = { identity: info.room, startedAtMs: Date.now(), endedAtMs: null };
  }
  if (sessionEnded === null) {
    sessionTimingRef.current.endedAtMs = null;
  } else if (sessionTimingRef.current.endedAtMs === null) {
    sessionTimingRef.current.endedAtMs = Date.now();
  }
  const sessionDuration = formatSessionDuration(
    Math.max(
      0,
      Math.floor(
        ((sessionTimingRef.current.endedAtMs ?? Date.now()) -
          sessionTimingRef.current.startedAtMs) /
          1_000,
      ),
    ),
  );
  // The video element as STATE (not just the ref) so useInputCapture re-runs
  // when it mounts — a ref's `.current` is mutated without re-rendering, so an
  // effect keyed on the ref would attach to the stale (null) element.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  // Optimistic-tap-feedback state (#124): a small ring of active ripples, each
  // spawned on pointerdown over the live video and auto-cleared shortly after.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rippleIdRef = useRef(0);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [state, setState] = useState<LivekitConnectionState>({ kind: 'idle' });
  // Box aspect = the `aspectRatio` prop, which the simulator drives with the LIVE
  // CONTENT aspect (videoW/videoH) — the SAME value its window-sizing math uses to
  // size the screen-host (P1b). So box == host == <video>, and the video fills the
  // box edge-to-edge with NO letterbox band. This REPLACES the old "lock to the
  // canonical 402:874" behavior: that was right when the box published the FULL
  // device (402×874), but the content-only per-archetype fork (A3 84de32ad4d)
  // publishes the web content edge-to-edge (e.g. 402×714), so a 402:874 box
  // letterboxed the wider content top+bottom inside it → the founder's persistent
  // bottom-black gap. The default (402:874) still applies until the first frame
  // reports. Any sub-pixel SFU-downscale drift (videoW/videoH ≈ but ≠ the exact
  // content aspect, A3 W2840) is absorbed by the <video>'s own object-contain.
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
  // A3 UX audit ww5k0xkmx (cold-start blank pane) — 'publishing' flips on
  // TrackSubscribed, but on a cold start the first DECODED frame can lag the
  // subscription by seconds (box encoder ramping to the first keyframe). If the
  // waiting overlay dropped at TrackSubscribed the pane would sit pure black with
  // no "is it working?" signal. Hold the starting overlay until a frame actually
  // paints (videoWidth > 0); re-armed per connection attempt alongside
  // setPublisher('waiting') so a Retry/reconnect gets the hold again. Once true it
  // stays true for the connection (mid-session drops keep the calmer
  // reconnecting-pill path over the last good frame — deliberate).
  const [firstFramePainted, setFirstFramePainted] = useState(false);
  // #1 — during the post-track-drop grace window (before we know whether the
  // publisher is truly gone or just re-negotiating), show a CALM "reconnecting…"
  // pill over the last good frame instead of the scary launch-failed overlay. True
  // only between a track drop and either its re-subscribe (cleared) or the grace
  // expiring (→ publisher 'none', the honest overlay).
  const [publisherReconnecting, setPublisherReconnecting] = useState(false);
  // Manual reconnect: bumping this re-runs the connect effect (new Room +
  // reconnect). Lets the customer recover from an error/disconnect without
  // reloading the whole app. Only bumped on the Reconnect button — and #5/#9's
  // sustained-freeze rebuild escalation — not a render-driven dep, so it can't
  // cause reconnect-thrash.
  const [retryNonce, setRetryNonce] = useState(0);
  // #5/#9 — the live remote VIDEO publication, captured on TrackSubscribed and
  // cleared on TrackUnsubscribed. setSubscribed(false→true) on it is the GUI's lever
  // to force a fresh keyframe (the browser auto-sends a PLI on re-subscribe). Held in
  // a ref so the recovery effect can read the latest publication WITHOUT re-running
  // the connect effect (which would thrash the room). `.setSubscribed` is on the
  // RemoteTrackPublication the SFU surfaces for the worker's published video track.
  const videoPublicationRef = useRef<{ setSubscribed?: (s: boolean) => void } | null>(null);
  // The live subscribed remote video track — surfaced for the adaptive
  // playout-delay controller (below) to sample stats + nudge the jitter buffer.
  const remoteVideoTrackRef = useRef<{
    getRTCStatsReport?: () => Promise<RTCStatsReport>;
    setPlayoutDelay?: (d: number) => void;
  } | null>(null);

  // #8 auto-reconnect attempt counter — held in a REF so it survives the connect
  // effect re-run that each reconnect triggers (a Disconnected schedules a
  // reconnect by bumping retryNonce, which is in the effect's deps → the effect
  // tears down and re-runs). A plain effect-local `let` reset to 0 on every such
  // re-run, so the exponential backoff (1s→3s→9s) and the 3-attempt cap were
  // UNREACHABLE — a flaky link that keeps dropping reconnected at a flat 1s
  // forever and never fell back to the manual Reconnect overlay (contributing to
  // "reconnects happen too often", task #70). Reset to 0 only on a GENUINELY
  // healthy session (a video track actually arrives — TrackSubscribed), so a
  // link that flaps without ever delivering a frame escalates to the manual
  // overlay instead of thrashing. (Fable GUI re-audit 2026-07-02.)
  const autoReconnectAttemptRef = useRef(0);

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
  // Aspect-track — onVideoDimensions in a ref (same identity-decoupling rationale) so the
  // resize-listener effect below depends ONLY on the video element, not the callback's
  // identity (re-attaching the listener every render would be churn).
  const onVideoDimensionsRef = useRef(onVideoDimensions);
  useEffect(() => {
    onVideoDimensionsRef.current = onVideoDimensions;
  }, [onVideoDimensions]);
  // The <video> intrinsic (videoWidth/videoHeight) can CHANGE after the first
  // loadedmetadata frame: the worker first publishes a frame at one aspect, then the
  // content-only steady state settles a beat later at the real content aspect (e.g. the
  // first frame is ~0.497 then steady ~0.593). The media element fires a `resize` event
  // each time its intrinsic dimensions change — forward it to the parent so the simulator
  // can re-fit the screen-host to the LIVE aspect (no stale-aspect TOP/BOTTOM letterbox).
  // The parent's handler is thrash-guarded (it ignores pure-resolution SFU downscales that
  // preserve the aspect), so firing on every resize is safe. Keyed on the element so it
  // (re)attaches when the <video> mounts/remounts.
  useEffect(() => {
    if (videoEl === null) return;
    const onResize = (): void => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        onVideoDimensionsRef.current?.(videoEl.videoWidth, videoEl.videoHeight);
      }
    };
    videoEl.addEventListener('resize', onResize);
    return () => {
      videoEl.removeEventListener('resize', onResize);
    };
  }, [videoEl]);
  // Cold-start first-frame detector (ww5k0xkmx): flip firstFramePainted the
  // moment the element has a decoded frame. Checks immediately (the element may
  // already be playing when it (re)mounts), then listens for loadeddata + resize
  // (both fire when the intrinsic size becomes real). Cheap: listeners detach on
  // unmount and the setState is a no-op once true.
  useEffect(() => {
    if (videoEl === null) return;
    const check = (): void => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) setFirstFramePainted(true);
    };
    check();
    videoEl.addEventListener('loadeddata', check);
    videoEl.addEventListener('resize', check);
    return () => {
      videoEl.removeEventListener('loadeddata', check);
      videoEl.removeEventListener('resize', check);
    };
  }, [videoEl]);
  // P1a — the latest terminal-end flag in a ref so the connect effect's event
  // handlers (Disconnected / publisher-lost / no-publisher timer) can short-circuit
  // WITHOUT re-running the connect effect (which depends only on ws_url/token/
  // retryNonce — re-running it would thrash the Room). When the session has
  // TERMINALLY ended, those handlers must NOT schedule a reconnect or flip to the
  // scary launch-failed overlay; the terminal "Session ended" overlay is the single
  // source of truth then. A transient drop (sessionEnded null) keeps the bounded
  // auto-reconnect.
  const sessionEndedRef = useRef(sessionEnded);
  useEffect(() => {
    sessionEndedRef.current = sessionEnded;
  }, [sessionEnded]);
  // P1a — when the session ends terminally, proactively tear down any in-flight
  // recovery: stop the calm "reconnecting" pill + drop the panel out of a
  // 'reconnecting' connection state so the terminal overlay (rendered below) wins
  // immediately instead of waiting for the next event. We DON'T disconnect the Room
  // here (the connect effect's cleanup owns that on unmount); we only stop claiming
  // we're recovering.
  useEffect(() => {
    if (sessionEnded === null) return;
    setPublisherReconnecting(false);
  }, [sessionEnded]);

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
    // #1 — pending grace timer after a track drop. Held in the effect closure
    // (not a render ref) so it's naturally cleared when the effect re-runs/tears
    // down. Cancelled by a TrackSubscribed re-arrival so a re-publish never flips
    // to the scary overlay.
    let publisherLostTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPublisherLostTimer = (): void => {
      if (publisherLostTimer !== null) {
        clearTimeout(publisherLostTimer);
        publisherLostTimer = null;
      }
    };
    // #8 — bounded auto-reconnect schedule for an UNEXPECTED Disconnected. The
    // attempt COUNTER lives in autoReconnectAttemptRef (component-level) so it
    // survives this effect's re-run on a reconnect (see the ref's declaration);
    // an effect-local counter reset every reconnect, defeating the backoff+cap.
    let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // RoomEvent wire-up. `as any` casts are scoped to the
    // livekit-client surface where exact typing isn't worth the
    // import-churn — the runtime contract is documented in the
    // wrapper's RoomEvent re-export.
    (room as any).on(RoomEvent.TrackSubscribed, (track: any, publication: any) => {
      if (cancelled) return;
      if (track.kind !== 'video') return;
      const el = videoRef.current;
      if (el !== null) track.attach(el);
      // #5/#9 — stash the publication so a sustained-freeze recovery can toggle its
      // subscription (forcing a fresh keyframe) without re-running the connect effect.
      videoPublicationRef.current = (publication ?? null) as typeof videoPublicationRef.current;
      // Surface the track for the adaptive playout controller (stats sampling +
      // jitter-buffer nudging). Cleared when a publisher-lost grace expires below.
      remoteVideoTrackRef.current = track as typeof remoteVideoTrackRef.current;
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
      // #1 — the track is back: cancel any pending grace + the calm pill, restore
      // 'publishing'. A brief SFU re-negotiation / encoder restart never surfaces
      // the launch-failed overlay now.
      clearPublisherLostTimer();
      setPublisherReconnecting(false);
      setPublisher('publishing');
      // #8 — a real video frame arrived → the session is GENUINELY healthy, so
      // reset the auto-reconnect attempt counter. A later unrelated drop then
      // starts a fresh 1s→3s→9s backoff sequence. A link that only flaps and
      // never delivers a track never resets → it escalates to the manual overlay.
      autoReconnectAttemptRef.current = 0;
    });
    // Reverse of TrackSubscribed: the publishing worker (the Mac browser fork) crashes or
    // restarts → the SFU drops its video track while OUR signal connection stays UP, so
    // RoomEvent.Disconnected never fires. Without this the last frame freezes with no overlay
    // and no recovery path (founder-hit class). (#145)
    //
    // #1 DEBOUNCE: do NOT flip to 'none' instantly — A3's idle frame-pump down-clock
    // (W2952) + routine encoder restarts / short SFU re-negotiations drop and re-add
    // the track within ~1-2s, and an instant flip slammed the scary "Couldn't start
    // the session…" alarm over the last good frame ("reconnecting, happens too often").
    // Show a calm "reconnecting…" pill over the last frame and only escalate to 'none'
    // (the honest overlay) if no TrackSubscribed re-arrives within the grace window.
    const onPublisherLost = (): void => {
      if (cancelled) return;
      // P1a — the session terminally ended: the publisher is gone for GOOD (the
      // worker browser closed). Don't run the grace→reconnecting pill dance; the
      // terminal "Session ended" overlay covers it. (Flipping to 'none' here is
      // harmless — the terminal overlay renders on top regardless — but skipping the
      // calm-pill path avoids a misleading "reconnecting…" flash.)
      if (sessionEndedRef.current !== null) return;
      setPublisher((p) => {
        if (p !== 'publishing') return p;
        setPublisherReconnecting(true);
        clearPublisherLostTimer();
        publisherLostTimer = setTimeout(() => {
          if (cancelled) return;
          publisherLostTimer = null;
          setPublisherReconnecting(false);
          // The grace expired with no TrackSubscribed (which would have CLEARED this
          // timer on re-arrival) → the publisher really is gone. Surface the honest
          // launch-failed overlay.
          setPublisher('none');
        }, PUBLISHER_LOST_GRACE_MS);
        // Stay 'publishing' (keep the last frame + the calm pill) for now.
        return p;
      });
    };
    (room as any).on(RoomEvent.TrackUnsubscribed, (track: any) => {
      if (track?.kind === 'video') {
        // #5/#9 — the publication's track is gone; drop the stale handle so a
        // recovery toggle can't act on a detached track. A re-subscribe re-stashes it.
        videoPublicationRef.current = null;
        remoteVideoTrackRef.current = null;
        onPublisherLost();
      }
    });
    (room as any).on(RoomEvent.ParticipantDisconnected, onPublisherLost);
    (room as any).on(RoomEvent.Disconnected, () => {
      if (cancelled) return;
      // P1a — the session TERMINALLY ended (worker browser closed / destroyed /
      // reaped): a Disconnected here is EXPECTED, not a transient blip. Do NOT
      // schedule the bounded auto-reconnect (it would loop "reconnecting" against a
      // session that's gone — the founder-reported bug). The terminal "Session
      // ended" overlay (rendered below on the sessionEnded prop) is the single
      // source of truth; we just stop claiming we're connecting.
      if (sessionEndedRef.current !== null) {
        setS({ kind: 'disconnected' });
        return;
      }
      // #8 — an UNEXPECTED transport drop (not a deliberate teardown — cleanup sets
      // `cancelled` BEFORE disconnect()) auto-retries with exponential backoff before
      // falling back to the manual Reconnect button. A reconnect re-runs this whole
      // effect via retryNonce (fresh Room + connect), so we only schedule the bump.
      if (autoReconnectAttemptRef.current < AUTO_RECONNECT_BACKOFF_MS.length) {
        const delay = AUTO_RECONNECT_BACKOFF_MS[autoReconnectAttemptRef.current];
        autoReconnectAttemptRef.current += 1;
        setS({ kind: 'reconnecting' });
        if (autoReconnectTimer !== null) clearTimeout(autoReconnectTimer);
        autoReconnectTimer = setTimeout(() => {
          if (cancelled) return;
          autoReconnectTimer = null;
          setRetryNonce((n) => n + 1);
        }, delay);
        return;
      }
      // Attempts exhausted — surface the manual Reconnect overlay.
      setS({ kind: 'disconnected' });
    });
    (room as any).on(RoomEvent.Reconnecting, () => {
      if (!cancelled) setS({ kind: 'reconnecting' });
    });
    (room as any).on(RoomEvent.Reconnected, () => {
      if (!cancelled) setS({ kind: 'connected' });
    });

    setS({ kind: 'connecting' });
    setPublisher('waiting');
    setFirstFramePainted(false);
    setPublisherReconnecting(false);
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
      // #1/#8 — drop any pending grace + auto-reconnect timer so a torn-down panel
      // can't flip publisher state or schedule a stray reconnect after unmount.
      clearPublisherLostTimer();
      if (autoReconnectTimer !== null) clearTimeout(autoReconnectTimer);
      // #5/#9 — drop the publication handle so a stray recovery toggle can't fire on a
      // torn-down room (a fresh connect re-stashes it on the next TrackSubscribed).
      videoPublicationRef.current = null;
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

  // Adaptive receiver jitter buffer (founder 2026-07-03: "streaming sometimes
  // majorly unresponsive … loss 2.4%, jitter 18ms, freezes 43 … tapping does
  // nothing"). TrackSubscribed starts the track at setPlayoutDelay(0) for the
  // lowest input→pixel latency, which is right on a clean link but turns every
  // loss/jitter spike into a visible FREEZE on a bad one. This closed loop
  // samples the live RTP stats each tick and nudges the playout delay UP under
  // stress (a buffer to ride out the hiccups) and back toward 0 when the link
  // is calm again — smoothness when the network is bad, latency when it's good.
  // Read-only sampling + a single setPlayoutDelay() call; never touches input.
  useEffect(() => {
    if (room === null) return;
    let cancelled = false;
    let prevFreeze = 0;
    let delay = 0;
    const tick = (): void => {
      if (cancelled) return;
      const track = remoteVideoTrackRef.current;
      if (track === null || typeof track.getRTCStatsReport !== 'function') return;
      void Promise.resolve(track.getRTCStatsReport())
        .then((report) => {
          if (cancelled || report === undefined) return;
          const s = parseConnectionStats(report);
          const freezeDelta = s.freezeCount !== null ? Math.max(0, s.freezeCount - prevFreeze) : 0;
          if (s.freezeCount !== null) prevFreeze = s.freezeCount;
          delay = nextPlayoutDelay(delay, {
            freezeDelta,
            packetLossPct: s.packetLossPct,
            jitterMs: s.jitterMs,
          });
          // Re-apply every tick (idempotent): a TrackSubscribed on a freeze
          // resubscribe resets the track to 0, so re-asserting keeps the buffer.
          try {
            track.setPlayoutDelay?.(delay);
          } catch {
            /* setPlayoutDelay unsupported — ignore */
          }
        })
        .catch(() => undefined);
    };
    const handle = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [room]);

  // #5/#9 — perform the recovery action the simulator's freeze driver requests. We
  // react to each DISTINCT recoverAction.nonce exactly once (the last-handled nonce
  // is tracked in a ref so a re-render with the same nonce never re-fires, and the
  // inert initial nonce 0 never triggers). 'resubscribe' toggles the remote video
  // subscription off→on — the browser auto-sends a PLI on re-subscribe, forcing the
  // SFU/encoder to emit a fresh keyframe (the GUI lever for a wedged decoder / a
  // stream the SFU stopped delivering). 'rebuild' (the driver's single escalation
  // when the resubscribe didn't restore frame progress) bumps retryNonce → the
  // connect effect tears down + reconnects the whole Room. All calls are guarded:
  // an absent publication / an older livekit-client without setSubscribed just no-ops.
  const lastRecoverNonceRef = useRef(0);
  useEffect(() => {
    const action = recoverAction;
    if (action === undefined || action.nonce === 0) return;
    if (action.nonce === lastRecoverNonceRef.current) return;
    lastRecoverNonceRef.current = action.nonce;
    // P1a — never perform a recovery (resubscribe / Room rebuild) once the session
    // has terminally ended; a rebuild would reconnect a fresh Room against a gone
    // session. The parent's freeze driver is already gated on the same flag, so this
    // is a defensive belt against a stale nonce racing the terminal latch.
    if (sessionEndedRef.current !== null) return;
    if (action.mode === 'rebuild') {
      setRetryNonce((n) => n + 1);
      return;
    }
    // 'resubscribe' — off then back on after a short beat so the SFU registers the
    // unsubscribe before the re-subscribe (a same-tick toggle can collapse to a no-op).
    // Hold the publication in the CLOSURE, not via videoPublicationRef, for the
    // re-subscribe leg: `setSubscribed(false)` makes livekit-client fire
    // RoomEvent.TrackUnsubscribed, whose handler NULLS videoPublicationRef.current —
    // so reading the ref 250ms later would find null and the re-subscribe would silently
    // no-op, leaving the stream unsubscribed (the freeze never clears, recovery is dead).
    // The captured `pub` is the same RemoteTrackPublication object livekit re-uses across
    // an unsub→resub on the same track, so setSubscribed(true) re-establishes it.
    const pub = videoPublicationRef.current;
    if (pub?.setSubscribed === undefined) return;
    try {
      pub.setSubscribed(false);
    } catch {
      /* publication detached mid-toggle — ignore */
    }
    const resubHandle = setTimeout(() => {
      try {
        pub.setSubscribed?.(true);
      } catch {
        /* publication detached mid-toggle — ignore */
      }
    }, 250);
    return () => clearTimeout(resubHandle);
  }, [recoverAction]);

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
      ref={containerRef}
      onPointerDown={(e) => {
        // Optimistic tap ripple (#124): fire ONLY on a direct pointerdown on the
        // live <video> while interactive. A terminal/reconnecting overlay is a
        // higher-z child, so `e.target` is that overlay (not the video) and no
        // ripple shows over it — matching where a real tap is actually accepted.
        // Purely visual: useInputCapture (attached to the same <video>) still
        // owns the real InputEvent; this only masks the input→publish round-trip.
        if (!interactive || room === null || e.target !== videoRef.current) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return; // no coords → nothing to place
        const id = (rippleIdRef.current += 1);
        // Cap the concurrent ring so a rapid tap storm can't unbound the array.
        setRipples((prev) => [...prev.slice(-4), { id, x, y }]);
        window.setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 500);
      }}
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
            // Real dims drive the parent's window resize (the FIRST-frame fit). Later
            // intrinsic changes reach the parent via the `resize` listener effect above,
            // so a steady-state aspect that settles after this first frame still re-fits
            // the screen-host. This does NOT change the panel's own box aspect (that's the
            // `aspectRatio` prop the simulator drives — see effectiveAspectRatio).
            onVideoDimensions?.(el.videoWidth, el.videoHeight);
          }
        }}
      />
      {/* Optimistic tap ripples (#124) — sit above the <video> (z-15) but below
          every terminal/reconnecting overlay (z-20+), so they never draw over a
          "Session ended" / "Switching…" state. */}
      {ripples.map((r) => (
        <TapRipple key={r.id} x={r.x} y={r.y} />
      ))}
      {/* Chrome-band masks REMOVED (A3 84de32ad4d content-only per-archetype fork on
          box mac-macstadium-us-001): the old fork baked a ~110px bottom + ~50px top
          bezel-black band into the capture (it hid the iOS-Safari URL bar but kept the
          714px web-view inside an 838px window → scalesToFit letterbox + freed-chrome
          reserve). The new fork sizes the captured window PER archetype so the web
          content fills the frame edge-to-edge with NO bands — masking it now covers
          REAL content (founder's "black space at the bottom + content cut off at the
          top"). `coverChromeBand` is kept as an inert prop for call-site compatibility. */}
      {/* P1a — TERMINAL "Session ended" overlay. The box session actually ended (the
          worker browser closed, the session was destroyed/errored, the orphan sweeper
          reaped it). This is the SINGLE source of truth when terminal: it renders on
          top of (and suppresses, via the `sessionEnded === null` guards below) every
          reconnecting/launch-failed/disconnected overlay so the founder sees a clear
          ended state with a Close action — NOT an endless "reconnecting" against a
          session that's gone. */}
      {/* About:blank placeholder while a tab switch is in flight (founder #5 2026-06-30:
          "keeps showing the old tab, no about:blank"). The box takes a beat to publish the
          NEW tab's page; until then the video still shows the OLD tab. Cover it with a clean
          white blank (like iOS Safari's blank tab) so the old tab never lingers — it clears
          the instant the new page's first page_state arrives (switching → false). Sits below
          the terminal "Session ended" overlay (z-30) so a real end always wins. */}
      {sessionEnded === null && switching && (
        <div
          data-overlay="tab-switching"
          className="absolute inset-0 z-20 flex items-center justify-center bg-white"
        >
          <span className="text-[11px] font-medium tracking-wide text-black/30">Switching…</span>
        </div>
      )}
      {sessionEnded !== null && (
        <div
          data-overlay="session-ended"
          {...(sessionEnded.reason !== null ? { 'data-reason': sessionEnded.reason } : {})}
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center text-sm text-ink-primary"
        >
          <svg
            viewBox="0 0 24 24"
            width="28"
            height="28"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-ink-secondary"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9 9l6 6M15 9l-6 6" />
          </svg>
          <span className="font-medium">Session ended</span>
          <div
            data-component="session-end-recap"
            className="grid w-full max-w-xs grid-cols-2 gap-2"
          >
            <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              <span className="block text-[10px] uppercase tracking-wide text-ink-secondary">
                Session length
              </span>
              <span data-summary="session-duration" className="mt-0.5 block text-xs font-medium">
                {sessionDuration}
              </span>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              <span className="block text-[10px] uppercase tracking-wide text-ink-secondary">
                Finished
              </span>
              <span data-summary="session-outcome" className="mt-0.5 block text-xs font-medium">
                {friendlySessionEndReason(sessionEnded.reason)}
              </span>
            </div>
          </div>
          <span className="max-w-xs text-xs text-ink-secondary">
            {sessionEnded.reason === 'idle_timeout'
              ? 'This session was closed after a period of inactivity.'
              : 'This session has stopped — the browser on the worker closed.'}{' '}
            {/* #8 — concrete next step instead of a dead-end. The standalone Simulator
                window can't relaunch in place (it holds only the per-session control key,
                not the account API key/SDK client a fresh session+token needs — that lives
                in the main app's keychain, and launch is driven from there). So tell the
                founder exactly where to go: close this window, then relaunch from the main
                Driftstack window. */}
            Close this window, then relaunch the profile from the main Driftstack window to get a
            fresh live view.
          </span>
          {onClose !== undefined && (
            <button
              type="button"
              data-action="close-ended-session"
              onClick={onClose}
              className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:bg-white/20"
            >
              Close
            </button>
          )}
        </div>
      )}
      {/* #1 — CALM reconnecting pill during the post-track-drop grace window. The
          track briefly dropped (A3 idle frame-pump down-clock / encoder restart /
          short SFU re-negotiation); the last good frame is still visible underneath,
          so we show a small unobtrusive pill — NOT the full-screen launch-failed
          alarm — until either the track re-arrives (cleared) or the grace expires
          (→ the honest overlay below). Mirrors the simulator's frozen/stalled badge
          treatment. P1a: suppressed when the session has terminally ended (the
          terminal overlay above is the single source of truth). */}
      {sessionEnded === null &&
        state.kind === 'connected' &&
        publisherReconnecting &&
        publisher === 'publishing' && (
          <div
            role="status"
            data-overlay="publisher-reconnecting"
            className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-[11px] font-medium text-white shadow-lg backdrop-blur"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            Reconnecting…
          </div>
        )}
      {/* W617 — connected but nothing publishing: waiting spinner first,
          then the honest no-worker overlay with the parent's fallback. P1a:
          suppressed when terminally ended (the "Session ended" overlay wins). */}
      {/* ww5k0xkmx — ALSO held while 'publishing' until the first frame decodes,
          so the cold-start gap between TrackSubscribed and the first keyframe
          shows the starting spinner instead of a silent black pane. */}
      {sessionEnded === null &&
        state.kind === 'connected' &&
        (publisher !== 'publishing' || !firstFramePainted) && (
          <div
            data-overlay="publisher-state"
            data-state={publisher}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center text-sm text-ink-primary"
          >
            {publisher === 'waiting' || publisher === 'publishing' ? (
              <>
                <span
                  className="h-7 w-7 animate-spin rounded-full border-2 border-white/25 border-t-white/90"
                  aria-hidden="true"
                />
                <span>
                  {publisher === 'publishing'
                    ? 'Almost there — the video stream is arriving…'
                    : 'Connected — starting the browser… a cold start can take a few seconds.'}
                </span>
              </>
            ) : (
              <>
                <span>
                  Couldn’t show the live view — the stream connected, but no video arrived from the
                  automation device. The task itself may still have run; this is usually temporary,
                  so press Retry. If it keeps happening, the device’s screen capture may need
                  attention.
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
                      // #8 — a USER-initiated retry grants a fresh auto-reconnect
                      // budget (1s→3s→9s) if the new connection later drops.
                      autoReconnectAttemptRef.current = 0;
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
      {/* P1a — suppressed when terminally ended so a Disconnected/error never shows
          the looping "reconnecting…" / Reconnect overlay over a session that's gone;
          the "Session ended" overlay above is the single source of truth. */}
      {sessionEnded === null && state.kind !== 'connected' && (
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
              className="text-status-error"
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
                // #8 — a USER-initiated reconnect grants a fresh auto-reconnect
                // budget (1s→3s→9s) if the new connection later drops.
                autoReconnectAttemptRef.current = 0;
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
