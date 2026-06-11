// Live session viewport — polling-based, with input forwarding.
//
// Polls `client.sessions.capture({kind:'screenshot'})` at ~500ms per
// frame and renders the base64 PNG in an <img>. When manual control
// is on, clicks/scrolls/keystrokes on the viewport translate to
// `client.sessions.interact()` calls so the founder can drive a real
// session through the GUI without the WebKit-fork dev tools.
//
// GUI4 input mapping:
//   - click on img            → { kind: 'tap_at', x, y } in viewport px
//   - wheel on img            → { kind: 'scroll', delta_x, delta_y }
//   - non-printable keys      → { kind: 'press', key }
//   - printable chars         → { kind: 'type_focused', text }
//
// Coord translation: img is rendered with `object-contain` against a
// flex container, so its bounding rect IS the rendered image area
// (width/height match natural × scale). Click x within the rect maps
// linearly to viewport px via `naturalWidth / rect.width`.
//
// Trade-offs we're accepting at 2 fps over HTTP/JSON-base64:
//   - ~50-200 KB per frame on the wire (base64 over HTTP).
//   - Latency floor of ~500ms request RTT + capture compute, which
//     means input → visible-effect lag is ~1s end-to-end. Bearable for
//     debugging, painful for real interactive control. WebRTC (or a
//     binary stream over WebSocket) closes that gap when GUI3+
//     justifies the server work.
//   - Polling pauses when the view unmounts AND when the user clicks
//     "Pause", so an idle window never burns rate-limit.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Driftstack } from '@driftstack/sdk';
import { ErrorBanner } from '../components/ErrorBanner';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError } from '../lib/client';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { GUIInputError, sendGUIInput, type GUIInputAction } from '../lib/gui-input';
import { SessionTabStrip } from '../components/SessionTabStrip';
import { useRecordings } from '../lib/recordings';

const FRAME_INTERVAL_MS = 500;

// Keys we forward as `press` (non-printable). Anything else printable
// goes through `type_focused`. This mirrors the InteractActionSchema in
// @driftstack/api-types — the union of {press,type_focused} covers
// every keyboard input.
const PRESS_KEYS = new Set([
  'Enter',
  'Escape',
  'Backspace',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
]);

interface FrameState {
  pngDataUrl: string | null;
  bytes: number;
  capturedAt: number;
  durationMs: number;
}

// W616 — page lifecycle from GET /state (W615 server field): the GUI's
// loading bar + "site couldn't be reached" overlay render from this.
interface PageStateInfo {
  state: 'loading' | 'loaded' | 'errored';
  error?: {
    kind: 'http' | 'tls' | 'dns' | 'net' | 'timeout';
    http_status?: number;
    message: string;
  };
}

interface ViewportState {
  currentUrl: string | null;
  currentTitle: string | null;
  frame: FrameState | null;
  paused: boolean;
  loading: boolean;
  error: string | null;
  fpsActual: number; // measured from the last 4 frame intervals
  manualControl: boolean;
  lastTap: { x: number; y: number; at: number } | null;
  /** W616 — null until the driver/harness reports a lifecycle event. */
  pageState: PageStateInfo | null;
}

export interface LiveSessionViewProps {
  sessionId: string;
  onBack: () => void;
  /** W609 — tab strip: switch the live view to another concurrent session. */
  onSwitchSession: (sessionId: string) => void;
  /** W609 — tab strip "+": launch another phone (routes to Profiles). */
  onNewTab: () => void;
}

