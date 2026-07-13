// V-534.P — sessions list view.
//
// Wires the V-534.O useSessionsList hook to the V-534.N
// SessionStatusBadge primitive. Renders the loading/error/ready
// states + a refresh button. Caller passes through to FleetView /
// SessionsHistoryView at the parent level; this component just
// surfaces the data.

import { useSessionsList } from '../lib/use-sessions-list';
import { SessionStatusBadge } from '../components/SessionStatusBadge';
import { EmptyState } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';

export interface SessionsListViewProps {
  limit?: number;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function SessionsListView(props: SessionsListViewProps): JSX.Element {
  const limit = props.limit ?? 25;
  const { state, refetch } = useSessionsList({ limit });
  const loading = state.kind === 'loading';

  return (
    <section className="space-y-4 p-4" aria-labelledby="sessions-list-heading">
      <header className="flex items-center justify-between gap-3">
        <h2
          id="sessions-list-heading"
          className="text-lg font-semibold tracking-tight text-ink-primary"
        >
          Sessions
        </h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={loading}
          aria-busy={loading}
          className="rounded border border-surface-divider px-2 py-1 text-sm text-ink-primary hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {loading && <SkeletonRows rows={5} label="Loading sessions" />}
      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded border border-status-error/60 bg-status-error/10 p-3 text-sm text-status-error"
        >
          Could not load sessions: {state.message}
        </div>
      )}
      {state.kind === 'ready' && state.data.sessions.length === 0 && (
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
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          }
          title="No sessions yet"
          description="Sessions you start will appear here — live ones first, then their history."
        />
      )}
      {state.kind === 'ready' && state.data.sessions.length > 0 && (
        <table className="w-full text-sm" aria-label="Sessions">
          <thead>
            <tr className="text-left text-ink-secondary">
              <th className="py-1">Id</th>
              <th className="py-1">URL</th>
              <th className="py-1">Status</th>
              <th className="py-1">Created</th>
            </tr>
          </thead>
          <tbody>
            {state.data.sessions.map((s) => (
              <tr key={s.id} className="border-t border-surface-divider">
                <td className="py-1 font-mono">{s.id}</td>
                <td className="py-1 text-ink-secondary truncate max-w-xs" title={s.url}>
                  {s.url}
                </td>
                <td className="py-1">
                  <SessionStatusBadge status={s.status} size="sm" />
                </td>
                <td className="py-1 text-ink-secondary">{fmtTime(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
