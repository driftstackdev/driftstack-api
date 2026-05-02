// Recording playback — timeline scrubber + play/pause.
//
// Plays back the in-memory frame buffer at the same wall-clock cadence
// they were captured (advances the cursor by real time, picks the
// frame whose `at` is the closest <= cursor). At 2 fps the playback
// looks like ~2 fps; if the underlying capture was bursty the
// playback honours that.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  useRecordings,
} from '../lib/recordings';

export interface RecordingPlayerViewProps {
  recordingId: string;
  onBack: () => void;
}

const TICK_MS = 100; // playback cursor advances at 10 Hz, frames pick the nearest

export function RecordingPlayerView({
  recordingId,
  onBack,
}: RecordingPlayerViewProps): JSX.Element {
  const { recordings } = useRecordings();
  const recording = recordings.get(recordingId) ?? null;

  // Cursor position in ms relative to recording.startedAt.
  const [cursorMs, setCursorMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const tickRef = useRef<number | null>(null);
  // Wall-clock anchor for the playback loop: { wallStart, cursorAtWallStart }
  const playStateRef = useRef<{ wallStart: number; cursorBase: number } | null>(null);

  const totalMs = useMemo(
    () => (recording !== null ? recordingDurationMs(recording) : 0),
    [recording],
  );

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

  // Pick the frame whose `at` is the latest <= recording.startedAt + cursorMs.
  const currentFrame = useMemo(() => {
    if (recording === null || recording.frames.length === 0) return null;
    const target = recording.startedAt + cursorMs;
    let chosen = recording.frames[0] ?? null;
    for (const f of recording.frames) {
      if (f.at <= target) chosen = f;
      else break;
    }
    return chosen;
  }, [recording, cursorMs]);

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
          <h2 className="text-sm text-ink-primary">
            <span className="mono">{recording.sessionId}</span>{' '}
            <span className="text-ink-muted">·</span>{' '}
            <span className="text-ink-secondary">
              {new Date(recording.startedAt).toLocaleString()}
            </span>
          </h2>
          <div className="flex items-center gap-3 text-2xs text-ink-muted">
            <span className="mono">{recording.frames.length} frames</span>
            <span>·</span>
            <span className="mono">
              {(recordingTotalBytes(recording) / 1024 / 1024).toFixed(1)} MB
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className="btn-primary" onClick={togglePlay}>
            {playing ? 'Pause' : cursorMs >= totalMs ? 'Replay' : 'Play'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center overflow-hidden rounded border border-surface-divider bg-black">
        {currentFrame === null ? (
          <span className="section-label text-ink-muted">No frames captured</span>
        ) : (
          <img
            src={currentFrame.dataUrl}
            alt={`recording frame at ${formatDuration(currentFrame.at - recording.startedAt)}`}
            className="max-h-full max-w-full object-contain"
          />
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
          className="flex-1 accent-accent"
        />
        <span className="mono w-12">{formatDuration(totalMs)}</span>
      </footer>
    </div>
  );
}