export function LiveSessionView({
  sessionId,
  onBack,
  onSwitchSession,
  onNewTab,
}: LiveSessionViewProps): JSX.Element {
  const { client, settings } = useSettings();
  const { startRecording, stopRecording, addFrame, activeRecordingFor } = useRecordings();
  const recordingId = activeRecordingFor(sessionId);
  const recordingIdRef = useRef<string | null>(recordingId);
  recordingIdRef.current = recordingId;
  const [state, setState] = useState<ViewportState>({
    currentUrl: null,
    currentTitle: null,
    frame: null,
    paused: false,
    loading: false,
    error: null,
    fpsActual: 0,
    manualControl: false,
    lastTap: null,
    pageState: null,
  });
  // W608 — device-frame bezel preference, persisted so power users who turn
  // it off for debugging keep the bare image across app restarts.
  const [deviceFrame, setDeviceFrame] = useState(
    () => localStorage.getItem('ds_gui_device_frame') !== 'off',
  );
  const toggleDeviceFrame = useCallback((): void => {
    setDeviceFrame((on) => {
      localStorage.setItem('ds_gui_device_frame', on ? 'off' : 'on');
      return !on;
    });
  }, []);
  // Refs avoid restarting the interval every state mutation.
  const pausedRef = useRef(false);
  const intervalIdRef = useRef<number | null>(null);
  // Skip overlapping captures: the poll runs on a FIXED setInterval, but a
  // screenshot capture can outlast FRAME_INTERVAL_MS. Without this guard a slow
  // endpoint stacks concurrent captures every tick (server load + out-of-order
  // frames). Mirrors createPollingFrameStream's fetchInFlight guard.
  const fetchInFlightRef = useRef(false);
  const frameTimestampsRef = useRef<number[]>([]);
  // W616 — interval tick counter driving the every-10th-tick meta refresh.
  const frameCounterRef = useRef(0);
  const manualControlRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const fetchFrame = useCallback(async (): Promise<void> => {
    if (!client) return;
    if (pausedRef.current) return;
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;

    setState((s) => ({ ...s, loading: true }));
    try {
      const cap = await client.sessions.capture(sessionId, { kind: 'screenshot' });
      // capture() returns base64 in `data` field with encoding='base64'.
      const dataUrl = `data:image/png;base64,${cap.data}`;

      const now = Date.now();
      frameTimestampsRef.current.push(now);
      // Keep the last 4 timestamps for the fps moving average.
      while (frameTimestampsRef.current.length > 4) frameTimestampsRef.current.shift();
      const fps = computeFps(frameTimestampsRef.current);

      setState((s) => ({
        ...s,
        loading: false,
        error: null,
        fpsActual: fps,
        frame: {
          pngDataUrl: dataUrl,
          bytes: cap.byte_size,
          capturedAt: now,
          durationMs: cap.duration_ms,
        },
      }));

      // If recording is active for this session, append the frame.
      const recId = recordingIdRef.current;
      if (recId !== null) {
        addFrame(recId, { at: now, dataUrl, bytes: cap.byte_size });
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: friendlyError(err, settings.baseUrl),
      }));
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [client, sessionId, addFrame]);

  const fetchSessionMeta = useCallback(async (): Promise<void> => {
    if (!client) return;
    // Tolerate failure here — capture is the load-bearing call.
    try {
      const st = await client.sessions.getState(sessionId);
      setState((s) => ({
        ...s,
        currentUrl: st.url,
        currentTitle: st.title,
        // W616 — page lifecycle (W615 server field). Older self-hosted
        // servers don't send it; treat absent as null.
        pageState: (st as { page_state?: PageStateInfo | null }).page_state ?? null,
      }));
    } catch {
      // Swallow — we still render frames even without state metadata.
    }
  }, [client, sessionId]);

  // W607 — browser-chrome navigation. The URL bar (Enter) + Reload button both
  // drive the existing navigate intent; reload re-navigates the current URL.
  // After navigating we refetch meta + a frame so the chrome + viewport reflect
  // the new page promptly (the poll would catch up anyway, but this is snappier).
  const navigateTo = useCallback(
    async (rawUrl: string): Promise<void> => {
      if (!client) return;
      const url = rawUrl.trim();
      if (url.length === 0) return;
      // Be forgiving: a bare host (example.com) gets https://.
      const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        await client.sessions.navigate(sessionId, { url: target });
        await fetchSessionMeta();
        await fetchFrame();
      } catch (err) {
        const diag = diagnosticFetchError(err, settings.baseUrl);
        setState((s) => ({
          ...s,
          loading: false,
          error: diag ?? (err instanceof Error ? err.message : 'Navigation failed.'),
        }));
      }
    },
    [client, sessionId, fetchSessionMeta, fetchFrame, settings.baseUrl],
  );

  // Mount: fetch session meta + start frame polling.
  useEffect(() => {
    void fetchSessionMeta();
    // First frame as soon as possible, then on interval.
    void fetchFrame();
    intervalIdRef.current = window.setInterval(() => {
      void fetchFrame();
      // W616 — refresh meta (url/title/page_state) every 10th tick (~5s).
      // NOT per-frame: getState records a state_capture usage event server-
      // side, so a 2/s meta poll would spam the customer's usage meter.
      // Skipped while paused (no usage burn on an idle window).
      frameCounterRef.current += 1;
      if (!pausedRef.current && frameCounterRef.current % 10 === 0) {
        void fetchSessionMeta();
      }
    }, FRAME_INTERVAL_MS);
    return () => {
      if (intervalIdRef.current !== null) {
        window.clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
    };
  }, [fetchFrame, fetchSessionMeta]);

  function togglePause(): void {
    pausedRef.current = !pausedRef.current;
    setState((s) => ({ ...s, paused: pausedRef.current }));
  }

  function toggleManualControl(): void {
    manualControlRef.current = !manualControlRef.current;
    setState((s) => ({ ...s, manualControl: manualControlRef.current }));
    // Focus the wrapper so keyboard events route to it.
    if (manualControlRef.current && wrapperRef.current !== null) {
      wrapperRef.current.focus();
    }
  }

  function toggleRecording(): void {
    if (recordingId === null) {
      startRecording(sessionId);
    } else {
      void stopRecording(recordingId);
    }
  }

  async function handleDestroy(): Promise<void> {
    if (!client) return;
    try {
      await destroyAndExit(client, sessionId);
      onBack();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    }
  }

  // ─── input forwarding ─────────────────────────────────────────────
  //
  // Two planes per L-001 (docs/locked-decisions.md):
  //   - intent-only (scroll, press) → customer SDK `interact`
  //   - coordinate (tap_at, type_focused) → gui-control endpoint via
  //     sendGUIInput. The user's API key needs the `gui_control` scope
  //     for this to succeed; otherwise the server responds 403 and
  //     we surface that in the inline error banner.

  const interact = useCallback(
    async (action: IntentActionPayload): Promise<void> => {
      if (!client) return;
      try {
        await client.sessions.interact(sessionId, { action });
      } catch (err) {
        setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
      }
    },
    [client, sessionId],
  );

  const guiInput = useCallback(
    async (action: GUIInputAction): Promise<void> => {
      try {
        await sendGUIInput(settings, sessionId, action);
      } catch (err) {
        setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
      }
    },
    [settings, sessionId],
  );

  const handleImgClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>): void => {
      if (!manualControlRef.current) return;
      const img = e.currentTarget;
      const rect = img.getBoundingClientRect();
      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      if (naturalW === 0 || naturalH === 0 || rect.width === 0 || rect.height === 0) return;
      const x = Math.round(((e.clientX - rect.left) / rect.width) * naturalW);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * naturalH);
      setState((s) => ({ ...s, lastTap: { x, y, at: Date.now() } }));
      void guiInput({ kind: 'tap_at', x, y });
    },
    [guiInput],
  );

  const handleImgWheel = useCallback(
    (e: React.WheelEvent<HTMLImageElement>): void => {
      if (!manualControlRef.current) return;
      e.preventDefault();
      const dx = Math.round(e.deltaX);
      const dy = Math.round(e.deltaY);
      if (dx === 0 && dy === 0) return;
      void interact({ kind: 'scroll', delta_x: dx, delta_y: dy });
    },
    [interact],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      // Esc always backs out of the live view, even when manual control is on.
      if (!manualControlRef.current && e.key === 'Escape') {
        e.preventDefault();
        onBack();
        return;
      }
      if (!manualControlRef.current) return;
      // Esc inside manual control turns control off (less destructive than navigating away).
      if (e.key === 'Escape') {
        e.preventDefault();
        manualControlRef.current = false;
        setState((s) => ({ ...s, manualControl: false }));
        return;
      }
      // Ignore modifier-only events.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      // Don't hijack copy/paste/devtools shortcuts.
      if (e.metaKey || e.ctrlKey) return;
      if (PRESS_KEYS.has(e.key)) {
        e.preventDefault();
        void interact({ kind: 'press', key: e.key });
        return;
      }
      // Single printable character → type_focused (gui-control plane).
      if (e.key.length === 1) {
        e.preventDefault();
        void guiInput({ kind: 'type_focused', text: e.key });
      }
    },
    [interact, guiInput, onBack],
  );

  // Auto-focus the wrapper on mount so Esc + manual-control keys
  // route to it without needing an initial click.
  useEffect(() => {
    wrapperRef.current?.focus();
  }, []);

  if (!client) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="section-label">Not connected</span>
        <p className="text-sm text-ink-secondary">
          Set an API key under Settings to view this session.
        </p>
        <button type="button" className="btn-secondary" onClick={onBack}>
          Back to sessions
        </button>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex h-full flex-col gap-3 p-6 outline-none"
    >
      {/* W609 — browser-style tabs. v1 tabs = concurrent sessions (each
          tab is its own iPhone); see SessionTabStrip + the UX plan doc. */}
      <SessionTabStrip activeSessionId={sessionId} onSwitch={onSwitchSession} onNewTab={onNewTab} />
      <Header
        sessionId={sessionId}
        currentUrl={state.currentUrl}
        currentTitle={state.currentTitle}
        paused={state.paused}
        manualControl={state.manualControl}
        recording={recordingId !== null}
        fps={state.fpsActual}
        onBack={onBack}
        onTogglePause={togglePause}
        onToggleManualControl={toggleManualControl}
        onToggleRecording={toggleRecording}
        onRefresh={() => void fetchFrame()}
        onNavigate={(url) => void navigateTo(url)}
        onReload={() => {
          if (state.currentUrl !== null) void navigateTo(state.currentUrl);
        }}
        onDestroy={() => void handleDestroy()}
      />

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      <Viewport
        frame={state.frame}
        loading={state.loading}
        manualControl={state.manualControl}
        deviceFrame={deviceFrame}
        onToggleDeviceFrame={toggleDeviceFrame}
        pageState={state.pageState}
        onReloadPage={() => {
          if (state.currentUrl !== null) void navigateTo(state.currentUrl);
        }}
        lastTap={state.lastTap}
        onImgClick={handleImgClick}
        onImgWheel={handleImgWheel}
      />

      <Footer
        frame={state.frame}
        fps={state.fpsActual}
        paused={state.paused}
        manualControl={state.manualControl}
        lastTap={state.lastTap}
      />
    </div>
  );
}

