// Recordings list — index of in-memory recordings.
//
// Recordings live until the app closes (see lib/recordings.tsx). The
// playback view is reached by clicking a row.

import { RelativeTime } from '../components/RelativeTime';
import {
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  useRecordings,
} from '../lib/recordings';

export interface RecordingsViewProps {
  onOpen: (recordingId: string) => void;
}

export function RecordingsView({ onOpen }: RecordingsViewProps): JSX.Element {
  const { recordings, deleteRecording, loading } = useRecordings();
  const list = Array.from(recordings.values()).sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Sessions</span>
          <h2 className="text-lg font-medium tracking-tight">
            <span className="bg-gradient-to-br from-ink-primary via-ink-primary to-glow-red bg-clip-text text-transparent">
              Recordings
            </span>
            <span className="ml-2 mono text-ink-muted">{list.length}</span>
          </h2>
          <p className="text-2xs text-ink-muted">
            Recordings live in memory until the app restarts. Persistence to disk lands in a
            follow-up phase.
          </p>
        </div>
      </header>

      {list.length === 0 ? (
        <Empty loading={loading} />
      ) : (
        <div className="overflow-auto rounded border border-surface-divider">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-divider bg-surface-elevated text-left">
                <Th>Session</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Frames</Th>
                <Th>Size</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const live = r.endedAt === null;
                const totalBytes = recordingTotalBytes(r);
                return (
                  <tr
                    key={r.id}
                    className="border-b border-surface-divider last:border-0 hover:bg-surface-elevated/40"
                  >
                    <Td>
                      <span className="mono text-ink-secondary">{r.sessionId}</span>
                    </Td>
                    <Td>
                      <span className="text-ink-muted">
                        <RelativeTime
                          iso={new Date(r.startedAt).toISOString()}
                          tooltipPrefix="Started"
                        />
                      </span>
                    </Td>
                    <Td>
                      <span className="mono">
                        {formatDuration(recordingDurationMs(r))}
                        {live && <span className="ml-1.5 text-status-busy">live</span>}
                      </span>
                    </Td>
                    <Td>
                      <span className="mono text-ink-secondary">
                        {r.hydrated && r.frames.length === 0 ? r.frameCount : r.frames.length}
                        {r.totalCaptured > Math.max(r.frames.length, r.frameCount) && (
                          <span className="ml-1 text-ink-muted">/ {r.totalCaptured}</span>
                        )}
                      </span>
                    </Td>
                    <Td>
                      <span className="mono text-ink-muted">
                        {(totalBytes / 1024 / 1024).toFixed(1)} MB
                      </span>
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => onOpen(r.id)}
                          disabled={r.frames.length === 0}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => void deleteRecording(r.id)}
                          disabled={live}
                          title={live ? 'Stop recording before deleting' : undefined}
                        >
                          Delete
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Empty({ loading }: { loading: boolean }): JSX.Element {
  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-surface-divider px-8 py-12 text-center">
        <span className="section-label">Loading recordings…</span>
        <p className="max-w-md text-sm text-ink-secondary">
          Reading the recordings index from disk.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded border border-dashed border-surface-divider px-8 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-subtle text-accent">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-ink-primary">No recordings yet</h3>
        <p className="max-w-md text-sm text-ink-secondary">
          Recordings capture every frame of a live session for replay + audit. Open a live session,
          click <span className="mono">Record</span>, and frames stream into memory while the
          session runs.
        </p>
      </div>
      <p className="text-xs text-ink-muted">
        Recordings live in memory until the app restarts. Persistence to disk lands in a follow-up
        phase.
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }): JSX.Element {
  return <th className="px-3 py-2 section-label">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }): JSX.Element {
  return <td className="px-3 py-2 align-middle text-sm">{children}</td>;
}
