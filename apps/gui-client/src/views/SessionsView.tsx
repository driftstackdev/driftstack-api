// Sessions view — list active sessions, create new, destroy individual.
//
// Auto-refreshes every 5 seconds so the list reflects fleet state
// without requiring the user to click. Stops polling when the view
// unmounts. Failures surface inline rather than via toasts so the
// founder can debug API issues without losing context.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { RelativeTime } from '../components/RelativeTime';
import { LiveElapsed } from '../components/LiveElapsed';
import { useSettings } from '../lib/SettingsContext';
import { useToasts } from '../lib/toasts';
import { useConfirm } from '../components/ConfirmProvider';
import { type Session } from '../lib/client';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { humanizeError } from '../lib/humanize-error';
import { listProxies, type ProxyConfig as LocalProxyConfig } from '../lib/proxies';
import { countActiveAgentSessions } from '../lib/active-agent-sessions';
import { useExclusiveAsyncAction } from '../lib/use-exclusive-async-action';

// Consistency #5 — the minimal agent-session shape SessionsView renders. A
// profile launch creates an `agt_` AGENT session (no driver row), which the
// driver-only `client.sessions.list()` never returns — so without this the
// running phone is invisible here. We list active agent sessions alongside the
// driver sessions so a launched profile is visible + stoppable on this surface.
interface AgentSessionLite {
  id: string;
  status: 'active' | 'paused' | 'closed';
  created_at: string;
  mode: 'manual' | 'ai' | 'pair';
}

// 2026-05-20 — slow the background poll from 5s → 15s + suppress the
// visible "loading" flicker on background refreshes (customer reported
// the panel "keeps refreshing"). The very first load still shows the
// loading state so the empty list doesn't flash; subsequent ticks
// fetch silently and only update the rendered list on completion.
const REFRESH_MS = 15_000;

