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
//     with plain-language guidance and a Retry button
//   - ready: account id + tier rendered, billing link visible

import { useCallback, useEffect, useState } from 'react';
import { disposeResponseBody } from '../lib/dispose-response-body';
import { fetchWithDeadline } from '../lib/fetch-with-deadline';
import { readBoundedApiJson } from '../lib/read-bounded-json';
import { useSettings } from '../lib/SettingsContext';
import { humanizeError } from '../lib/humanize-error';
import { useToasts } from '../lib/toasts';

/**
 * The FLAT shape `GET /v1/account/me` actually returns
 * (`apps/server/src/routes/account-me.ts` — `return { id, email, name, tier, ... }`).
 *
 * ⛔ V-1611 — this used to declare a NESTED `{ account: { id, email, tier } }`,
 * which the route has never sent. `body.account` was therefore `undefined` and
 * the first `state.account.id` in the render threw, taking the whole Settings
 * tab down behind the error boundary. It failed on the SUCCESS path, which is
 * why every error path looked healthy.
 *
 * It survived because the FIXTURES agreed with the bug rather than with the
 * server — `tests/unit/SettingsAccountCard.test.tsx` and `SettingsView.test.tsx`
 * both built `{ account: {...} }`, so the suite was green while production
 * crashed. `SettingsContext.refreshAccountMe` reads the flat shape and is the
 * canonical reader; this card was the only consumer that disagreed.
 */
interface AccountMeResponse {
  id: string;
  email: string;
  tier: string;
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; account: AccountMeResponse };

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
  return 'https://app.driftstack.io';
}

/**
 * Turn a raw tier slug ('self_hosted', 'pay-as-you-go') into a human
 * label ('Self Hosted', 'Pay As You Go') so the card never shows a
 * lowercase database value to the customer.
 */
function humanizeTier(tier: string): string {
  return tier
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Map a failed /v1/account/me fetch to plain, actionable copy. Raw
 * 'HTTP 401' told the customer nothing; 401/403 almost always means the
 * saved API key is wrong or lacks access.
 */
function errorMessageForStatus(status: number): string {
  if (status === 401) return "Your API key wasn't accepted. Check the key above, then retry.";
  if (status === 403) return "This API key doesn't have access to account info.";
  if (status === 404) return 'Account info is not available for this key.';
  if (status === 429) return 'Too many requests. Wait a moment, then retry.';
  if (status >= 500) return 'The account service is temporarily unavailable. Try again shortly.';
  return "Couldn't load account info. Check the server URL, then retry.";
}

export function SettingsAccountCard(): JSX.Element | null {
  const { settings } = useSettings();
  const { push: pushToast } = useToasts();
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  // Bumping the nonce re-runs the fetch effect — the Retry button's mechanism.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!settings.apiKey) {
      setState({ kind: 'error', message: 'No API key configured.' });
      return;
    }
    setState({ kind: 'loading' });
    const controller = new AbortController();
    void (async () => {
      try {
        const baseUrl = settings.baseUrl.replace(/\/+$/, '');
        const res = await fetchWithDeadline(`${baseUrl}/v1/account/me`, {
          signal: controller.signal,
          headers: { authorization: `Bearer ${settings.apiKey ?? ''}`, accept: 'application/json' },
        });
        if (controller.signal.aborted) {
          await disposeResponseBody(res);
          return;
        }
        if (!res.ok) {
          const status = res.status;
          await disposeResponseBody(res);
          setState({ kind: 'error', message: errorMessageForStatus(status) });
          return;
        }
        const body = await readBoundedApiJson<AccountMeResponse>(res);
        if (controller.signal.aborted) return;
        setState({ kind: 'ready', account: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'The request took too long. Check your connection and try again.'
              : humanizeError(err, "Couldn't load account info. Try again."),
        });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [settings.apiKey, settings.baseUrl, retryNonce]);

  const dashboardUrl = dashboardUrlFor(settings.baseUrl);

  const handleCopyId = useCallback(
    async (id: string): Promise<void> => {
      try {
        if (navigator.clipboard === undefined) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(id);
        pushToast({ title: 'Copied', tone: 'success' });
      } catch {
        pushToast({ title: "Couldn't copy — clipboard blocked", tone: 'error' });
      }
    },
    [pushToast],
  );

  return (
    <section
      aria-label="Account info"
      className="rounded-xl border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm space-y-2"
    >
      <header className="flex items-baseline justify-between">
        <span className="section-label">Account</span>
        <a
          href={`${dashboardUrl}/billing/`}
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
        <div className="flex items-start justify-between gap-3" role="alert">
          <p className="text-sm text-status-warning">{state.message}</p>
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <dl className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-ink-secondary">Account id</dt>
            <dd className="min-w-0">
              <button
                type="button"
                onClick={() => void handleCopyId(state.account.id)}
                title="Copy account id"
                className="block w-full truncate text-right font-mono text-ink-primary underline decoration-dotted underline-offset-2 hover:text-accent"
              >
                {state.account.id}
              </button>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-ink-secondary">Email</dt>
            <dd className="min-w-0 truncate text-right text-ink-primary">{state.account.email}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-ink-secondary">Tier</dt>
            <dd className="text-ink-primary">{humanizeTier(state.account.tier)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
