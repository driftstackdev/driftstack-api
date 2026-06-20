// Recordings gallery — thumbnail grid + player rail over the in-memory
// recordings (founder-approved Console restyle of the recordings-gallery
// visual demo, 2026-06-14: matches ProfilesView/console.html — hero header,
// gallery cards with hover play affordance, polished empty/loading states,
// hairline-divided fact rail).
//
// Recordings persist to disk (see lib/recordings.tsx — ndjson store,
// frames hydrate on demand). The playback view is reached via the
// rail's Open action (or activating a card twice). Selecting a card
// shows its session facts in the rail.

import { useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { RelativeTime } from '../components/RelativeTime';
import { Skeleton } from '../components/Skeleton';
import { useToasts } from '../lib/toasts';
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
  const { push: pushToast } = useToasts();
  const { recordings, deleteRecording, loading } = useRecordings();

  // Copy the selected recording's session id so the operator can correlate it
  // with the dashboard / API without retyping. Clipboard writes can fail in
  // locked-down WKWebView contexts — fail quietly.
  async function handleCopySession(sessionId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(sessionId);
      pushToast({ title: 'Copied', tone: 'success' });
    } catch {
      /* clipboard write can fail in locked-down envs; silent */
    }
  }
  const list = Array.from(recordings.values()).sort((a, b) => b.startedAt - a.startedAt);
  // Selected card drives the rail. Default = newest; deleting the
  // selected recording falls back to newest on the next render.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = (selectedId !== null ? recordings.get(selectedId) : undefined) ?? list[0];
  const liveCount = list.filter((r) => r.endedAt === null).length;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* HERO — section-label + title + at-a-glance context on the left
          (console.html .hero). Recordings carry no primary action of their
          own (they're created from a live session), so the right side holds
          a quiet live/idle pill rather than a button. */}
      <header className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3">
        <div className="min-w-0">
          <span className="section-label">Sessions</span>
          <h2 className="mt-0.5 flex items-baseline gap-2 text-[19px] font-semibold tracking-tight text-ink-primary">
            Recordings
            <span className="mono text-base font-medium text-ink-muted">{list.length}</span>
          </h2>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Recordings persist on this machine (app data); frames load on demand when you open one.
          </p>
        </div>
        {list.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {liveCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-status-busy/30 bg-status-busy/10 px-2.5 py-1 text-2xs font-semibold text-status-busy">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-busy"
                />
                {liveCount} recording
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-divider bg-surface-raised px-2.5 py-1 text-2xs text-ink-secondary">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-ready" />
              {list.length} saved
            </span>
          </div>
        )}
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
              className="flex w-72 shrink-0 flex-col gap-3 self-start rounded-lg border border-surface-divider bg-surface-raised p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="section-label">Now selected</span>
                {selected.endedAt === null ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-status-busy">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-busy"
                    />
                    Live
                  </span>
                ) : (
                  <span className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                    Saved
                  </span>
                )}
              </div>
              <Thumb recording={selected} large />
              <p className="truncate text-sm font-semibold tracking-tight text-ink-primary">
                {selected.label ?? selected.sessionId}
              </p>
              <dl className="flex flex-col">
                <FactRow k="Session">
                  <span className="flex items-center gap-1.5">
                    <span className="mono text-ink-secondary">{selected.sessionId}</span>
                    <button
                      type="button"
                      aria-label="Copy session ID"
                      title="Copy session ID"
                      className="text-2xs text-accent hover:underline"
                      onClick={() => void handleCopySession(selected.sessionId)}
                    >
                      Copy
                    </button>
                  </span>
                </FactRow>
                <FactRow k="Started">
                  <RelativeTime
                    iso={new Date(selected.startedAt).toISOString()}
                    tooltipPrefix="Started"
                  />
                </FactRow>
                <FactRow k="Duration">
                  <span className="mono text-ink-primary">
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
                  className="btn-primary flex flex-1 items-center justify-center gap-1.5"
                  onClick={() => onOpen(selected.id)}
                  // Openable when frames are in memory OR persisted on disk
                  // (the player hydrates on mount). The old list disabled
                  // Open on frames.length===0 alone, which made every
                  // persisted recording unplayable after an app restart.
                  disabled={
                    selected.frames.length === 0 && !(selected.hydrated && selected.frameCount > 0)
                  }
                >
                  <PlayGlyph size={12} />
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
  const playable = r.frames.length > 0 || (r.hydrated && r.frameCount > 0);
  return (
    <button
      type="button"
      data-recording-card={r.id}
      aria-pressed={selected}
      className={`group relative overflow-hidden rounded-lg border bg-surface-raised text-left transition-all hover:-translate-y-px hover:shadow-md ${
        selected
          ? 'border-accent ring-1 ring-accent'
          : 'border-surface-divider hover:border-ink-muted/60'
      }`}
      onClick={onSelect}
      onDoubleClick={playable ? onOpen : undefined}
    >
      <div className="relative">
        <Thumb recording={r} />
        {/* Hover play affordance — a quiet centered glyph revealed over the
            thumbnail on hover, only when the recording can actually be
            opened. Purely decorative: the double-click handler drives the
            real open (the card itself stays a single Select target). */}
        {playable && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/25 group-hover:opacity-100"
          >
            <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-raised/95 text-accent shadow-md">
              <PlayGlyph size={16} />
            </span>
          </span>
        )}
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold tracking-tight text-ink-primary">
          {r.label ?? r.sessionId}
        </p>
        <p className="mono mt-0.5 flex items-center gap-1.5 text-2xs text-ink-muted">
          <RelativeTime iso={new Date(r.startedAt).toISOString()} tooltipPrefix="Started" />
          {live && (
            <span className="inline-flex items-center gap-1 font-semibold text-status-busy">
              <span
                aria-hidden="true"
                className="h-1 w-1 animate-pulse rounded-full bg-status-busy"
              />
              live
            </span>
          )}
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
        <div className="flex flex-col items-center gap-1.5 text-ink-muted">
          <FilmGlyph size={large ? 26 : 22} />
          <span className="mono text-2xs">{r.hydrated ? 'frames on disk' : 'no frames'}</span>
        </div>
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
    return <GallerySkeleton />;
  }
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<FilmGlyph size={22} />}
        title="No recordings yet"
        description="Recordings capture every frame of a live session for replay + audit. Open a live session, hit Record, and frames stream into memory while the session runs — they persist on this machine and survive an app restart."
      />
    </div>
  );
}

// Gallery-shaped loading state — pulsing thumbnail cards that settle into
// the real grid's shape (instead of bare list rows), so the load reads as
// the gallery arriving. Mirrors the Skeleton/SkeletonRows reduced-motion
// contract (animate-pulse is reduced-motion-safe globally).
function GallerySkeleton(): JSX.Element {
  return (
    <div role="status" aria-label="Loading recordings" className="min-h-0 flex-1">
      <span className="sr-only">Loading recordings</span>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-lg border border-surface-divider bg-surface-raised"
          >
            <Skeleton className="aspect-[9/12] rounded-none" />
            <div className="flex flex-col gap-1.5 px-3 py-2">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Inline glyphs (Lucide-style stroke, currentColor) — kept local so the
// view carries no new dependency. Play = the gallery's signature action;
// Film = the recordings identity (empty state + no-frame placeholder).
function PlayGlyph({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="translate-x-px"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function FilmGlyph({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4M7 12h10" />
    </svg>
  );
}
