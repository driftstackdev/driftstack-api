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

const REFRESH_MS = 5000;

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
  const { client, settings } = useSettings();
  const [state, setState] = useState<ProfilesState>({
    profiles: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);

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
        error: friendlyError(err),
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
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err) }));
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
            <span className="ml-2 mono text-ink-muted">{state.profiles.length}</span>
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
          {/* New-profile flow lands later — needs a name + archetype picker dialog. */}
          <button type="button" className="btn-primary" disabled aria-disabled="true">
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
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-md text-center">
            <span className="section-label">No profiles</span>
            <p className="mt-2 text-sm text-ink-secondary">
              Profiles let you persist cookies + localStorage across sessions for recurring
              workloads. Create one to attach sessions to a persistent identity.
            </p>
          </div>
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

function friendlyError(err: unknown): string {
  if (err instanceof DriftstackError) {
    return `${err.title} (${err.kind}): ${err.detail ?? err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
