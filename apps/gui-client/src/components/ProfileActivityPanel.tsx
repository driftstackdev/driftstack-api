// P-23 — a profile's recent navigation, read from GET /v1/profiles/:id/activity.
//
// ⛔ NAMING IS PART OF THE CONTRACT. This is ACCOUNT ACTIVITY, never "browsing
// history". Ledger decision D-1 keeps the server-side session transcript out of
// the profile's "Clear history" action (which clears the profile's open tabs on
// the device and nothing else), so a customer who clears history and then opens
// this panel still sees these rows. A heading that said "history" would have the
// product tell them two contradictory things. The subtitle says so in plain
// words instead of hiding it.

import { useEffect, useState } from 'react';
import type { ProfileActivityResponse } from '@driftstack/sdk';

/** Structural: only the one call this panel makes, so a test double is trivial
 *  and the panel cannot grow a hidden dependency on the rest of the client. */
interface ActivityClient {
  profiles: { activity(id: string): Promise<ProfileActivityResponse> };
}

interface ProfileActivityPanelProps {
  client: ActivityClient;
  profileId: string;
  profileName: string;
  onClose: () => void;
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'ready'; activity: ProfileActivityResponse }
  | { kind: 'error'; message: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function whenOf(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

export function ProfileActivityPanel(props: ProfileActivityPanelProps): JSX.Element {
  const { client, profileId, profileName, onClose } = props;
  const [state, setState] = useState<PanelState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    client.profiles
      .activity(profileId)
      .then((activity) => {
        if (!cancelled) setState({ kind: 'ready', activity });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not load activity.';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [client, profileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-activity-title"
      data-component="profile-activity-panel"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-divider bg-surface-elevated text-ink-primary shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4">
          <div className="min-w-0">
            <h2 id="profile-activity-title" className="truncate text-base font-semibold">
              Activity · {profileName}
            </h2>
            {/* The honest sentence. Do not shorten it to "history". */}
            <p
              className="mt-1 text-xs text-ink-secondary"
              data-component="profile-activity-subtitle"
            >
              Pages this profile&apos;s sessions opened, from your account&apos;s session records.
              Clearing the profile&apos;s history does not remove these.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-sm text-ink-secondary hover:bg-surface-raised hover:text-ink-primary"
            onClick={onClose}
            aria-label="Close activity"
          >
            ✕
          </button>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-3"
          data-component="profile-activity-body"
        >
          {state.kind === 'loading' ? (
            <p className="py-6 text-center text-sm text-ink-secondary">Loading activity…</p>
          ) : state.kind === 'error' ? (
            <p className="py-6 text-center text-sm text-danger" role="alert">
              {state.message}
            </p>
          ) : state.activity.data.length === 0 ? (
            <p
              className="py-6 text-center text-sm text-ink-secondary"
              data-component="profile-activity-empty"
            >
              No pages recorded yet. Activity appears here after a session opens a page with this
              profile.
            </p>
          ) : (
            <ol className="divide-y divide-divider" data-component="profile-activity-list">
              {state.activity.data.map((row, i) => (
                <li
                  key={`${row.agent_session_id}:${row.at}:${String(i)}`}
                  className="flex items-baseline gap-3 py-2 text-sm"
                  data-component="profile-activity-row"
                >
                  <time
                    dateTime={row.at}
                    className="shrink-0 font-mono text-[11px] tabular-nums text-ink-secondary"
                  >
                    {whenOf(row.at)}
                  </time>
                  <span className="min-w-0 flex-1 truncate" title={row.url}>
                    <span className="font-medium">{hostOf(row.url)}</span>
                    <span className="text-ink-secondary"> {row.url}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {state.kind === 'ready' ? (
          <footer className="border-t border-divider px-5 py-2 text-[11px] text-ink-secondary">
            {state.activity.sessions_scanned === 1
              ? '1 session read'
              : `${String(state.activity.sessions_scanned)} sessions read`}
            {state.activity.truncated ? ' · older activity exists but is not shown' : ''}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