interface SessionsState {
  sessions: Session[];
  // Consistency #5 — profile-launched agent sessions, surfaced alongside the
  // driver sessions so a running launched profile is visible + actionable here.
  agentSessions: AgentSessionLite[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

export interface SessionsViewProps {
  onGoToSettings: () => void;
  onGoToProxies: () => void;
}

export function SessionsView({ onGoToSettings, onGoToProxies }: SessionsViewProps): JSX.Element {
  const { client, settings, accountMe, refreshAccountMe } = useSettings();
  const { push: pushToast } = useToasts();
  const confirm = useConfirm();
  const [state, setState] = useState<SessionsState>({
    sessions: [],
    agentSessions: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  // One shared synchronous owner covers every billed/session mutation. React's
  // disabled state is visible feedback, not a mutex: two native click/Enter
  // events can arrive before the state commit. The hook acquires before the
  // first async boundary (including confirm) and releases on every outcome.
  const {
    error: mutationError,
    reset: resetMutationError,
    run: runMutation,
  } = useExclusiveAsyncAction({
    mapError: (err: unknown) => friendlyError(err, settings.baseUrl),
  });

  // Toast on status transitions (demo-concepts arc): when the 15s poll sees a
  // session newly errored, surface it instead of waiting for the customer to
  // glance at the list. View-scoped v1 — runs while Sessions is mounted; the
  // app-level watcher arrives when session polling lifts into a shared store.
  const prevStatuses = useRef(new Map<string, string>());
  useEffect(() => {
    const prev = prevStatuses.current;
    const seen = new Set<string>();
    for (const session of state.sessions) {
      seen.add(session.id);
      const before = prev.get(session.id);
      if (before !== undefined && before !== 'errored' && session.status === 'errored') {
        pushToast({
          title: 'Session errored',
          body: `${session.label ?? session.id} stopped unexpectedly.`,
          tone: 'warn',
        });
      }
      prev.set(session.id, session.status);
    }
    // Evict ids that left the list so the Map can't grow unbounded over the
    // lifetime of this long-lived, polling view (audit wja3dfl5t).
    for (const id of prev.keys()) {
      if (!seen.has(id)) prev.delete(id);
    }
  }, [state.sessions, pushToast]);

  // Consistency #5/#43 — `concurrent_session_active` is the server's DRIVER-only
  // count, but profile launches create AGENT sessions (the path most GUI users
  // take). Fold the active agent count in so the cap gate + the "X / Y" header
  // reflect every running phone — otherwise the gate reads "0 / 3" while three
  // launched phones run and the proactive cap-gate it exists to provide fails.
  // Driver + agent ids are disjoint, so adding never double-counts.
  const activeAgentCount = countActiveAgentSessions(state.agentSessions);

  // V-239 — gate the New session button when the customer is at the
  // concurrent cap. Server enforces (V-073 returns 402); the GUI's job
  // is to surface the cap proactively so the customer never sees the
  // 402 in normal flow. accountMe === null (not loaded) → don't gate.
  const concurrentCap = accountMe?.concurrent_session_cap ?? null;
  const concurrentActive =
    accountMe?.concurrent_session_active !== undefined
      ? accountMe.concurrent_session_active + activeAgentCount
      : null;
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

  // "Active/running" = non-terminal sessions only. state.sessions includes
  // destroyed/errored entries until the next poll drops them (the server list
  // is account-scoped, not status-filtered), so counting the raw array length
  // over-reports running sessions. Add the active agent sessions (consistency
  // #5) so the "running" line counts launched profiles too.
  const activeCount = counts.ready + counts.busy + activeAgentCount;

  const refresh = useCallback(
    async (showLoading: boolean): Promise<void> => {
      if (!client) {
        resetMutationError();
        setState({
          sessions: [],
          agentSessions: [],
          refreshedAt: null,
          loading: false,
          error: null,
        });
        return;
      }
      if (showLoading) setState((s) => ({ ...s, loading: true }));
      try {
        // Consistency #5 — fetch driver + agent sessions together so the list +
        // counters reflect both. The agent-session list is best-effort: it 503s
        // when the agent runtime isn't wired on the deployment, which must not
        // blank the driver list — fall back to the prior agent list on failure.
        const [page, agentSessions] = await Promise.all([
          client.sessions.list(),
          typeof client.agentSessions.list === 'function'
            ? client.agentSessions
                .list()
                .then((p) =>
                  p.data.map((s): AgentSessionLite => ({
                    id: s.id,
                    status: s.status,
                    created_at: s.created_at,
                    mode: s.mode,
                  })),
                )
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        resetMutationError();
        setState((s) => ({
          ...s,
          sessions: page.data,
          // null = agent fetch failed/unavailable → keep the prior list rather
          // than wrongly emptying it (mirrors the driver list's recover path).
          agentSessions: agentSessions ?? s.agentSessions,
          refreshedAt: Date.now(),
          loading: false,
          // Clear any prior error — a successful list() proves the list is
          // reachable, so a stale "Could not load" banner must not stay pinned
          // after a transient poll failure recovers (adversarial review w410wv3eq;
          // mirrors SessionsHistoryView's success path which sets error: null).
          error: null,
        }));
      } catch (err) {
        resetMutationError();
        setState((s) => ({
          ...s,
          loading: false,
          error: friendlyError(err, settings.baseUrl),
        }));
      }
    },
    [client, resetMutationError, settings.baseUrl],
  );

  // First fetch shows the loading hint so the empty list doesn't flash;
  // background polls every 15s fetch silently — no UI flicker.
  useEffect(() => {
    void refresh(true);
    // Skip the background poll while the app window is hidden/minimized (no point hitting
    // the control plane when nothing's on screen — audit 2026-07-08, pattern from
    // recordings.tsx). The interval keeps ticking so it resumes on the next visible tick.
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh(false);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleCreate(): Promise<void> {
    if (!client) return;
    await runMutation(async () => {
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
          // Setup step, not an error: this deployment routes every session through a
          // proxy and none is saved yet. Offer a direct jump to Proxies instead of a
          // red banner the user then has to act on manually (journey audit M9).
          if (
            await confirm(
              "This deployment routes every session through a proxy, and you don't have one saved yet. Add a SOCKS5 server in Proxies, then come back to start a session.",
              { confirmLabel: 'Open Proxies' },
            )
          ) {
            onGoToProxies();
          }
          return;
        }
        const proxy = toServerProxyEnvelope(first);
        // Consistency #11 — this New-session path creates a bare driver session:
        // no saved profile (so no persistent identity — cookies/logins don't
        // survive), the operator-default device, through the FIRST saved proxy
        // (not one the user picked here). Confirm so the founder isn't surprised
        // by a no-identity session on a slot/bill they didn't intend, and is
        // pointed at the profile-based launch when they want a saved identity.
        const proceed = await confirm(
          `Start a quick session with NO saved profile?\n\n` +
            `• No persistent identity — cookies/logins won't be saved or restored.\n` +
            `• Uses the default device and your first saved proxy (${first.label}).\n\n` +
            `For a saved identity + a device/proxy you choose, launch a profile from Profiles instead.`,
          { confirmLabel: 'Start quick session' },
        );
        if (!proceed) return;
        // SDK type doesn't yet declare the proxy field — server accepts
        // it via the EG-API-1.6 raw-body pass-through. Cast through
        // unknown to keep the call typesafe at the type-narrow boundary.
        await client.sessions.create({ proxy } as unknown as Parameters<
          typeof client.sessions.create
        >[0]);
        await refresh(false);
        await refreshAccountMe();
      } finally {
        setBusyId(null);
      }
    });
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
    await runMutation(async () => {
      // Stopping tears down a live (billed) browser immediately — confirm so a
      // misclick in the dense session grid doesn't kill a running session.
      if (
        !(await confirm(
          'Stop this session now? The live browser is torn down immediately and anything in progress is lost.',
          { confirmLabel: 'Stop session' },
        ))
      )
        return;
      setBusyId(id);
      try {
        await client.sessions.destroy(id);
        await refresh(false);
        // V-239 — refresh after destroy so the cap counter unlocks the
        // Spawn button when we drop below cap.
        await refreshAccountMe();
      } finally {
        setBusyId(null);
      }
    });
  }

  // Consistency #5 — stop a profile-launched AGENT session from this surface
  // (its row's Stop), so a running launched profile is actionable here, not
  // only from its Profiles row.
  async function handleCloseAgent(id: string): Promise<void> {
    if (!client) return;
    await runMutation(async () => {
      if (
        !(await confirm(
          'Stop this running session now? The live browser is torn down immediately and anything in progress is lost.',
          { confirmLabel: 'Stop session' },
        ))
      )
        return;
      setBusyId(id);
      try {
        await client.agentSessions.close(id);
        await refresh(false);
        await refreshAccountMe();
      } finally {
        setBusyId(null);
      }
    });
  }

  if (!client) {
    return <EmptyConnect baseUrl={settings.baseUrl} onGoToSettings={onGoToSettings} />;
  }

  // Consistency #5 — only ACTIVE agent sessions are rendered as live cards
  // (paused/closed are terminal/inactive here). Listed alongside driver
  // sessions so a launched profile is visible + stoppable on this surface.
  const liveAgentSessions = state.agentSessions.filter((s) => s.status === 'active');
  const hasSessions = state.sessions.length > 0 || liveAgentSessions.length > 0;
  const showSkeleton = state.loading && !hasSessions;

  // The primary New-session control, shared verbatim by the hero + the empty
  // state so behavior (cap-gating, busy label, title) stays identical wherever
  // it appears. Presentation-only wrapper — no logic change.
  const capTitle = atConcurrentCap
    ? `Concurrent session cap reached (${(concurrentCap ?? 0).toString()} for ${
        accountMe?.tier ?? 'this tier'
      }). Destroy a session or upgrade to spawn more.`
    : undefined;
  const visibleError = mutationError ?? state.error;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-6">
      {/* Page hero — an accent icon chip + a radial identity glow, the
          at-a-glance live/cap context line, a live "refreshed" pill, and the
          primary Refresh + New session actions on the right. Matches the
          Command Center / Settings gradient-card language. */}
      <header className="relative overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full opacity-40 blur-3xl"
          style={{
            background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.55), transparent 70%)',
          }}
        />
        <div className="relative flex flex-wrap items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"
            aria-hidden="true"
          >
            <IconPhone />
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent">Sessions</span>
            <h2 className="mt-0.5 flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-ink-primary">
              Active sessions
              <span className="mono text-base font-medium text-ink-muted">
                {concurrentCap !== null && concurrentActive !== null
                  ? `${concurrentActive.toString()} / ${concurrentCap.toString()}`
                  : state.sessions.length.toString()}
              </span>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
              <b className="font-semibold text-ink-primary">{activeCount}</b> running
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
                title={capTitle}
              >
                <IconPlus />
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
        </div>
      </header>

      {/* STAT STRIP — icon-led at-a-glance KPI cards derived from the live list
          + account caps (no new data / no new fetch), matching the Command
          Center fleet KPI strip. */}
      {hasSessions && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            icon={<IconBolt />}
            l="Active"
            value={activeCount}
            sub={
              concurrentCap !== null
                ? `of ${concurrentCap.toString()} concurrent cap`
                : 'no fixed cap'
            }
          />
          <Stat
            icon={<IconCheck />}
            l="Ready"
            value={counts.ready}
            accent
            sub={`${counts.busy} busy`}
          />
          <Stat
            icon={<IconAlert />}
            l="Errored"
            value={counts.errored}
            sub={counts.errored > 0 ? 'needs attention' : 'all healthy'}
          />
          <Stat
            icon={<IconSlots />}
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

      {visibleError !== null && (
        // Sticky so a failed action (Stop/Destroy on a card the user has
        // scrolled down to) stays visible instead of dropping into a banner
        // that's scrolled off the top (journey audit M6). Kept inline rather
        // than a toast per this view's debug-without-losing-context convention
        // — sticky just pins the existing banner in view. bg-surface-base (the
        // content-area colour) keeps scrolled cards from bleeding through.
        <div className="sticky top-0 z-20 bg-surface-base py-1">
          <ErrorBanner
            message={visibleError}
            onRetry={() => void refresh(true)}
            retrying={state.loading}
            onDismiss={() => {
              resetMutationError();
              setState((s) => ({ ...s, error: null }));
            }}
          />
        </div>
      )}

      {showSkeleton ? (
        <div
          role="status"
          aria-label="Fetching the current session list."
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <span className="sr-only">Fetching the current session list.</span>
          {Array.from({ length: 3 }).map((_, i) => (
            <SessionCardSkeleton key={i} />
          ))}
        </div>
      ) : !hasSessions ? (
        <SessionsEmptyState
          onCreate={() => void handleCreate()}
          disabled={busyId === '__create__' || atConcurrentCap}
          creating={busyId === '__create__'}
          title={capTitle}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Profile-launched agent sessions first (consistency #5) — these are
              the running phones the user launched from Profiles; without them
              this list claimed "no active sessions" while a phone was live. */}
          {liveAgentSessions.map((s) => (
            <AgentSessionCard
              key={s.id}
              session={s}
              busy={busyId === s.id}
              onStop={() => void handleCloseAgent(s.id)}
            />
          ))}
          {state.sessions
            // The account-scoped list keeps a just-destroyed session until the next
            // poll drops it; rendering it with a live Stop button while the header
            // "running" count already excludes it read as a contradiction (audit
            // 2026-07-08). Hide destroyed rows; errored stays (separately counted +
            // still actionable to clean up).
            .filter((s) => s.status !== 'destroyed')
            .map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                busy={busyId === s.id}
                onDestroy={() => void handleDestroy(s.id)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// Consistency #5 — a profile-launched AGENT session rendered in the Sessions
// list. Distinct from SessionCard (driver `Session`): an agent session carries
// no archetype/egress facts, so this is a lighter card — identity (id + mode) +
// a live "running for" timer + a Stop action (client.agentSessions.close). The
// "Profile session" label + a distinct chip make clear it's a launched profile,
// not a raw driver session.
function AgentSessionCard({
  session,
  busy,
  onStop,
}: {
  session: AgentSessionLite;
  busy: boolean;
  onStop: () => void;
}): JSX.Element {
  const modeLabel =
    session.mode === 'ai' ? 'AI-driven' : session.mode === 'pair' ? 'Pair mode' : 'Manual';
  return (
    <article className="group flex flex-col gap-3.5 rounded-xl border border-status-ready/50 bg-surface-raised p-4 shadow-sm transition-all hover:-translate-y-px hover:shadow-md">
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent"
          aria-hidden="true"
        >
          <IconPhone />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold tracking-tight text-ink-primary">
            Profile session
          </p>
          <p className="mono mt-0.5 truncate text-[10.5px] text-ink-muted" title={session.id}>
            {session.id}
          </p>
        </div>
        <span
          className="shrink-0 whitespace-nowrap text-[10px] text-ink-muted"
          title={`Started ${new Date(session.created_at).toLocaleString()}`}
        >
          <LiveElapsed iso={session.created_at} tooltipPrefix="Started" />
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <span className="status-pip bg-status-ready" />
          <span className="text-status-ready">running</span>
        </span>
        <span className="mono truncate text-[11px] text-ink-muted" title={modeLabel}>
          {modeLabel}
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-surface-inset px-2.5 py-1.5">
        <span aria-hidden="true" className="text-ink-secondary">
          <IconPhone />
        </span>
        <span className="text-[10.5px] text-ink-muted">
          Launched from a profile — manage it from its Profiles row too.
        </span>
      </div>

      <div className="mt-auto flex gap-2 pt-0.5">
        <button
          type="button"
          className="btn-danger flex-1 text-xs"
          onClick={onStop}
          disabled={busy}
        >
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </article>
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
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col p-6">
      <section className="relative flex flex-col items-center gap-4 overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised px-8 py-14 text-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full opacity-40 blur-3xl"
          style={{
            background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.55), transparent 70%)',
          }}
        />
        <span
          className="relative grid h-12 w-12 place-items-center rounded-xl bg-accent/15 text-accent"
          aria-hidden="true"
        >
          <IconPhone />
        </span>
        <div className="relative flex flex-col gap-1">
          <span className="section-label text-accent">Not connected</span>
          <h2 className="text-xl font-semibold tracking-tight text-ink-primary">
            Connect to start sessions
          </h2>
          <p className="mx-auto max-w-md text-sm text-ink-secondary">
            Add an API key to connect to <span className="mono">{baseUrl}</span>.
          </p>
        </div>
        <div className="relative flex items-center gap-3">
          <button type="button" className="btn-primary" onClick={onGoToSettings}>
            Open settings
          </button>
          <span className="text-2xs text-ink-muted">
            or press <span className="mono">⌘ ,</span>
          </span>
        </div>
      </section>
    </div>
  );
}

// Polished empty state — an accent icon chip + heading + supporting copy + the
// (cap-gated) create affordance, in a raised card matching the hero rhythm.
// Preserves the exact create behavior (the button props mirror the hero's).
function SessionsEmptyState({
  onCreate,
  disabled,
  creating,
  title,
}: {
  onCreate: () => void;
  disabled: boolean;
  creating: boolean;
  title: string | undefined;
}): JSX.Element {
  return (
    <section className="flex flex-col items-center gap-4 rounded-2xl border border-surface-divider bg-surface-raised px-8 py-12 text-center shadow-sm">
      <span
        className="grid h-12 w-12 place-items-center rounded-xl bg-surface-inset text-ink-muted"
        aria-hidden="true"
      >
        <IconPhone />
      </span>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold tracking-tight text-ink-primary">
          No active sessions yet
        </h3>
        <p className="max-w-md text-sm leading-relaxed text-ink-secondary">
          A session is one running iPhone Safari instance. Click New session above to spin one up —
          sessions show up here with a live status while they run. Each one uses a concurrent slot
          until you destroy it or it idle-times-out.
        </p>
      </div>
      <button
        type="button"
        className="btn-primary mt-1 flex items-center gap-1.5"
        onClick={onCreate}
        disabled={disabled}
        aria-disabled={disabled}
        title={title}
      >
        <IconPlus />
        <span>{creating ? 'Creating…' : 'New session'}</span>
      </button>
    </section>
  );
}

// Console session card — status pill, mono id, archetype/proxy details,
// duration, quiet row actions. Live (ready/busy) cards carry a subtle
// status-ready ring; hover lifts the card a hair (matches the hub).
function SessionCard({
  session,
  busy,
  onDestroy,
}: {
  session: Session;
  busy: boolean;
  onDestroy: () => void;
}): JSX.Element {
  const live = session.status === 'ready' || session.status === 'busy';
  const errored = session.status === 'errored';
  const egress = session.egress_capabilities;
  // The leading identity chip is tinted by health so a card reads its state at a
  // glance: accent for a live run, error for a fault, quiet for terminal.
  const chipClass = errored
    ? 'bg-status-error/12 text-status-error'
    : live
      ? 'bg-accent/15 text-accent'
      : 'bg-surface-inset text-ink-muted';
  return (
    <article
      className={`group flex flex-col gap-3.5 rounded-xl border bg-surface-raised p-4 shadow-sm transition-all hover:-translate-y-px hover:shadow-md ${
        errored
          ? 'border-status-error/50'
          : live
            ? 'border-status-ready/50'
            : 'border-surface-divider hover:border-ink-muted/60'
      }`}
    >
      {/* Header: an accent icon chip leading the identity (label + mono id),
          with a live worktimer on the right for running sessions (ticking
          elapsed since created_at), else the static "created X ago". */}
      <div className="flex items-start gap-3">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${chipClass}`}
          aria-hidden="true"
        >
          <IconPhone />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold tracking-tight text-ink-primary">
            {session.label ?? 'Untitled session'}
          </p>
          <p className="mono mt-0.5 truncate text-[10.5px] text-ink-muted" title={session.id}>
            {session.id}
          </p>
        </div>
        <span
          className="shrink-0 whitespace-nowrap text-[10px] text-ink-muted"
          title={`Created ${new Date(session.created_at).toLocaleString()}`}
        >
          {live ? (
            <LiveElapsed iso={session.created_at} tooltipPrefix="Started" />
          ) : (
            <RelativeTime iso={session.created_at} tooltipPrefix="Created" />
          )}
        </span>
      </div>

      {/* Status + archetype facts row. */}
      <div className="flex items-center justify-between gap-2">
        <StatusPill status={session.status} />
        <span className="mono truncate text-[11px] text-ink-muted" title={session.archetype}>
          {session.archetype}
        </span>
      </div>

      {/* Egress / proxy detail row — honest: shows the harness-reported
          egress capability when present, else a quiet placeholder. */}
      <div className="flex items-center gap-2 rounded-lg bg-surface-inset px-2.5 py-1.5">
        <span aria-hidden="true" className="text-ink-secondary">
          {egress !== null ? <IconGlobe /> : <IconPlug />}
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

      {/* Quiet row action: Stop. (Live viewing moved entirely to the floating
          Simulator window launched from Profiles — the in-app session viewer
          was removed, so a session card no longer has a "View" affordance.) */}
      <div className="mt-auto flex gap-2 pt-0.5">
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

// Loading placeholder shaped like a SessionCard — chip + identity lines, a facts
// row, the egress strip, and the action pair — so the list settles in without a
// layout jump. Static + aria-hidden (the parent carries the status role).
function SessionCardSkeleton(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-3.5 rounded-xl border border-surface-divider bg-surface-raised p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-inset" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-inset" />
          <div className="h-2.5 w-1/2 animate-pulse rounded bg-surface-inset" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="h-3 w-16 animate-pulse rounded bg-surface-inset" />
        <div className="h-3 w-20 animate-pulse rounded bg-surface-inset" />
      </div>
      <div className="h-7 w-full animate-pulse rounded-lg bg-surface-inset" />
      <div className="flex gap-2 pt-0.5">
        <div className="h-7 flex-1 animate-pulse rounded bg-surface-inset" />
        <div className="h-7 flex-1 animate-pulse rounded bg-surface-inset" />
      </div>
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

// Icon-led KPI card — an icon chip + an uppercase label + a big mono numeral
// + a sub-line, matching the Command Center fleet-stat strip. `accent` tints
// the chip + numeral (light → accent, dark → ready) for the highlighted metric.
// Pure presentation over derived counts.
function Stat({
  icon,
  l,
  value,
  sub,
  accent,
}: {
  icon: ReactNode;
  l: string;
  value: number;
  sub: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-surface-divider bg-surface-raised px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
            accent ? 'bg-accent/15 text-accent' : 'bg-surface-inset text-ink-secondary'
          }`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <span className="section-label">{l}</span>
      </div>
      <span
        className={`mono text-2xl font-semibold leading-none tracking-tight tabular-nums ${
          accent ? 'text-accent dark:text-status-ready' : 'text-ink-primary'
        }`}
      >
        {value}
      </span>
      <span className="text-[10.5px] text-ink-muted">{sub}</span>
    </div>
  );
}

// ─── icons (Lucide-shape, inline, no dependency) — matches CommandCenterView ──
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
// A phone outline, echoing the "one running iPhone Safari instance" framing.
function IconPhone(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
    </svg>
  );
}
function IconPlus(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" {...stroke}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
function IconBolt(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M8.5 1.5 3.5 9h3.5l-.5 5.5L12 7H8.5Z" />
    </svg>
  );
}
function IconCheck(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.25 8.25 7.25 10.25 11 6" />
    </svg>
  );
}
function IconAlert(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M8 1.75 14.5 13.5H1.5Z" />
      <path d="M8 6.25v3M8 11.5h.01" />
    </svg>
  );
}
function IconSlots(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <rect x="2" y="2.5" width="5" height="5" rx="1" />
      <rect x="9" y="2.5" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <path d="M9 11.5h5M11.5 9v5" />
    </svg>
  );
}
function IconGlobe(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" {...stroke}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5" />
      <path d="M8 2.25c1.7 2 2.5 4 2.5 5.75S9.7 12 8 13.75C6.3 11.75 5.5 9.75 5.5 8s.8-3.75 2.5-5.75Z" />
    </svg>
  );
}
function IconPlug(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" {...stroke}>
      <path d="M6 2v3M10 2v3" />
      <path d="M4.5 5h7v2a3.5 3.5 0 0 1-7 0Z" />
      <path d="M8 10.5V14" />
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
  return humanizeError(err, "Couldn't complete the session request. Try again.");
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
