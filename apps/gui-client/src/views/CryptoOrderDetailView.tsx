// V-534.AD — single-order detail view.
//
// Combines useCryptoOrder (poll), useCancelOrder (V-534.Y), and
// CryptoReceiptView (V-534.AB) on one page. Cancel is only offered
// while status === 'pending'; a confirming/partial/paid/failed order
// shows an explanatory note instead. The receipt panel renders inline
// once the order reaches paid; before that we surface the polling
// status so the user knows we're waiting for on-chain confirmation.

import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { useCancelOrder } from '../lib/use-cancel-order';
import { useCryptoOrder } from '../lib/use-crypto-order';
import { CryptoReceiptView } from './CryptoReceiptView';

export interface CryptoOrderDetailViewProps {
  /** The order id to display. Pass null for the empty state. */
  orderId: string | null;
}

function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function CryptoOrderDetailView(props: CryptoOrderDetailViewProps): JSX.Element {
  const { state, refetch } = useCryptoOrder(props.orderId);
  const cancel = useCancelOrder();

  if (props.orderId === null) {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">
        Pick an order to view its details.
      </div>
    );
  }

  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">
        Loading order…
      </div>
    );
  }

  if (state.kind === 'error') {
    return <ErrorBanner message={state.message} onDismiss={() => undefined} />;
  }

  const order = state.data;
  const cancellable = order.status === 'pending';
  const isPaid = order.status === 'paid';

  const onCancel = async (): Promise<void> => {
    await cancel.cancel(order.order_id);
    // Refresh the order so the badge transitions out of "pending".
    await refetch();
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-md border border-surface-divider bg-surface-inset p-4">
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Order</h3>
            <p className="font-mono text-xs text-ink-secondary">{order.order_id}</p>
          </div>
          <CryptoOrderStatusBadge status={order.status} />
        </header>
        <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-ink-secondary">Product</dt>
          <dd>{order.product}</dd>
          <dt className="text-ink-secondary">Amount</dt>
          <dd>{formatCents(order.price_cents, order.price_currency)}</dd>
          {order.payment_id !== null && (
            <>
              <dt className="text-ink-secondary">Payment id</dt>
              <dd className="font-mono text-xs">{order.payment_id}</dd>
            </>
          )}
          <dt className="text-ink-secondary">Created</dt>
          <dd>{order.created_at}</dd>
          <dt className="text-ink-secondary">Updated</dt>
          <dd>{order.updated_at}</dd>
        </dl>

        {cancellable && (
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void onCancel()}
              disabled={cancel.state.kind === 'submitting'}
              className="self-start rounded border border-status-error/40 px-3 py-1 text-sm text-status-error hover:bg-status-error/10 disabled:opacity-50"
            >
              {cancel.state.kind === 'submitting' ? 'Cancelling…' : 'Cancel order'}
            </button>
            {cancel.state.kind === 'failed' && (
              <p className="text-xs text-status-error">{cancel.state.message}</p>
            )}
          </div>
        )}

        {!cancellable && order.status !== 'paid' && order.status !== 'failed' && (
          <p className="mt-4 text-xs text-ink-secondary">
            Payment activity has been detected on-chain. Cancellation is no longer self-service —
            contact support to reconcile or refund.
          </p>
        )}
      </section>

      {isPaid && <CryptoReceiptView orderId={order.order_id} />}
    </div>
  );
}
