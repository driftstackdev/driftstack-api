// Live session viewport — polling-based.
//
// Polls `client.sessions.capture({kind:'screenshot'})` at ~500ms per
// frame and renders the base64 PNG in an <img>. Architecturally this
// is the right place to start before committing to WebRTC: it lets us
// exercise the input event forwarding (GUI4) + session control loop +
// recording architecture (GUI6) against today's API surface, with no
// server-side streaming dependency.
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
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError } from '../lib/client';

const FRAME_INTERVAL_MS = 500;

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
}

export interface LiveSessionViewProps {
  sessionId: string;
  onBack: () => void;
}

export function LiveSessionView({ sessionId, onBack }: LiveSessionViewProps): JSX.Element {
  const { client } = useSettings();
  const [state, setState] = useState<ViewportState>({
    currentUrl: null,
    currentTitle: null,
    frame: null,
    paused: false,
    loading: false,
    error: null,
    fpsActual: 0,
  });
  // Refs avoid restarting the interval every state mutation.
  const pausedRef = useRef(false);
  const intervalIdRef = useRef<number | null>(null);
  const frameTimestampsRef = useRef<number[]>([]);

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
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: friendlyError(err),
      }));
    }
  }, [client, sessionId]);

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

  async function handleDestroy(): Promise<void> {
    if (!client) return;
    try {
      await destroyAndExit(client, sessionId);
      onBack();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    }
  }

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
    <div className="flex h-full flex-col gap-3 p-6">
      <Header
        sessionId={sessionId}
        currentUrl={state.currentUrl}
        currentTitle={state.currentTitle}
        paused={state.paused}
        fps={state.fpsActual}
        onBack={onBack}
        onTogglePause={togglePause}
        onRefresh={() => void fetchFrame()}
        onDestroy={() => void handleDestroy()}
      />

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      <Viewport frame={state.frame} loading={state.loading} />

      <Footer frame={state.frame} fps={state.fpsActual} paused={state.paused} />
    </div>
  );
}

// ─── subcomponents ────────────────────────────────────────────────

interface HeaderProps {
  sessionId: string;
  currentUrl: string | null;
  currentTitle: string | null;
  paused: boolean;
  fps: number;
  onBack: () => void;
  onTogglePause: () => void;
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
        <button type="button" className="btn-danger" onClick={props.onDestroy}>
          Destroy
        </button>
      </div>
    </header>
  );
}

function Viewport({ frame, loading }: { frame: FrameState | null; loading: boolean }): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden rounded border border-surface-divider bg-black">
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
          className="max-h-full max-w-full object-contain"
          // No `loading="lazy"` — we always want the latest frame
          // visible, and lazy loading would prevent the displayed
          // frame from updating off-screen.
        />
      )}
    </div>
  );
}

function Footer({
  frame,
  fps,
  paused,
}: {
  frame: FrameState | null;
  fps: number;
  paused: boolean;
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
      </div>
      {frame !== null && (
        <div className="mono">
          {(frame.bytes / 1024).toFixed(1)} KB · capture {frame.durationMs} ms
        </div>
      )}
    </footer>
  );
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 rounded border border-status-error/30 bg-status-error/10 px-3 py-2">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="section-label text-status-error/80">Error</span>
        <span className="text-sm text-ink-primary truncate">{message}</span>
      </div>
      <button type="button" className="btn-secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
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

function friendlyError(err: unknown): string {
  if (err instanceof DriftstackError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}
