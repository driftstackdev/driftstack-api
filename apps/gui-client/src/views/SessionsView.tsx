// Sessions view — list active sessions, create new, destroy individual.
//
// Auto-refreshes every 5 seconds so the list reflects fleet state
// without requiring the user to click. Stops polling when the view
// unmounts. Failures surface inline rather than via toasts so the
// founder can debug API issues without losing context.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { RelativeTime } from '../components/RelativeTime';
import { SkeletonRows } from '../components/Skeleton';
import { useSettings } from '../lib/SettingsContext';
import { useToasts } from '../lib/toasts';
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
  const { push: pushToast } = useToasts();
  const [state, setState] = useState<SessionsState>({
    sessions: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  // Toast on status transitions (demo-concepts arc): when the 15s poll sees a
  // session newly errored, surface it instead of waiting for the customer to
  // glance at the list. View-scoped v1 — runs while Sessions is mounted; the
  // app-level watcher arrives when session polling lifts into a shared store.
  const prevStatuses = useRef(new Map<string, string>());
  useEffect(() => {
    const prev = prevStatuses.current;
    for (const session of state.sessions) {
      const before = prev.get(session.id);
      if (before !== undefined && before !== 'errored' && session.status === 'errored') {
        pushToast({
          title: 'Session errored',
          body: `${session.label ?? session.id} stopped unexpectedly.`,
          tone: 'warn',
          action: { label: 'Open', run: () => onView(session.id) },
        });
      }
      prev.set(session.id, session.status);
    }
  }, [state.sessions, pushToast, onView]);

  // V-239 — gate the New session button when the customer is at the
  // concurrent cap. Server enforces (V-073 returns 402); the GUI's job
  // is to surface the cap proactively so the customer never sees the
  // 402 in normal flow. accountMe === null (not loaded) → don't gate.
  const concurrentCap = accountMe?.concurrent_session_cap ?? null;
  const concurrentActive = accountMe?.concurrent_session_active ?? null;
  const atConcurrentCap =
    concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap;

  // At-a-glance status breakdown over the live list (pure-derived, no new
  // data). Drives the Console stat strip + hero health line.
  const counts = useMemo(() => {
    let ready = 0;
    let busy = 0;
    let errored = 0;
    for (const s of state.sessions) {
      if (s.status === 'ready') ready += 1;
      else if (s.status === 'busy') busy += 1;
      else if (s.status === 'errored') errored += 1;
    }
    return { ready, busy, errored };
  }, [state.sessions]);

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

  const hasSessions = state.sessions.length > 0;
  const showSkeleton = state.loading && !hasSessions;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* HERO — section-label + title with at-a-glance live/cap context, a
          live "refreshed" pill, and the primary actions on the right.
          Mirrors the Profiles hub's hero rhythm so the app reads as one
          cohesive product. */}
      <header className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3">
        <div className="min-w-0">
          <span className="section-label">Sessions</span>
          <h2 className="mt-0.5 flex items-baseline gap-2 text-[19px] font-semibold tracking-tight text-ink-primary">
            Active sessions
            <span className="mono text-sm font-medium text-ink-muted">
              {concurrentCap !== null && concurrentActive !== null
                ? `${concurrentActive.toString()} / ${concurrentCap.toString()}`
                : state.sessions.length.toString()}
            </span>
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
            <b className="font-semibold text-ink-primary">{state.sessions.length}</b> running
            <span className="text-surface-divider">·</span>
            <span className="font-semibold text-status-ready">{counts.ready} ready</span>
            {counts.busy > 0 && (
              <>
                <span className="text-surface-divider">·</span>
                <span className="font-semibold text-status-busy">{counts.busy} busy</span>
              </>
            )}
            {counts.errored > 0 && (
              <>
                <span className="text-surface-divider">·</span>
                <span className="font-semibold text-status-error">{counts.errored} errored</span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
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
              className="btn-primary flex items-center gap-1.5"
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
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path
                  d="M8 3v10M3 8h10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <span>{busyId === '__create__' ? 'Creating…' : 'New session'}</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted">
            <span
              aria-hidden="true"
              className="relative inline-block h-1.5 w-1.5 rounded-full bg-status-ready"
            >
              <span className="absolute inset-[-3px] animate-ping rounded-full border border-status-ready opacity-60" />
            </span>
            {state.refreshedAt !== null ? (
              <>
                Refreshed <span className="mono">{formatTime(state.refreshedAt)}</span> ·
                auto-refresh {REFRESH_MS / 1000}s
              </>
            ) : (
              <>auto-refresh {REFRESH_MS / 1000}s</>
            )}
          </div>
        </div>
      </header>

      {/* STAT STRIP — Console-density at-a-glance metrics, derived from the
          live list + account caps (no new data / no new fetch). */}
      {hasSessions && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-surface-divider bg-surface-divider sm:grid-cols-4">
          <Stat
            l="Active"
            value={state.sessions.length}
            sub={
              concurrentCap !== null
                ? `of ${concurrentCap.toString()} concurrent cap`
                : 'no fixed cap'
            }
          />
          <Stat l="Ready" value={counts.ready} accent sub={`${counts.busy} busy`} />
          <Stat
            l="Errored"
            value={counts.errored}
            sub={counts.errored > 0 ? 'needs attention' : 'all healthy'}
          />
          <Stat
            l="Slots free"
            value={
              concurrentCap !== null && concurrentActive !== null
                ? Math.max(0, concurrentCap - concurrentActive)
                : state.sessions.length
            }
            sub={atConcurrentCap ? 'at cap' : 'available'}
          />
        </div>
      )}

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {showSkeleton ? (
        <div className="flex flex-col gap-3">
          <SkeletonRows rows={3} label="Fetching the current session list." />
        </div>
      ) : !hasSessions ? (
        <EmptyState
          icon={<SessionGlyph />}
          title="No active sessions yet"
          description="A session is one running iPhone Safari instance. Click New session above to spin one up — sessions show up here with a live status while they run. Each one uses a concurrent slot until you destroy it or it idle-times-out."
          action={
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
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {state.sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              busy={busyId === s.id}
              onView={() => onView(s.id)}
              onDestroy={() => void handleDestroy(s.id)}
            />
          ))}
        </div>
      )}
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

// Console session card — status pill, mono id, archetype/proxy details,
// duration, quiet row actions. Live (ready/busy) cards carry a subtle
// status-ready ring; hover lifts the card a hair (matches the hub).
function SessionCard({
  session,
  busy,
  onView,
  onDestroy,
}: {
  session: Session;
  busy: boolean;
  onView: () => void;
  onDestroy: () => void;
}): JSX.Element {
  const live = session.status === 'ready' || session.status === 'busy';
  const errored = session.status === 'errored';
  const egress = session.egress_capabilities;
  return (
    <article
      className={`group flex flex-col gap-3 rounded-lg border bg-surface-raised p-3.5 shadow-sm transition-all hover:-translate-y-px hover:shadow-md ${
        errored
          ? 'border-status-error/50'
          : live
            ? 'border-status-ready/50'
            : 'border-surface-divider hover:border-ink-muted/60'
      }`}
    >
      {/* Header: status pill + device/archetype, with duration on the right. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <StatusPill status={session.status} />
          <span className="mono text-[11px] text-ink-muted">{session.archetype}</span>
        </div>
        <span
          className="shrink-0 whitespace-nowrap text-[10px] text-ink-muted"
          title={`Created ${new Date(session.created_at).toLocaleString()}`}
        >
          <RelativeTime iso={session.created_at} tooltipPrefix="Created" />
        </span>
      </div>

      {/* Identity: label (or fallback) + the mono session id. */}
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold tracking-tight text-ink-primary">
          {session.label ?? 'Untitled session'}
        </p>
        <p className="mono mt-0.5 truncate text-[10.5px] text-ink-muted" title={session.id}>
          {session.id}
        </p>
      </div>

      {/* Egress / proxy detail row — honest: shows the harness-reported
          egress capability when present, else a quiet placeholder. */}
      <div className="flex items-center gap-2 rounded-lg bg-surface-inset px-2 py-1.5">
        <span aria-hidden="true" className="text-[13px] leading-none">
          {egress !== null ? '🌍' : '🔌'}
        </span>
        {egress !== null ? (
          <>
            <span className="mono min-w-0 truncate text-[10.5px] text-ink-secondary">
              {egress.udp_associate ? 'SOCKS5 · UDP relay' : 'SOCKS5 egress'}
            </span>
            <span
              className={`ml-auto shrink-0 rounded-[5px] px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${
                egress.udp_associate
                  ? 'bg-status-ready/12 text-status-ready'
                  : 'bg-surface-inset text-ink-muted'
              }`}
              title={
                egress.udp_associate
                  ? 'UDP relay verified — QUIC + WebRTC tunnel through this exit.'
                  : 'No UDP relay reported — sessions fall back to h2 / TURN-over-TCP.'
              }
            >
              {egress.udp_associate ? 'UDP' : 'TCP'}
            </span>
          </>
        ) : (
          <span className="text-[10.5px] text-ink-muted">egress pending report</span>
        )}
      </div>

      {/* Quiet row actions: View + Stop. */}
      <div className="mt-auto flex gap-2 pt-0.5">
        <button type="button" className="btn-secondary flex-1 text-xs" onClick={onView}>
          View
        </button>
        <button
          type="button"
          className="btn-danger flex-1 text-xs"
          onClick={onDestroy}
          disabled={busy}
        >
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </article>
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
  const textColor =
    status === 'ready'
      ? 'text-status-ready'
      : status === 'busy'
        ? 'text-status-busy'
        : status === 'errored'
          ? 'text-status-error'
          : 'text-ink-secondary';
  const pulse = status === 'busy' ? 'animate-pulse' : '';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium capitalize">
      <span className={`status-pip ${dotColor} ${pulse}`} />
      <span className={textColor}>{status}</span>
    </span>
  );
}

// Console-density stat tile — small uppercase label + a BIG mono numeral
// + a sub-line. `accent` tints the numeral (light → accent, dark → ready)
// for the highlighted metric. Pure presentation over derived counts.
function Stat({
  l,
  value,
  sub,
  accent,
}: {
  l: string;
  value: number;
  sub: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 bg-surface-base px-4 py-3">
      <span className="section-label">{l}</span>
      <span
        className={`mono text-[26px] font-semibold leading-none tracking-tight tabular-nums ${
          accent ? 'text-accent dark:text-status-ready' : 'text-ink-primary'
        }`}
      >
        {value}
      </span>
      <span className="text-[10.5px] text-ink-muted">{sub}</span>
    </div>
  );
}

// Empty-state glyph — a phone outline, echoing the "one running iPhone
// Safari instance" framing.
function SessionGlyph(): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
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
  );
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
