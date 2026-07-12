import { useEffect, useMemo, useState } from 'react';
import {
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  type Recording,
} from '../lib/recordings';

export interface SimulatorRecordingPaneProps {
  recordings: ReadonlyMap<string, Recording>;
  recordingId: string | null;
  sessionAvailable: boolean;
  confirmingDeleteId: string | null;
  onToggleRecording: () => void;
  onExport: (recording: Recording) => void;
  onDelete: (recordingId: string) => void;
}

function formatRecordingBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Recording drawer content isolated from the live simulator host. Its one-second
 * elapsed clock updates this subtree only, instead of rerendering the video, tab
 * strip, browser chrome, and every other drawer pane in SimulatorWindow.
 */
export function SimulatorRecordingPane({
  recordings,
  recordingId,
  sessionAvailable,
  confirmingDeleteId,
  onToggleRecording,
  onExport,
  onDelete,
}: SimulatorRecordingPaneProps): JSX.Element {
  const activeRecording = recordingId !== null ? (recordings.get(recordingId) ?? null) : null;
  const isRecording = activeRecording !== null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording, recordingId]);

  const saved = useMemo(
    () =>
      Array.from(recordings.values())
        .filter((recording) => recording.id !== recordingId)
        .sort((a, b) => b.startedAt - a.startedAt),
    [recordingId, recordings],
  );
  const elapsedMs =
    activeRecording !== null
      ? Math.max(recordingDurationMs(activeRecording), now - activeRecording.startedAt)
      : 0;
  const liveFrames = activeRecording?.frames.length ?? 0;
  const liveBytes = activeRecording !== null ? recordingTotalBytes(activeRecording) : 0;

  return (
    <section data-component="drawer-recording" className="space-y-2.5 text-[11px] text-white/80">
      <div className="flex items-center gap-2 font-sans text-[11px] font-semibold text-white">
        <span>Recording</span>
        {isRecording && (
          <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold text-red-400">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]"
            />
            REC <span data-component="sim-recording-elapsed">{formatDuration(elapsedMs)}</span>
          </span>
        )}
      </div>

      <div
        className={`rounded-lg border p-3 ${
          isRecording ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-white/[0.10] bg-black/20'
        }`}
      >
        <button
          type="button"
          aria-label={isRecording ? 'Stop recording' : 'Start recording'}
          title={
            isRecording
              ? 'Stop and save the recording'
              : 'Capture the live session as frames you can replay or export'
          }
          disabled={!sessionAvailable}
          onClick={onToggleRecording}
          className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            isRecording
              ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
              : 'bg-white/5 text-white/90 hover:bg-white/10'
          }`}
        >
          <span
            aria-hidden="true"
            className={
              isRecording
                ? 'h-2.5 w-2.5 rounded-[2px] bg-red-400'
                : 'h-2.5 w-2.5 rounded-full bg-red-500'
            }
          />
          {isRecording ? 'Stop recording' : 'Start recording'}
        </button>
        <div
          className={`mt-2 text-center text-[10px] ${
            isRecording ? 'text-red-200/80' : 'text-white/40'
          }`}
        >
          {isRecording
            ? `${formatDuration(elapsedMs)} · ${liveFrames.toLocaleString()} frames · ${formatRecordingBytes(liveBytes)} · capturing…`
            : 'Capture the live session as frames you can replay or export'}
        </div>
      </div>

      <div className="mt-3 px-0.5 text-[10px] uppercase tracking-[0.04em] text-white/40">
        Saved recordings
        {saved.length > 0 && <span> · {saved.length}</span>}
      </div>
      {saved.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-white/40">No recordings yet.</div>
      ) : (
        <div className="space-y-2">
          {saved.map((recording) => {
            const frames =
              recording.frameCount > 0 ? recording.frameCount : recording.frames.length;
            const label = recording.label ?? 'Session recording';
            return (
              <div
                key={recording.id}
                data-component="sim-recording-row"
                className="flex items-center gap-2.5 rounded-lg border border-white/[0.10] bg-black/20 px-2.5 py-2"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-inset text-ink-secondary"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-semibold text-white">{label}</div>
                  <div className="truncate text-[10px] text-white/40">
                    {formatDuration(recordingDurationMs(recording))} · {frames.toLocaleString()}{' '}
                    frames · {formatRecordingBytes(recordingTotalBytes(recording))}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Export ${recording.label ?? 'recording'}`}
                  title="Export this recording as JSON"
                  onClick={() => onExport(recording)}
                  className="shrink-0 rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/80 transition-colors hover:bg-white/10"
                >
                  ⬇
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${recording.label ?? 'recording'}`}
                  title={
                    confirmingDeleteId === recording.id
                      ? 'Click again to permanently delete'
                      : 'Delete this recording'
                  }
                  onClick={() => onDelete(recording.id)}
                  className={`shrink-0 rounded border px-2 py-0.5 text-[11px] transition-colors ${
                    confirmingDeleteId === recording.id
                      ? 'border-red-400/70 bg-red-500/30 text-red-200'
                      : 'border-white/15 bg-white/5 text-white/60 hover:bg-red-500/20 hover:text-red-300'
                  }`}
                >
                  {confirmingDeleteId === recording.id ? 'Delete?' : '×'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
