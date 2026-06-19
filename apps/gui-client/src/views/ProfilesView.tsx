// Profiles view — list profiles, create new, delete.
//
// V-136 (Tier 3 draft). Persistent identity slots that survive across
// sessions. Each profile carries its own cookies + localStorage; the
// driver attaches them to a session when the session is created against
// a profile.
//
// Mirrors SessionsView shape: 5-second poll, inline error banner, busy
// state per row.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  folderList,
  aggregateTags,
  loadProfilesMeta,
  persistProfilesMeta,
  saveProfileMeta,
  seedMetaFromServer,
  saveProfilesMetaBulk,
  type ProfilesMetaMap,
} from '../lib/profiles-meta';
import { loadFolders, addFolder, loadFolderIcons, replaceAllFolders } from '../lib/folders-store';
import { loadTags, addTag, replaceAllTags } from '../lib/tags-store';
import { fetchOrganization, saveOrganization } from '../lib/account-organization';
import {
  loadProbeCache,
  saveProbeResult,
  saveExitResult,
  type ProbeCacheMap,
} from '../lib/proxy-probe-cache';
import { downloadJson, timestampedFilename } from '../lib/download';
import { useConfirm } from '../components/ConfirmProvider';
import { loadTemplates, saveTemplate, type ProfileTemplate } from '../lib/profile-templates';
import { PROFILE_ICONS } from '../lib/profile-icons';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import {
  ProfilesActionBar,
  type ProfileSortBy,
  type ProfileStatusFilter,
} from '../components/ProfilesActionBar';
import { ProxyCapabilityChips, proxyCapabilities } from '../components/ProxyCapabilities';
import { ProfilePhoneCard } from '../components/ProfilePhoneCard';
import { RelativeTime } from '../components/RelativeTime';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableSortKey,
} from '../components/ProfilesTable';
import { ARCHETYPE_REGISTRY, type ArchetypeStatus } from '@driftstack/sdk';
import { openSimulatorWindow } from '../lib/open-simulator';
import { mintGuiControlKey, getPageState } from '../lib/agent-session-control';
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
  setProxyServerId,
  testProxy,
  probeProxyExit,
  type ProxyConfig as LocalProxyConfig,
  type ProxyTestResult,
} from '../lib/proxies';
import {
  createProxy as createAccountProxy,
  updateProxy as updateAccountProxy,
} from '../lib/account-proxies';

// 2026-05-20 — match SessionsView: slow background poll + skip the
// visible loading flicker on tick refreshes so the panel doesn't
// constantly re-flash.
const REFRESH_MS = 15_000;

// Cold-start grace for the agent-session LIVENESS check (founder 2026-06-18:
// "always says open session even on long-expired/failed sessions"). An active
// agent session whose worker crashed / never came up stays `active` server-side
// for up to the 12h reaper cap, so it falsely reads "running". We probe the
// worker page-state: page_state non-null → a worker is driving it (running);
// page_state null AND the session is older than this window → no worker activity
// past startup, treat as dead (idle). Within the window a fresh launch's worker
// may still be spinning up (page_state legitimately null), so we keep it running
// to avoid flapping a just-launched profile to idle.
const SESSION_LIVENESS_GRACE_MS = 90_000;

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
  // L4b recycle bin — null for live profiles; set for trashed ones (only the
  // GET /v1/profiles/trash response carries a non-null value).
  deleted_at: string | null;
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
  /** F1c — open the AI assistant scoped to a profile (from a card's "Assist"). */
  onAssist?: (profileId: string) => void;
}

