// V-534.X — Crypto orders history view.
// V-534.Z — adds per-row Cancel action for pending orders.
//
// Renders the caller account's crypto-order history using
// useCryptoOrdersList (V-534.W) + CryptoOrderStatusBadge (V-534.U).
// Shows order_id, product, price, status, and created/updated
// timestamps. Refresh button re-runs the fetch. Pending rows get
// a Cancel button wired to useCancelOrder (V-534.Y).

import { useEffect } from 'react';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { useCancelOrder } from '../lib/use-cancel-order';
import { useCryptoOrdersList } from '../lib/use-crypto-orders-list';

function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const ago = Date.now() - then;
  if (ago < 60_000) return 'just now';
  if (ago < 60 * 60_000) return `${Math.floor(ago / 60_000).toString()}m ago`;
  if (ago < 24 * 60 * 60_000) return `${Math.floor(ago / (60 * 60_000)).toString()}h ago`;
  return `${Math.floor(ago / (24 * 60 * 60_000)).toString()}d ago`;
}

export function CryptoOrdersHistoryView(): JSX.Element {
  const { state, refetch } = useCryptoOrdersList();
  const cancel = useCancelOrder();

  // Refresh the list on a successful cancel so the new 'cancelled'
  // status flows into the table. The cancel-hook's `succeeded` state
  // is the trigger; we reset the hook after refetching so a second
  // cancel on a different row starts from idle.
  useEffect(() => {
    if (cancel.state.kind === 'succeeded') {
      void refetch().then(() => {
        cancel.reset();
      });
    }
  }, [cancel.state, cancel, refetch]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Crypto orders</h2>
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

      {cancel.state.kind === 'failed' && (
        <ErrorBanner message={cancel.state.message} onDismiss={() => cancel.reset()} />
      )}

      {state.kind === 'ready' && state.data.orders.length === 0 && (
        <div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">
          No crypto orders yet. Open a checkout from the Billing view to create one.
        </div>
      )}

      {state.kind === 'ready' && state.data.orders.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-ink-secondary">
            <tr>
              <th className="py-2 pr-4 font-medium">Order</th>
              <th className="py-2 pr-4 font-medium">Product</th>
              <th className="py-2 pr-4 font-medium">Price</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th className="py-2 pr-4 font-medium" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {state.data.orders.map((o) => {
              const isCancellingThis =
                cancel.state.kind === 'submitting' && cancel.state.orderId === o.order_id;
              return (
                <tr key={o.order_id} className="border-t border-surface-divider">
                  <td className="py-2 pr-4 font-mono text-xs">{o.order_id}</td>
                  <td className="py-2 pr-4">{o.product}</td>
                  <td className="py-2 pr-4">{formatCents(o.price_cents, o.price_currency)}</td>
                  <td className="py-2 pr-4">
                    <CryptoOrderStatusBadge status={o.status} size="sm" />
                  </td>
                  <td className="py-2 pr-4 text-ink-secondary">{formatRelative(o.created_at)}</td>
                  <td className="py-2 pr-4">
                    {o.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => void cancel.cancel(o.order_id)}
                        disabled={isCancellingThis}
                        className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-inset disabled:opacity-50"
                        aria-label={`Cancel order ${o.order_id}`}
                      >
                        {isCancellingThis ? 'Cancelling…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
