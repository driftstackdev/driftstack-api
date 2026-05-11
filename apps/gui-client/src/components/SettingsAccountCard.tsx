// V-534.L — account-info card surfaced in SettingsView.
//
// Shows the connected account id (read from /v1/account/me) plus a
// "Manage billing" link that opens the dashboard's billing page.
// Stays a separate component so SettingsView's existing tests (V-272)
// don't churn — parent decides whether to mount it.
//
// The card has three observable states:
//   - loading: account fetch in-flight
//   - error: 401 / 403 / network — the card collapses to a small notice
//   - ready: account id + tier rendered, billing link visible

import { useEffect, useState } from 'react';
import { useSettings } from '../lib/SettingsContext';

interface AccountMeResponse {
  account: {
    id: string;
    email: string;
    tier: string;
  };
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; account: AccountMeResponse['account'] };

/**
 * Resolve the dashboard URL for the configured baseUrl. The mapping
 * lives here (and not in SettingsContext) so the card is the single
 * place that has to change when the dashboard moves.
 */
function dashboardUrlFor(baseUrl: string): string {
  // localhost / app.driftstack.local → use the dev dashboard.
  if (baseUrl.includes('localhost') || baseUrl.includes('driftstack.local')) {
    return 'http://localhost:5173';
  }
  return 'https://app.driftstack.dev';
}

export function SettingsAccountCard(): JSX.Element | null {
  const { settings } = useSettings();
  const [state, setState] = useState<CardState>({ kind: 'loading' });

  useEffect(() => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/v1/account/me`, {
          headers: { authorization: `Bearer ${settings.apiKey ?? ''}`, accept: 'application/json' },
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status.toString()}` });
          return;
        }
        const body = (await res.json()) as AccountMeResponse;
        setState({ kind: 'ready', account: body.account });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.apiKey, settings.baseUrl]);

  const dashboardUrl = dashboardUrlFor(settings.baseUrl);

  return (
    <section
      aria-label="Account info"
      className="max-w-xl rounded border border-surface-divider bg-surface-raised px-4 py-3 space-y-2"
    >
      <header className="flex items-baseline justify-between">
        <span className="section-label">Account</span>
        <a
          href={`${dashboardUrl}/billing`}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-accent underline"
        >
          Manage billing →
        </a>
      </header>

      {state.kind === 'loading' && (
        <p className="text-sm text-ink-secondary" role="status">
          Loading account…
        </p>
      )}
      {state.kind === 'error' && (
        <p className="text-sm text-status-warning" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && (
        <dl className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-secondary">Account id</dt>
            <dd className="font-mono text-ink-primary">{state.account.id}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-secondary">Email</dt>
            <dd className="text-ink-primary">{state.account.email}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-secondary">Tier</dt>
            <dd className="text-ink-primary">{state.account.tier}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
