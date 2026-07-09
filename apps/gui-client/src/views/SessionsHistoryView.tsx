// V-334 — Sessions history view. Shows TERMINATED sessions
// (destroyed + errored) with their lifetime + status. Mirrors the
// SessionsView state-machine (poll-on-mount, refresh button) but
// scoped to terminal-state sessions only.
//
// Useful for the founder running locally to verify session lifecycle
// + spot patterns in failures (which archetype keeps erroring,
// which durations are abnormal). Active sessions live in
// SessionsView; this is the post-mortem complement.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';
import { RelativeTime } from '../components/RelativeTime';
import { SessionStatusBadge } from '../components/SessionStatusBadge';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError, type Session } from '../lib/client';

interface HistoryState {
  sessions: Session[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

export function SessionsHistoryView(): JSX.Element {
  const { client } = useSettings();
  const [state, setState] = useState<HistoryState>({
    sessions: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ sessions: [], refreshedAt: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await client.sessions.list();
      const terminated = page.data.filter(
        (s) => s.status === 'destroyed' || s.status === 'errored',
      );
      // Newest first. Errored sessions often have no destroyed_at (the
      // box never ran a clean teardown), so falling back to last_state_at
      // then created_at keeps them interleaved by when they actually ended
      // instead of dumping every reasonless error at the bottom (time 0).
      terminated.sort((a, b) => endedAtMs(b) - endedAtMs(a));
      setState({
        sessions: terminated,
        refreshedAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err) {
      const message =
        err instanceof DriftstackError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to load history.';
      setState((s) => ({ ...s, loading: false, error: message }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!client) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <span className="section-label">Configure API access</span>
        <p className="max-w-md text-sm text-ink-secondary">
          Set up your API key in Settings to view session history.
        </p>
      </div>
    );
  }

  const hasSessions = state.sessions.length > 0;
  const showSkeleton = state.loading && !hasSessions;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="section-label">History</span>
          <h2 className="mt-1 flex items-baseline gap-2 text-lg font-medium tracking-tight text-ink-primary">
            Past sessions
            {hasSessions && (
              <span className="text-sm font-normal text-ink-muted">{state.sessions.length}</span>
            )}
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Ended sessions (destroyed or errored) with their lifetime and final status. Active
            sessions live under "Active" in the sidebar.
          </p>
          {state.refreshedAt !== null && (
            <p className="mt-1 text-2xs text-ink-muted">
              Refreshed <span className="mono">{formatTime(state.refreshedAt)}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void refresh()}
          disabled={state.loading}
        >
          {state.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {showSkeleton && <SkeletonRows rows={5} label="Loading session history…" />}

      {!hasSessions && !showSkeleton && state.error === null && (
        <EmptyState
          icon={
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
          }
          title="No past sessions yet"
          description="Sessions that have ended — destroyed or errored — show up here."
        />
      )}

      {state.sessions.length > 0 && (
        <ul className="divide-y divide-surface-divider rounded border border-surface-divider bg-surface-raised">
          {state.sessions.map((s) => {
            // Errored sessions frequently lack a destroyed_at (no clean
            // teardown); fall back to the last state transition so the row
            // still shows *when* it ended rather than a bare em dash.
            const endedIso = s.destroyed_at ?? s.last_state_at;
            return (
              <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="mono text-sm text-ink-primary">{s.id}</p>
                  <p className="mt-1 text-2xs text-ink-muted">
                    {s.archetype} · {fmtDuration(s.created_at, endedIso)} ·{' '}
                    {endedIso ? (
                      <RelativeTime
                        iso={endedIso}
                        tooltipPrefix={s.destroyed_at ? 'Ended' : 'Last state (errored)'}
                      />
                    ) : (
                      '—'
                    )}
                  </p>
                  {s.status === 'errored' && (
                    <p className="mt-0.5 text-2xs text-ink-muted italic">
                      Reason not reported by the harness
                    </p>
                  )}
                </div>
                <SessionStatusBadge status={s.status} size="sm" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Mirrors SessionsView.formatTime — wall-clock of the last refresh.
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

// The moment a terminated session actually ended, most-reliable first:
// destroyed_at (clean teardown) → last_state_at (last transition an
// errored session recorded) → created_at (only if both are missing).
// Used so reasonless errors don't collapse to time 0 and sink to the
// bottom of the newest-first list.
function endedAtMs(s: Session): number {
  const iso = s.destroyed_at ?? s.last_state_at ?? s.created_at;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function fmtDuration(createdIso: string, destroyedIso: string | null): string {
  if (!destroyedIso) return '—';
  const ms = new Date(destroyedIso).getTime() - new Date(createdIso).getTime();
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 6_000) / 10}m`;
  return `${Math.round(ms / 360_000) / 10}h`;
}