export function ProfilesView({
  onGoToSettings,
  onOpenSession,
  onAssist,
}: ProfilesViewProps): JSX.Element {
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
  // Worktimer (2026-06-16) — agent sessions (id + created_at) for the running-
  // row live-elapsed timer; agent sessions aren't in activeSessions (driver-
  // only), so we fetch them separately. Empty when the runtime isn't wired.
  const [agentSessions, setAgentSessions] = useState<
    Array<{ id: string; created_at: string; status: string }>
  >([]);
  // True once the live agent-session list has been fetched at least once. Until
  // then boundSession TRUSTS the binding — a transient list-fetch miss must not
  // flip a genuinely-running profile to idle.
  const [agentSessionsLoaded, setAgentSessionsLoaded] = useState(false);
  // Liveness cache (founder 2026-06-18) — per agent session id, whether the last
  // worker page-state probe found a worker driving the page. Probed only for the
  // bounded set of agt_-bound sessions on the existing refresh cadence (no idle
  // polling). boundSession consults this to demote an active-but-dead session to
  // idle. A not-yet-probed id (absent here) → boundSession trusts the binding,
  // same best-effort contract as agentSessionsLoaded.
  const [sessionLiveness, setSessionLiveness] = useState<
    Record<string, { pageStatePresent: boolean; checkedAt: number }>
  >({});
  const [bindings, setBindings] = useState<ProfileBinding[]>([]);
  const [proxies, setProxies] = useState<LocalProxyConfig[]>([]);
  // V-239 — gate the New profile button at the tier cap (skip when
  // profile_cap === null which means enterprise / no fixed cap).
  const profileCap = accountMe?.profile_cap ?? null;
  const profileCount = accountMe?.profile_count ?? null;
  const atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap;
  // Teams (2026-06-16) — the server now lets a team ADMIN launch the owner's
  // profiles (agent-sessions create honors X-Driftstack-Account for admins;
  // the client already ships that header for the active workspace). So launch
  // is blocked only for NON-admin members of a team workspace; admins + Personal
  // can launch.
  const activeRole =
    activeWorkspace !== null
      ? ((accountMe?.teams ?? []).find((t) => t.owner_account_id === activeWorkspace)?.role ?? null)
      : null;
  const teamLaunchBlocked = activeWorkspace !== null && activeRole !== 'admin';
  const teamLaunchBlockedReason =
    'Shared team profile — ask a team admin to launch it (you have read-only access here).';
  const [state, setState] = useState<ProfilesState>({
    profiles: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
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
  // List-view (table) sort — default by name asc. Header clicks toggle dir.
  const [sortKey, setSortKey] = useState<ProfilesTableSortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
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
  // 2026-06-15 (founder) — user-created folder names persisted independently of
  // profiles, so an empty folder made from the rail's "New folder" affordance
  // survives. The rail/pickers show the UNION of these + folders derived from
  // profile metadata. `newFolderName` drives the inline create input.
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  // 2026-06-16 (founder) — per-folder icon (name→emoji), shown in the rail.
  const [customFolderIcons, setCustomFolderIcons] = useState<Record<string, string>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderIcon, setNewFolderIcon] = useState('');
  // G3 — filter the grid by a single tag (null = all). Composes (AND) with the
  // folder + status + search filters.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 2026-06-16 (founder) — tags moved into the LEFT rail under Folders, with a
  // create affordance mirroring "New folder". User-created tag names persist so
  // an empty tag survives; the rail shows the UNION of these + derived tags.
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [creatingTag, setCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  // Increment 3 — bulk select: client-side organize actions over a selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkFolder, setBulkFolder] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const [bulkExporting, setBulkExporting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkLaunching, setBulkLaunching] = useState(false);
  // L4b recycle bin — Trash view: a rail entry flips trashView on, which swaps
  // the grid/table for a list of soft-deleted profiles with Restore actions.
  const [trashView, setTrashView] = useState(false);
  const [trashed, setTrashed] = useState<Profile[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const confirm = useConfirm();
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
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>('all');
  const [sortBy, setSortBy] = useState<ProfileSortBy>('last-used');

  useEffect(() => {
    void loadProfilesMeta().then(setProfilesMeta);
    void loadProbeCache().then(setProbeCache);
    void loadFolders().then(setCustomFolders);
    void loadFolderIcons().then(setCustomFolderIcons);
    void loadTags().then(setCustomTags);
  }, []);

  // org-sync phase 3c (2026-06-16) — pull the account-level taxonomy (empty
  // folders/icons + tags) from the server so it follows the account across
  // machines. Server WINS on a successful load; the local folders/tags store
  // (loaded above) is the offline cache, kept aligned via replaceAll*. Re-runs
  // if the key/baseUrl change. Failure (offline/unauth) keeps the local cache.
  useEffect(() => {
    const apiKey = settings.apiKey;
    if (apiKey === null || apiKey.length === 0) return;
    void (async () => {
      try {
        const org = await fetchOrganization(settings.baseUrl, apiKey);
        const names = org.folders.map((f) => f.name);
        const icons: Record<string, string> = {};
        for (const f of org.folders)
          if (f.icon !== undefined && f.icon.length > 0) icons[f.name] = f.icon;
        setCustomFolders([...names].sort((a, b) => a.localeCompare(b)));
        setCustomFolderIcons(icons);
        setCustomTags([...org.tags].sort((a, b) => a.localeCompare(b)));
        await replaceAllFolders(names, icons);
        await replaceAllTags(org.tags);
      } catch {
        /* offline / unauth → keep the local cache loaded on mount */
      }
    })();
  }, [settings.apiKey, settings.baseUrl]);

  // org-sync — push the full account taxonomy to the server after a local
  // mutation (best-effort; the local store stays the source if it fails).
  const pushOrg = useCallback(
    (folders: string[], icons: Record<string, string>, tags: string[]): void => {
      if (settings.apiKey === null || settings.apiKey.length === 0) return;
      const org = {
        folders: folders.map((name) =>
          icons[name] !== undefined && icons[name].length > 0
            ? { name, icon: icons[name] }
            : { name },
        ),
        tags,
      };
      void saveOrganization(settings.baseUrl, settings.apiKey, org).catch(() => undefined);
    },
    [settings.apiKey, settings.baseUrl],
  );

  // Liveness probe (founder 2026-06-18) — for each agt_-bound session that's
  // still present in the live list AND not closed, GET its worker page-state and
  // cache whether a worker is driving it. Scoped to the bounded set of bound
  // sessions (NOT all profiles); runs on the existing refresh cadence only. The
  // probes are best-effort + independent (one failure can't blank the others);
  // getPageState returns null on failure, in which case we leave the cache entry
  // untouched so boundSession falls back to trusting the binding.
  const probeSessionLiveness = useCallback(
    (
      currentBindings: ProfileBinding[],
      liveSessions: Array<{ id: string; status: string }>,
    ): void => {
      const apiKey = settings.apiKey;
      if (apiKey === null || apiKey.length === 0) return;
      const boundIds = new Set(
        currentBindings
          .map((b) => b.currentSessionId)
          .filter(
            (sid): sid is string => sid !== null && sid !== undefined && sid.startsWith('agt_'),
          ),
      );
      const targets = liveSessions.filter((s) => boundIds.has(s.id) && s.status !== 'closed');
      for (const s of targets) {
        void getPageState(settings.baseUrl, apiKey, s.id).then((present) => {
          if (present === null) return; // transient failure → keep prior verdict
          setSessionLiveness((prev) => ({
            ...prev,
            [s.id]: { pageStatePresent: present, checkedAt: Date.now() },
          }));
        });
      }
    },
    [settings.apiKey, settings.baseUrl],
  );

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
        // Worktimer (founder) — fetch agent sessions (best-effort, separate
        // from the critical Promise.all: the list endpoint 503s when the agent
        // runtime isn't wired, which must not blank the whole hub). Gives the
        // running-row live "running for" timer the agent session's created_at
        // (driver sessions already carry it in activeSessions).
        if (typeof client.agentSessions.list === 'function') {
          void client.agentSessions
            .list()
            .then((page) => {
              setAgentSessions(
                page.data.map((s) => ({ id: s.id, created_at: s.created_at, status: s.status })),
              );
              setAgentSessionsLoaded(true);
              // Liveness probe (founder 2026-06-18) — for the BOUNDED set of
              // agt_-bound sessions still present + not closed, probe the worker
              // page-state so boundSession can demote an active-but-dead binding
              // to idle. Probe on this existing refresh cadence only (no idle
              // polling). Best-effort: getPageState returns null on any failure,
              // and we only write a present/absent verdict (true/false) — a probe
              // failure leaves the prior cache entry (or absent → trust binding).
              void probeSessionLiveness(currentBindings, page.data);
            })
            .catch(() => undefined);
        }
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
    [client, settings.baseUrl, probeSessionLiveness],
  );

  // L4b — load the account's trashed profiles for the recycle-bin view.
  // Best-effort: an older server without /trash (404/405) just yields [].
  const loadTrash = useCallback(async (): Promise<void> => {
    if (!client || typeof client.profiles.listTrash !== 'function') {
      setTrashed([]);
      return;
    }
    setTrashLoading(true);
    try {
      const page = await client.profiles.listTrash();
      setTrashed(page.data);
    } catch {
      setTrashed([]);
    } finally {
      setTrashLoading(false);
    }
  }, [client]);

  // L4b — restore a trashed profile, then refresh both the trash list and the
  // live profile list. A 409 (a live profile took the name) surfaces as a
  // notice telling the customer to rename first.
  const handleRestore = useCallback(
    async (id: string): Promise<void> => {
      if (!client) return;
      setRestoringId(id);
      try {
        await client.profiles.restore(id);
        await Promise.all([loadTrash(), refresh(false)]);
      } catch (err) {
        const status = (err as { status?: number }).status;
        await confirm(
          status === 409
            ? 'A live profile already uses this name. Rename it, then restore again.'
            : friendlyError(err, settings.baseUrl),
          { confirmLabel: 'OK' },
        );
      } finally {
        setRestoringId(null);
      }
    },
    [client, loadTrash, refresh, confirm, settings.baseUrl],
  );

  // L4b anti-abuse — permanently delete a trashed profile (frees its cap slot
  // immediately; trashed profiles otherwise hold a slot until the 30-day
  // auto-purge). Irreversible, so we gate it behind a destructive confirm.
  const handlePurge = useCallback(
    async (id: string, name: string): Promise<void> => {
      if (!client || typeof client.profiles.purge !== 'function') return;
      const ok = await confirm(
        `Permanently delete “${name}”? This frees a profile slot but can’t be undone — the profile is gone for good.`,
        { confirmLabel: 'Delete permanently' },
      );
      if (!ok) return;
      setPurgingId(id);
      try {
        await client.profiles.purge(id);
        await Promise.all([loadTrash(), refresh(false)]);
      } catch (err) {
        await confirm(friendlyError(err, settings.baseUrl), { confirmLabel: 'OK' });
      } finally {
        setPurgingId(null);
      }
    },
    [client, loadTrash, refresh, confirm, settings.baseUrl],
  );

  // Switching account/workspace must NOT carry the prior account's agent-session
  // cache forward — boundSession would otherwise match a stale agt_ id from the
  // other account and falsely report a profile running until the next list
  // fetch lands. Reset to the not-yet-loaded state so boundSession trusts only
  // the binding until the fresh list arrives.
  useEffect(() => {
    setAgentSessions([]);
    setAgentSessionsLoaded(false);
    // Drop the liveness cache too — a stale page-state verdict from the prior
    // account must not influence boundSession after a workspace switch.
    setSessionLiveness({});
  }, [client, activeWorkspace]);

  useEffect(() => {
    void refresh(true);
    const id = window.setInterval(() => void refresh(false), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleDelete(id: string): Promise<void> {
    if (!client) return;
    // Founder 2026-06-16 — confirm before a single-profile delete (the bulk bar
    // already confirms; the per-row/card delete did not). Profile delete is a
    // permanent server hard-delete (the identity's cookies/storage/fingerprint
    // + its encryption key are destroyed), so it must not fire on a stray click.
    const name = state.profiles.find((p) => p.id === id)?.name ?? 'this profile';
    const ok = await confirm(
      `Delete "${name}"? This permanently removes the profile's identity — its cookies, storage, and fingerprint — from your account and can't be undone.`,
      { confirmLabel: 'Delete' },
    );
    if (!ok) return;
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
    if (sid.startsWith('agt_')) {
      // Self-heal stale agent bindings to idle (founder 2026-06-18: "always says
      // open session even on long-expired/failed sessions"). Once the live
      // agent-session list has loaded, a bound session reads as running ONLY if
      // it's still present AND not closed (expired/failed → closed or gone).
      // Before the first successful list fetch, trust the binding so a transient
      // fetch miss doesn't flip a genuinely-live session to idle.
      if (!agentSessionsLoaded) return { id: sid, kind: 'agent' };
      const live = agentSessions.find((s) => s.id === sid);
      if (live === undefined || live.status === 'closed') return null;
      // LIVENESS (founder 2026-06-18) — an `active`-but-DEAD session (worker
      // crashed / never came up) stays `active` for up to the 12h reaper cap, so
      // the list check above isn't enough. Consult the worker page-state probe:
      //   • page_state present → a worker is driving the page → RUNNING.
      //   • page_state absent AND the session is older than the cold-start grace
      //     → no worker activity past startup → treat as IDLE (return null) so
      //     the row shows Launch, not Open session.
      //   • page_state absent but WITHIN the grace (just launched, worker still
      //     spinning up) → keep RUNNING so a fresh launch doesn't flap to idle.
      // Best-effort: a not-yet-probed session (no cache entry) trusts the binding
      // (RUNNING), mirroring the agentSessionsLoaded trust pattern, so a transient
      // probe miss never flips a genuinely-running profile to idle.
      const liveness = sessionLiveness[sid];
      if (liveness !== undefined && !liveness.pageStatePresent) {
        const ageMs = Date.now() - new Date(live.created_at).getTime();
        if (ageMs > SESSION_LIVENESS_GRACE_MS) return null;
      }
      return { id: sid, kind: 'agent' };
    }
    // A driver session reads as running only if it's live AND not in a terminal
    // state — an errored/destroyed session lingering in the list must read idle
    // (otherwise the row offers "Open session" on a dead session).
    return activeSessions.some(
      (s) => s.id === sid && s.status !== 'destroyed' && s.status !== 'errored',
    )
      ? { id: sid, kind: 'driver' }
      : null;
  }

  // Worktimer — the ISO start time of a profile's bound running session, or
  // null. Driver sessions carry created_at in activeSessions; agent sessions
  // come from the separately-fetched agentSessions list (absent until/unless
  // that fetch succeeds → the timer just doesn't show, never errors).
  function boundSessionStartedAt(profileId: string): string | null {
    const bound = boundSession(profileId);
    if (bound === null) return null;
    if (bound.kind === 'driver') {
      return activeSessions.find((s) => s.id === bound.id)?.created_at ?? null;
    }
    return agentSessions.find((s) => s.id === bound.id)?.created_at ?? null;
  }

  // W624 — re-open the live stream for an already-running agent session
  // (the profile-row "Live view" when the binding is an agent session).
  async function reopenStream(agentSessionId: string, profileId: string): Promise<void> {
    if (!client) return;
    setBusyId(profileId);
    try {
      const info = await client.agentSessions.livekitToken(agentSessionId);
      // Open the floating-iPhone simulator window (the only experience now).
      const reopened = state.profiles.find((p) => p.id === profileId);
      const reopenProxy = pickProxy(profileId);
      const reopenCountry =
        reopenProxy !== null ? (probeCache[reopenProxy.id]?.exitCountry ?? null) : null;
      const sim = await openSimulatorWindow({
        sessionId: agentSessionId,
        info,
        deviceName: formatDeviceName(reopened?.archetype ?? ''),
        profileName: reopened?.name,
        countryCode: reopenCountry,
        ...(reopenProxy !== null
          ? { proxyLabel: `${reopenProxy.label} · ${reopenProxy.host}:${String(reopenProxy.port)}` }
          : {}),
      });
      if (!sim.opened) {
        // No in-app full-page fallback (founder 2026-06-18: it looked bad,
        // scaled). The simulator is ONLY the separate window now.
        setState((s) => ({
          ...s,
          error: `Couldn't reopen the simulator window: ${sim.reason ?? 'unknown'}. If one is already open for this session, close it and relaunch.`,
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

  // Effective folder list = folders derived from profile metadata UNION the
  // user-created (possibly empty) folders. Used by the rail + both folder
  // pickers so a freshly-created empty folder is immediately pickable.
  const allFolders = useMemo<string[]>(() => {
    const set = new Set<string>([...folderList(scopedMeta), ...customFolders]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [scopedMeta, customFolders]);

  // Effective tag list (rail) = tags derived from profiles (with counts) UNION
  // the user-created tags (count 0 until a profile uses them), sorted by name.
  const allTags = useMemo<Array<{ tag: string; count: number }>>(() => {
    const counts = new Map<string, number>();
    for (const { tag, count } of aggregateTags(scopedMeta)) counts.set(tag, count);
    for (const t of customTags) if (!counts.has(t)) counts.set(t, 0);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [scopedMeta, customTags]);

  // Create a tag from the rail's inline input (mirrors handleCreateFolder).
  const handleCreateTag = useCallback(async () => {
    const next = await addTag(newTagName);
    setCustomTags(next);
    pushOrg(customFolders, customFolderIcons, next); // org-sync write-through
    const created = newTagName.trim().replace(/^#+/, '').trim();
    if (created.length > 0) setTagFilter(created);
    setNewTagName('');
    setCreatingTag(false);
  }, [newTagName, pushOrg, customFolders, customFolderIcons]);

  // Create a folder from the rail's inline input: persist the name, refresh the
  // list, jump the filter to the new folder, and close the input.
  const handleCreateFolder = useCallback(async () => {
    const next = await addFolder(newFolderName, newFolderIcon);
    setCustomFolders(next);
    const created = newFolderName.trim();
    const nextIcons =
      created.length > 0 && newFolderIcon.length > 0
        ? { ...customFolderIcons, [created]: newFolderIcon }
        : customFolderIcons;
    if (created.length > 0 && newFolderIcon.length > 0) {
      setCustomFolderIcons(nextIcons);
    }
    pushOrg(next, nextIcons, customTags); // org-sync write-through
    if (created.length > 0 && next.includes(created)) setFolderFilter(created);
    setNewFolderName('');
    setNewFolderIcon('');
    setCreatingFolder(false);
  }, [newFolderName, newFolderIcon, pushOrg, customFolderIcons, customTags]);

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
    if (tagFilter !== null) {
      list = list.filter((p) => (profilesMeta[p.id]?.tags ?? []).includes(tagFilter));
    }
    if (statusFilter !== 'all') {
      list = list.filter((p) => {
        // Single source of truth for "running" — boundSession self-heals stale
        // agent bindings + ignores terminal driver sessions, so filter, badge,
        // and live count agree.
        const running = boundSession(p.id) !== null;
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
    tagFilter,
    profilesMeta,
    state.profiles,
    searchQuery,
    statusFilter,
    sortBy,
    activeSessions,
    bindings,
    // boundSession (via the status filter) also reads the agent-session list +
    // its loaded flag + the liveness cache, so recompute when those change.
    agentSessions,
    agentSessionsLoaded,
    sessionLiveness,
  ]);

  // Are any of the composing filters narrowing the grid? Drives the "clear
  // filters" affordance on the empty state (folder + tag + search + status all
  // AND together, so it's easy to filter to zero and not see why).
  const hasActiveFilters =
    folderFilter !== 'all' ||
    tagFilter !== null ||
    searchQuery.trim() !== '' ||
    statusFilter !== 'all';
  const clearFilters = useCallback(() => {
    setFolderFilter('all');
    setTagFilter(null);
    setSearchQuery('');
    setStatusFilter('all');
  }, []);

  // S5 (GUI-rework 2026-06-14) — hero/stat derived metrics. Live count =
  // profiles bound to a live session. Proxy health = share of saved proxies
  // whose LAST probe was reachable (honest: from the real probeCache; null
  // when nothing's been probed yet so we don't invent a number).
  const liveCount = useMemo(
    () => state.profiles.filter((p) => boundSession(p.id) !== null).length,
    // boundSession reads bindings + activeSessions + the agent-session list/loaded
    // flag + the liveness cache; recompute when any of those move.
    [state.profiles, bindings, activeSessions, agentSessions, agentSessionsLoaded, sessionLiveness],
  );
  const proxyHealthPct = useMemo<number | null>(() => {
    if (proxies.length === 0) return null;
    const probed = proxies.filter((p) => probeCache[p.id] !== undefined);
    if (probed.length === 0) return null;
    const ok = probed.filter((p) => probeCache[p.id]?.result.reachable === true).length;
    return (ok / probed.length) * 100;
  }, [proxies, probeCache]);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

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
          setProbeCache(
            await saveExitResult(px.id, exit.ip, exit.country, {
              city: exit.city ?? null,
              region: exit.region ?? null,
              timezone: exit.timezone ?? null,
              asnOrg: exit.asn_org ?? null,
            }),
          );
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

  // ARC A — ensure the picked local proxy has a server-side account_proxies row
  // (encrypted under the account TMK, owner-scoped) and return its id to pass as
  // proxy_id at launch. Creates on first use (caching the id on the local proxy),
  // refreshes on later launches so an edited host/credential stays current
  // server-side. Returns undefined when there's no API key (caller launches
  // without proxy_id → operator-default egress).
  async function ensureServerProxy(p: LocalProxyConfig): Promise<string | undefined> {
    const apiKey = settings.apiKey;
    if (apiKey === null || apiKey.length === 0) return undefined;
    const input = {
      label: p.label,
      scheme: p.scheme ?? ('socks5' as const),
      host: p.host,
      port: p.port,
      username: p.username,
      password: p.password,
      // OVPN/WG — forward the VPN config block when present so the server wraps
      // the secret (config_blob / private_key) under the account TMK.
      ...(p.openvpn !== undefined ? { openvpn: p.openvpn } : {}),
      ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
    };
    if (p.serverId !== undefined) {
      try {
        await updateAccountProxy(settings.baseUrl, apiKey, p.serverId, input);
        return p.serverId;
      } catch (err) {
        // Stale cached serverId: the account_proxies row was deleted server-side
        // (e.g. during a DB recovery), so the PUT 404s. Self-heal by clearing the
        // stale id and re-creating below, instead of failing the launch-sync
        // forever. Any other error is real — re-throw it.
        if ((err as { status?: number }).status !== 404) throw err;
      }
    }
    const created = await createAccountProxy(settings.baseUrl, apiKey, input);
    await setProxyServerId(p.id, created.id);
    setProxies(await listProxies());
    return created.id;
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
      // Test-before-open (#4): if the bound proxy's LAST probe showed it down,
      // warn before launching (override-able) rather than opening a session
      // that'll fail on a dead exit. Uses the CACHED result only — never blocks
      // a launch on a fresh probe, so an untested/healthy proxy launches
      // straight through.
      const lastProbe = probeCache[proxy.id];
      if (lastProbe && (!lastProbe.result.reachable || !lastProbe.result.auth_ok)) {
        const reason = !lastProbe.result.reachable ? 'was unreachable' : 'rejected its credentials';
        const proceed = await confirm(
          `The proxy "${proxy.label}" ${reason} on its last test, so this session may fail to reach the internet. Launch anyway?`,
          { confirmLabel: 'Launch anyway' },
        );
        if (!proceed) return; // finally resets busyId
      }
      // ARC A — sync the picked proxy to the account (server-side, encrypted)
      // so the dispatch routes egress through it. ensureServerProxy creates or
      // refreshes the account_proxies row + caches its id locally; we pass that
      // id as proxy_id. Best-effort: a sync failure (offline / SSRF-rejected
      // host / unauth) falls back to launching without proxy_id rather than
      // blocking — the session still runs (operator-default egress).
      let proxyIdForLaunch: string | undefined;
      try {
        proxyIdForLaunch = await ensureServerProxy(proxy);
      } catch (err) {
        console.warn('proxy account-sync failed; launching without proxy_id', err);
      }
      // Attach THIS profile so the session restores/persists its saved browser
      // identity (file 57). Pass the canonical prof_<uuid> id as-is — the create
      // API accepts it (W335/W336 made both session routes normalize prof_<uuid>
      // or a bare uuid server-side).
      // Launch in manual mode: a GUI launch opens the simulator for the user to
      // drive, so it should start under their control (not AI). They can switch
      // via the mode toggle. (The agent-chat path creates with mode:'ai'.)
      const created = await client.agentSessions.create(
        proxyIdForLaunch !== undefined
          ? { profile_id: profile.id, proxy_id: proxyIdForLaunch, mode: 'manual' }
          : { profile_id: profile.id, mode: 'manual' },
      );
      await markLaunched(profile.id, created.id);
      if (created.livekit) {
        // Mint the per-session gui_control_key so the SEPARATE simulator
        // app (which can't read this app's keychain) can drive the
        // control endpoints. Best-effort: minting in the MAIN app with
        // the account API key; a failure leaves controlKey undefined and
        // the simulator falls back to the in-app/keychain path. The key
        // is session-scoped + 24h-TTL — NOT the account API key.
        const apiKey = settings.apiKey;
        const controlKey =
          apiKey !== null && apiKey.length > 0
            ? ((await mintGuiControlKey(settings.baseUrl, apiKey, created.id)) ?? undefined)
            : undefined;
        // Open the floating-iPhone simulator window (the only experience now).
        // The proxy's exit country (from its probe) rides through so the
        // separate simulator app's macOS Dock tile reflects the egress country.
        const launchProxy = pickProxy(profile.id);
        const launchCountry =
          launchProxy !== null ? (probeCache[launchProxy.id]?.exitCountry ?? null) : null;
        const sim = await openSimulatorWindow({
          sessionId: created.id,
          info: created.livekit,
          deviceName: formatDeviceName(profile.archetype),
          profileName: profile.name,
          countryCode: launchCountry,
          ...(controlKey !== undefined ? { controlKey } : {}),
          ...(launchProxy !== null
            ? {
                proxyLabel: `${launchProxy.label} · ${launchProxy.host}:${String(launchProxy.port)}`,
              }
            : {}),
        });
        if (!sim.opened) {
          // No in-app full-page fallback — founder 2026-06-18: the in-app view
          // looked bad (a phone scaled into the full GUI page). The simulator is
          // ONLY ever the separate window now; surface why it didn't open.
          setState((s) => ({
            ...s,
            error: `Couldn't open the simulator window: ${sim.reason ?? 'unknown'}. If one is already open for this session, close it and relaunch.`,
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
    } catch (err) {
      // Surface the failure in the banner instead of letting the rejection reach
      // the global handler (which would blank the app with the fatal overlay).
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setQuickBusy(false);
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

  // Set (or clear, with '') a chosen icon on every selected profile — applied
  // immediately on pick. Icon is a local-only convenience (no server column),
  // so no write-through.
  async function handleBulkIcon(icon: string): Promise<void> {
    if (selectedIds.size === 0) return;
    const next = await saveProfilesMetaBulk(
      [...selectedIds],
      { icon },
      'merge',
      activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
    );
    setProfilesMeta(next);
    // Per-account sync — write each icon through to the server profile row.
    if (client) {
      for (const id of selectedIds) {
        void client.profiles
          .update(id, { icon: icon.length > 0 ? icon : null })
          .catch(() => undefined);
      }
    }
  }

  // Bulk export — snapshot each selected profile via profiles.export (the v1
  // portability envelope; had zero GUI callers) and download them as one JSON
  // file. Best-effort per id; a failed export is skipped, not fatal.
  async function handleBulkExport(): Promise<void> {
    if (!client || selectedIds.size === 0 || bulkExporting) return;
    setBulkExporting(true);
    try {
      const envelopes = [];
      for (const id of selectedIds) {
        try {
          envelopes.push(await client.profiles.export(id));
        } catch {
          /* skip a profile that failed to export; keep the rest */
        }
      }
      if (envelopes.length > 0) {
        downloadJson(timestampedFilename('driftstack-profiles', 'json', new Date()), envelopes);
      } else {
        setState((s) => ({ ...s, error: 'Could not export the selected profiles.' }));
      }
    } finally {
      setBulkExporting(false);
    }
  }

  // Single-profile export — the grid ⋯ menu's Export action. Downloads the
  // portable JSON envelope for one profile (same format as bulk, one entry).
  async function handleExport(id: string): Promise<void> {
    if (!client) return;
    try {
      const envelope = await client.profiles.export(id);
      downloadJson(timestampedFilename('driftstack-profile', 'json', new Date()), envelope);
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
    }
  }

  // Bulk launch — start a session for each selected profile, sequentially (so
  // the fleet sees distinct launches + we don't blast the concurrency cap).
  // Confirms first since each launch spawns a billed session; best-effort per
  // profile (a gated/failed one is skipped, the rest still launch).
  async function handleBulkLaunch(): Promise<void> {
    if (!client || selectedIds.size === 0 || bulkLaunching) return;
    const targets = state.profiles.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    const ok = await confirm(
      `Launch ${targets.length.toString()} session${
        targets.length === 1 ? '' : 's'
      }? Each selected profile opens its own browser session.`,
      { confirmLabel: 'Launch' },
    );
    if (!ok) return;
    setBulkLaunching(true);
    try {
      for (const p of targets) {
        try {
          await handleLaunch(p);
        } catch {
          /* skip one that failed/was gated — keep launching the rest */
        }
      }
      setSelectedIds(new Set());
    } finally {
      setBulkLaunching(false);
    }
  }

  // Bulk delete — destructive, so it goes through the in-app confirm (native
  // confirm() is flaky in the Tauri WKWebView). Best-effort per id (a running
  // profile's delete fails server-side and is skipped, not fatal); bindings are
  // dropped alongside so stale entries don't linger.
  async function handleBulkDelete(): Promise<void> {
    if (!client || selectedIds.size === 0 || bulkDeleting) return;
    const ids = [...selectedIds];
    const ok = await confirm(
      `Delete ${ids.length} profile${ids.length === 1 ? '' : 's'}? This removes ${
        ids.length === 1 ? 'it' : 'them'
      } from your account and can't be undone.`,
      { confirmLabel: 'Delete' },
    );
    if (!ok) return;
    setBulkDeleting(true);
    try {
      for (const id of ids) {
        try {
          await client.profiles.delete(id);
          await deleteBinding(id);
        } catch {
          /* skip one that failed (e.g. running) — keep deleting the rest */
        }
      }
      setSelectedIds(new Set());
      await refresh(false);
      await refreshAccountMe();
    } finally {
      setBulkDeleting(false);
    }
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
      // destroy the session.
      if (bound.kind === 'agent') {
        await client.agentSessions.close(bound.id);
      } else {
        await client.sessions.destroy(bound.id);
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

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-6">
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
      {/* (Profiles hub-stats strip removed 2026-06-15 — the fleet KPIs live on
          the Command Center only, per founder; Profiles stays focused on the
          grid/list.) */}
      {/* Team workspace indicator (hub demo, honest v1): memberships
          from /v1/account/me. Workspace SWITCHING (X-Driftstack-Account
          effective-account) is the named follow-up — this surfaces the
          real memberships so the demo's team surface stops being
          invisible. Sits below the stat strip (not inside the bordered
          grid) so the metrics read as a clean console strip. */}
      {state.profiles.length > 0 && (
        <div
          data-component="workspace-strip"
          className="flex flex-wrap items-center gap-2 rounded-md border border-surface-divider bg-surface-raised px-3 py-2 text-xs"
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
          {/* Discoverability (2026-06-16, founder "where am I supposed to look"):
              the strip now renders for everyone (not only team members). With no
              teams yet, explain what team workspaces are + where to set one up,
              so Teams isn't invisible until you already belong to one. */}
          {(accountMe?.teams?.length ?? 0) === 0 && (
            <span className="ml-auto text-2xs text-ink-muted">
              Team workspaces let members share profiles — set one up in the web dashboard (Team),
              then it appears here.
            </span>
          )}
          {activeWorkspace !== null && (
            <span className="ml-auto text-2xs text-ink-muted">
              Viewing a team workspace — writes need the admin role.
            </span>
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
      {/* S5 (GUI-rework 2026-06-14) — HERO strip (console.html): greeting +
          health line on the left; primary New-profile + a "Refreshed … ·
          auto-refresh" live pill on the right. No personal name (founder
          anonymity). The refresh timestamp folds into the hero-right pill. */}
      <div
        data-component="profiles-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink-primary">{greeting}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
            <b className="font-semibold text-ink-primary">{liveCount}</b> live
            <span className="text-surface-divider">·</span>
            {proxyHealthPct !== null ? (
              <span className="font-semibold text-status-ready">
                {proxyHealthPct.toFixed(1)}% proxy health
              </span>
            ) : (
              <span className="text-ink-muted">proxy health untested</span>
            )}
            <span className="text-surface-divider">·</span>
            all systems nominal
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
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
          <button
            type="button"
            className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted hover:text-ink-secondary disabled:opacity-60"
            onClick={() => void refresh(true)}
            disabled={state.loading}
            title="Refresh now"
          >
            <span
              aria-hidden="true"
              className="relative inline-block h-1.5 w-1.5 rounded-full bg-status-ready"
            >
              <span className="absolute inset-[-3px] animate-ping rounded-full border border-status-ready opacity-60" />
            </span>
            {state.loading ? (
              'Refreshing…'
            ) : (
              <>
                Refreshed{' '}
                <span className="mono">
                  {state.refreshedAt !== null
                    ? new Date(state.refreshedAt).toLocaleTimeString()
                    : '—'}
                </span>{' '}
                · auto-refresh 5s
              </>
            )}
          </button>
        </div>
      </div>
      <header className="flex flex-col gap-3">
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
          className="animate-view-in fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-surface-divider bg-surface-elevated px-4 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.4)]"
        >
          <span className="text-xs font-semibold text-ink-primary">
            {selectedIds.size.toString()} selected
          </span>
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5 px-3 py-1 text-xs disabled:opacity-50"
            onClick={() => void handleBulkLaunch()}
            disabled={bulkLaunching}
            title="Open a browser session for each selected profile"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
            </svg>
            {bulkLaunching ? 'Launching…' : 'Launch'}
          </button>
          <span aria-hidden className="h-5 w-px bg-surface-divider" />
          <FolderPicker
            ariaLabel="Bulk folder"
            noneLabel="Move to folder…"
            folders={allFolders}
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
          <select
            aria-label="Set icon"
            className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
            value="__noop"
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__noop') return;
              void handleBulkIcon(v === '__none' ? '' : v);
            }}
          >
            <option value="__noop">Set icon…</option>
            <option value="__none">✕ None</option>
            {PROFILE_ICONS.map((i) => (
              <option key={i.emoji} value={i.emoji}>
                {i.emoji} {i.label}
              </option>
            ))}
          </select>
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
            className="btn-secondary px-2.5 py-1 text-xs disabled:opacity-50"
            onClick={() => void handleBulkExport()}
            disabled={bulkExporting}
            title="Download the selected profiles as a portable JSON export"
          >
            {bulkExporting ? 'Exporting…' : 'Export'}
          </button>
          <span aria-hidden className="h-5 w-px bg-surface-divider" />
          <button
            type="button"
            className="rounded px-2.5 py-1 text-xs font-medium text-status-error transition-colors hover:bg-status-error/10 disabled:opacity-50"
            onClick={() => void handleBulkDelete()}
            disabled={bulkDeleting}
            title="Delete the selected profiles (asks for confirmation)"
          >
            {bulkDeleting ? 'Deleting…' : 'Delete'}
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
        <div className="flex min-h-0 flex-1 gap-4">
          {/* S3 (GUI-rework 2026-06-15, founder) — FOLDERS as a permanent left
              NAV rail (vertical, full-width rows) instead of the old horizontal
              shelf + the redundant filter dropdown. Counts derive from the same
              organization map; selection drives folderFilter unchanged. */}
          <aside
            aria-label="Folders and tags"
            className="flex min-h-0 w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-surface-divider pr-3"
          >
            <span className="section-label px-2.5 pb-1">Folders</span>
            <FolderItem
              variant="rail"
              label="All profiles"
              count={state.profiles.length}
              active={folderFilter === 'all'}
              onSelect={() => setFolderFilter('all')}
            />
            {allFolders.map((f) => (
              <FolderItem
                key={f}
                variant="rail"
                label={f}
                icon={customFolderIcons[f]}
                count={state.profiles.filter((p) => profilesMeta[p.id]?.folder === f).length}
                active={folderFilter === f}
                onSelect={() => setFolderFilter(f)}
              />
            ))}
            <FolderItem
              variant="rail"
              label="Unfiled"
              count={state.profiles.filter((p) => (profilesMeta[p.id]?.folder ?? '') === '').length}
              active={folderFilter === 'unfiled'}
              onSelect={() => setFolderFilter('unfiled')}
            />
            {/* 2026-06-15/16 (founder) — create a new (possibly empty) folder
                from the rail, now WITH an optional icon picker. Name + icon +
                Add; Enter-in-name or Add commits via handleCreateFolder, Escape
                cancels. (No blur-commit — clicking the icon select blurs the
                name input, which must not fire a create.) */}
            {creatingFolder ? (
              <div className="mt-0.5 flex flex-col gap-1 rounded-lg border border-surface-divider bg-surface-inset p-1.5">
                <input
                  autoFocus
                  aria-label="New folder name"
                  placeholder="Folder name…"
                  value={newFolderName}
                  maxLength={60}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateFolder();
                    else if (e.key === 'Escape') {
                      setNewFolderName('');
                      setNewFolderIcon('');
                      setCreatingFolder(false);
                    }
                  }}
                  className="w-full rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
                />
                <select
                  aria-label="New folder icon"
                  value={newFolderIcon}
                  onChange={(e) => setNewFolderIcon(e.target.value)}
                  className="w-full rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary focus:border-accent focus:outline-none"
                >
                  <option value="">— Icon (optional) —</option>
                  {PROFILE_ICONS.map((i) => (
                    <option key={i.emoji} value={i.emoji}>
                      {i.emoji} {i.label}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void handleCreateFolder()}
                    disabled={newFolderName.trim().length === 0}
                    className="flex-1 rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewFolderName('');
                      setNewFolderIcon('');
                      setCreatingFolder(false);
                    }}
                    className="rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreatingFolder(true)}
                className="mt-0.5 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-ink-muted/60 hover:text-ink-primary"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  +
                </span>
                New folder
              </button>
            )}
            {/* 2026-06-16 (founder) — TAGS section in the left rail, under
                Folders, with a create affordance (mirrors folders). Filtering
                by a tag composes (AND) with the folder filter. */}
            <span className="section-label px-2.5 pb-1 pt-3">Tags</span>
            {allTags.map(({ tag, count }) => {
              const active = tagFilter === tag;
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTagFilter(active ? null : tag)}
                  className={`flex w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-accent-subtle font-semibold text-ink-primary'
                      : 'text-ink-secondary hover:bg-surface-raised hover:text-ink-primary'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: folderColor(tag) }}
                  />
                  <span className="flex-1 truncate text-left">#{tag}</span>
                  <span
                    className={`mono rounded-[5px] px-1.5 py-px text-2xs font-semibold ${
                      active ? 'bg-accent/15 text-ink-primary' : 'bg-surface-inset text-ink-muted'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
            {creatingTag ? (
              <input
                autoFocus
                aria-label="New tag name"
                placeholder="Tag name…"
                value={newTagName}
                maxLength={40}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateTag();
                  else if (e.key === 'Escape') {
                    setNewTagName('');
                    setCreatingTag(false);
                  }
                }}
                onBlur={() => {
                  if (newTagName.trim().length > 0) void handleCreateTag();
                  else setCreatingTag(false);
                }}
                className="mt-0.5 w-full rounded-lg border border-surface-divider bg-surface-inset px-2.5 py-1.5 text-xs text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setCreatingTag(true)}
                className="mt-0.5 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-ink-muted/60 hover:text-ink-primary"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  +
                </span>
                New tag
              </button>
            )}
            {/* L4b recycle bin — Trash entry, pinned at the bottom of the rail.
                Toggles the trashed-profiles view; loads on open. */}
            <button
              type="button"
              onClick={() => {
                setTrashView((on) => {
                  const next = !on;
                  if (next) void loadTrash();
                  return next;
                });
              }}
              className={`mt-3 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                trashView
                  ? 'border-accent bg-accent-subtle text-ink-primary'
                  : 'border-transparent text-ink-muted hover:bg-surface-elevated hover:text-ink-primary'
              }`}
              aria-pressed={trashView}
            >
              <span aria-hidden="true">🗑️</span>
              <span className="flex-1 truncate text-left">Trash</span>
              {trashed.length > 0 ? (
                <span className="rounded-full bg-surface-divider px-1.5 text-[10px] text-ink-secondary">
                  {trashed.length}
                </span>
              ) : null}
            </button>
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {/* min-h-0 + overflow-y-auto so the grid/table scrolls WITHIN the
                view on small screens instead of overflowing off-screen
                (founder: "profile list isn't fully in view, should auto-scale"). */}
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              {trashView ? (
                <TrashPanel
                  trashed={trashed}
                  loading={trashLoading}
                  restoringId={restoringId}
                  purgingId={purgingId}
                  onRestore={(id) => void handleRestore(id)}
                  onPurge={(id, name) => void handlePurge(id, name)}
                  onBack={() => setTrashView(false)}
                />
              ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3">
                  {filteredProfiles.length === 0 ? (
                    <div className="col-span-full">
                      <ProfilesEmpty hasActiveFilters={hasActiveFilters} onClear={clearFilters} />
                    </div>
                  ) : null}
                  {filteredProfiles.map((profile) => {
                    const bound = boundSession(profile.id);
                    const running = bound !== null;
                    // S5 (GUI-rework 2026-06-14) — card-level derived display
                    // values from the REAL probe cache (no invented data). The
                    // proxy row + latency meter + health pill all read these.
                    const px = pickProxy(profile.id);
                    const probe = px !== null ? probeCache[px.id] : undefined;
                    const lat = probe?.result.latency_ms;
                    // latency meter fill: 0–250ms mapped to 0–100% (clamped).
                    const latFill =
                      lat !== undefined ? Math.max(6, Math.min(100, (lat / 250) * 100)) : 0;
                    const latGood = lat !== undefined && lat <= 100;
                    return (
                      <ProfilePhoneCard
                        key={profile.id}
                        name={profile.name}
                        monogram={profileMonogram(profile.name)}
                        icon={profilesMeta[profile.id]?.icon ?? ''}
                        hue={identityHue(profile.name)}
                        deviceLabel={formatDeviceName(profile.archetype)}
                        running={running}
                        selected={selectedIds.has(profile.id)}
                        lastUsedIso={profile.last_used_at}
                        folder={profilesMeta[profile.id]?.folder ?? ''}
                        tags={profilesMeta[profile.id]?.tags ?? []}
                        hasProxy={px !== null}
                        flag={probe?.exitCountry ? flagEmoji(probe.exitCountry) : '🌍'}
                        countryCode={probe?.exitCountry ?? null}
                        exitIp={probe?.exitIp ?? null}
                        latencyMs={lat ?? null}
                        latencyFillPct={latFill}
                        latencyGood={latGood}
                        probed={probe !== undefined}
                        capabilities={probe?.result ?? null}
                        checkedAtIso={
                          probe?.at !== undefined ? new Date(probe.at).toISOString() : null
                        }
                        busy={busyId === profile.id}
                        testing={px !== null && testingProxyId === px.id}
                        testDisabled={testingProxyId !== null}
                        launchDisabled={teamLaunchBlocked}
                        launchDisabledReason={teamLaunchBlockedReason}
                        onToggleSelect={() => toggleSelected(profile.id)}
                        onPrimary={() => {
                          if (running && bound !== null) {
                            // agt_ ids 400 in the driver session viewer — re-open
                            // the agent stream instead (mirror onWatch).
                            if (bound.kind === 'agent') void reopenStream(bound.id, profile.id);
                            else onOpenSession(bound.id);
                          } else void handleLaunch(profile);
                        }}
                        onWatch={() => {
                          if (running && bound !== null) {
                            if (bound.kind === 'agent') void reopenStream(bound.id, profile.id);
                            else onOpenSession(bound.id);
                          } else void handleLaunch(profile);
                        }}
                        onTest={() => {
                          if (px !== null) void handleTestProxy(px);
                        }}
                        onAssist={onAssist ? () => onAssist(profile.id) : undefined}
                        onExport={() => void handleExport(profile.id)}
                        onDelete={() => void handleDelete(profile.id)}
                      />
                    );
                  })}
                </div>
              ) : filteredProfiles.length === 0 ? (
                <ProfilesEmpty hasActiveFilters={hasActiveFilters} onClear={clearFilters} />
              ) : (
                (() => {
                  const byId = new Map(filteredProfiles.map((pr) => [pr.id, pr]));
                  const rows: ProfileTableRow[] = filteredProfiles.map((profile) => {
                    const bound = boundSession(profile.id);
                    const px = pickProxy(profile.id);
                    const probe = px !== null ? probeCache[px.id] : undefined;
                    const caps = probe !== undefined ? proxyCapabilities(probe.result) : null;
                    const udp: 'ok' | 'fail' | 'unknown' =
                      caps === null
                        ? 'unknown'
                        : (caps.find((c) => c.key === 'webrtc')?.ok ?? false)
                          ? 'ok'
                          : 'fail';
                    return {
                      id: profile.id,
                      name: profile.name,
                      icon: profilesMeta[profile.id]?.icon ?? '',
                      deviceLabel: formatDeviceName(profile.archetype),
                      running: bound !== null,
                      runningSinceIso: boundSessionStartedAt(profile.id),
                      hasProxy: px !== null,
                      flag: probe?.exitCountry ? flagEmoji(probe.exitCountry) : '🌍',
                      countryCode: probe?.exitCountry ?? null,
                      exitIp: probe?.exitIp ?? null,
                      proxyAddress: px !== null ? `${px.host}:${px.port}` : null,
                      // Prefer the granular lumtest geo (city, region) when the
                      // exit probe captured it; the flag already conveys the
                      // country, so fall back to the country name otherwise.
                      locationLabel:
                        probe?.exitCity != null && probe.exitCity.length > 0
                          ? [probe.exitCity, probe.exitRegion]
                              .filter((s): s is string => typeof s === 'string' && s.length > 0)
                              .join(', ')
                          : probe?.exitCountry
                            ? regionName(probe.exitCountry)
                            : null,
                      probed: probe !== undefined,
                      udp,
                      latencyMs: probe?.result.latency_ms ?? null,
                      folder: profilesMeta[profile.id]?.folder ?? '',
                      tags: profilesMeta[profile.id]?.tags ?? [],
                      note: profilesMeta[profile.id]?.note ?? '',
                      createdAtIso: profile.created_at,
                      lastUsedIso: profile.last_used_at,
                      selected: selectedIds.has(profile.id),
                      busy: busyId === profile.id,
                      testing: px !== null && testingProxyId === px.id,
                      testDisabled: testingProxyId !== null,
                      // Launch blocks NON-admin team members only — the server
                      // lets admins launch the owner's profile (V-326e3-style);
                      // admins + Personal can launch. NOT atProfileCap: the cap
                      // limits CREATING, launching consumes a session slot
                      // (free-tier fix 0ccff415; the table Launch is busy-only).
                      launchDisabled: teamLaunchBlocked,
                      launchDisabledReason: teamLaunchBlockedReason,
                    };
                  });
                  const dir = sortDir === 'asc' ? 1 : -1;
                  rows.sort((a, b) => {
                    switch (sortKey) {
                      case 'name':
                        return dir * a.name.localeCompare(b.name);
                      case 'status':
                        return dir * (Number(a.running) - Number(b.running));
                      case 'country':
                        return dir * (a.countryCode ?? 'zz').localeCompare(b.countryCode ?? 'zz');
                      case 'created': {
                        const at = a.createdAtIso !== null ? new Date(a.createdAtIso).getTime() : 0;
                        const bt = b.createdAtIso !== null ? new Date(b.createdAtIso).getTime() : 0;
                        return dir * (at - bt);
                      }
                      case 'lastUsed': {
                        const at = a.lastUsedIso !== null ? new Date(a.lastUsedIso).getTime() : 0;
                        const bt = b.lastUsedIso !== null ? new Date(b.lastUsedIso).getTime() : 0;
                        return dir * (at - bt);
                      }
                    }
                  });
                  const resolve = (id: string) => byId.get(id) ?? null;
                  return (
                    <ProfilesTable
                      rows={rows}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={(k) => {
                        if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                        else {
                          setSortKey(k);
                          setSortDir('asc');
                        }
                      }}
                      allSelected={rows.length > 0 && rows.every((row) => selectedIds.has(row.id))}
                      onToggleSelectAll={() => {
                        setSelectedIds((prev) => {
                          const allOn = rows.length > 0 && rows.every((row) => prev.has(row.id));
                          if (allOn) return new Set();
                          return new Set(rows.map((row) => row.id));
                        });
                      }}
                      onToggleSelect={(id) => toggleSelected(id)}
                      onPrimary={(id) => {
                        const profile = resolve(id);
                        if (profile === null) return;
                        const bound = boundSession(id);
                        if (bound !== null) {
                          // agt_ ids 400 in the driver session viewer — re-open
                          // the agent stream instead (mirror onWatch).
                          if (bound.kind === 'agent') void reopenStream(bound.id, id);
                          else onOpenSession(bound.id);
                        } else void handleLaunch(profile);
                      }}
                      onWatch={(id) => {
                        const profile = resolve(id);
                        if (profile === null) return;
                        const bound = boundSession(id);
                        if (bound !== null) {
                          if (bound.kind === 'agent') void reopenStream(bound.id, id);
                          else onOpenSession(bound.id);
                        } else void handleLaunch(profile);
                      }}
                      onStop={(id) => {
                        const profile = resolve(id);
                        if (profile !== null) void handleStop(profile);
                      }}
                      onTest={(id) => {
                        const px = pickProxy(id);
                        if (px !== null) void handleTestProxy(px);
                      }}
                      onDelete={(id) => void handleDelete(id)}
                      onSaveNote={(id, note) => {
                        void saveProfileMeta(
                          id,
                          { note },
                          state.profiles.map((pr) => pr.id),
                        ).then(setProfilesMeta);
                        // Per-account sync (2026-06-16) — write the note through
                        // to the server profile row so it follows the account.
                        if (client) {
                          void client.profiles
                            .update(id, { note: note.length > 0 ? note : null })
                            .catch(() => undefined);
                        }
                      }}
                    />
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <CreateProfileModal
          existingFolders={allFolders}
          // When the user is viewing a specific folder, a new profile inherits it
          // (founder: "created inside a folder → add it to that folder, not unfiled").
          initialFolder={folderFilter !== 'all' && folderFilter !== 'unfiled' ? folderFilter : ''}
          // Likewise, a profile created while filtered to a tag inherits that tag.
          initialTag={tagFilter ?? ''}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void refresh(false);
            // V-239 — refresh the cap counter so the gate flips to
            // disabled if we just hit cap.
            void refreshAccountMe();
            // #3 auto-test on create: a new profile launches through the first
            // available proxy — probe it now (if not already cached) so its
            // card shows egress without a manual Test. Best-effort, background.
            const firstProxy = proxies[0];
            if (firstProxy !== undefined && probeCache[firstProxy.id] === undefined) {
              void handleTestProxy(firstProxy);
            }
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
  initialFolder,
  initialTag,
}: {
  onClose: () => void;
  onCreated: () => void;
  /** Folder names for the Notes-tab picker (from the hub's organization map). */
  existingFolders: string[];
  /** Pre-selected folder — the one the user is currently viewing, so a profile
   *  created from inside a folder lands there. Empty = unfiled. */
  initialFolder?: string;
  /** Pre-filled tag — the tag the user is currently filtered to, so a profile
   *  created from inside a tag view carries it. Empty = no tag. */
  initialTag?: string;
}): JSX.Element {
  const { client, settings } = useSettings();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archetype, setArchetype] = useState(KNOWN_ARCHETYPES[0]?.id ?? '');
  // Icon at create (founder 2026-06-16: "same for new Profile" — the icon
  // picker existed only for bulk-edit; offer it up-front too). Saved into
  // profilesMeta alongside folder/tags after create.
  const [icon, setIcon] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Configurator port (founder-approved profile-create demo, 2026-06-12):
  // tabbed layout + live identity-preview rail. Storage/Behavior tabs are
  // informational (their facts are real, their controls are future).
  const [tab, setTab] = useState<'identity' | 'proxy' | 'storage' | 'behavior' | 'notes'>(
    'identity',
  );
  // Organization metadata at create (backend columns, migration 0076).
  const [folder, setFolder] = useState(initialFolder ?? '');
  const [tags, setTags] = useState(initialTag ?? '');
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
        // Per-account sync — send the chosen icon so it follows the account.
        ...(icon.length > 0 ? { icon } : {}),
      });
      // Mirror into the local organization cache so the hub shows the
      // folder/tags immediately (and offline).
      if (folder.trim().length > 0 || tagList.length > 0 || icon.length > 0) {
        await saveProfileMeta(profile.id, { folder: folder.trim(), tags: tagList, icon });
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

                <label className="flex flex-col gap-1">
                  <span className="section-label">Icon (optional)</span>
                  <select
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                    aria-label="Profile icon"
                  >
                    <option value="">— No icon —</option>
                    {PROFILE_ICONS.map((i) => (
                      <option key={i.emoji} value={i.emoji}>
                        {i.emoji} {i.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-ink-muted">
                    A quick visual marker shown on the profile card + list.
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
                      {p.label} ·{' '}
                      {p.scheme === 'openvpn' || p.scheme === 'wireguard'
                        ? `${p.scheme} · ${p.host}:${p.port}`
                        : `${p.host}:${p.port}`}
                    </option>
                  ))}
                  <option value="create-new">+ Add new SOCKS5 proxy…</option>
                </select>
                <span className="mt-1 text-2xs text-ink-muted">
                  OpenVPN / WireGuard: add it on the Proxies tab (paste or upload your .ovpn /
                  wg0.conf), then pick it here.
                </span>
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
                            <ProxyCapabilityChips result={testResult} size="sm" />
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

// G2 (5→10, 2026-06-14) — profile IDENTITY card for the grid thumbnail.
// Replaces the old `MiniPage` faux-webpage placeholder, which the founder read
// as "random images of a browser". We have no real screenshots yet (driver is
// mock), so instead of inventing a fake page we render a clean, deterministic
// IDENTITY: a monogram on a per-profile accent-hued wash + the device label.
// Future-proof: pass `screenshotUrl` once the driver captures a real last-frame
// and it takes over from the identity fallback.
export function profileMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase() || '?';
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
}

// Deterministic 0..359 hue from the name so each card reads distinctly and
// stably (no flicker across renders).
export function identityHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

// (ProfileIdentity removed — GX replaced the device-frame thumbnail with the
// full ProfilePhoneCard; profileMonogram/identityHue/formatDeviceName are now
// consumed by that component via props computed in the grid map.)

// Folder visual identity (founder: folders "look boring without any images").
// All/Unfiled get fixed glyphs; named folders get a per-name emoji (matched on
// common operator terms, console.html's 🛒/🏦/📣 shelf) plus a deterministic
// color dot hashed from the name so each folder is visually distinguishable at
// a glance without requiring per-folder icon metadata.
export function folderGlyph(label: string): string {
  if (label === 'All profiles') return '▦';
  if (label === 'Unfiled') return '📥';
  const l = label.toLowerCase();
  if (/shop|store|retail|cart|commerce/.test(l)) return '🛒';
  if (/bank|finance|pay|wallet/.test(l)) return '🏦';
  if (/ad|market|campaign|promo/.test(l)) return '📣';
  if (/social|insta|meta|tweet|post/.test(l)) return '📱';
  if (/test|sandbox|dev|qa/.test(l)) return '🧪';
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
  variant = 'pill',
  icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
  // 'pill' = the original inline emoji shelf chip; 'rail' = a full-width row
  // for the S3 (2026-06-15) left folder rail (icon + name on the left, count
  // pushed right). Same folderFilter selection behavior either way.
  variant?: 'pill' | 'rail';
  // 2026-06-16 (founder) — a user-chosen folder icon; overrides the
  // deterministic folderGlyph when set.
  icon?: string;
}): JSX.Element {
  const namedFolder = label !== 'All profiles' && label !== 'Unfiled';
  const rail = variant === 'rail';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={
        rail
          ? `flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'border-transparent bg-accent-subtle font-semibold text-ink-primary'
                : 'border-transparent text-ink-secondary hover:bg-surface-raised hover:text-ink-primary'
            }`
          : `inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'border-transparent bg-accent-subtle font-semibold text-ink-primary'
                : 'border-surface-divider bg-surface-raised text-ink-secondary hover:border-ink-muted/50 hover:text-ink-primary'
            }`
      }
    >
      <span aria-hidden="true" className="text-[13px] leading-none">
        {icon !== undefined && icon.length > 0 ? icon : folderGlyph(label)}
      </span>
      {namedFolder && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: folderColor(label) }}
        />
      )}
      <span className={rail ? 'flex-1 truncate text-left' : 'max-w-[10rem] truncate'}>{label}</span>
      <span
        className={`mono rounded-[5px] px-1.5 py-px text-2xs font-semibold ${
          active ? 'bg-accent/15 text-ink-primary' : 'bg-surface-inset text-ink-muted'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// G3 — tag filter rail. A row of "#tag · count" pills below the folder shelf;
// clicking one filters the grid to that tag (clicking the active one, or
// "clear", resets). Renders nothing when there are no tags so it never adds
// empty chrome. Tag color is the deterministic folderColor hash so a tag reads
// consistently wherever it appears.
export function TagFilterRail({
  tags,
  active,
  onSelect,
}: {
  tags: Array<{ tag: string; count: number }>;
  active: string | null;
  onSelect: (tag: string | null) => void;
}): JSX.Element | null {
  if (tags.length === 0) return null;
  return (
    <nav aria-label="Tags" className="flex flex-col gap-2 border-b border-surface-divider pb-3">
      <div className="flex items-center justify-between">
        <span className="section-label">Tags</span>
        {active !== null && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="section-label text-accent hover:underline"
          >
            clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tags.map(({ tag, count }) => {
          const on = active === tag;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(on ? null : tag)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                on
                  ? 'border-accent bg-accent-subtle font-medium text-ink-primary'
                  : 'border-surface-divider text-ink-secondary hover:border-accent/50 hover:text-ink-primary'
              }`}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: folderColor(tag) }}
              />
              {tag}
              <span
                className={`mono rounded-[5px] px-1 text-2xs ${
                  on ? 'bg-accent/15 text-ink-primary' : 'bg-surface-inset text-ink-muted'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// Empty state for the profile grid/list (5→10 polish). Distinguishes the two
// "nothing shows" reasons: an active filter narrowed everything out (offer a
// one-click "Clear filters" that resets folder + tag + search + status — the
// old list-only "Clear" forgot folder + tag, so a tag/folder filter to zero was
// unrecoverable) vs a genuinely empty account. Uses the shared EmptyState so it
// reads deliberate, not like a bare gray line.
export function ProfilesEmpty({
  hasActiveFilters,
  onClear,
}: {
  hasActiveFilters: boolean;
  onClear: () => void;
}): JSX.Element {
  return (
    <EmptyState
      icon={
        <svg
          viewBox="0 0 16 16"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5Z" />
        </svg>
      }
      title={hasActiveFilters ? 'No profiles match these filters' : 'No profiles here yet'}
      description={
        hasActiveFilters
          ? 'Nothing matches the folder, tag, search and status filters together. Clear them to see everything.'
          : 'Profiles you create show up here, ready to launch or hand to the AI.'
      }
      action={
        hasActiveFilters ? (
          <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={onClear}>
            Clear filters
          </button>
        ) : undefined
      }
    />
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

/** ISO-3166 alpha-2 → regional-indicator flag emoji ('NL' → 🇳🇱). */
function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌍';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// Country name for an ISO-3166 alpha-2 code via the platform's Intl region
// names (WebKit ships the full set) — no hand-maintained map. Falls back to the
// raw code for non-country values (Tor 'T1', 'XX').
function regionName(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return cc;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc;
  } catch {
    return cc;
  }
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

// L4b recycle bin — the Trash view. Lists soft-deleted profiles with a Restore
// action; the row data + DEK survive server-side until a purge. Restore returns
// a profile to the live list (its name must be free, else the server 409s).
function TrashPanel({
  trashed,
  loading,
  restoringId,
  purgingId,
  onRestore,
  onPurge,
  onBack,
}: {
  trashed: Profile[];
  loading: boolean;
  restoringId: string | null;
  purgingId: string | null;
  onRestore: (id: string) => void;
  onPurge: (id: string, name: string) => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-primary">Recycle bin</h3>
          <p className="mt-0.5 text-[11px] text-ink-secondary">
            Deleted profiles are kept here so you can restore them. Restoring returns a profile to
            your list; its name must be free. Trashed profiles still use a slot toward your plan —
            delete one permanently to free it now, or it’s purged automatically after 30 days.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded-lg border border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:text-ink-primary"
        >
          ← Back to profiles
        </button>
      </div>
      {loading ? (
        <p className="py-8 text-center text-xs text-ink-muted">Loading…</p>
      ) : trashed.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-divider py-10 text-center text-xs text-ink-muted">
          Trash is empty.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {trashed.map((p) => {
            const id = p.id.replace(/^prof_/, '');
            const restoring = restoringId === id || restoringId === p.id;
            const purging = purgingId === id || purgingId === p.id;
            const busy = restoring || purging;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-surface-divider bg-surface-raised px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink-primary">{p.name}</div>
                  <div className="truncate text-[11px] text-ink-muted">
                    {formatDeviceName(p.archetype)}
                    {p.deleted_at !== null ? (
                      <>
                        {' · deleted '}
                        <RelativeTime iso={p.deleted_at} />
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onPurge(p.id, p.name)}
                    disabled={busy}
                    title="Permanently delete — frees a profile slot, can’t be undone"
                    className="rounded-lg border border-status-error/40 px-2.5 py-1.5 text-xs font-medium text-status-error transition-colors hover:bg-status-error/15 disabled:opacity-50"
                  >
                    {purging ? 'Deleting…' : 'Delete permanently'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRestore(p.id)}
                    disabled={busy}
                    className="btn-primary text-xs"
                  >
                    {restoring ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