// Intent-only interact payloads — coordinate primitives are on the
// gui-control plane (see GUIInputAction in lib/gui-input.ts).
type IntentActionPayload =
  | { kind: 'scroll'; delta_x: number; delta_y: number }
  | { kind: 'press'; key: string };

// ─── subcomponents ────────────────────────────────────────────────

interface HeaderProps {
  sessionId: string;
  currentUrl: string | null;
  currentTitle: string | null;
  paused: boolean;
  manualControl: boolean;
  recording: boolean;
  fps: number;
  onBack: () => void;
  onTogglePause: () => void;
  onToggleManualControl: () => void;
  onToggleRecording: () => void;
  onRefresh: () => void;
  onNavigate: (url: string) => void;
  onReload: () => void;
  onDestroy: () => void;
}

function Header(props: HeaderProps): JSX.Element {
  // W607 — editable URL bar. Local draft so the customer can type without the
  // poll-driven currentUrl clobbering keystrokes; resets to currentUrl when the
  // page actually changes underneath.
  const [draftUrl, setDraftUrl] = useState(props.currentUrl ?? '');
  const lastSyncedUrl = useRef(props.currentUrl);
  if (props.currentUrl !== lastSyncedUrl.current) {
    lastSyncedUrl.current = props.currentUrl;
    setDraftUrl(props.currentUrl ?? '');
  }
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <button
          type="button"
          onClick={props.onBack}
          className="self-start text-2xs text-ink-muted hover:text-ink-primary"
        >
          ← Sessions
        </button>
        {/* W607 — browser chrome: title + editable URL bar + reload. */}
        {props.currentTitle !== null && (
          <span className="truncate max-w-md text-sm text-ink-primary">{props.currentTitle}</span>
        )}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            props.onNavigate(draftUrl);
          }}
        >
          <button
            type="button"
            className="btn-secondary shrink-0 px-2"
            title="Reload the current page"
            aria-label="Reload"
            onClick={props.onReload}
          >
            ↻
          </button>
          <input
            type="text"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="example.com — type a URL, press Enter"
            spellCheck={false}
            autoComplete="off"
            aria-label="Address bar"
            className="mono w-full min-w-0 rounded-md border border-surface-divider bg-surface-base px-2 py-1 text-2xs text-ink-secondary"
          />
        </form>
        <h2 className="mono truncate text-2xs text-ink-muted">{props.sessionId}</h2>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button type="button" className="btn-secondary" onClick={props.onRefresh}>
          Refresh
        </button>
        <button type="button" className="btn-secondary" onClick={props.onTogglePause}>
          {props.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className={props.manualControl ? 'btn-primary' : 'btn-secondary'}
          onClick={props.onToggleManualControl}
          title="Forward clicks/scroll/keystrokes to the session"
        >
          {props.manualControl ? 'Control: on' : 'Control: off'}
        </button>
        <button
          type="button"
          className={props.recording ? 'btn-primary' : 'btn-secondary'}
          onClick={props.onToggleRecording}
          title="Capture polled frames into a recording"
        >
          {props.recording ? '● Recording' : 'Record'}
        </button>
        <button type="button" className="btn-danger" onClick={props.onDestroy}>
          Destroy
        </button>
      </div>
    </header>
  );
}

