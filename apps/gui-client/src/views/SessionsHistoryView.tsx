// V-334 — Sessions history view. Shows TERMINATED sessions
// (destroyed + errored) with their lifetime + reason. Mirrors the
// SessionsView state-machine (poll-on-mount, refresh button) but
// scoped to terminal-state sessions only.
//
// Useful for the founder running locally to verify session lifecycle
// + spot patterns in failures (which archetype keeps erroring,
// which durations are abnormal). Active sessions live in
// SessionsView; this is the post-mortem complement.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
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
      // Newest first.
      terminated.sort((a, b) => {
        const tA = a.destroyed_at ? new Date(a.destroyed_at).getTime() : 0;
        const tB = b.destroyed_at ? new Date(b.destroyed_at).getTime() : 0;
        return tB - tA;
      });
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

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <span className="section-label">History</span>
          <h2 className="mt-1 text-lg font-medium text-ink-primary">Past sessions</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Sessions that have ended (destroyed or errored). Active sessions live under "Active" in
            the sidebar.
          </p>
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

      {state.sessions.length === 0 && state.error === null && !state.loading && (
        <div className="rounded border border-surface-divider bg-surface-raised p-8 text-center text-sm text-ink-secondary">
          No terminated sessions yet. They show up here once destroyed or errored.
        </div>
      )}

      {state.sessions.length > 0 && (
        <ul className="divide-y divide-surface-divider rounded border border-surface-divider bg-surface-raised">
          {state.sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <p className="mono text-sm text-ink-primary">{s.id}</p>
                <p className="mt-1 text-2xs text-ink-muted">
                  {s.archetype} · {fmtDuration(s.created_at, s.destroyed_at)} ·{' '}
                  {s.destroyed_at ? new Date(s.destroyed_at).toISOString() : '—'}
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ${
                  s.status === 'errored'
                    ? 'bg-status-error/20 text-status-error'
                    : 'bg-surface-elevated text-ink-secondary'
                }`}
              >
                {s.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
