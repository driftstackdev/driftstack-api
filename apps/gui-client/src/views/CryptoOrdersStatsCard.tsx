// V-534.AI — admin stats summary card for crypto orders.
//
// Surfaces the /v1/admin/crypto-orders/stats response (V-666.N +
// V-666.W) as a compact at-a-glance card: total orders, per-status
// counts, paid revenue per currency, and the avg time-to-paid KPI.
// Pure read-only; no actions.

import { formatCents } from '../lib/crypto-format';
import { ErrorBanner } from '../components/ErrorBanner';
import { useAdminCryptoStats, type AdminCryptoStatsStatus } from '../lib/use-admin-crypto-stats';

const STATUS_LABELS: Record<AdminCryptoStatsStatus, string> = {
  pending: 'Pending',
  confirming: 'Confirming',
  paid: 'Paid',
  failed: 'Failed',
  partial: 'Partial',
  cancelled: 'Cancelled',
};

const STATUS_ORDER: AdminCryptoStatsStatus[] = [
  'pending',
  'confirming',
  'paid',
  'failed',
  'partial',
  'cancelled',
];

function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000).toString()}s`;
  if (ms < 60 * 60_000) {
    const minutes = ms / 60_000;
    return `${minutes.toFixed(1)}m`;
  }
  const hours = ms / (60 * 60_000);
  return `${hours.toFixed(1)}h`;
}

export function CryptoOrdersStatsCard(): JSX.Element {
  const { state, refetch } = useAdminCryptoStats();

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">
        Loading stats…
      </div>
    );
  }

  if (state.kind === 'error') {
    return <ErrorBanner message={state.message} onDismiss={() => void refetch()} />;
  }

  const { data } = state;
  const revenueEntries = Object.entries(data.paid_revenue_cents);

  return (
    <section
      aria-label="Crypto orders stats"
      className="flex flex-col gap-4 rounded-md border border-surface-divider bg-surface-inset p-4"
    >
      <header className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Crypto orders — at a glance</h3>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-base"
        >
          Refresh
        </button>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs uppercase text-ink-secondary">Total orders</p>
          <p className="text-xl font-semibold">{data.total}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-ink-secondary">Paid</p>
          <p className="text-xl font-semibold">{data.by_status.paid}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-ink-secondary">Pending</p>
          <p className="text-xl font-semibold">{data.by_status.pending}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-ink-secondary">Avg time-to-pay</p>
          <p className="text-xl font-semibold">
            {data.avg_time_to_paid_ms !== null ? formatDurationMs(data.avg_time_to_paid_ms) : '—'}
          </p>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs uppercase text-ink-secondary">By status</p>
        <dl className="grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-3">
          {STATUS_ORDER.map((s) => (
            <div key={s} className="flex items-center justify-between gap-2">
              <dt className="text-ink-secondary">{STATUS_LABELS[s]}</dt>
              <dd>{data.by_status[s]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <p className="mb-1 text-xs uppercase text-ink-secondary">Paid revenue</p>
        {revenueEntries.length === 0 ? (
          <p className="text-sm text-ink-secondary">No paid orders in scope.</p>
        ) : (
          <ul className="flex flex-wrap gap-3 text-sm">
            {revenueEntries.map(([currency, cents]) => (
              <li key={currency} className="font-mono">
                {formatCents(cents, currency)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.truncated && (
        <p className="text-xs text-status-warning">
          Stats scanned {data.scanned} orders and stopped at the scan-window limit. Numbers may be
          undercounts; widen the analytics window if this becomes routine.
        </p>
      )}
    </section>
  );
}