// W616 — friendly copy per page-error kind. The harness/driver supplies the
// kind; the GUI renders what a customer should DO about it.
function pageErrorCopy(err: NonNullable<PageStateInfo['error']>): string {
  switch (err.kind) {
    case 'dns':
      return "Couldn't find this site — check the address (DNS lookup failed).";
    case 'tls':
      return 'Secure connection failed — the site’s certificate could not be trusted.';
    case 'http':
      return `The site returned HTTP ${err.http_status ?? 'error'}.`;
    case 'timeout':
      return 'The site took too long to respond.';
    case 'net':
      return 'Network error while loading the page.';
  }
}

function Viewport({
  frame,
  loading,
  manualControl,
  deviceFrame,
  onToggleDeviceFrame,
  pageState,
  onReloadPage,
  lastTap,
  onImgClick,
  onImgWheel,
}: {
  frame: FrameState | null;
  loading: boolean;
  manualControl: boolean;
  deviceFrame: boolean;
  onToggleDeviceFrame: () => void;
  pageState: PageStateInfo | null;
  onReloadPage: () => void;
  lastTap: { x: number; y: number; at: number } | null;
  onImgClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  onImgWheel: (e: React.WheelEvent<HTMLImageElement>) => void;
}): JSX.Element {
  // Highlight the most recent tap for ~600 ms so the founder sees the
  // input registered even before the next frame paints over it.
  const tapAgeMs = lastTap !== null ? Date.now() - lastTap.at : Infinity;
  const showTapMarker = lastTap !== null && tapAgeMs < 600;
  // W613 — the bezel hugs the PHONE aspect instead of the whole pane (a
  // pane-shaped bezel reads as an iPad, founder-reported). Aspect comes
  // from the live frame's natural dimensions once the first frame loads
  // (nothing hardcoded per-archetype); until then a 9:19.5 placeholder.
  const [frameAspect, setFrameAspect] = useState<string | null>(null);
  return (
    // W608 — iOS device-frame treatment (toggleable): thick rounded phone
    // bezel + a pointer-events-none dynamic-island notch overlay. Purely
    // cosmetic — the <img> and TapMarker stay direct children of this
    // positioned container so the tap-projection math (img.parentElement
    // rect) is unchanged, and the bezel scales with the resizable window
    // because the img is object-contain inside an aspect-locked bezel.
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <div
        data-device-frame={deviceFrame ? 'on' : 'off'}
        style={deviceFrame ? { aspectRatio: frameAspect ?? '9 / 19.5' } : undefined}
        className={`relative flex items-center justify-center overflow-hidden bg-black ${
          deviceFrame
            ? 'h-full max-h-full max-w-full rounded-[2.25rem] border-[10px] shadow-2xl'
            : 'h-full w-full rounded border'
        } ${
          manualControl
            ? 'border-accent'
            : deviceFrame
              ? 'border-zinc-800'
              : 'border-surface-divider'
        }`}
      >
        {/* Dynamic-island notch — sits over the status-bar region like a real
          iPhone (the OS draws it over web content too); never intercepts taps. */}
        {deviceFrame && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-1/2 z-10 h-5 w-24 -translate-x-1/2 rounded-full bg-black/80"
          ></div>
        )}
        {/* W616 — thin top loading bar while the page is loading (local
            navigate in-flight OR the harness reports page_state loading). */}
        {(loading || pageState?.state === 'loading') && (
          <div
            data-overlay="page-loading"
            aria-hidden="true"
            className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden"
          >
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
        )}
        {/* W616 — honest page-error overlay (DNS/TLS/HTTP/timeout/net) with
            a Retry that re-navigates the current URL. */}
        {pageState?.state === 'errored' && pageState.error !== undefined && (
          <div
            data-overlay="page-error"
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center"
          >
            <span className="section-label text-status-error/80">Page failed to load</span>
            <span className="max-w-xs text-sm text-ink-primary">
              {pageErrorCopy(pageState.error)}
            </span>
            <button type="button" className="btn-secondary" onClick={onReloadPage}>
              Try again
            </button>
          </div>
        )}
        {/* Bare-image escape hatch for debugging (pixel-peeping a capture). */}
        <button
          type="button"
          onClick={onToggleDeviceFrame}
          title={deviceFrame ? 'Hide the phone bezel (bare image)' : 'Show the phone bezel'}
          aria-label={deviceFrame ? 'Hide device frame' : 'Show device frame'}
          className="absolute bottom-2 right-3 z-10 rounded-md bg-black/60 px-2 py-0.5 text-2xs text-ink-muted opacity-50 hover:opacity-100"
        >
          {deviceFrame ? 'Frame: on' : 'Frame: off'}
        </button>
        {frame === null ? (
          <div className="flex flex-col items-center gap-2 text-ink-muted">
            <span className="section-label">
              {loading ? 'Capturing first frame…' : 'No frame yet'}
            </span>
            <span className="text-2xs">First capture takes a beat — driver has to ack.</span>
          </div>
        ) : (
          <img
            src={frame.pngDataUrl ?? undefined}
            alt={`session viewport at ${new Date(frame.capturedAt).toLocaleTimeString()}`}
            className={`max-h-full max-w-full object-contain ${
              manualControl ? 'cursor-crosshair' : ''
            }`}
            onClick={onImgClick}
            onWheel={onImgWheel}
            onLoad={(e) => {
              // W613 — drive the bezel aspect from the capture itself.
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                const next = `${el.naturalWidth} / ${el.naturalHeight}`;
                setFrameAspect((prev) => (prev === next ? prev : next));
              }
            }}
            draggable={false}
            // No `loading="lazy"` — we always want the latest frame
            // visible, and lazy loading would prevent the displayed
            // frame from updating off-screen.
          />
        )}
        {showTapMarker && lastTap !== null && <TapMarker x={lastTap.x} y={lastTap.y} />}
      </div>
    </div>
  );
}

