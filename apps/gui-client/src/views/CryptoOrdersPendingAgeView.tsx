// V-534.AO — admin pending-orders age histogram view.
//
// Companion to V-534.AG (admin list) + V-534.AH (daily breakdown).
// Renders the four age buckets returned by
// /v1/admin/crypto-orders/pending-age (V-666.AC) so ops can spot stale
// pending orders at a glance. The over_24h bucket is the most
// operationally interesting — those are candidates for the
// sweep-expired endpoint.

import { ErrorBanner } from '../components/ErrorBanner';
import { formatCents } from '../lib/crypto-format';
import { useAdminCryptoPendingAge } from '../lib/use-admin-crypto-pending-age';

interface BucketDef {
  key: 'under_1h' | 'h1_to_6h' | 'h6_to_24h' | 'over_24h';
  label: string;
  hint: string;
}

const BUCKETS: BucketDef[] = [
  { key: 'under_1h', label: 'Under 1h', hint: 'Fresh' },
  { key: 'h1_to_6h', label: '1–6h', hint: 'Normal' },
  { key: 'h6_to_24h', label: '6–24h', hint: 'Watch' },
  { key: 'over_24h', label: 'Over 24h', hint: 'Sweep candidate' },
];

export function CryptoOrdersPendingAgeView(): JSX.Element {
  const { state, refetch } = useAdminCryptoPendingAge();

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Pending orders — age histogram</h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={state.kind === 'loading'}
          className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {state.kind === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {state.kind === 'error' && (
        <ErrorBanner message={state.message} onDismiss={() => void refetch()} />
      )}

      {state.kind === 'ready' && (
        <>
          <p className="text-sm text-ink-secondary">
            <strong>{state.data.total}</strong> pending order
            {state.data.total === 1 ? '' : 's'} in scope.
            {state.data.truncated && (
              <span className="ml-2 text-status-warning">
                Scan truncated at {state.data.scanned} — widen the analytics window if this becomes
                routine.
              </span>
            )}
          </p>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="pending-age-buckets">
            {BUCKETS.map((b) => {
              const count = state.data.buckets[b.key];
              return (
                <div
                  key={b.key}
                  className="rounded-md border border-surface-divider bg-surface-inset p-4"
                  data-testid={`bucket-${b.key}`}
                >
                  <div className="text-xs uppercase tracking-wide text-ink-secondary">
                    {b.label}
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{count}</div>
                  <div className="mt-1 text-xs text-ink-secondary">{b.hint}</div>
                </div>
              );
            })}
          </div>

          <section>
            <h3 className="text-sm font-medium text-ink-secondary">Pending value by currency</h3>
            {Object.keys(state.data.pending_value_cents).length === 0 ? (
              <p className="mt-1 text-sm text-ink-secondary">No pending value.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-3 text-sm">
                {Object.entries(state.data.pending_value_cents).map(([currency, cents]) => (
                  <li
                    key={currency}
                    className="rounded border border-surface-divider bg-surface-base px-3 py-1 font-mono"
                    data-testid={`pending-value-${currency}`}
                  >
                    {formatCents(cents, currency)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
