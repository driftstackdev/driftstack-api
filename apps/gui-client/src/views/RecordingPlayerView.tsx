// Recording playback — timeline scrubber + play/pause.
//
// Plays back the in-memory frame buffer at the same wall-clock cadence
// they were captured (advances the cursor by real time, picks the
// frame whose `at` is the closest <= cursor). At 2 fps the playback
// looks like ~2 fps; if the underlying capture was bursty the
// playback honours that.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  useRecordings,
} from '../lib/recordings';
import { useToasts } from '../lib/toasts';
import { downloadJson } from '../lib/download';
import { buildRecordingExport, recordingExportFilename } from '../lib/recordings-export';

export interface RecordingPlayerViewProps {
  recordingId: string;
  onBack: () => void;
}

const TICK_MS = 100; // playback cursor advances at 10 Hz, frames pick the nearest

export function RecordingPlayerView({
  recordingId,
  onBack,
}: RecordingPlayerViewProps): JSX.Element {
  const { recordings, hydrateFrames } = useRecordings();
  const { push: pushToast } = useToasts();
  const recording = recordings.get(recordingId) ?? null;

  // Cursor position in ms relative to recording.startedAt.
  const [cursorMs, setCursorMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  // A frame-load FAILURE must read differently from a genuinely empty
  // recording: "No frames captured" implies the recording is fine but empty,
  // which is misleading when the read actually errored. Track it separately
  // and offer a retry.
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const tickRef = useRef<number | null>(null);
  // Wall-clock anchor for the playback loop: { wallStart, cursorBase }
  const playStateRef = useRef<{ wallStart: number; cursorBase: number } | null>(null);

  const loadFrames = useCallback((): void => {
    setHydrating(true);
    setHydrateError(null);
    void hydrateFrames(recordingId)
      .catch((err: unknown) => {
        setHydrateError(
          err instanceof Error ? err.message : 'Could not read the recording from disk.',
        );
      })
      .finally(() => setHydrating(false));
  }, [hydrateFrames, recordingId]);

  // Lazy-load frames the first time this player opens for a persisted recording.
  useEffect(() => {
    if (recording === null) return;
    if (!recording.hydrated || recording.frames.length > 0) return;
    loadFrames();
  }, [recording, loadFrames]);

  // Timeline anchor. A long capture can hit MAX_FRAMES_PER_RECORDING and drop
  // its oldest frames (ring buffer), so frames[0].at may be well AFTER
  // recording.startedAt while the header's startedAt→endedAt span is unchanged.
  // Basing the cursor/scrubber on startedAt would then leave the whole
  // pre-frames[0] stretch with no frame qualifying (currentFrame stays frozen
  // on frames[0]). Anchor instead on the first SURVIVING frame so the cursor
  // maps onto the range we can actually show. Fall back to startedAt/duration
  // for header-only stubs whose frames aren't hydrated yet.
  const effectiveStart = useMemo(() => {
    if (recording === null) return 0;
    return recording.frames[0]?.at ?? recording.startedAt;
  }, [recording]);

  const totalMs = useMemo(() => {
    if (recording === null) return 0;
    const frames = recording.frames;
    if (frames.length > 0) {
      const last = frames[frames.length - 1];
      return last !== undefined ? Math.max(0, last.at - effectiveStart) : 0;
    }
    // No frames in memory (header-only stub / genuinely empty) — use the
    // header-derived duration so the scrubber still spans the run.
    return recordingDurationMs(recording);
  }, [recording, effectiveStart]);

  const stopTick = useCallback((): void => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    playStateRef.current = null;
  }, []);

  const startTick = useCallback((): void => {
    stopTick();
    playStateRef.current = { wallStart: Date.now(), cursorBase: cursorMs };
    tickRef.current = window.setInterval(() => {
      const ps = playStateRef.current;
      if (ps === null) return;
      const elapsed = Date.now() - ps.wallStart;
      const next = ps.cursorBase + elapsed;
      if (next >= totalMs) {
        setCursorMs(totalMs);
        setPlaying(false);
        stopTick();
      } else {
        setCursorMs(next);
      }
    }, TICK_MS);
  }, [cursorMs, stopTick, totalMs]);

  useEffect(() => {
    if (playing) startTick();
    else stopTick();
    return stopTick;
  }, [playing, startTick, stopTick]);

  // Space toggles play/pause — but only when the keystroke isn't meant for a
  // text field. Without the typing guard, hitting Space while focused in an
  // input/textarea/contenteditable would both type a space AND hijack
  // playback, so we bail when an editable element holds focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== ' ' && e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable === true
      ) {
        return;
      }
      e.preventDefault();
      if (cursorMs >= totalMs) {
        // Restart from the beginning if we're at the end (mirrors togglePlay).
        setCursorMs(0);
        playStateRef.current = { wallStart: Date.now(), cursorBase: 0 };
      }
      setPlaying((p) => !p);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cursorMs, totalMs]);

  // Pick the frame whose `at` is the latest <= effectiveStart + cursorMs.
  // effectiveStart is the first surviving frame (see totalMs above), so cursor 0
  // maps onto frames[0] even when the front of the buffer was ring-trimmed.
  const currentFrame = useMemo(() => {
    if (recording === null || recording.frames.length === 0) return null;
    const target = effectiveStart + cursorMs;
    let chosen = recording.frames[0] ?? null;
    for (const f of recording.frames) {
      if (f.at <= target) chosen = f;
      else break;
    }
    return chosen;
  }, [recording, cursorMs, effectiveStart]);

  if (recording === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="section-label">Recording not found</span>
        <p className="text-sm text-ink-secondary">It may have been deleted or the app restarted.</p>
        <button type="button" className="btn-secondary" onClick={onBack}>
          Back to recordings
        </button>
      </div>
    );
  }

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>): void {
    const next = Number(e.target.value);
    setCursorMs(next);
    if (playing) {
      // Re-anchor the playback loop so the next tick measures from
      // the new cursor.
      playStateRef.current = { wallStart: Date.now(), cursorBase: next };
    }
  }

  // Export the open recording as a portable JSON envelope. Frames are already
  // hydrated by the time the player is interactive, so no async hydrate here.
  async function handleExport(): Promise<void> {
    if (recording === null || recording.frames.length === 0) return;
    const now = new Date();
    const stillLive = recording.endedAt === null;
    // AWAIT + gate on the CONFIRMED-write boolean: in the Tauri WKWebView the anchor
    // fallback writes NOTHING but returns true, so the unconditional (un-awaited)
    // "Exported" toast was a lie. Only claim success when the file actually landed.
    const saved = await downloadJson(
      recordingExportFilename(recording, now),
      buildRecordingExport(recording, now),
    );
    if (!saved) {
      pushToast({ title: 'Export failed', body: 'Could not save the file.', tone: 'error' });
      return;
    }
    // A still-recording session exports a partial envelope (endedAt:null + only
    // the frames captured so far). Be honest about that in the toast rather than
    // claiming a 'complete' export — the user might think they have the whole run.
    pushToast({
      title: stillLive ? 'Exported (still recording)' : 'Exported',
      body: stillLive
        ? `${recording.frames.length} frames captured so far — this recording is still live, so the export is a partial snapshot.`
        : `${recording.frames.length} frames saved as JSON.`,
      tone: stillLive ? 'warn' : 'success',
    });
  }

  function togglePlay(): void {
    if (cursorMs >= totalMs) {
      // Restart from the beginning if we're at the end.
      setCursorMs(0);
      playStateRef.current = { wallStart: Date.now(), cursorBase: 0 };
    }
    setPlaying((p) => !p);
  }

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="self-start text-2xs text-ink-muted hover:text-ink-primary"
          >
            ← Recordings
          </button>
          <h2
            className="truncate text-sm text-ink-primary"
            title={`${recording.sessionId} · ${new Date(recording.startedAt).toLocaleString()}`}
          >
            <span className="mono">{recording.sessionId}</span>{' '}
            <span className="text-ink-muted">·</span>{' '}
            <span className="text-ink-secondary">
              {new Date(recording.startedAt).toLocaleString()}
            </span>
          </h2>
          <div className="flex min-w-0 items-center gap-3 text-2xs text-ink-muted">
            <span className="mono truncate">{recording.frames.length} frames</span>
            <span>·</span>
            <span className="mono truncate">{formatBytes(recordingTotalBytes(recording))}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleExport()}
            disabled={recording.frames.length === 0}
            title="Download this recording as a JSON file"
          >
            Export
          </button>
          <button type="button" className="btn-primary" onClick={togglePlay}>
            {playing ? 'Pause' : cursorMs >= totalMs ? 'Replay' : 'Play'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center overflow-hidden rounded border border-surface-divider bg-black">
        {hydrating ? (
          <span className="section-label text-ink-muted">Loading frames…</span>
        ) : hydrateError !== null ? (
          <div className="flex flex-col items-center gap-3 px-8 text-center">
            <span className="section-label text-status-error">Couldn't load frames</span>
            <p className="max-w-sm text-xs text-ink-secondary">{hydrateError}</p>
            <button type="button" className="btn-secondary" onClick={loadFrames}>
              Try again
            </button>
          </div>
        ) : currentFrame === null ? (
          <span className="section-label text-ink-muted">No frames captured</span>
        ) : (
          // The frame itself is the play/pause hit target — click anywhere on it
          // (like a video player) and a center glyph surfaces the otherwise-hidden
          // Space shortcut on hover/paused.
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause playback' : 'Play recording'}
            className="group relative flex h-full w-full items-center justify-center"
          >
            <img
              src={currentFrame.dataUrl}
              alt={`recording frame at ${formatDuration(currentFrame.at - recording.startedAt)}`}
              className="max-h-full max-w-full object-contain"
            />
            <span
              className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 transition-opacity ${
                playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
              }`}
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/50 text-2xl text-white">
                {playing ? '❚❚' : '▶'}
              </span>
              <span className="rounded bg-black/50 px-2 py-0.5 text-2xs text-white">
                Space to play
              </span>
            </span>
          </button>
        )}
      </div>

      <footer className="flex items-center gap-3 text-2xs text-ink-muted">
        <span className="mono w-12 text-right">{formatDuration(cursorMs)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(totalMs, 1)}
          value={Math.min(cursorMs, totalMs)}
          step={TICK_MS}
          onChange={handleScrub}
          aria-label="Playback progress"
          className="flex-1 accent-accent"
        />
        <span className="mono w-12">{formatDuration(totalMs)}</span>
      </footer>
    </div>
  );
}
