// V-534.AG — admin crypto-orders view.
//
// Admin-only counterpart to CryptoOrdersHistoryView. Calls
// /v1/admin/crypto-orders (V-666.D + V-666.T) and renders the full
// cross-account list with status + free-text-search filter controls.
// Caller must hold an API key with the `driftstack_internal_admin`
// scope; without it the API returns 403 which surfaces as an error
// banner.
//
// V-666.D returns account_id in the public envelope so each row
// surfaces the owning account (helpful for support drilling into a
// customer's order).

import { useState } from 'react';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatCents, formatRelative } from '../lib/crypto-format';
import {
  useAdminCryptoOrdersList,
  type AdminCryptoOrder,
} from '../lib/use-admin-crypto-orders-list';

const STATUS_OPTIONS: Array<{ value: AdminCryptoOrder['status'] | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirming', label: 'Confirming' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'partial', label: 'Partial' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function CryptoOrdersAdminView(): JSX.Element {
  const [status, setStatus] = useState<AdminCryptoOrder['status'] | ''>('');
  const [search, setSearch] = useState<string>('');
  const { state, refetch } = useAdminCryptoOrdersList({
    status: status === '' ? null : status,
    search,
  });

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Crypto orders (admin)</h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={state.kind === 'loading'}
          className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {state.kind === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as AdminCryptoOrder['status'] | '')}
            className="rounded border border-surface-divider bg-surface-base px-2 py-1 text-sm"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 items-center gap-2 text-sm">
          Search
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="order_id / product / customer note…"
            className="flex-1 rounded border border-surface-divider bg-surface-base px-2 py-1 text-sm"
          />
        </label>
      </div>

      {state.kind === 'error' && (
        <ErrorBanner message={state.message} onDismiss={() => void refetch()} />
      )}

      {state.kind === 'ready' && state.data.orders.length === 0 && (
        <div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">
          No orders match the current filters.
        </div>
      )}

      {state.kind === 'ready' && state.data.orders.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-ink-secondary">
            <tr>
              <th className="py-2 pr-4 font-medium">Order</th>
              <th className="py-2 pr-4 font-medium">Account</th>
              <th className="py-2 pr-4 font-medium">Product</th>
              <th className="py-2 pr-4 font-medium">Price</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {state.data.orders.map((o) => (
              <tr key={o.order_id} className="border-t border-surface-divider">
                <td className="py-2 pr-4 font-mono text-xs">{o.order_id}</td>
                <td className="py-2 pr-4 font-mono text-xs">{o.account_id ?? '—'}</td>
                <td className="py-2 pr-4">{o.product}</td>
                <td className="py-2 pr-4">{formatCents(o.price_cents, o.price_currency)}</td>
                <td className="py-2 pr-4">
                  <CryptoOrderStatusBadge status={o.status} size="sm" />
                </td>
                <td className="py-2 pr-4 text-ink-secondary">{formatRelative(o.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
