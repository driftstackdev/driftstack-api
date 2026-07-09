// V-534.AD — single-order detail view.
// V-534.AF — body now rendered via CryptoOrderSummaryCard.
// V-534.BE — renders the V-666.AU events timeline inline below the
//            summary card so the customer can see when the order
//            transitioned states (useful for proving payment in
//            support tickets).
//
// Combines useCryptoOrder (poll), useCancelOrder (V-534.Y), and
// CryptoReceiptView (V-534.AB) on one page. Cancel is only offered
// while status === 'pending'; a confirming/partial/paid/failed order
// shows an explanatory note instead. The receipt panel renders inline
// once the order reaches paid; before that we surface the polling
// status so the user knows we're waiting for on-chain confirmation.

import { useEffect, useRef, useState } from 'react';

import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { CryptoOrderSummaryCard } from '../components/CryptoOrderSummaryCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatTimestamp } from '../lib/crypto-format';
import { useCancelOrder } from '../lib/use-cancel-order';
import { useCryptoOrder, type CryptoOrderEvent } from '../lib/use-crypto-order';
import { CryptoReceiptView } from './CryptoReceiptView';

function EventsTimeline({ events }: { events: CryptoOrderEvent[] }): JSX.Element {
  if (events.length === 0) {
    return <p className="text-sm text-ink-secondary">No events recorded yet.</p>;
  }
  return (
    <ol aria-label="Order events timeline" className="flex flex-col gap-1 text-sm">
      {events.map((e, i) => (
        <li
          key={`${e.at}-${i.toString()}`}
          className="flex items-center justify-between gap-2 rounded border border-surface-divider bg-surface-inset px-2 py-1"
        >
          <span className="flex items-center gap-2">
            <CryptoOrderStatusBadge status={e.status} size="sm" />
            <span className="text-xs text-ink-secondary">via {e.source}</span>
          </span>
          <span className="text-xs text-ink-secondary">{formatTimestamp(e.at)}</span>
        </li>
      ))}
    </ol>
  );
}

export interface CryptoOrderDetailViewProps {
  /** The order id to display. Pass null for the empty state. */
  orderId: string | null;
}

export function CryptoOrderDetailView(props: CryptoOrderDetailViewProps): JSX.Element {
  const { state, refetch } = useCryptoOrder(props.orderId);
  const cancel = useCancelOrder();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const keepBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirmOpen(false);
    };
    window.addEventListener('keydown', onKey);
    keepBtnRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [confirmOpen]);

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
    // Dismiss retries the order fetch rather than dead-ending on a stale error.
    return <ErrorBanner message={state.message} onDismiss={() => void refetch()} />;
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
            onClick={() => setConfirmOpen(true)}
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
      {(order.status === 'confirming' || order.status === 'partial') && (
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
      {order.events !== undefined && order.events.length > 0 && (
        <section aria-label="Timeline" className="flex flex-col gap-2">
          <h4 className="text-xs uppercase text-ink-secondary">Timeline</h4>
          <EventsTimeline events={order.events} />
        </section>
      )}
      {isPaid && <CryptoReceiptView orderId={order.order_id} />}
      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm order cancellation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-surface-divider bg-surface-base p-6">
            <h3 className="text-base font-semibold">Cancel this order?</h3>
            <p className="text-sm">
              Order <span className="font-mono text-xs">{order.order_id}</span> will be marked
              cancelled. You can still mint a new order afterwards. Crypto payments are{' '}
              <strong>non-refundable</strong>; cancelling only stops the pending pay window — if
              you've already sent crypto, contact support to reconcile.
            </p>
            <div className="flex justify-end gap-2">
              <button
                ref={keepBtnRef}
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded border border-surface-divider px-3 py-1 text-sm hover:bg-surface-inset"
              >
                Keep order
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  void onCancel();
                }}
                className="rounded border border-status-error/40 bg-status-error/10 px-3 py-1 text-sm font-medium text-status-error hover:bg-status-error/20"
              >
                Confirm cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
