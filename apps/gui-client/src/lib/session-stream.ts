// V-534.E — session stream source abstraction.
//
// LiveSessionView (apps/gui-client/src/views/LiveSessionView.tsx) currently
// embeds the polling-capture loop inline. V-534.E extracts that loop into
// a reusable, testable stream-source: caller hands in a `fetchFrame()`
// function, the module manages the interval, pause state, fps measurement,
// error reporting, and listener fan-out.
//
// Two implementations land here:
//
//   - `createPollingFrameStream(fetchFrame, opts)` — the polling source
//     LiveSessionView uses today. Drops in unchanged onto the existing
//     polling architecture.
//   - `createSseFrameStream(...)` and `createWebRtcFrameStream(...)`
//     placeholders — defer to a future slice. The polling impl is the
//     reference contract.
//
// Pure TypeScript — no React hook. The hook wrapper lands when
// LiveSessionView migrates onto this module.

export interface Frame {
  /** Base64-encoded PNG bytes, no data: prefix. */
  pngBase64: string;
  bytes: number;
  capturedAt: number;
  durationMs: number;
}

export type FrameStreamListener = (event: FrameStreamEvent) => void;

export type FrameStreamEvent =
  | { kind: 'frame'; frame: Frame; fpsActual: number }
  | { kind: 'error'; error: unknown }
  | { kind: 'paused' }
  | { kind: 'resumed' };

export interface FrameStream {
  /** Subscribe to stream events; returns an unsubscribe fn. */
  subscribe(listener: FrameStreamListener): () => void;
  /** Pause polling. Frames buffer at the source side; we don't queue them. */
  pause(): void;
  /** Resume polling. Triggers an immediate frame fetch. */
  resume(): void;
  /** Current paused state. */
  isPaused(): boolean;
  /** Latest computed fps (4-frame moving average). */
  getFpsActual(): number;
  /** Tear down — no more frames, listeners cleared. */
  stop(): void;
}

export interface PollingFrameStreamOpts {
  /** How often to request a frame (ms). Default 500. */
  intervalMs?: number;
  /** Initial paused state. Default false. */
  initialPaused?: boolean;
}

/**
 * Internal helper — used by both the stream impl and unit tests so the
 * fps math has a single source of truth.
 */
export function computeFps(timestamps: readonly number[]): number {
  if (timestamps.length < 2) return 0;
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  if (first === undefined || last === undefined) return 0;
  const dt = last - first;
  if (dt <= 0) return 0;
  // (n-1) intervals across (n) timestamps → frame rate = (n-1) / dt seconds.
  return Math.round(((timestamps.length - 1) / dt) * 1000 * 10) / 10;
}

/**
 * Create a polling-driven frame stream. Caller injects `fetchFrame`
 * (typically a wrapper around `client.sessions.capture()`). The stream
 * manages timing, pause/resume, fps, and listener fan-out.
 */
export function createPollingFrameStream(
  fetchFrame: () => Promise<Frame>,
  opts: PollingFrameStreamOpts = {},
): FrameStream {
  const intervalMs = opts.intervalMs ?? 500;
  const listeners = new Set<FrameStreamListener>();
  const frameTimestamps: number[] = [];
  let paused = opts.initialPaused ?? false;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let fpsActual = 0;
  let fetchInFlight = false;

  function emit(event: FrameStreamEvent): void {
    for (const l of listeners) l(event);
  }

  async function tick(): Promise<void> {
    if (stopped || paused) return;
    if (fetchInFlight) {
      // Skip overlapping fetches — slow capture endpoint shouldn't queue
      // up frames. Just schedule the next tick.
      schedule();
      return;
    }
    fetchInFlight = true;
    try {
      const frame = await fetchFrame();
      if (stopped) return;
      frameTimestamps.push(frame.capturedAt);
      while (frameTimestamps.length > 4) frameTimestamps.shift();
      fpsActual = computeFps(frameTimestamps);
      emit({ kind: 'frame', frame, fpsActual });
    } catch (err) {
      if (!stopped) emit({ kind: 'error', error: err });
    } finally {
      fetchInFlight = false;
      schedule();
    }
  }

  function schedule(): void {
    if (stopped || paused) return;
    handle = setTimeout(() => {
      void tick();
    }, intervalMs);
  }

  if (!paused) void tick();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pause() {
      if (paused) return;
      paused = true;
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
      emit({ kind: 'paused' });
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      emit({ kind: 'resumed' });
      void tick();
    },
    isPaused() {
      return paused;
    },
    getFpsActual() {
      return fpsActual;
    },
    stop() {
      stopped = true;
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
      listeners.clear();
    },
  };
}
