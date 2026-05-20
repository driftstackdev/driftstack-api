// Sessions view — list active sessions, create new, destroy individual.
//
// Auto-refreshes every 5 seconds so the list reflects fleet state
// without requiring the user to click. Stops polling when the view
// unmounts. Failures surface inline rather than via toasts so the
// founder can debug API issues without losing context.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError, type Session } from '../lib/client';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { listProxies, type ProxyConfig as LocalProxyConfig } from '../lib/proxies';

// 2026-05-20 — slow the background poll from 5s → 15s + suppress the
// visible "loading" flicker on background refreshes (customer reported
// the panel "keeps refreshing"). The very first load still shows the
// loading state so the empty list doesn't flash; subsequent ticks
// fetch silently and only update the rendered list on completion.
const REFRESH_MS = 15_000;

interface SessionsState {
  sessions: Session[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

export interface SessionsViewProps {
  onView: (sessionId: string) => void;
  onGoToSettings: () => void;
}

export function SessionsView({ onView, onGoToSettings }: SessionsViewProps): JSX.Element {
  const { client, settings, accountMe, refreshAccountMe } = useSettings();
  const [state, setState] = useState<SessionsState>({
    sessions: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  // V-239 — gate the New session button when the customer is at the
  // concurrent cap. Server enforces (V-073 returns 402); the GUI's job
  // is to surface the cap proactively so the customer never sees the
  // 402 in normal flow. accountMe === null (not loaded) → don't gate.
  const concurrentCap = accountMe?.concurrent_session_cap ?? null;
  const concurrentActive = accountMe?.concurrent_session_active ?? null;
  const atConcurrentCap =
    concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap;

  const refresh = useCallback(
    async (showLoading: boolean): Promise<void> => {
      if (!client) {
        setState({ sessions: [], refreshedAt: null, loading: false, error: null });
        return;
      }
      if (showLoading) setState((s) => ({ ...s, loading: true }));
      try {
        const page = await client.sessions.list();
        setState((s) => ({
          sessions: page.data,
          refreshedAt: Date.now(),
          loading: false,
          error: s.error,
        }));
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: friendlyError(err, settings.baseUrl),
        }));
      }
    },
    [client, settings.baseUrl],
  );

  // First fetch shows the loading hint so the empty list doesn't flash;
  // background polls every 15s fetch silently — no UI flicker.
  useEffect(() => {
    void refresh(true);
    const id = window.setInterval(() => void refresh(false), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleCreate(): Promise<void> {
    if (!client) return;
    setBusyId('__create__');
    try {
      // 2026-05-20 — auto-attach the first saved proxy to the
      // create-session body. Server's egress-required deployments
      // reject sessions without a `proxy` envelope (per planning 133),
      // and the local proxy store has been disconnected from the
      // create flow — customer reported '2 proxies set, still get the
      // proxy-required error'. Pick the first saved proxy as the
      // default; future iterations can surface a picker.
      const saved = await listProxies();
      const first = saved[0];
      if (first === undefined) {
        setState((s) => ({
          ...s,
          error:
            'No saved proxies. Open the Proxies tab in the sidebar, add a SOCKS5 server, then come back to create a session. (This deployment requires every session to ship traffic through a proxy.)',
        }));
        return;
      }
      const proxy = toServerProxyEnvelope(first);
      // SDK type doesn't yet declare the proxy field — server accepts
      // it via the EG-API-1.6 raw-body pass-through. Cast through
      // unknown to keep the call typesafe at the type-narrow boundary.
      await client.sessions.create({ proxy } as unknown as Parameters<
        typeof client.sessions.create
      >[0]);
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  /** Map the GUI-local proxy shape to the server's discriminated-union
   *  envelope (`{type: 'socks5', socks5: {host, port, ...}}`). Only
   *  SOCKS5 is supported by the local store at v0.0.1. */
  function toServerProxyEnvelope(p: LocalProxyConfig): {
    type: 'socks5';
    socks5: {
      host: string;
      port: number;
      username?: string;
      password?: string;
      udp_associate: boolean;
      require_remote_dns: boolean;
    };
  } {
    const socks5: {
      host: string;
      port: number;
      username?: string;
      password?: string;
      udp_associate: boolean;
      require_remote_dns: boolean;
    } = {
      host: p.host,
      port: p.port,
      udp_associate: true,
      require_remote_dns: false,
    };
    if (p.username !== null) socks5.username = p.username;
    if (p.password !== null) socks5.password = p.password;
    return { type: 'socks5', socks5 };
  }

  async function handleDestroy(id: string): Promise<void> {
    if (!client) return;
    setBusyId(id);
    try {
      await client.sessions.destroy(id);
      await refresh(false);
      // V-239 — refresh after destroy so the cap counter unlocks the
      // Spawn button when we drop below cap.
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  if (!client) {
    return <EmptyConnect baseUrl={settings.baseUrl} onGoToSettings={onGoToSettings} />;
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="section-label">Sessions</span>
          <h2 className="text-lg font-medium text-ink-primary">
            Active sessions
            <span className="ml-2 mono text-ink-muted">
              {concurrentCap !== null && concurrentActive !== null
                ? `${concurrentActive.toString()} / ${concurrentCap.toString()}`
                : state.sessions.length.toString()}
            </span>
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void refresh(true)}
            disabled={state.loading}
          >
            {state.loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleCreate()}
            disabled={busyId === '__create__' || atConcurrentCap}
            aria-disabled={busyId === '__create__' || atConcurrentCap}
            title={
              atConcurrentCap
                ? `Concurrent session cap reached (${(concurrentCap ?? 0).toString()} for ${
                    accountMe?.tier ?? 'this tier'
                  }). Destroy a session or upgrade to spawn more.`
                : undefined
            }
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
          onView={onView}
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

function EmptyConnect({
  baseUrl,
  onGoToSettings,
}: {
  baseUrl: string;
  onGoToSettings: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <span className="section-label">Not connected</span>
      <p className="max-w-md text-sm text-ink-secondary">
        Add an API key to connect to <span className="mono">{baseUrl}</span>.
      </p>
      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary" onClick={onGoToSettings}>
          Open settings
        </button>
        <span className="text-2xs text-ink-muted">
          or press <span className="mono">⌘ ,</span>
        </span>
      </div>
    </div>
  );
}

function EmptyList({ loading }: { loading: boolean }): JSX.Element {
  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-surface-divider px-8 py-12 text-center">
        <span className="section-label">Loading…</span>
        <p className="max-w-md text-sm text-ink-secondary">Fetching the current session list.</p>
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
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12" y2="18" />
        </svg>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-ink-primary">No active sessions yet</h3>
        <p className="max-w-md text-sm text-ink-secondary">
          A session is one running iPhone Safari instance. Click <strong>New session</strong> above
          to spin one up — sessions show up here with a live status while they run.
        </p>
      </div>
      <p className="text-xs text-ink-muted">
        Each session uses one of your account's concurrent slots until you destroy it or it
        idle-times-out.
      </p>
    </div>
  );
}

function SessionsTable({
  sessions,
  busyId,
  onView,
  onDestroy,
}: {
  sessions: Session[];
  busyId: string | null;
  onView: (id: string) => void;
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
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-secondary" onClick={() => onView(s.id)}>
                    View
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => onDestroy(s.id)}
                    disabled={busyId === s.id}
                  >
                    {busyId === s.id ? 'Destroying…' : 'Destroy'}
                  </button>
                </div>
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

// ─── helpers ──────────────────────────────────────────────────────

function friendlyError(err: unknown, baseUrl?: string): string {
  // 2026-05-20 — network-failure preflight (catches Tauri WebKit
  // "Load failed" before falling through to per-view formatting).
  if (baseUrl !== undefined) {
    const diag = diagnosticFetchError(err, baseUrl);
    if (diag !== null) return diag;
  }
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
