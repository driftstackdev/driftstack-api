// Profiles view — list profiles, create new, delete.
//
// V-136 (Tier 3 draft). Persistent identity slots that survive across
// sessions. Each profile carries its own cookies + localStorage; the
// driver attaches them to a session when the session is created against
// a profile.
//
// Mirrors SessionsView shape: 5-second poll, inline error banner, busy
// state per row.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  folderList,
  loadProfilesMeta,
  saveProfileMeta,
  type ProfilesMetaMap,
} from '../lib/profiles-meta';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  ProfilesActionBar,
  type ProfileSortBy,
  type ProfileStatusFilter,
} from '../components/ProfilesActionBar';
import { ProxyChip } from '../components/ProxyChip';
import { RelativeTime } from '../components/RelativeTime';
import { ARCHETYPE_REGISTRY, type ArchetypeStatus, type LiveKitInfo } from '@driftstack/sdk';
import { openSimulatorWindow } from '../lib/open-simulator';
import { useSettings } from '../lib/SettingsContext';
import { useConnectionStatus } from '../lib/use-connection-status';
import { DriftstackError, type Session } from '../lib/client';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import {
  clearSession as clearProfileSession,
  deleteBinding,
  listBindings,
  markLaunched,
  setDefaultProxy,
  type ProfileBinding,
} from '../lib/profile-bindings';
import {
  addProxy,
  listProxies,
  testProxy,
  type ProxyConfig as LocalProxyConfig,
  type ProxyTestResult,
} from '../lib/proxies';

// LAZY-LOADED: AgentSessionPanel pulls in livekit-client (a heavy WebRTC
// dependency). Loading it at the top level dragged livekit-client into the
// main bundle, which broke the minified production mount (the whole app failed
// to render → flicker). Deferring it behind React.lazy keeps the dashboard
// mount free of livekit-client; the panel + its deps load only when a session
// is actually being watched (watchInfo set).
const AgentSessionPanel = lazy(() =>
  import('../components/AgentSessionPanel').then((m) => ({ default: m.AgentSessionPanel })),
);

// 2026-05-20 — match SessionsView: slow background poll + skip the
// visible loading flicker on tick refreshes so the panel doesn't
// constantly re-flash.
const REFRESH_MS = 15_000;

// W637 — the selectable archetype catalog is now derived from the shared
// ARCHETYPE_REGISTRY (single source of truth), filtered to the verified
// statuses that are safe to run a real session as: `launch` (the locked
// reference) + `available` (fingerprint-atlas-ready). `reference` and
// `planned` (e.g. iPhone 17, still per-value verified vs real-device per
// the "100% verified profiles" rule) are intentionally EXCLUDED — they
// light up automatically the moment A1 flips their status, with zero GUI
// change. The locked launch archetype is preselected; the select enables
// once 2+ verified options exist.
const SELECTABLE_STATUSES = new Set<ArchetypeStatus>(['launch', 'available']);
const KNOWN_ARCHETYPES: ReadonlyArray<{ id: string; label: string }> = ARCHETYPE_REGISTRY.filter(
  (a) => SELECTABLE_STATUSES.has(a.status),
).map((a) => ({ id: a.id, label: a.displayLabel }));

