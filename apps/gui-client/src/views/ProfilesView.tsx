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
import { ErrorBanner } from '../components/ErrorBanner';
import {
  ProfilesActionBar,
  type ProfileSortBy,
  type ProfileStatusFilter,
} from '../components/ProfilesActionBar';
import { ProxyChip } from '../components/ProxyChip';
import { RelativeTime } from '../components/RelativeTime';
import { useSettings } from '../lib/SettingsContext';
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
import { addProxy, listProxies, type ProxyConfig as LocalProxyConfig } from '../lib/proxies';

// 2026-05-20 — match SessionsView: slow background poll + skip the
// visible loading flicker on tick refreshes so the panel doesn't
// constantly re-flash.
const REFRESH_MS = 15_000;

// V-238 — only one customer-pickable archetype today. When V-136-style
// expansion lands more archetypes (e.g. iPhone 17 Pro / iOS 19), surface
// them here. The form preselects this single option; the select control
// is disabled until there are 2+ choices.
const KNOWN_ARCHETYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'iphone16pro_ios18_7_safari26_4', label: 'iPhone 16 Pro / iOS 18.7 / Safari 26.4' },
];

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

export interface ProfilesViewProps {
  onGoToSettings: () => void;
  /** Open the live-session view for a specific session id. */
  onOpenSession: (sessionId: string) => void;
}

export function ProfilesView({ onGoToSettings, onOpenSession }: ProfilesViewProps): JSX.Element {
  const { client, settings, accountMe, refreshAccountMe } = useSettings();
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
  // V-238 — create-form modal state. Lives here (not lifted to App.tsx)
  // because every other ProfilesView interaction is local; the modal
  // is a transient overlay scoped to this view's lifecycle.
  const [createOpen, setCreateOpen] = useState(false);
  // 2026-05-21 — header action cluster (operator-UI polish wave).
  // Pure-local filter/sort over `state.profiles`; no API change. Defaults
  // mirror the "what did I touch last" mental model that dominates
  // operator usage (show all, sort by recent use).
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>('all');
  const [sortBy, setSortBy] = useState<ProfileSortBy>('last-used');

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
  function runningSessionFor(profileId: string): Session | null {
    const binding = bindings.find((b) => b.profileId === profileId);
    if (binding === null || binding === undefined || binding.currentSessionId === null) {
      return null;
    }
    return activeSessions.find((s) => s.id === binding.currentSessionId) ?? null;
  }

  // 2026-05-21 — derive the filtered/sorted view over state.profiles.
  // Search matches name + description + archetype; status filter joins
  // against activeSessions via runningSessionFor; sort is
  // recency-by-default ("what did I touch last?" beats alpha for the
  // operator workflow).
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
    if (statusFilter !== 'all') {
      list = list.filter((p) => {
        const binding = bindings.find((b) => b.profileId === p.id);
        const running =
          binding !== undefined &&
          binding.currentSessionId !== null &&
          activeSessions.some((s) => s.id === binding.currentSessionId);
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
  }, [state.profiles, searchQuery, statusFilter, sortBy, activeSessions, bindings]);

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
      const body: Record<string, unknown> = {
        archetype: profile.archetype,
        label: profile.name,
        proxy: {
          type: 'socks5',
          socks5: {
            host: proxy.host,
            port: proxy.port,
            ...(proxy.username !== null ? { username: proxy.username } : {}),
            ...(proxy.password !== null ? { password: proxy.password } : {}),
            udp_associate: true,
            require_remote_dns: false,
          },
        },
        metadata: { gui_profile_id: profile.id, gui_profile_name: profile.name },
      };
      const created = await client.sessions.create(body);
      await markLaunched(profile.id, created.id);
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleStop(profile: Profile): Promise<void> {
    if (!client) return;
    const session = runningSessionFor(profile.id);
    if (session === null) {
      await clearProfileSession(profile.id);
      await refresh(false);
      return;
    }
    setBusyId(profile.id);
    try {
      await client.sessions.destroy(session.id);
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
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="section-label">Profiles</span>
            <h2 className="text-lg font-medium tracking-tight">
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
            const session = runningSessionFor(profile.id);
            const running = session !== null;
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
                        onClick={() => onOpenSession(session.id)}
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
                      disabled={busy || atProfileCap}
                    >
                      {busy ? 'Launching…' : 'Launch'}
                    </button>
                  )}
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
  useEffect(() => {
    void (async () => {
      const list = await listProxies();
      setProxies(list);
      if (list.length === 0) setProxyChoice('create-new');
    })();
  }, []);

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
                    onChange={(e) => setNewProxy((p) => ({ ...p, host: e.target.value }))}
                    placeholder="Host (e.g. proxy.example.com)"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={newProxy.port}
                    onChange={(e) => setNewProxy((p) => ({ ...p, port: e.target.value }))}
                    placeholder="Port"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="text"
                    value={newProxy.username}
                    onChange={(e) => setNewProxy((p) => ({ ...p, username: e.target.value }))}
                    placeholder="Username (optional)"
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                  <input
                    type="password"
                    value={newProxy.password}
                    onChange={(e) => setNewProxy((p) => ({ ...p, password: e.target.value }))}
                    placeholder="Password (optional)"
                    disabled={submitting}
                    className="col-span-2 rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                  />
                </div>
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
