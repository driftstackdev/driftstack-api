// Recordings gallery — thumbnail grid + player rail over the in-memory
// recordings (founder-approved gallery port of the recordings-gallery
// visual demo, 2026-06-12).
//
// Recordings persist to disk (see lib/recordings.tsx — ndjson store,
// frames hydrate on demand). The playback view is reached via the
// rail's Open action (or activating a card twice). Selecting a card
// shows its session facts in the rail.

import { useState } from 'react';
import { RelativeTime } from '../components/RelativeTime';
import { SkeletonRows } from '../components/Skeleton';
import {
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  useRecordings,
  type Recording,
} from '../lib/recordings';

export interface RecordingsViewProps {
  onOpen: (recordingId: string) => void;
}

export function RecordingsView({ onOpen }: RecordingsViewProps): JSX.Element {
  const { recordings, deleteRecording, loading } = useRecordings();
  const list = Array.from(recordings.values()).sort((a, b) => b.startedAt - a.startedAt);
  // Selected card drives the rail. Default = newest; deleting the
  // selected recording falls back to newest on the next render.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = (selectedId !== null ? recordings.get(selectedId) : undefined) ?? list[0];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Sessions</span>
          <h2 className="text-lg font-medium tracking-tight text-ink-primary">
            Recordings
            <span className="ml-2 mono text-ink-muted">{list.length}</span>
          </h2>
          <p className="text-2xs text-ink-muted">
            Recordings persist on this machine (app data); frames load on demand when you open one.
          </p>
        </div>
      </header>

      {list.length === 0 ? (
        <Empty loading={loading} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          {/* Thumbnail gallery */}
          <div className="min-w-0 flex-1 overflow-auto">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {list.map((r) => (
                <RecordingCard
                  key={r.id}
                  recording={r}
                  selected={selected?.id === r.id}
                  onSelect={() => setSelectedId(r.id)}
                  onOpen={() => onOpen(r.id)}
                />
              ))}
            </div>
          </div>

          {/* Player rail — facts + actions for the selected recording */}
          {selected && (
            <aside
              data-component="recording-rail"
              className="flex w-72 shrink-0 flex-col gap-3 self-start rounded-lg border border-surface-divider bg-surface-raised p-4"
            >
              <Thumb recording={selected} large />
              <dl className="flex flex-col">
                <FactRow k="Session">
                  <span className="mono text-ink-secondary">{selected.sessionId}</span>
                </FactRow>
                <FactRow k="Started">
                  <RelativeTime
                    iso={new Date(selected.startedAt).toISOString()}
                    tooltipPrefix="Started"
                  />
                </FactRow>
                <FactRow k="Duration">
                  <span className="mono">
                    {formatDuration(recordingDurationMs(selected))}
                    {selected.endedAt === null && (
                      <span className="ml-1.5 text-status-busy">live</span>
                    )}
                  </span>
                </FactRow>
                <FactRow k="Frames">
                  <span className="mono text-ink-secondary">
                    {selected.hydrated && selected.frames.length === 0
                      ? selected.frameCount
                      : selected.frames.length}
                    {selected.totalCaptured >
                      Math.max(selected.frames.length, selected.frameCount) && (
                      <span className="ml-1 text-ink-muted">/ {selected.totalCaptured}</span>
                    )}
                  </span>
                </FactRow>
                <FactRow k="Size">
                  <span className="mono text-ink-muted">
                    {(recordingTotalBytes(selected) / 1024 / 1024).toFixed(1)} MB
                  </span>
                </FactRow>
              </dl>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary flex-1"
                  onClick={() => onOpen(selected.id)}
                  // Openable when frames are in memory OR persisted on disk
                  // (the player hydrates on mount). The old list disabled
                  // Open on frames.length===0 alone, which made every
                  // persisted recording unplayable after an app restart.
                  disabled={
                    selected.frames.length === 0 && !(selected.hydrated && selected.frameCount > 0)
                  }
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void deleteRecording(selected.id)}
                  disabled={selected.endedAt === null}
                  title={selected.endedAt === null ? 'Stop recording before deleting' : undefined}
                >
                  Delete
                </button>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

// Card: thumbnail (first captured frame when loaded; neutral placeholder
// for hydrated-not-yet-loaded entries) + duration chip + meta strip.
function RecordingCard({
  recording: r,
  selected,
  onSelect,
  onOpen,
}: {
  recording: Recording;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}): JSX.Element {
  const live = r.endedAt === null;
  return (
    <button
      type="button"
      data-recording-card={r.id}
      aria-pressed={selected}
      className={`overflow-hidden rounded-lg border bg-surface-raised text-left transition-colors ${
        selected
          ? 'border-accent ring-1 ring-accent'
          : 'border-surface-divider hover:border-ink-muted/40'
      }`}
      onClick={onSelect}
      onDoubleClick={r.frames.length > 0 || (r.hydrated && r.frameCount > 0) ? onOpen : undefined}
    >
      <Thumb recording={r} />
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-ink-primary">{r.label ?? r.sessionId}</p>
        <p className="mono text-2xs text-ink-muted">
          <RelativeTime iso={new Date(r.startedAt).toISOString()} tooltipPrefix="Started" />
          {live && <span className="ml-1.5 text-status-busy">live</span>}
        </p>
      </div>
    </button>
  );
}

function Thumb({
  recording: r,
  large = false,
}: {
  recording: Recording;
  large?: boolean;
}): JSX.Element {
  const first = r.frames[0];
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden bg-surface-inset ${
        large ? 'aspect-[9/13] rounded-md' : 'aspect-[9/12]'
      }`}
    >
      {first ? (
        // First captured frame as the poster. alt empty: decorative — the
        // card's text carries the accessible name.
        <img src={first.dataUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="mono text-2xs text-ink-muted">
          {r.hydrated ? 'frames on disk' : 'no frames'}
        </span>
      )}
      <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 mono text-2xs text-white">
        {formatDuration(recordingDurationMs(r))}
      </span>
    </div>
  );
}

function FactRow({ k, children }: { k: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-surface-divider py-1.5 text-xs last:border-0">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="text-ink-primary">{children}</dd>
    </div>
  );
}

function Empty({ loading }: { loading: boolean }): JSX.Element {
  if (loading) {
    return <SkeletonRows rows={4} label="Loading recordings" />;
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
        Recordings persist on this machine (app data) and survive an app restart.
      </p>
    </div>
  );
}