// Renders a small ring at the last tap location, projecting from
// natural-px (what we sent to the server) back to display-px (where it
// actually appeared on screen). We re-read the img's bounding rect at
// effect time so the marker tracks resizes between renders.
function TapMarker({ x, y }: { x: number; y: number }): JSX.Element | null {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="session viewport at"]');
    if (img === null) return;
    if (img.naturalWidth === 0 || img.naturalHeight === 0) return;
    const rect = img.getBoundingClientRect();
    const parent = img.parentElement?.getBoundingClientRect();
    if (parent === undefined) return;
    setPos({
      left: rect.left - parent.left + (x / img.naturalWidth) * rect.width,
      top: rect.top - parent.top + (y / img.naturalHeight) * rect.height,
    });
  }, [x, y]);
  if (pos === null) return null;
  return (
    <span
      className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent"
      style={{ left: pos.left, top: pos.top }}
    />
  );
}

function Footer({
  frame,
  fps,
  paused,
  manualControl,
  lastTap,
}: {
  frame: FrameState | null;
  fps: number;
  paused: boolean;
  manualControl: boolean;
  lastTap: { x: number; y: number; at: number } | null;
}): JSX.Element {
  return (
    <footer className="flex items-center justify-between text-2xs text-ink-muted">
      <div className="flex items-center gap-3">
        <span>polling every {FRAME_INTERVAL_MS} ms</span>
        {paused ? (
          <span className="text-status-busy">paused</span>
        ) : (
          <span className="mono">{fps.toFixed(1)} fps</span>
        )}
        {manualControl && (
          <span className="text-accent">
            control on
            {lastTap !== null && (
              <span className="mono ml-1 text-ink-muted">
                last tap ({lastTap.x}, {lastTap.y})
              </span>
            )}
          </span>
        )}
      </div>
      {frame !== null && (
        <div className="mono">
          {(frame.bytes / 1024).toFixed(1)} KB · capture {frame.durationMs} ms
        </div>
      )}
    </footer>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

async function destroyAndExit(client: Driftstack, sessionId: string): Promise<void> {
  await client.sessions.destroy(sessionId);
}

function computeFps(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  if (first === undefined || last === undefined) return 0;
  const elapsedMs = last - first;
  if (elapsedMs <= 0) return 0;
  return ((timestamps.length - 1) * 1000) / elapsedMs;
}

function friendlyError(err: unknown, baseUrl?: string): string {
  // 2026-05-20 — network-failure preflight. Catches the Tauri WebKit
  // "Load failed" / Chrome "Failed to fetch" / Firefox NetworkError
  // class of fetch errors before they reach the per-view fallthrough.
  if (baseUrl !== undefined) {
    const diag = diagnosticFetchError(err, baseUrl);
    if (diag !== null) return diag;
  }
  if (err instanceof GUIInputError) {
    if (err.status === 403) {
      return 'API key lacks gui_control scope — manual control is unavailable on this key.';
    }
    return err.message;
  }
  if (err instanceof DriftstackError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}