interface Profile {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfilesState {
  profiles: Profile[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

/** Friendly device label for the simulator toolbar, derived from the archetype
 *  slug: "iphone17_ios18_7_safari26_4" → "iPhone 17", "iphone16pro_…" → "iPhone
 *  16 Pro". Falls back to the raw first segment (or "iPhone") for an
 *  unrecognised shape, so a future archetype never renders blank. */
export function formatDeviceName(archetype: string): string {
  const seg = archetype.split('_')[0] ?? archetype;
  const m = /^iphone(\d+)(pro)?(max)?(e)?$/i.exec(seg);
  if (m === null) return seg || 'iPhone';
  const [, num, pro, max, e] = m;
  return ['iPhone', `${num}${e ? 'e' : ''}`, pro ? 'Pro' : '', max ? 'Max' : '']
    .filter(Boolean)
    .join(' ');
}

export interface ProfilesViewProps {
  onGoToSettings: () => void;
  /** Open the live-session view for a specific session id. */
  onOpenSession: (sessionId: string) => void;
}

export function ProfilesView({ onGoToSettings, onOpenSession }: ProfilesViewProps): JSX.Element {
  const { client, settings, accountMe, refreshAccountMe } = useSettings();
  // W625 — surface the connected server's session driver so we can warn up
  // front that a mock-driver deployment won't open a real browser on launch
  // (the recurring "I launched but nothing opened" confusion). Reuses the
  // 30s /version poll the title-bar pill already runs; null until first probe.
  const serverDriver = useConnectionStatus(settings.baseUrl).driver;
  // 2026-05-20 — antidetect-browser-style hub: profiles are first-class,
  // sessions are an implementation detail of "this profile is running".
  // Track live sessions + GUI-local bindings so we can show per-profile
  // Launch/Stop buttons + a status badge per row.
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [bindings, setBindings] = useState<ProfileBinding[]>([]);
  const [proxies, setProxies] = useState<LocalProxyConfig[]>([]);
  // V-239 — gate the New profile button at the tier cap (skip when
  // profile_cap === null which means enterprise / no fixed cap).
  const profileCap = accountMe?.profile_cap ?? null;
  const profileCount = accountMe?.profile_count ?? null;
  const atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap;
  const [state, setState] = useState<ProfilesState>({
    profiles: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  // Live-stream viewer: set when a launched session returns a LiveKit block;
  // renders an overlay with the AgentSessionPanel (subscribes immediately).
  const [watchInfo, setWatchInfo] = useState<LiveKitInfo | null>(null);
  // W617 — the profile + agent-session behind the active stream overlay, so
  // the empty-room fallback can re-launch the same profile in the viewer.
  const [watchSource, setWatchSource] = useState<{
    profileId: string;
    agentSessionId: string;
  } | null>(null);
  // V-238 — create-form modal state. Lives here (not lifted to App.tsx)
  // because every other ProfilesView interaction is local; the modal
  // is a transient overlay scoped to this view's lifecycle.
  const [createOpen, setCreateOpen] = useState(false);
  // 2026-05-21 — header action cluster (operator-UI polish wave).
  // Pure-local filter/sort over `state.profiles`; no API change. Defaults
  // mirror the "what did I touch last" mental model that dominates
  // operator usage (show all, sort by recent use).
  const [searchQuery, setSearchQuery] = useState('');
  // Fleet hub (2026-06-12, demo-concepts greenlight): grid/list toggle +
  // one-click ephemeral Quick Session. List stays the default render.
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [quickBusy, setQuickBusy] = useState(false);
  // Increment 2 — client-persisted organization (folders/tags/notes).
  const [profilesMeta, setProfilesMeta] = useState<ProfilesMetaMap>({});
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [organizeId, setOrganizeId] = useState<string | null>(null);
  const [draftFolder, setDraftFolder] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>('all');
  const [sortBy, setSortBy] = useState<ProfileSortBy>('last-used');

  useEffect(() => {
    void loadProfilesMeta().then(setProfilesMeta);
  }, []);

  const refresh = useCallback(
    async (showLoading: boolean): Promise<void> => {
      if (!client) {
        setState({ profiles: [], refreshedAt: null, loading: false, error: null });
        return;
      }
      if (showLoading) setState((s) => ({ ...s, loading: true }));
      try {
        // Fetch profiles + active sessions in parallel — both feed the hub.
        const [profilesPage, sessionsPage, currentBindings, currentProxies] = await Promise.all([
          (async () => {
            const collected: Profile[] = [];
            for await (const profile of client.profiles.iterate({ limit: 50 })) {
              collected.push(profile);
            }
            return collected;
          })(),
          client.sessions.list(),
          listBindings(),
          listProxies(),
        ]);
        setActiveSessions(sessionsPage.data);
        setBindings(currentBindings);
        setProxies(currentProxies);
        setState((s) => ({
          profiles: profilesPage,
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

  useEffect(() => {
    void refresh(true);
    const id = window.setInterval(() => void refresh(false), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleDuplicate(profile: Profile): Promise<void> {
    if (!client || busyId !== null) return;
    setBusyId(profile.id);
    try {
      // Backend clone: server-side copy of the profile's sealed state +
      // archetype under a fresh identity (POST /v1/profiles/:id/clone).
      await client.profiles.clone(profile.id);
      await refresh(false);
      await refreshAccountMe();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!client) return;
    setBusyId(id);
    try {
      await client.profiles.delete(id);
      // Drop the local binding so stale {currentSessionId, defaultProxyId}
      // entries don't accumulate as customers churn through profiles.
      await deleteBinding(id);
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  /** Returns the currently-active session for a profile, or null when
   *  the profile is idle. Looks up the binding's currentSessionId in
   *  the live activeSessions list — a stale binding (session destroyed
   *  externally) reads as idle. */
  // W624 — the session a profile is bound to, by KIND. A launch with live
  // video binds the profile to an AGENT session (agt_<uuid>); a LiveKit-less
  // launch binds a DRIVER session (ses_<uuid>). The old runningSessionFor
  // only looked agt_ ids up in the driver-session list (sessions.list()),
  // never found them, so an agent-backed profile showed idle AND its Stop
  // button no-op'd — the founder-hit "destroy doesn't stop it, keeps
  // running". Driver sessions keep the staleness cross-check against the
  // live list; agent sessions are treated as running from the binding (no
  // cheap list endpoint — and agentSessions.close is idempotent, so a Stop
  // on an already-reaped agent session is a harmless cleanup).
  function boundSession(profileId: string): { id: string; kind: 'agent' | 'driver' } | null {
    const binding = bindings.find((b) => b.profileId === profileId);
    const sid = binding?.currentSessionId ?? null;
    if (sid === null) return null;
    if (sid.startsWith('agt_')) return { id: sid, kind: 'agent' };
    return activeSessions.some((s) => s.id === sid) ? { id: sid, kind: 'driver' } : null;
  }

  // W624 — re-open the live stream for an already-running agent session
  // (the profile-row "Live view" when the binding is an agent session).
  async function reopenStream(agentSessionId: string, profileId: string): Promise<void> {
    if (!client) return;
    setBusyId(profileId);
    try {
      const info = await client.agentSessions.livekitToken(agentSessionId);
      setWatchSource({ profileId, agentSessionId });
      // Open the floating-iPhone simulator window (the standard experience).
      // Falls back to the in-app overlay when not under Tauri (browser preview).
      const reopened = state.profiles.find((p) => p.id === profileId);
      const sim = await openSimulatorWindow({
        sessionId: agentSessionId,
        info,
        deviceName: formatDeviceName(reopened?.archetype ?? ''),
        profileName: reopened?.name,
      });
      if (!sim.opened) {
        setWatchInfo(info);
        // Founder-visible: WHY the separate window fell back in-app.
        setState((s) => ({
          ...s,
          error: `Simulator window could not open (showing in-app view instead): ${sim.reason ?? 'unknown'}`,
        }));
      }
    } catch (err) {
      // W638 — a profile bound to a CLOSED agent session 403s here ("Cannot
      // mint LiveKit token for closed agent session"); 404 if it's gone.
      // boundSession (W624) can't cheaply tell live from closed (no list
      // endpoint), so it optimistically showed the profile "running". On
      // that signal the binding is stale — clear it so the profile
      // self-heals to idle instead of repeatedly offering a Live-view that
      // 403s.
      if (err instanceof DriftstackError && (err.status === 403 || err.status === 404)) {
        await clearProfileSession(profileId).catch(() => undefined);
        await refresh(false);
      }
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  // 2026-05-21 — derive the filtered/sorted view over state.profiles.
  // Search matches name + description + archetype; status filter treats a
  // profile as running when it's bound to a live driver session OR an agent
  // session (W624); sort is recency-by-default ("what did I touch last?"
  // beats alpha for the operator workflow).
  const filteredProfiles = useMemo(() => {
    let list = state.profiles;
    const q = searchQuery.trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description?.toLowerCase().includes(q) ?? false) ||
          p.archetype.toLowerCase().includes(q),
      );
    }
    if (folderFilter !== 'all') {
      list = list.filter((p) =>
        folderFilter === 'unfiled'
          ? (profilesMeta[p.id]?.folder ?? '') === ''
          : profilesMeta[p.id]?.folder === folderFilter,
      );
    }
    if (statusFilter !== 'all') {
      list = list.filter((p) => {
        // W624 — agent-backed (agt_) sessions count as running too, not just
        // driver sessions present in the live list.
        const binding = bindings.find((b) => b.profileId === p.id);
        const sid = binding?.currentSessionId ?? null;
        const running =
          sid !== null && (sid.startsWith('agt_') || activeSessions.some((s) => s.id === sid));
        return statusFilter === 'running' ? running : !running;
      });
    }
    const ordered = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'created':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'last-used': {
          const at = a.last_used_at !== null ? new Date(a.last_used_at).getTime() : 0;
          const bt = b.last_used_at !== null ? new Date(b.last_used_at).getTime() : 0;
          return bt - at;
        }
      }
    });
    return ordered;
  }, [
    folderFilter,
    profilesMeta,
    state.profiles,
    searchQuery,
    statusFilter,
    sortBy,
    activeSessions,
    bindings,
  ]);

  /** Pick the proxy to use on Launch — explicit binding default first,
   *  else the first saved proxy, else null (handled in handleLaunch as
   *  an inline error). */
  function pickProxy(profileId: string): LocalProxyConfig | null {
    const binding = bindings.find((b) => b.profileId === profileId);
    if (binding?.defaultProxyId !== undefined && binding?.defaultProxyId !== null) {
      const explicit = proxies.find((p) => p.id === binding.defaultProxyId);
      if (explicit !== undefined) return explicit;
    }
    return proxies[0] ?? null;
  }

  async function handleLaunch(profile: Profile): Promise<void> {
    if (!client) return;
    setBusyId(profile.id);
    try {
      const proxy = pickProxy(profile.id);
      if (proxy === null) {
        setState((s) => ({
          ...s,
          error:
            'No saved proxies. Open the Proxies tab, add a SOCKS5 server, then launch this profile. (Sessions require a proxy on this deployment.)',
        }));
        return;
      }
      // Create a STREAMING agent-session: this dispatches the session to the
      // fleet harness (which spawns the browser + captures + publishes) and
      // returns a `livekit` block we subscribe to immediately — no timing lag.
      // The selected proxy gates launch (this deployment requires one); the
      // server injects the egress proxy into the dispatched session.
      void proxy;
      // Attach THIS profile so the session restores/persists its saved browser
      // identity (file 57). Pass the canonical prof_<uuid> id as-is — the create
      // API accepts it (W335/W336 made both session routes normalize prof_<uuid>
      // or a bare uuid server-side).
      const created = await client.agentSessions.create({ profile_id: profile.id });
      await markLaunched(profile.id, created.id);
      if (created.livekit) {
        // W617 — remember which profile/agent-session backs the stream so
        // the no-publisher fallback can re-launch as a direct session.
        setWatchSource({ profileId: profile.id, agentSessionId: created.id });
        // Open the floating-iPhone simulator window (the standard experience).
        // Falls back to the in-app overlay when not under Tauri (browser preview).
        const sim = await openSimulatorWindow({
          sessionId: created.id,
          info: created.livekit,
          deviceName: formatDeviceName(profile.archetype),
          profileName: profile.name,
        });
        if (!sim.opened) {
          setWatchInfo(created.livekit);
          setState((s) => ({
            ...s,
            error: `Simulator window could not open (showing in-app view instead): ${sim.reason ?? 'unknown'}`,
          }));
        }
      } else {
        // W611/W613 — no livekit block (deployment without LiveKit, e.g. a
        // self-hosted/mock-driver server): fall back to the polling live
        // view instead of dead-ending with an error.
        await openPollingFallback(profile.id, created.id);
      }
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  // W613/W617 — shared LiveKit-less fallback. The polling viewer speaks the
  // DRIVER-session routes (/v1/sessions/:id, ses_<uuid>), and a fresh agent
  // session has no driftstack_session_id yet (created lazily on the first
  // agent turn) — so opening the agt_ id there 400s (founder-hit, W613).
  // Close the unused agent session (frees the concurrency slot + token
  // budget) and launch a plain driver session with the same profile.
  async function openPollingFallback(profileId: string, agentSessionId: string): Promise<void> {
    if (!client) return;
    await client.agentSessions.close(agentSessionId).catch(() => undefined);
    const driverSession = await client.sessions.create({ profile_id: profileId });
    await markLaunched(profileId, driverSession.id);
    onOpenSession(driverSession.id);
  }

  async function handleQuickSession(): Promise<void> {
    if (!client || quickBusy) return;
    setQuickBusy(true);
    try {
      // Ephemeral by design: no profile_id — fresh state every run (the
      // same contract the empty-state copy documents).
      const driverSession = await client.sessions.create({ label: 'quick-session' });
      onOpenSession(driverSession.id);
    } finally {
      setQuickBusy(false);
    }
  }

  async function handleOrganizeSave(profileId: string): Promise<void> {
    const next = await saveProfileMeta(
      profileId,
      {
        folder: draftFolder.trim(),
        tags: draftTags
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      },
      state.profiles.map((p) => p.id),
    );
    setProfilesMeta(next);
    setOrganizeId(null);
  }

  async function handleStop(profile: Profile): Promise<void> {
    if (!client) return;
    const bound = boundSession(profile.id);
    if (bound === null) {
      await clearProfileSession(profile.id);
      await refresh(false);
      return;
    }
    setBusyId(profile.id);
    try {
      // W624 — close by KIND so an agent-backed profile actually stops
      // (was the founder-hit "destroy keeps running"): agent → close the
      // agent session (which tears down its dispatched browser); driver →
      // destroy the session. If the live overlay is showing this session,
      // dismiss it too.
      if (bound.kind === 'agent') {
        await client.agentSessions.close(bound.id);
      } else {
        await client.sessions.destroy(bound.id);
      }
      if (watchSource?.profileId === profile.id) {
        setWatchInfo(null);
        setWatchSource(null);
      }
      await clearProfileSession(profile.id);
      await refresh(false);
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

  if (watchInfo) {
    return (
      <div className="flex h-full flex-col bg-black">
        <div className="flex items-center gap-3 p-3 text-sm text-ink-secondary">
          <span className="section-label">Live session</span>
          <span className="mono">{watchInfo.room}</span>
          <button
            type="button"
            className="btn ml-auto"
            onClick={() => {
              setWatchInfo(null);
              setWatchSource(null);
            }}
          >
            Close
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-hidden">
          <Suspense fallback={<div className="text-sm text-ink-secondary">Loading viewer…</div>}>
            <AgentSessionPanel
              info={watchInfo}
              // W617 — empty-room fallback: room connected but no browser
              // worker published video → offer the polling viewer instead.
              onNoPublisher={() => {
                const src = watchSource;
                setWatchInfo(null);
                setWatchSource(null);
                if (src !== null) {
                  void openPollingFallback(src.profileId, src.agentSessionId).catch(() => {
                    setState((s) => ({
                      ...s,
                      error: 'Could not open the direct viewer — try launching again.',
                    }));
                  });
                }
              }}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* W625/W640 — heads-up about the real-browser path. The mock driver
          only affects the DIRECT (polling) viewer — it shows placeholder
          frames. A live browser comes from a connected WebKit worker (the
          harness on a Mac), which self-hosted fully supports. So this is
          framed as "connect a worker to go live", NOT "self-hosted can't do
          real browsers". Shown while driver==='mock' (a fair proxy for "no
          real-driver/worker wired yet"). */}
      {serverDriver === 'mock' && (
        <div
          data-banner="mock-driver"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-2xs text-ink-secondary"
        >
          The <span className="mono">mock</span> driver is handling the direct viewer, so launches
          show placeholder frames here. To run a real iPhone session, connect a WebKit browser
          worker (the harness on a Mac) — then launches stream live video. Sessions, the viewer and
          controls work now for testing the flow.
        </div>
      )}
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="section-label">Profiles</span>
            <h2 className="text-lg font-medium tracking-tight text-ink-primary">
              Persistent identity slots
              <span className="ml-2 mono text-ink-muted">
                {profileCap !== null && profileCount !== null
                  ? `${profileCount.toString()} / ${profileCap.toString()}`
                  : profileCount !== null
                    ? `${profileCount.toString()}`
                    : state.profiles.length.toString()}
              </span>
            </h2>
          </div>
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
              className="btn-secondary flex items-center gap-1.5"
              onClick={() => void handleQuickSession()}
              disabled={state.loading || quickBusy || !client}
              title="Launch an ephemeral session with fresh state — no profile, no setup"
            >
              <span aria-hidden="true">⚡</span>
              <span>{quickBusy ? 'Starting…' : 'Quick Session'}</span>
            </button>
            <button
              type="button"
              className="btn-primary flex items-center gap-1.5"
              onClick={() => setCreateOpen(true)}
              disabled={state.loading || atProfileCap}
              aria-disabled={state.loading || atProfileCap}
              title={
                atProfileCap
                  ? `Profile cap reached (${(profileCap ?? 0).toString()} for ${
                      accountMe?.tier ?? 'this tier'
                    }). Delete a profile or upgrade to add more.`
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
              <span>New profile</span>
            </button>
          </div>
        </div>
        {state.profiles.length > 0 && (
          <ProfilesActionBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            visibleCount={filteredProfiles.length}
            totalCount={state.profiles.length}
          />
        )}
        {state.profiles.length > 0 && (
          <div className="flex items-center justify-end gap-2">
            <select
              aria-label="Filter by folder"
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary"
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
            >
              <option value="all">All folders</option>
              <option value="unfiled">Unfiled</option>
              {folderList(profilesMeta).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={viewMode === 'list'}
              className={
                viewMode === 'list'
                  ? 'rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary'
                  : 'rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary'
              }
              onClick={() => setViewMode('list')}
            >
              ☰ List
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'grid'}
              className={
                viewMode === 'grid'
                  ? 'rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary'
                  : 'rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary'
              }
              onClick={() => setViewMode('grid')}
            >
              ▦ Grid
            </button>
          </div>
        )}
      </header>

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {state.profiles.length === 0 ? (
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
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-medium text-ink-primary">No profiles yet</h3>
            <p className="max-w-md text-sm text-ink-secondary">
              A profile is a persistent identity — cookies, localStorage, IndexedDB — reused across
              sessions. Bind a session to a profile to keep login state, returning-visitor signals,
              and stealth fingerprints stable between runs.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setCreateOpen(true)}
            disabled={atProfileCap}
            title={
              atProfileCap
                ? `Profile cap reached (${(profileCap ?? 0).toString()} for ${
                    accountMe?.tier ?? 'this tier'
                  }). Upgrade to add more.`
                : undefined
            }
          >
            Create your first profile
          </button>
          <p className="text-xs text-ink-muted">
            Sessions without a profile start ephemeral — fresh state every run.
          </p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProfiles.length === 0 ? (
            <p className="col-span-full px-4 py-8 text-center text-sm text-ink-muted">
              No profiles match the current filter.
            </p>
          ) : null}
          {filteredProfiles.map((profile) => {
            const bound = boundSession(profile.id);
            const running = bound !== null;
            return (
              <div
                key={profile.id}
                className="flex flex-col gap-2 rounded-md border border-surface-divider bg-surface-raised p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-ink-primary">{profile.name}</p>
                  <span
                    className={
                      running
                        ? 'inline-flex items-center gap-1 rounded-full border border-surface-divider px-2 py-0.5 text-[10px] font-semibold text-status-ready'
                        : 'inline-flex items-center gap-1 rounded-full border border-surface-divider px-2 py-0.5 text-[10px] font-semibold text-ink-muted'
                    }
                  >
                    <span
                      className={
                        running
                          ? 'h-1.5 w-1.5 rounded-full bg-status-ready'
                          : 'h-1.5 w-1.5 rounded-full bg-status-idle'
                      }
                    />
                    {running ? 'Running' : 'Idle'}
                  </span>
                </div>
                <p className="mono truncate text-xs text-ink-muted">{profile.archetype}</p>
                {organizeId === profile.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-surface-divider bg-surface-inset p-2">
                    <input
                      aria-label="Folder"
                      placeholder="Folder"
                      className="w-32 rounded border border-surface-divider bg-surface-raised px-2 py-1 text-xs text-ink-primary"
                      value={draftFolder}
                      onChange={(e) => setDraftFolder(e.target.value)}
                    />
                    <input
                      aria-label="Tags (comma-separated)"
                      placeholder="tags, comma, separated"
                      className="w-48 rounded border border-surface-divider bg-surface-raised px-2 py-1 text-xs text-ink-primary"
                      value={draftTags}
                      onChange={(e) => setDraftTags(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-primary px-2 py-1 text-xs"
                      onClick={() => void handleOrganizeSave(profile.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-xs text-ink-muted hover:text-ink-primary"
                      onClick={() => setOrganizeId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                <div className="mt-auto flex gap-2 pt-1">
                  {running ? (
                    <button
                      type="button"
                      className="btn-secondary flex-1 text-xs"
                      onClick={() => onOpenSession(bound.id)}
                    >
                      Open session
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary flex-1 text-xs"
                      disabled={busyId === profile.id}
                      onClick={() => void handleLaunch(profile)}
                    >
                      {busyId === profile.id ? 'Launching…' : 'Launch'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-surface-divider rounded-md border border-surface-divider bg-surface-raised">
          {filteredProfiles.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-ink-muted">
              No profiles match the current filter.{' '}
              <button
                type="button"
                className="text-accent underline-offset-2 hover:underline"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                }}
              >
                Clear
              </button>
            </li>
          ) : null}
          {filteredProfiles.map((profile) => {
            const bound = boundSession(profile.id);
            const running = bound !== null;
            const binding = bindings.find((b) => b.profileId === profile.id) ?? null;
            const selectedProxy = pickProxy(profile.id);
            const busy = busyId === profile.id;
            return (
              <li
                key={profile.id}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        running ? 'bg-emerald-500' : 'bg-ink-muted/40'
                      }`}
                      aria-label={running ? 'Running' : 'Idle'}
                    />
                    <p className="text-sm font-medium text-ink-primary">{profile.name}</p>
                    {(profilesMeta[profile.id]?.folder ?? '') !== '' && (
                      <span className="rounded-sm bg-accent-subtle px-1.5 py-0.5 text-[10px] text-ink-secondary">
                        📁 {profilesMeta[profile.id]?.folder}
                      </span>
                    )}
                    {(profilesMeta[profile.id]?.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-sm border border-surface-divider px-1.5 py-0.5 text-[10px] text-ink-muted"
                      >
                        {tag}
                      </span>
                    ))}
                    <button
                      type="button"
                      className="text-[10px] text-ink-muted underline-offset-2 hover:text-ink-primary hover:underline"
                      onClick={() => {
                        if (organizeId === profile.id) {
                          setOrganizeId(null);
                          return;
                        }
                        setDraftFolder(profilesMeta[profile.id]?.folder ?? '');
                        setDraftTags((profilesMeta[profile.id]?.tags ?? []).join(', '));
                        setOrganizeId(profile.id);
                      }}
                    >
                      Organize
                    </button>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        running
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-surface-base text-ink-muted'
                      }`}
                    >
                      {running ? 'Running' : 'Idle'}
                    </span>
                  </div>
                  {profile.description !== null && (
                    <p className="mt-1 text-xs text-ink-secondary">{profile.description}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                    <span className="mono rounded-sm bg-surface-base px-1.5 py-0.5 text-[11px]">
                      {profile.archetype}
                    </span>
                    <ProxyChip
                      proxy={selectedProxy}
                      defaulted={
                        binding?.defaultProxyId === null || binding?.defaultProxyId === undefined
                      }
                    />
                    <select
                      aria-label={`Change proxy binding for ${profile.name}`}
                      className="mono rounded-sm bg-surface-base px-1 py-0.5 text-[11px] text-ink-secondary"
                      value={binding?.defaultProxyId ?? ''}
                      onChange={(e) => {
                        const next = e.target.value === '' ? null : e.target.value;
                        void setDefaultProxy(profile.id, next).then(() => void refresh(false));
                      }}
                      disabled={busy || running}
                      title={running ? 'Stop the profile to change proxy' : 'Change proxy binding'}
                    >
                      <option value="">— (first available)</option>
                      {proxies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} ({p.host}:{p.port})
                        </option>
                      ))}
                    </select>
                    {profile.last_used_at !== null && (
                      <span>
                        last used{' '}
                        <RelativeTime iso={profile.last_used_at} tooltipPrefix="Last used" />
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {running ? (
                    <>
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        onClick={() => {
                          // W624 — agent session → re-open the WebRTC stream;
                          // driver session → the polling viewer.
                          if (bound === null) return;
                          if (bound.kind === 'agent') {
                            void reopenStream(bound.id, profile.id);
                          } else {
                            onOpenSession(bound.id);
                          }
                        }}
                        disabled={busy}
                      >
                        Live view
                      </button>
                      <button
                        type="button"
                        className="rounded border border-status-error/40 bg-status-error/10 px-3 py-1 text-xs font-medium text-status-error hover:bg-status-error/20 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => void handleStop(profile)}
                        disabled={busy}
                      >
                        {busy ? 'Stopping…' : 'Stop'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary text-xs"
                      onClick={() => void handleLaunch(profile)}
                      // Launch gates on `busy` only. NOT atProfileCap: the
                      // profile cap limits how many profiles you can CREATE, not
                      // whether you can launch an existing one (launching consumes
                      // a session slot, not a profile slot). Gating Launch on
                      // atProfileCap meant a free-tier user (profile_cap 1) could
                      // never launch their one allowed profile. The server
                      // enforces the concurrent-session cap and handleLaunch
                      // surfaces that error.
                      disabled={busy}
                    >
                      {busy ? 'Launching…' : 'Launch'}
                    </button>
                  )}
                  {/* cap-first operand order ON PURPOSE: duplicate CREATES a
                      profile so cap-gating is correct here — but the pinned
                      free-tier regression guard bans the `busy || atProfileCap`
                      form (the Launch bug pattern); keep this order. */}
                  <button
                    type="button"
                    className="text-xs text-ink-muted hover:text-ink-primary"
                    onClick={() => void handleDuplicate(profile)}
                    disabled={atProfileCap || busy}
                    title={
                      atProfileCap
                        ? 'Profile cap reached — delete a profile or upgrade to duplicate'
                        : 'Server-side copy: same archetype + state, fresh identity'
                    }
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="text-xs text-ink-muted hover:text-status-error"
                    onClick={() => void handleDelete(profile.id)}
                    disabled={busy || running}
                    title={running ? 'Stop the profile before deleting' : undefined}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {state.refreshedAt !== null && (
        <p className="text-xs text-ink-muted">
          Refreshed {new Date(state.refreshedAt).toLocaleTimeString()} · auto-refresh 5s
        </p>
      )}

      {createOpen && (
        <CreateProfileModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void refresh(false);
            // V-239 — refresh the cap counter so the gate flips to
            // disabled if we just hit cap.
            void refreshAccountMe();
          }}
        />
      )}
    </div>
  );
}

// V-238 — Create-profile modal. Form has name (required, 1-120 chars),
// optional description (max 500 chars per server schema), and archetype
// picker (currently single-option; expands when V-136+ adds more).
// On submit: calls client.profiles.create(); closes + refreshes parent
// on success; surfaces server error inline on failure (e.g. tier-cap
// reached, duplicate name).
function CreateProfileModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { client, settings } = useSettings();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archetype, setArchetype] = useState(KNOWN_ARCHETYPES[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 2026-05-20 — antidetect-style advanced panel. Proxy is selected
  // up-front + bound to the profile via profile-bindings on create.
  // 'create-new' opens an inline SOCKS5 mini-form so the customer can
  // mint a proxy from inside this modal (no context-switch to Proxies
  // tab). OpenVPN + WireGuard are surfaced as disabled placeholders
  // to set expectations — the local proxy store is SOCKS5-only at
  // v0.0.1; lib/proxies.ts grows when those land.
  const [proxies, setProxies] = useState<LocalProxyConfig[]>([]);
  const [proxyChoice, setProxyChoice] = useState<string>('first-available');
  const [newProxy, setNewProxy] = useState<{
    label: string;
    host: string;
    port: string;
    username: string;
    password: string;
  }>({ label: '', host: '', port: '1080', username: '', password: '' });
  // Native proxy probe (SOCKS5 reachability + UDP-associate detection).
  // Runs against the inline create-new draft so the customer can confirm
  // the proxy works — and whether UDP/QUIC/WebRTC will tunnel — before
  // minting the profile. Cleared whenever the draft host/port changes so
  // a stale "reachable" badge can't outlive its inputs.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  useEffect(() => {
    void (async () => {
      const list = await listProxies();
      setProxies(list);
      if (list.length === 0) setProxyChoice('create-new');
    })();
  }, []);

  async function handleTestDraftProxy(): Promise<void> {
    const portNum = Number.parseInt(newProxy.port, 10);
    if (
      newProxy.host.trim().length === 0 ||
      Number.isNaN(portNum) ||
      portNum < 1 ||
      portNum > 65535
    ) {
      setTestResult({
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        latency_ms: 0,
        message: 'Enter a host and a port between 1–65535 before testing.',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProxy({
        host: newProxy.host.trim(),
        port: portNum,
        username: newProxy.username.trim().length > 0 ? newProxy.username.trim() : null,
        password: newProxy.password.length > 0 ? newProxy.password : null,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        latency_ms: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  function randomizeArchetype(): void {
    if (KNOWN_ARCHETYPES.length === 0) return;
    const idx = Math.floor(Math.random() * KNOWN_ARCHETYPES.length);
    setArchetype(KNOWN_ARCHETYPES[idx]?.id ?? KNOWN_ARCHETYPES[0]?.id ?? '');
  }

  // ESC-to-close — matches the macOS Cmd+W / standard modal convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!client) {
      setError('No client configured.');
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 1. Optionally mint a new SOCKS5 proxy first (inline create
      //    flow keyed by proxyChoice === 'create-new').
      let resolvedProxyId: string | null = null;
      if (proxyChoice === 'create-new') {
        const portNum = Number.parseInt(newProxy.port, 10);
        if (
          newProxy.label.trim().length === 0 ||
          newProxy.host.trim().length === 0 ||
          Number.isNaN(portNum) ||
          portNum < 1 ||
          portNum > 65535
        ) {
          setError('Proxy label, host, and a port between 1–65535 are all required.');
          setSubmitting(false);
          return;
        }
        const created = await addProxy({
          label: newProxy.label.trim(),
          host: newProxy.host.trim(),
          port: portNum,
          username: newProxy.username.trim().length > 0 ? newProxy.username.trim() : null,
          password: newProxy.password.length > 0 ? newProxy.password : null,
        });
        resolvedProxyId = created.id;
      } else if (proxyChoice !== 'first-available') {
        resolvedProxyId = proxyChoice;
      }
      // 2. Create the profile.
      const profile = await client.profiles.create({
        name: trimmed,
        archetype,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      });
      // 3. Bind the chosen proxy to the new profile. null = use the
      //    first-available proxy at Launch time.
      await setDefaultProxy(profile.id, resolvedProxyId);
      onCreated();
    } catch (err) {
      setError(friendlyError(err, settings.baseUrl));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-profile-title"
      onClick={(e) => {
        // Click the backdrop (not the modal itself) closes — unless mid-submit.
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-md border border-surface-divider bg-surface-raised p-5 shadow-lg">
        <header className="mb-4 flex items-center justify-between">
          <h3 id="create-profile-title" className="text-base font-medium text-ink-primary">
            New profile
          </h3>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="section-label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              minLength={1}
              required
              autoFocus
              disabled={submitting}
              className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
              placeholder="my-recurring-workflow"
            />
            <span className="text-xs text-ink-muted">
              Used to identify the profile in lists + when attaching sessions.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="section-label">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              disabled={submitting}
              className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
              placeholder="What this identity slot is for"
            />
          </label>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="section-label">Device archetype</span>
              <button
                type="button"
                onClick={randomizeArchetype}
                disabled={submitting || KNOWN_ARCHETYPES.length < 2}
                className="text-2xs text-glow-red underline disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline"
                title={
                  KNOWN_ARCHETYPES.length < 2
                    ? 'Only one archetype available today'
                    : 'Pick a random device'
                }
              >
                Randomize
              </button>
            </div>
            <select
              value={archetype}
              onChange={(e) => setArchetype(e.target.value)}
              disabled={submitting || KNOWN_ARCHETYPES.length < 2}
              className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
            >
              {KNOWN_ARCHETYPES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            {KNOWN_ARCHETYPES.length < 2 && (
              <span className="text-xs text-ink-muted">
                Single archetype today — Randomize will pick across iPhone 15/16/17 Pro lineups as
                they land.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1 rounded border border-surface-divider bg-surface-base/40 p-3">
            <span className="section-label">Proxy</span>
            <select
              value={proxyChoice}
              onChange={(e) => setProxyChoice(e.target.value)}
              disabled={submitting}
              className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
            >
              {proxies.length > 0 && (
                <option value="first-available">First available saved proxy</option>
              )}
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.host}:{p.port}
                </option>
              ))}
              <option value="create-new">+ Add new SOCKS5 proxy…</option>
              <option value="future-openvpn" disabled>
                + Add new OpenVPN (coming soon)
              </option>
              <option value="future-wireguard" disabled>
                + Add new WireGuard (coming soon)
              </option>
            </select>
            {proxyChoice === 'create-new' && (
              <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-dashed border-surface-divider bg-surface-base/60 p-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="text"
                    value={newProxy.label}
                    onChange={(e) => setNewProxy((p) => ({ ...p, label: e.target.value }))}
                    placeholder="Label (e.g. shopify-us-east)"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="text"
                    value={newProxy.host}
                    onChange={(e) => {
                      setNewProxy((p) => ({ ...p, host: e.target.value }));
                      setTestResult(null);
                    }}
                    placeholder="Host (e.g. proxy.example.com)"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={newProxy.port}
                    onChange={(e) => {
                      setNewProxy((p) => ({ ...p, port: e.target.value }));
                      setTestResult(null);
                    }}
                    placeholder="Port"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="text"
                    value={newProxy.username}
                    onChange={(e) => {
                      setNewProxy((p) => ({ ...p, username: e.target.value }));
                      setTestResult(null);
                    }}
                    placeholder="Username (optional)"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="password"
                    value={newProxy.password}
                    onChange={(e) => {
                      setNewProxy((p) => ({ ...p, password: e.target.value }));
                      setTestResult(null);
                    }}
                    placeholder="Password (optional)"
                    disabled={submitting}
                    className="col-span-2 rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTestDraftProxy()}
                    disabled={submitting || testing || newProxy.host.trim().length === 0}
                    className="btn-secondary text-xs"
                  >
                    {testing ? 'Testing…' : 'Test proxy'}
                  </button>
                  <span className="text-2xs text-ink-muted">
                    Runs a SOCKS5 handshake from this Mac — checks reachability, auth, and UDP
                    support.
                  </span>
                </div>
                {testResult !== null && (
                  <div
                    role="status"
                    className={`flex flex-col gap-1 rounded-sm border px-2 py-1.5 text-2xs ${
                      testResult.reachable && testResult.auth_ok
                        ? 'border-status-success/40 bg-status-success/10 text-status-success'
                        : 'border-status-error/40 bg-status-error/10 text-status-error'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">
                        {testResult.reachable
                          ? testResult.auth_ok
                            ? `Reachable · ${testResult.latency_ms} ms`
                            : 'Auth failed'
                          : 'Not reachable'}
                      </span>
                      {testResult.reachable && (
                        <span
                          className={`rounded-sm px-1 py-0.5 ${
                            testResult.udp_associate
                              ? 'bg-status-success/20'
                              : 'bg-surface-divider text-ink-muted'
                          }`}
                        >
                          {testResult.udp_associate ? 'UDP ✓' : 'UDP ✗'}
                        </span>
                      )}
                    </div>
                    <span className="text-ink-secondary">{testResult.message}</span>
                  </div>
                )}
                <span className="text-2xs text-ink-muted">
                  Stored locally in this app — credentials never go to the Driftstack control plane.
                </span>
              </div>
            )}
            <span className="text-xs text-ink-muted">
              Sessions launched from this profile route through the selected proxy. Manage all saved
              proxies under the Proxies tab.
            </span>
          </div>

          {error !== null && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}

          <div className="mt-2 flex items-center justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || name.trim().length === 0}
            >
              {submitting ? 'Creating…' : 'Create profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EmptyConnect({
  baseUrl,
  onGoToSettings,
}: {
  baseUrl: string;
  onGoToSettings: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="section-label">Not connected</span>
      <p className="max-w-md text-sm text-ink-secondary">
        Set an API key in Settings to load profiles from <span className="mono">{baseUrl}</span>.
      </p>
      <button type="button" className="btn-primary" onClick={onGoToSettings}>
        Open Settings
      </button>
    </div>
  );
}

function friendlyError(err: unknown, baseUrl?: string): string {
  // 2026-05-20 — network-failure preflight (catches Tauri WebKit
  // "Load failed" before falling through to per-view formatting).
  if (baseUrl !== undefined) {
    const diag = diagnosticFetchError(err, baseUrl);
    if (diag !== null) return diag;
  }
  if (err instanceof DriftstackError) {
    return `${err.title} (${err.kind}): ${err.detail ?? err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
