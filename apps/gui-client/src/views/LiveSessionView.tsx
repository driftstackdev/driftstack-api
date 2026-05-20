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
}

export interface LiveSessionViewProps {
  sessionId: string;
  onBack: () => void;
}

export function LiveSessionView({ sessionId, onBack }: LiveSessionViewProps): JSX.Element {
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
  });
  // Refs avoid restarting the interval every state mutation.
  const pausedRef = useRef(false);
  const intervalIdRef = useRef<number | null>(null);
  const frameTimestampsRef = useRef<number[]>([]);
  const manualControlRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const fetchFrame = useCallback(async (): Promise<void> => {
    if (!client) return;
    if (pausedRef.current) return;

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
      }));
    } catch {
      // Swallow — we still render frames even without state metadata.
    }
  }, [client, sessionId]);

  // Mount: fetch session meta + start frame polling.
  useEffect(() => {
    void fetchSessionMeta();
    // First frame as soon as possible, then on interval.
    void fetchFrame();
    intervalIdRef.current = window.setInterval(() => void fetchFrame(), FRAME_INTERVAL_MS);
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
  onDestroy: () => void;
}

function Header(props: HeaderProps): JSX.Element {
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <button
          type="button"
          onClick={props.onBack}
          className="self-start text-2xs text-ink-muted hover:text-ink-primary"
        >
          ← Sessions
        </button>
        <h2 className="mono truncate text-sm text-ink-primary">{props.sessionId}</h2>
        <div className="flex items-center gap-3 text-2xs text-ink-muted">
          {props.currentTitle !== null && (
            <span className="truncate max-w-xs text-ink-secondary">{props.currentTitle}</span>
          )}
          {props.currentUrl !== null && (
            <span className="mono truncate max-w-md">{props.currentUrl}</span>
          )}
        </div>
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

function Viewport({
  frame,
  loading,
  manualControl,
  lastTap,
  onImgClick,
  onImgWheel,
}: {
  frame: FrameState | null;
  loading: boolean;
  manualControl: boolean;
  lastTap: { x: number; y: number; at: number } | null;
  onImgClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  onImgWheel: (e: React.WheelEvent<HTMLImageElement>) => void;
}): JSX.Element {
  // Highlight the most recent tap for ~600 ms so the founder sees the
  // input registered even before the next frame paints over it.
  const tapAgeMs = lastTap !== null ? Date.now() - lastTap.at : Infinity;
  const showTapMarker = lastTap !== null && tapAgeMs < 600;
  return (
    <div
      className={`relative flex flex-1 items-center justify-center overflow-hidden rounded border bg-black ${
        manualControl ? 'border-accent' : 'border-surface-divider'
      }`}
    >
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
          draggable={false}
          // No `loading="lazy"` — we always want the latest frame
          // visible, and lazy loading would prevent the displayed
          // frame from updating off-screen.
        />
      )}
      {showTapMarker && lastTap !== null && <TapMarker x={lastTap.x} y={lastTap.y} />}
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
