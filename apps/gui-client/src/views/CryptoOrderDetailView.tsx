// V-534.AD — single-order detail view.
// V-534.AF — body now rendered via CryptoOrderSummaryCard.
//
// Combines useCryptoOrder (poll), useCancelOrder (V-534.Y), and
// CryptoReceiptView (V-534.AB) on one page. Cancel is only offered
// while status === 'pending'; a confirming/partial/paid/failed order
// shows an explanatory note instead. The receipt panel renders inline
// once the order reaches paid; before that we surface the polling
// status so the user knows we're waiting for on-chain confirmation.

import { CryptoOrderSummaryCard } from '../components/CryptoOrderSummaryCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { useCancelOrder } from '../lib/use-cancel-order';
import { useCryptoOrder } from '../lib/use-crypto-order';
import { CryptoReceiptView } from './CryptoReceiptView';

export interface CryptoOrderDetailViewProps {
  /** The order id to display. Pass null for the empty state. */
  orderId: string | null;
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

  const footer = (
    <>
      {cancellable && (
        <div className="flex flex-col gap-2">
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
        <p className="text-xs text-ink-secondary">
          Payment activity has been detected on-chain. Cancellation is no longer self-service —
          contact support to reconcile or refund.
        </p>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <CryptoOrderSummaryCard order={order} footer={footer} />
      {isPaid && <CryptoReceiptView orderId={order.order_id} />}
    </div>
  );
}
