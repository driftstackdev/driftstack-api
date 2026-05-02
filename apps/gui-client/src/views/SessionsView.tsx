// Sessions view — list active sessions, create new, destroy individual.
//
// Auto-refreshes every 5 seconds so the list reflects fleet state
// without requiring the user to click. Stops polling when the view
// unmounts. Failures surface inline rather than via toasts so the
// founder can debug API issues without losing context.

import { useCallback, useEffect, useState } from 'react';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError, type Session } from '../lib/client';

const REFRESH_MS = 5000;

interface SessionsState {
  sessions: Session[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

export function SessionsView(): JSX.Element {
  const { client, settings } = useSettings();
  const [state, setState] = useState<SessionsState>({
    sessions: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ sessions: [], refreshedAt: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await client.listSessions();
      setState({
        sessions: page.data,
        refreshedAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: friendlyError(err),
      }));
    }
  }, [client]);

  // Initial fetch + 5-second poll.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleCreate(): Promise<void> {
    if (!client) return;
    setBusyId('__create__');
    try {
      await client.createSession();
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDestroy(id: string): Promise<void> {
    if (!client) return;
    setBusyId(id);
    try {
      await client.destroySession(id);
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    } finally {
      setBusyId(null);
    }
  }

  if (!client) {
    return <EmptyConnect baseUrl={settings.baseUrl} />;
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Sessions</span>
          <h2 className="text-lg font-medium text-ink-primary">
            Active sessions
            <span className="ml-2 mono text-ink-muted">{state.sessions.length}</span>
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void refresh()}
            disabled={state.loading}
          >
            {state.loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleCreate()}
            disabled={busyId === '__create__'}
          >
            {busyId === '__create__' ? 'Creating…' : 'New session'}
          </button>
        </div>
      </header>

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {state.sessions.length === 0 ? (
        <EmptyList loading={state.loading} />
      ) : (
        <SessionsTable
          sessions={state.sessions}
          busyId={busyId}
          onDestroy={(id) => void handleDestroy(id)}
        />
      )}

      <footer className="text-2xs text-ink-muted">
        {state.refreshedAt !== null && (
          <>
            Last refreshed <span className="mono">{formatTime(state.refreshedAt)}</span> ·
            auto-refresh every {REFRESH_MS / 1000}s
          </>
        )}
      </footer>
    </div>
  );
}

// ─── subcomponents ────────────────────────────────────────────────

function EmptyConnect({ baseUrl }: { baseUrl: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="section-label">Not connected</span>
      <p className="max-w-md text-sm text-ink-secondary">
        Add an API key under <span className="mono">Settings</span> to connect to{' '}
        <span className="mono">{baseUrl}</span>.
      </p>
    </div>
  );
}

function EmptyList({ loading }: { loading: boolean }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-surface-divider px-8 py-12 text-center">
      <span className="section-label">{loading ? 'Loading…' : 'No active sessions'}</span>
      <p className="max-w-md text-sm text-ink-secondary">
        {loading
          ? 'Fetching the current session list.'
          : 'Click "New session" above to spin up a Driftstack session.'}
      </p>
    </div>
  );
}

function SessionsTable({
  sessions,
  busyId,
  onDestroy,
}: {
  sessions: Session[];
  busyId: string | null;
  onDestroy: (id: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-auto rounded border border-surface-divider">
      <table className="w-full">
        <thead>
          <tr className="border-b border-surface-divider bg-surface-elevated text-left">
            <Th>ID</Th>
            <Th>Status</Th>
            <Th>Archetype</Th>
            <Th>Label</Th>
            <Th>Created</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={s.id}
              className="border-b border-surface-divider last:border-0 hover:bg-surface-elevated/40"
            >
              <Td>
                <span className="mono text-ink-secondary">{s.id}</span>
              </Td>
              <Td>
                <StatusPill status={s.status} />
              </Td>
              <Td>
                <span className="mono text-ink-secondary">{s.archetype}</span>
              </Td>
              <Td>
                <span className="text-ink-secondary">{s.label ?? '—'}</span>
              </Td>
              <Td>
                <span className="mono text-ink-muted">
                  {formatTime(new Date(s.created_at).getTime())}
                </span>
              </Td>
              <Td>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => onDestroy(s.id)}
                  disabled={busyId === s.id}
                >
                  {busyId === s.id ? 'Destroying…' : 'Destroy'}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: Session['status'] }): JSX.Element {
  const dotColor =
    status === 'ready'
      ? 'bg-status-ready'
      : status === 'busy'
        ? 'bg-status-busy'
        : status === 'errored'
          ? 'bg-status-error'
          : 'bg-status-idle';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`status-pip ${dotColor}`} />
      <span className="text-ink-secondary">{status}</span>
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }): JSX.Element {
  return <th className="px-3 py-2 section-label">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }): JSX.Element {
  return <td className="px-3 py-2 align-middle text-sm">{children}</td>;
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 rounded border border-status-error/30 bg-status-error/10 px-3 py-2">
      <div className="flex flex-col gap-0.5">
        <span className="section-label text-status-error/80">Error</span>
        <span className="text-sm text-ink-primary">{message}</span>
      </div>
      <button type="button" className="btn-secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

function friendlyError(err: unknown): string {
  if (err instanceof DriftstackError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'unknown error';
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
