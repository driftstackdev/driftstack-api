// Recordings list — index of in-memory recordings.
//
// Recordings live until the app closes (see lib/recordings.tsx). The
// playback view is reached by clicking a row.

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
  const { recordings, deleteRecording } = useRecordings();
  const list = Array.from(recordings.values()).sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Sessions</span>
          <h2 className="text-lg font-medium text-ink-primary">
            Recordings
            <span className="ml-2 mono text-ink-muted">{list.length}</span>
          </h2>
          <p className="text-2xs text-ink-muted">
            Recordings live in memory until the app restarts. Persistence to disk lands in a
            follow-up phase.
          </p>
        </div>
      </header>

      {list.length === 0 ? (
        <Empty />
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
                      <span className="mono text-ink-muted">
                        {new Date(r.startedAt).toLocaleString()}
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
                        {r.frames.length}
                        {r.totalCaptured > r.frames.length && (
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
                          onClick={() => deleteRecording(r.id)}
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

function Empty(): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-surface-divider px-8 py-12 text-center">
      <span className="section-label">No recordings yet</span>
      <p className="max-w-md text-sm text-ink-secondary">
        Open a live session and click <span className="mono">Record</span> to capture frames.
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
