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
  persistProfilesMeta,
  saveProfileMeta,
  seedMetaFromServer,
  saveProfilesMetaBulk,
  type ProfilesMetaMap,
} from '../lib/profiles-meta';
import {
  loadProbeCache,
  saveProbeResult,
  saveExitResult,
  type ProbeCacheMap,
} from '../lib/proxy-probe-cache';
import { loadTemplates, saveTemplate, type ProfileTemplate } from '../lib/profile-templates';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
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
  probeProxyExit,
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
  const { client, settings, accountMe, refreshAccountMe, activeWorkspace, setActiveWorkspace } =
    useSettings();
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
  // Grid is the DEFAULT (founder directive 2026-06-12 night arc) — the
  // visual workspace is the product; list remains a toggle for dense ops.
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
  const [quickBusy, setQuickBusy] = useState(false);
  // Increment 2 — client-persisted organization (folders/tags/notes).
  const [profilesMeta, setProfilesMeta] = useState<ProfilesMetaMap>({});
  // Night-arc B: last probe result per proxy id (written by the Proxies
  // tab's Test actions) — cards render the UDP badge from it; absent =
  // honest 'untested'.
  const [probeCache, setProbeCache] = useState<ProbeCacheMap>({});
  // S3 — per-card proxy "Test" in flight (proxy id), so the card can show
  // "Testing…" + disable the button while the native SOCKS5 + exit-geo probe runs.
  const [testingProxyId, setTestingProxyId] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [organizeId, setOrganizeId] = useState<string | null>(null);
  // Increment 3 — bulk select: client-side organize actions over a selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkFolder, setBulkFolder] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  // Onboarding checklist dismissal — webview localStorage persists per
  // install. Guarded: some embeddings/test environments stub storage out.
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try {
      return localStorage.getItem('ds_onboarding_dismissed') === '1';
    } catch {
      return false;
    }
  });
  // Night-arc D — privacy banner (hub demo). Claims limited to wording
  // already shipped on the production dashboard trust surface; the
  // demo's stronger phrasing stays gated on founder+legal sign-off.
  const [privacyDismissed, setPrivacyDismissed] = useState(() => {
    try {
      return localStorage.getItem('ds_privacy_banner_dismissed') === '1';
    } catch {
      return false;
    }
  });
  const [draftFolder, setDraftFolder] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>('all');
  const [sortBy, setSortBy] = useState<ProfileSortBy>('last-used');

  useEffect(() => {
    void loadProfilesMeta().then(setProfilesMeta);
    void loadProbeCache().then(setProbeCache);
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
        // Organization sync Phase 2 — seed-down: profiles organized on
        // another device (server folder/tags set, no local entry) get a
        // local entry so the hub shows them immediately. Local-vs-server
        // conflicts: local wins; the next edit's write-through reconciles.
        setProfilesMeta((local) => {
          const seeded = seedMetaFromServer(local, profilesPage);
          if (!seeded.changed) return local;
          void persistProfilesMeta(
            seeded.map,
            // Prune orphans ONLY in Personal — there the listed profiles are
            // the authoritative full set. In a team workspace `profilesPage`
            // is the OWNER's profiles; pruning against it would delete the
            // member's personal org metadata (data-loss). Orphan entries are
            // keyed by globally-unique uuids → harmless; they self-clean on
            // the next Personal refresh.
            activeWorkspace === null ? profilesPage.map((p) => p.id) : undefined,
          ).catch(() => undefined);
          return seeded.map;
        });
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
      const reopenProxy = pickProxy(profileId);
      const sim = await openSimulatorWindow({
        sessionId: agentSessionId,
        info,
        deviceName: formatDeviceName(reopened?.archetype ?? ''),
        profileName: reopened?.name,
        ...(reopenProxy !== null
          ? { proxyLabel: `${reopenProxy.label} · ${reopenProxy.host}:${String(reopenProxy.port)}` }
          : {}),
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

  // Workspace-scoped org metadata for folder ENUMERATION (sidebar / pickers).
  // profiles-meta.json is a single global store keyed by globally-unique
  // profile uuid; seed-down adds the active workspace's owner folders to it,
  // so enumerating the whole map would bleed one workspace's folders into
  // another's view. Scope folder lists to the currently-listed profiles
  // (state.profiles = the active workspace's set). Per-profile chip/filter
  // reads stay keyed by id directly (unambiguous).
  const scopedMeta = useMemo<ProfilesMetaMap>(() => {
    const out: ProfilesMetaMap = {};
    for (const p of state.profiles) {
      const m = profilesMeta[p.id];
      if (m) out[p.id] = m;
    }
    return out;
  }, [state.profiles, profilesMeta]);

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
  // S3 — test a profile's bound proxy right from the hub card (founder: "not a
  // proxy check"). Runs the native SOCKS5 capability probe + the exit-geo probe
  // and persists both to the shared probe cache, so the card immediately shows
  // exit IP / country / latency / last-checked / UDP. Mirrors the canonical
  // ProxiesView.handleTest flow. Best-effort: a probe failure keeps prior state.
  async function handleTestProxy(px: LocalProxyConfig): Promise<void> {
    setTestingProxyId(px.id);
    try {
      const result = await testProxy({
        host: px.host,
        port: px.port,
        username: px.username,
        password: px.password,
      });
      setProbeCache(await saveProbeResult(px.id, result, Date.now()));
      if (result.reachable && result.auth_ok) {
        const exit = await probeProxyExit({
          host: px.host,
          port: px.port,
          username: px.username,
          password: px.password,
        });
        if (exit !== null) {
          setProbeCache(await saveExitResult(px.id, exit.ip, exit.country));
        }
      }
    } catch {
      /* best-effort — the card keeps its prior probe state on failure */
    } finally {
      setTestingProxyId(null);
    }
  }

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
          ...(pickProxy(profile.id) !== null
            ? {
                proxyLabel: `${pickProxy(profile.id)?.label ?? ''} · ${pickProxy(profile.id)?.host ?? ''}:${String(pickProxy(profile.id)?.port ?? '')}`,
              }
            : {}),
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
      // Personal-only prune (see refresh seed-down): never prune the global
      // org store against a team workspace's profile list.
      activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
    );
    setProfilesMeta(next);
    setOrganizeId(null);
    // Phase 2 write-through: persist organization server-side too
    // (migration 0076 columns). Best-effort — offline or a pre-0076
    // server (which strips the fields) must never break the local save
    // the user just watched succeed. Local store remains the UI source.
    const saved = next[profileId];
    if (client && saved) {
      void client.profiles
        .update(profileId, {
          folder: saved.folder.length > 0 ? saved.folder : null,
          tags: saved.tags,
        })
        .catch(() => undefined);
    }
  }

  function toggleSelected(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkApply(): Promise<void> {
    if (selectedIds.size === 0) return;
    const meta: { folder?: string; tags?: string[] } = {};
    if (bulkFolder.trim().length > 0) meta.folder = bulkFolder.trim();
    if (bulkTag.trim().length > 0) meta.tags = [bulkTag.trim()];
    if (meta.folder === undefined && meta.tags === undefined) return;
    const next = await saveProfilesMetaBulk(
      [...selectedIds],
      meta,
      'merge',
      // Personal-only prune (see refresh seed-down).
      activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
    );
    setProfilesMeta(next);
    // Phase 2 write-through (same best-effort contract as the single-
    // profile organize save): push each selected profile's merged result.
    if (client) {
      for (const id of selectedIds) {
        const saved = next[id];
        if (!saved) continue;
        void client.profiles
          .update(id, {
            folder: saved.folder.length > 0 ? saved.folder : null,
            tags: saved.tags,
          })
          .catch(() => undefined);
      }
    }
    setSelectedIds(new Set());
    setBulkFolder('');
    setBulkTag('');
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
      {/* ALWAYS-RENDERED workspace recovery bar (independent of profiles/
          accountMe load state). A persisted activeWorkspace pointing at a
          team the user was REMOVED from 403s every request → profiles +
          accountMe both empty → the in-stats-row switcher (gated on those)
          never renders → the hub would be bricked with no way back. This
          bar guarantees a Switch-to-Personal escape regardless of load
          state. */}
      {activeWorkspace !== null && (
        <div
          data-component="workspace-recovery-bar"
          className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent-subtle px-3 py-2 text-xs"
        >
          <span className="text-ink-primary">
            Viewing a team workspace
            <span className="mono ml-1.5 text-ink-muted">{activeWorkspace}</span>
          </span>
          <button
            type="button"
            className="ml-auto rounded-full border border-surface-divider bg-surface-raised px-2.5 py-0.5 font-medium text-ink-primary hover:border-accent"
            onClick={() => setActiveWorkspace(null)}
          >
            ↩ Switch to Personal
          </button>
        </div>
      )}
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
      {!privacyDismissed && (
        <div
          data-component="privacy-banner"
          className="flex items-center gap-3 rounded-lg border border-surface-divider bg-surface-raised px-4 py-2.5"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
            className="shrink-0 text-accent"
          >
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p className="flex-1 text-xs text-ink-secondary">
            <b className="text-ink-primary">Sealed &amp; private.</b> Profile state is sealed with
            per-profile encryption under your account's own key hierarchy; proxies and credentials
            stay on this device — never uploaded to the control plane.
          </p>
          <button
            type="button"
            aria-label="Dismiss privacy note"
            className="text-xs text-ink-muted hover:text-ink-primary"
            onClick={() => {
              setPrivacyDismissed(true);
              try {
                localStorage.setItem('ds_privacy_banner_dismissed', '1');
              } catch {
                /* session-only dismissal */
              }
            }}
          >
            ✕
          </button>
        </div>
      )}
      {state.profiles.length > 0 && (
        <div data-component="hub-stats" className="grid grid-cols-4 gap-3">
          <HubStat n={String(state.profiles.length)} l="Profiles" />
          <HubStat
            n={String(state.profiles.filter((p) => boundSession(p.id) !== null).length)}
            l="Running now"
            tone="ok"
          />
          <HubStat n={String(proxies.length)} l="Proxies" />
          <HubStat n={String(folderList(scopedMeta).length)} l="Folders" />
          {/* Team workspace indicator (hub demo, honest v1): memberships
              from /v1/account/me. Workspace SWITCHING (X-Driftstack-Account
              effective-account) is the named follow-up — this surfaces the
              real memberships so the demo's team surface stops being
              invisible. */}
          {(accountMe?.teams?.length ?? 0) > 0 && (
            <div
              data-component="workspace-strip"
              className="col-span-4 flex flex-wrap items-center gap-2 rounded-md border border-surface-divider bg-surface-raised px-3 py-2 text-xs"
            >
              <span className="section-label">Workspaces</span>
              {/* The chips ARE the switcher (half-2): selecting rebuilds the
                  client with the SDK effectiveAccount option; every list/
                  action then runs against that workspace (writes need the
                  admin role — server-enforced, surfaced via the role label). */}
              <button
                type="button"
                aria-pressed={activeWorkspace === null}
                className={`rounded-full px-2 py-0.5 ${
                  activeWorkspace === null
                    ? 'bg-accent-subtle font-medium text-ink-primary'
                    : 'border border-surface-divider text-ink-secondary hover:border-ink-muted/40'
                }`}
                onClick={() => setActiveWorkspace(null)}
              >
                Personal
              </button>
              {(accountMe?.teams ?? []).map((t) => (
                <button
                  key={t.membership_id}
                  type="button"
                  aria-pressed={activeWorkspace === t.owner_account_id}
                  className={`rounded-full px-2 py-0.5 ${
                    activeWorkspace === t.owner_account_id
                      ? 'bg-accent-subtle font-medium text-ink-primary'
                      : 'border border-surface-divider text-ink-secondary hover:border-ink-muted/40'
                  }`}
                  title={`Owner account ${t.owner_account_id}`}
                  onClick={() => setActiveWorkspace(t.owner_account_id)}
                >
                  Team · {t.role}
                </button>
              ))}
              {activeWorkspace !== null && (
                <span className="ml-auto text-2xs text-ink-muted">
                  Viewing a team workspace — writes need the admin role.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {!onboardingDismissed && (
        <OnboardingChecklist
          steps={[
            {
              id: 'connect',
              label: 'Connect your account',
              done: settings.apiKey !== null,
              go: onGoToSettings,
            },
            {
              id: 'profile',
              label: 'Create a profile',
              done: (accountMe?.profile_count ?? 0) > 0 || state.profiles.length > 0,
              go: () => setCreateOpen(true),
            },
            {
              id: 'launch',
              label: 'Launch a session',
              done: (accountMe?.concurrent_session_active ?? 0) > 0 || activeSessions.length > 0,
            },
          ]}
          onDismiss={() => {
            try {
              localStorage.setItem('ds_onboarding_dismissed', '1');
            } catch {
              /* storage unavailable — session-only dismissal */
            }
            setOnboardingDismissed(true);
          }}
        />
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
            {state.refreshedAt !== null && (
              <span className="text-2xs text-ink-muted">
                Refreshed {new Date(state.refreshedAt).toLocaleTimeString()} · auto-refresh 5s
              </span>
            )}
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
              {folderList(scopedMeta).map((f) => (
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

      {selectedIds.size > 0 && (
        <div
          data-component="bulk-bar"
          className="flex flex-wrap items-center gap-2 rounded-md border border-surface-divider bg-surface-raised px-3 py-2"
        >
          <span className="text-xs font-medium text-ink-primary">
            {selectedIds.size.toString()} selected
          </span>
          <FolderPicker
            ariaLabel="Bulk folder"
            noneLabel="Move to folder…"
            folders={folderList(scopedMeta)}
            value={bulkFolder}
            onChange={setBulkFolder}
          />
          <input
            aria-label="Bulk tag"
            placeholder="Add tag…"
            className="w-32 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
            value={bulkTag}
            onChange={(e) => setBulkTag(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary px-2.5 py-1 text-xs"
            onClick={() => void handleBulkApply()}
            disabled={bulkFolder.trim().length === 0 && bulkTag.trim().length === 0}
          >
            Apply
          </button>
          <button
            type="button"
            className="text-xs text-ink-muted hover:text-ink-primary"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </button>
        </div>
      )}
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
      ) : (
        <div className="flex min-h-0 flex-1 items-start gap-3">
          {/* Folders sidebar (hub-demo port — replaces the old dropdown
              filter). Counts derive from the same organization map the
              filter reads; selection drives folderFilter unchanged. */}
          <nav
            aria-label="Folders"
            className="flex w-40 shrink-0 flex-col gap-0.5 rounded-md border border-surface-divider bg-surface-raised p-2"
          >
            <FolderItem
              label="All profiles"
              count={state.profiles.length}
              active={folderFilter === 'all'}
              onSelect={() => setFolderFilter('all')}
            />
            <FolderItem
              label="Unfiled"
              count={state.profiles.filter((p) => (profilesMeta[p.id]?.folder ?? '') === '').length}
              active={folderFilter === 'unfiled'}
              onSelect={() => setFolderFilter('unfiled')}
            />
            {folderList(scopedMeta).map((f) => (
              <FolderItem
                key={f}
                label={f}
                count={state.profiles.filter((p) => profilesMeta[p.id]?.folder === f).length}
                active={folderFilter === f}
                onSelect={() => setFolderFilter(f)}
              />
            ))}
          </nav>
          <div className="min-w-0 flex-1">
            {viewMode === 'grid' ? (
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
                      className="group flex flex-col gap-2 rounded-md border border-surface-divider bg-surface-raised p-4 transition-colors hover:border-accent/50"
                    >
                      <div className="flex items-start gap-3">
                        {/* iPhone silhouette (night-arc B): pure-CSS device
                            shape — Dynamic-Island notch, screen glow when
                            running. Decorative; facts live in the text. */}
                        <div
                          aria-hidden="true"
                          className={`relative h-16 w-9 shrink-0 rounded-[9px] border-2 ${
                            running
                              ? 'border-accent bg-accent-subtle shadow-[0_0_10px] shadow-accent/30'
                              : 'border-surface-divider bg-surface-inset'
                          }`}
                        >
                          <span className="absolute left-1/2 top-1 h-1 w-3 -translate-x-1/2 rounded-full bg-ink-muted/40" />
                          {running && (
                            <span className="absolute bottom-1.5 right-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-status-ready" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium text-ink-primary">
                              {profile.name}
                            </p>
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
                          <p className="mono truncate text-xs text-ink-muted">
                            {deviceLine(profile.archetype)}
                          </p>
                          {/* Egress strip: bound proxy host:port + UDP badge
                              from the LAST probe (Proxies tab Test) — honest
                              'untested' when never probed. Exit country
                              arrives with the echo endpoint. */}
                          {(() => {
                            const px = pickProxy(profile.id);
                            if (px === null) return null;
                            const probe = probeCache[px.id];
                            return (
                              <div className="mono mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-secondary">
                                <span className="truncate">
                                  {probe?.exitCountry ? flagEmoji(probe.exitCountry) : '🌍'}{' '}
                                  {px.label} · {px.host}:{px.port}
                                  {probe?.exitIp !== undefined && ` → ${probe.exitIp}`}
                                  {probe?.result.latency_ms !== undefined &&
                                    ` · ${probe.result.latency_ms}ms`}
                                </span>
                                {probe?.at !== undefined && (
                                  <span className="shrink-0 text-ink-muted">
                                    checked{' '}
                                    <RelativeTime
                                      iso={new Date(probe.at).toISOString()}
                                      tooltipPrefix="Proxy checked"
                                    />
                                  </span>
                                )}
                                {probe ? (
                                  <span
                                    className={`shrink-0 rounded-sm px-1 py-px ${
                                      probe.result.udp_associate
                                        ? 'bg-status-ready/15 text-status-ready'
                                        : 'bg-surface-inset text-ink-muted line-through'
                                    }`}
                                    title={
                                      probe.result.udp_associate
                                        ? 'UDP relay verified — QUIC + WebRTC tunnel through this exit.'
                                        : 'No UDP relay on last test — sessions fall back to h2 / TURN-over-TCP.'
                                    }
                                  >
                                    UDP
                                  </span>
                                ) : (
                                  <span
                                    className="shrink-0 rounded-sm bg-surface-inset px-1 py-px text-ink-muted"
                                    title="Never probed — click Test to check it."
                                  >
                                    untested
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleTestProxy(px);
                                  }}
                                  disabled={testingProxyId === px.id}
                                  className="ml-auto shrink-0 rounded-sm border border-surface-divider px-1.5 py-px text-ink-muted transition-colors hover:border-accent hover:text-ink-primary disabled:opacity-50"
                                  title="Test this proxy — reachability, latency, and exit IP / country"
                                >
                                  {testingProxyId === px.id ? 'Testing…' : 'Test'}
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      {/* Organization chips — folder + tags VISIBLE on the
                          default grid view (founder: 'missing folders,
                          tags'); same data as the list rows. */}
                      {((profilesMeta[profile.id]?.folder ?? '') !== '' ||
                        (profilesMeta[profile.id]?.tags ?? []).length > 0) && (
                        <div className="flex flex-wrap items-center gap-1">
                          {(profilesMeta[profile.id]?.folder ?? '') !== '' && (
                            <span className="rounded-full border border-surface-divider bg-surface-inset px-2 py-0.5 text-[10px] text-ink-secondary">
                              📁 {profilesMeta[profile.id]?.folder}
                            </span>
                          )}
                          {(profilesMeta[profile.id]?.tags ?? []).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full border border-surface-divider px-2 py-0.5 text-[10px] text-ink-muted"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {organizeId === profile.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-surface-divider bg-surface-inset p-2">
                          <FolderPicker
                            ariaLabel="Folder"
                            noneLabel="Unfiled"
                            folders={folderList(scopedMeta)}
                            value={draftFolder}
                            onChange={setDraftFolder}
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
                            // In a team workspace these are the OWNER's profiles
                            // (profiles.list honors X-Driftstack-Account). Launch
                            // goes through agent-sessions create, which is
                            // self-scoped + ships the profile DEK — server RBAC
                            // for member-launches-owner-profile is unresolved, so
                            // it would 404. Gate it honestly: launch from Personal.
                            disabled={busyId === profile.id || activeWorkspace !== null}
                            title={
                              activeWorkspace !== null
                                ? 'Launching a team-workspace profile isn’t available yet — switch to Personal to launch your own.'
                                : undefined
                            }
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
                          <input
                            type="checkbox"
                            aria-label={`Select ${profile.name}`}
                            className="h-3.5 w-3.5 accent-[var(--accent)]"
                            checked={selectedIds.has(profile.id)}
                            onChange={() => toggleSelected(profile.id)}
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
                              binding?.defaultProxyId === null ||
                              binding?.defaultProxyId === undefined
                            }
                          />
                          <select
                            aria-label={`Change proxy binding for ${profile.name}`}
                            className="mono rounded-sm bg-surface-base px-1 py-0.5 text-[11px] text-ink-secondary"
                            value={binding?.defaultProxyId ?? ''}
                            onChange={(e) => {
                              const next = e.target.value === '' ? null : e.target.value;
                              void setDefaultProxy(profile.id, next).then(
                                () => void refresh(false),
                              );
                            }}
                            disabled={busy || running}
                            title={
                              running ? 'Stop the profile to change proxy' : 'Change proxy binding'
                            }
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
                            // surfaces that error. ALSO gated in a team workspace —
                            // these are the owner's profiles + agent-sessions launch is
                            // self-scoped (would 404); launch from Personal.
                            disabled={busy || activeWorkspace !== null}
                            title={
                              activeWorkspace !== null
                                ? 'Launching a team-workspace profile isn’t available yet — switch to Personal to launch your own.'
                                : undefined
                            }
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
          </div>
        </div>
      )}

      {createOpen && (
        <CreateProfileModal
          existingFolders={folderList(scopedMeta)}
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
  existingFolders,
}: {
  onClose: () => void;
  onCreated: () => void;
  /** Folder names for the Notes-tab picker (from the hub's organization map). */
  existingFolders: string[];
}): JSX.Element {
  const { client, settings } = useSettings();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archetype, setArchetype] = useState(KNOWN_ARCHETYPES[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Configurator port (founder-approved profile-create demo, 2026-06-12):
  // tabbed layout + live identity-preview rail. Storage/Behavior tabs are
  // informational (their facts are real, their controls are future).
  const [tab, setTab] = useState<'identity' | 'proxy' | 'storage' | 'behavior' | 'notes'>(
    'identity',
  );
  // Organization metadata at create (backend columns, migration 0076).
  const [folder, setFolder] = useState('');
  const [tags, setTags] = useState('');
  // Night-arc H: named create-presets (demo's From-template / Save-as-
  // template) — client-side store; loading one fills the form fields.
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  useEffect(() => {
    void loadTemplates().then(setTemplates);
  }, []);
  function applyTemplate(t: ProfileTemplate): void {
    if (t.archetype.length > 0 && ARCHETYPE_REGISTRY.some((a) => a.id === t.archetype)) {
      setArchetype(t.archetype);
    }
    setDescription(t.description);
    setFolder(t.folder);
    setTags(t.tags);
    setTemplateNotice(`Loaded template "${t.name}" — give the profile a name.`);
  }
  async function handleSaveTemplate(): Promise<void> {
    const tplName =
      name.trim().length > 0 ? name.trim() : `template-${String(templates.length + 1)}`;
    const next = await saveTemplate({
      name: tplName,
      archetype,
      description,
      folder,
      tags,
      savedAt: Date.now(),
    });
    setTemplates(next);
    setTemplateNotice(`Saved as template "${tplName}".`);
  }
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
      // 2. Create the profile (organization metadata rides the create —
      //    backend columns since migration 0076; a pre-0076 server strips
      //    the unknown fields harmlessly).
      // Clamp to the server caps HERE too (the organize paths go through
      // cleanEntry; create previously didn't — a 25-char tag 400'd the
      // whole create).
      const tagList = tags
        .split(',')
        .map((t) => t.trim().slice(0, 24))
        .filter((t) => t.length > 0)
        .slice(0, 12);
      const profile = await client.profiles.create({
        name: trimmed,
        archetype,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        ...(folder.trim().length > 0 ? { folder: folder.trim().slice(0, 32) } : {}),
        ...(tagList.length > 0 ? { tags: [...new Set(tagList)] } : {}),
      });
      // Mirror into the local organization cache so the hub shows the
      // folder/tags immediately (and offline).
      if (folder.trim().length > 0 || tagList.length > 0) {
        await saveProfileMeta(profile.id, { folder: folder.trim(), tags: tagList });
      }
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
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-md border border-surface-divider bg-surface-raised p-5 shadow-lg">
        <header className="mb-3 flex items-center justify-between">
          <h3 id="create-profile-title" className="text-base font-medium text-ink-primary">
            New profile
          </h3>
          <div className="flex items-center gap-2">
            {templates.length > 0 && (
              <select
                aria-label="From template"
                className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-secondary"
                value=""
                disabled={submitting}
                onChange={(e) => {
                  const t = templates.find((x) => x.name === e.target.value);
                  if (t) applyTemplate(t);
                }}
              >
                <option value="" disabled>
                  ⎘ From template…
                </option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>
        {templateNotice !== null && (
          <p role="status" className="mb-2 text-2xs text-accent">
            {templateNotice}
          </p>
        )}

        {/* Configurator tabs (demo port). role=tablist keyboardable via the buttons. */}
        <div
          role="tablist"
          aria-label="Profile configuration"
          className="mb-3 flex gap-1 border-b border-surface-divider"
        >
          {(
            [
              ['identity', '📱 Identity'],
              ['proxy', '🌍 Proxy'],
              ['storage', '🍪 Storage'],
              ['behavior', '🖐 Behavior'],
              ['notes', '🏷 Notes & tags'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`-mb-px rounded-t border-b-2 px-3 py-1.5 text-xs ${
                tab === id
                  ? 'border-accent font-medium text-ink-primary'
                  : 'border-transparent text-ink-muted hover:text-ink-secondary'
              }`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {tab === 'identity' && (
              <>
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

                <div className="flex flex-col gap-2 rounded border border-surface-divider bg-surface-base/40 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-medium text-ink-primary">Device & identity</h4>
                      <p className="mt-0.5 text-2xs text-ink-muted">
                        A bit-exact mobile fingerprint, not a spoofed user-agent — pick the device;
                        everything stays coherent with it.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={randomizeArchetype}
                      disabled={submitting || KNOWN_ARCHETYPES.length < 2}
                      className="text-2xs text-accent underline disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline"
                      title={
                        KNOWN_ARCHETYPES.length < 2
                          ? 'Only one archetype available today'
                          : 'Pick a random device'
                      }
                    >
                      Randomize
                    </button>
                  </div>
                  {/* Device cards (demo port): selectable launch archetypes +
                disabled reference baselines — honest registry facts only. */}
                  <div className="grid grid-cols-3 gap-2">
                    {ARCHETYPE_REGISTRY.map((a) => {
                      const selectable = a.status === 'launch';
                      const on = archetype === a.id;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          disabled={!selectable || submitting}
                          aria-pressed={on}
                          onClick={() => setArchetype(a.id)}
                          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left ${
                            on ? 'border-accent ring-1 ring-accent' : 'border-surface-divider'
                          } ${selectable ? 'hover:border-ink-muted/40' : 'cursor-not-allowed opacity-50'}`}
                        >
                          <span aria-hidden="true">📱</span>
                          <span className="text-sm font-medium text-ink-primary">{a.device}</span>
                          <span className="mono text-2xs text-ink-muted">
                            iOS {a.iosVersion} · Safari {a.safariVersion}
                          </span>
                          <span
                            className={`mt-1 rounded-full px-1.5 py-0.5 text-2xs ${
                              selectable
                                ? 'bg-status-ready/15 text-status-ready'
                                : 'bg-surface-inset text-ink-muted'
                            }`}
                          >
                            {selectable ? '✓ bit-exact' : 'reference'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col gap-1 rounded border border-surface-divider bg-surface-base/40 p-3">
                  <h4 className="text-sm font-medium text-ink-primary">Locale &amp; timezone</h4>
                  <p className="text-xs text-ink-secondary">
                    Auto-follows the proxy exit geo at session time — language, locale and timezone
                    never contradict the IP. No overrides: coherence is the point.
                  </p>
                </div>
              </>
            )}

            {tab === 'proxy' && (
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
                      Stored locally in this app — credentials never go to the Driftstack control
                      plane.
                    </span>
                  </div>
                )}
                <span className="text-xs text-ink-muted">
                  Sessions launched from this profile route through the selected proxy. Manage all
                  saved proxies under the Proxies tab.
                </span>
              </div>
            )}

            {tab === 'storage' && (
              <div className="flex flex-col gap-2 rounded border border-surface-divider bg-surface-base/40 p-3">
                <h4 className="text-sm font-medium text-ink-primary">Persistent browser state</h4>
                <p className="text-xs text-ink-secondary">
                  Cookies, localStorage and IndexedDB persist across this profile's sessions — log
                  in once, stay logged in. State is sealed with per-profile encryption under your
                  account's own key hierarchy; staff can't read it.
                </p>
                <p className="text-2xs text-ink-muted">
                  Always on for profile-backed sessions — nothing to configure here yet. Snapshots
                  (point-in-time copies) live on the profile's row actions after creation.
                </p>
              </div>
            )}

            {tab === 'behavior' && (
              <div className="flex flex-col gap-2 rounded border border-surface-divider bg-surface-base/40 p-3">
                <h4 className="text-sm font-medium text-ink-primary">Human-cadence input</h4>
                <p className="text-xs text-ink-secondary">
                  Taps, scrolls and typing run through the behavioral simulation layer — native
                  events with human timing, not synthetic JavaScript. On by default for every
                  session this profile launches.
                </p>
                <p className="text-2xs text-ink-muted">
                  Per-session behavioral profiles are selectable via the API/SDK (behavioral_profile
                  on session create); a per-profile default lands here when the backend grows that
                  column.
                </p>
              </div>
            )}

            {tab === 'notes' && (
              <>
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
                <label className="flex flex-col gap-1">
                  <span className="section-label">Folder (optional)</span>
                  <FolderPicker
                    ariaLabel="Profile folder"
                    noneLabel="No folder"
                    folders={existingFolders}
                    value={folder}
                    onChange={setFolder}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="section-label">Tags (optional, comma-separated)</span>
                  <input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                    placeholder="retail, warmup"
                  />
                  <span className="text-2xs text-ink-muted">
                    Up to 12 tags, 24 characters each — synced to your account and shown across
                    devices.
                  </span>
                </label>
              </>
            )}
          </div>

          {/* Live identity-preview rail (demo port — verified facts only). */}
          <aside
            data-component="identity-preview-rail"
            className="flex w-60 shrink-0 flex-col gap-2 self-start rounded-md border border-surface-divider bg-surface-base/40 p-3"
          >
            <span className="section-label">Live identity preview</span>
            <p className="truncate text-sm font-medium text-ink-primary">
              {name.trim().length > 0 ? name.trim() : 'unnamed profile'}
            </p>
            {/* Identity panel (demo's coherence ring, honest version): the
                ring renders the VERIFIED state of the selected archetype —
                launch archetypes are device-verified bit-exact; no invented
                numeric score. */}
            <div className="flex items-center gap-2.5 rounded border border-surface-divider bg-surface-base/60 p-2">
              <div
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-status-ready text-status-ready"
              >
                ✓
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink-primary">Identity coherence</p>
                <p className="text-2xs text-ink-muted">bit-exact archetype · engine-deep</p>
              </div>
            </div>
            {(() => {
              const a = ARCHETYPE_REGISTRY.find((x) => x.id === archetype);
              return (
                <dl className="flex flex-col">
                  <PreviewRow k="Device" v={a?.device ?? '—'} />
                  <PreviewRow
                    k="iOS / Safari"
                    v={a ? `${a.iosVersion} / ${a.safariVersion}` : '—'}
                  />
                  <PreviewRow k="Locale" v="follows proxy exit" />
                  <PreviewRow
                    k="Proxy"
                    v={
                      proxyChoice === 'create-new'
                        ? newProxy.label.trim() || 'new SOCKS5'
                        : proxyChoice === 'first-available'
                          ? 'first available'
                          : (proxies.find((p) => p.id === proxyChoice)?.label ?? '—')
                    }
                  />
                  <PreviewRow k="Storage" v="🔒 sealed" />
                  <PreviewRow k="Tags" v={tags.trim().length > 0 ? tags.trim() : '—'} />
                </dl>
              );
            })()}
            <p className="rounded-sm border border-surface-divider bg-surface-base/60 p-2 text-2xs text-ink-muted">
              <b className="text-ink-secondary">What a site sees:</b> a genuine iPhone — Apple's
              engine with a bit-exact device identity, not a spoofed user-agent.
            </p>

            {error !== null && (
              <p className="text-xs text-status-error" role="alert">
                {error}
              </p>
            )}

            <div className="mt-1 flex flex-col gap-1.5">
              <button
                type="submit"
                className="btn-primary"
                disabled={submitting || name.trim().length === 0}
              >
                {submitting ? 'Creating…' : 'Create profile'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="text-2xs text-ink-muted underline-offset-2 hover:text-ink-primary hover:underline"
                onClick={() => void handleSaveTemplate()}
                disabled={submitting}
              >
                ⎘ Save as template
              </button>
            </div>
          </aside>
        </form>
      </div>
    </div>
  );
}

// Folder picker (founder UX fix, night arc): SELECT existing folders
// instead of retyping names — '__new__' reveals a free-text input;
// '' = no change (bulk) / unfiled (organize). Controlled entirely by
// the caller through value/onChange.
function FolderPicker({
  value,
  onChange,
  folders,
  ariaLabel,
  noneLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  folders: string[];
  ariaLabel: string;
  noneLabel: string;
}): JSX.Element {
  const isCustom = value.length > 0 && !folders.includes(value);
  const [mode, setMode] = useState<'pick' | 'new'>(isCustom ? 'new' : 'pick');
  // External clears (bulk apply resets value to '') drop back to the
  // select — otherwise the picker strands on an empty 'new' input.
  useEffect(() => {
    if (value === '' && mode === 'new') setMode('pick');
    // NOTE: deliberately depends on `value` only — `mode` is the state
    // this effect manages; depending on it would re-close user-opened
    // 'new' inputs (this workspace doesn't enable react-hooks lint rules,
    // so no disable directive is needed or valid here).
  }, [value]);
  return (
    <span className="inline-flex items-center gap-1">
      {mode === 'pick' ? (
        <select
          aria-label={ariaLabel}
          className="w-36 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
          value={folders.includes(value) ? value : ''}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setMode('new');
              onChange('');
            } else {
              onChange(e.target.value);
            }
          }}
        >
          <option value="">{noneLabel}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              📁 {f}
            </option>
          ))}
          <option value="__new__">＋ New folder…</option>
        </select>
      ) : (
        <>
          <input
            aria-label={`${ariaLabel} (new)`}
            placeholder="New folder name"
            autoFocus
            maxLength={32}
            className="w-32 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            aria-label="Back to folder list"
            className="text-xs text-ink-muted hover:text-ink-primary"
            onClick={() => {
              setMode('pick');
              onChange('');
            }}
          >
            ↩
          </button>
        </>
      )}
    </span>
  );
}

function HubStat({ n, l, tone }: { n: string; l: string; tone?: 'ok' }): JSX.Element {
  // S4 — Console-density stat tile: mono tabular numerals (the "metric" feel
  // from console.html) + the app's section-label for the caption.
  return (
    <div className="rounded-md border border-surface-divider bg-surface-raised px-3 py-2">
      <p
        className={`mono text-xl font-semibold tabular-nums tracking-tight ${tone === 'ok' ? 'text-status-ready' : 'text-ink-primary'}`}
      >
        {n}
      </p>
      <p className="section-label mt-0.5">{l}</p>
    </div>
  );
}

// Folder visual identity (founder: folders "look boring without any images").
// All/Unfiled get fixed glyphs; named folders get a 📁 plus a deterministic
// color dot hashed from the name so each folder is visually distinguishable
// at a glance without requiring per-folder icon metadata.
export function folderGlyph(label: string): string {
  if (label === 'All profiles') return '🗂️';
  if (label === 'Unfiled') return '📥';
  return '📁';
}

export function folderColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i += 1) h = (h * 31 + label.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 55%)`;
}

function FolderItem({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  const namedFolder = label !== 'All profiles' && label !== 'Unfiled';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs ${
        active
          ? 'bg-accent-subtle font-medium text-ink-primary'
          : 'text-ink-secondary hover:bg-surface-inset'
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="shrink-0 text-[11px] leading-none">
          {folderGlyph(label)}
        </span>
        {namedFolder && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: folderColor(label) }}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className="mono text-2xs text-ink-muted">{count}</span>
    </button>
  );
}

function PreviewRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-surface-divider py-1 text-xs last:border-0">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="truncate text-ink-primary">{v}</dd>
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

/** Human device line from the registry — 'iPhone 17 · iOS 18.7 · Safari 26.4';
 *  unknown archetypes fall back to the raw slug (never crash on growth). */
function deviceLine(archetypeId: string): string {
  const a = ARCHETYPE_REGISTRY.find((x) => x.id === archetypeId);
  if (!a) return archetypeId;
  return `${a.device} · iOS ${a.iosVersion} · Safari ${a.safariVersion}`;
}

/** ISO-3166 alpha-2 → regional-indicator flag emoji ('NL' → 🇳🇱). */
function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌍';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
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
