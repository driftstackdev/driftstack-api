// Profiles view — list profiles, create new, delete.
//
// V-136 (Tier 3 draft). Persistent identity slots that survive across
// sessions. Each profile carries its own cookies + localStorage; the
// driver attaches them to a session when the session is created against
// a profile.
//
// Mirrors SessionsView shape: 5-second poll, inline error banner, busy
// state per row.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError } from '../lib/client';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';

const REFRESH_MS = 5000;

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
}

export function ProfilesView({ onGoToSettings }: ProfilesViewProps): JSX.Element {
  const { client, settings, accountMe, refreshAccountMe } = useSettings();
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

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ profiles: [], refreshedAt: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const collected: Profile[] = [];
      for await (const profile of client.profiles.iterate({ limit: 50 })) {
        collected.push(profile);
      }
      setState({
        profiles: collected,
        refreshedAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: friendlyError(err, settings.baseUrl),
      }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleDelete(id: string): Promise<void> {
    if (!client) return;
    setBusyId(id);
    try {
      await client.profiles.delete(id);
      await refresh();
      // V-239 — refresh the cap counter so a deletion unlocks the
      // New profile button when we drop below cap.
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
          <span className="section-label">Profiles</span>
          <h2 className="text-lg font-medium text-ink-primary">
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
            New profile
          </button>
        </div>
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
          {state.profiles.map((profile) => (
            <li key={profile.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-primary">{profile.name}</p>
                <p className="mt-0.5 mono text-xs text-ink-muted">{profile.id}</p>
                {profile.description !== null && (
                  <p className="mt-1 text-xs text-ink-secondary">{profile.description}</p>
                )}
                <p className="mt-1 text-xs text-ink-muted">
                  Archetype: <span className="mono">{profile.archetype}</span>
                  {profile.last_used_at !== null && (
                    <>
                      {' · '}
                      last used {new Date(profile.last_used_at).toLocaleString()}
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void handleDelete(profile.id)}
                disabled={busyId === profile.id}
              >
                {busyId === profile.id ? 'Deleting…' : 'Delete'}
              </button>
            </li>
          ))}
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
            void refresh();
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
      await client.profiles.create({
        name: trimmed,
        archetype,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      });
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

          <label className="flex flex-col gap-1">
            <span className="section-label">Archetype</span>
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
                Single archetype available today — expands as new device targets land.
              </span>
            )}
          </label>

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
