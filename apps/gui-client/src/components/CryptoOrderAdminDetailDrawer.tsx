// V-534.AM — admin order-detail drawer.
// V-534.AN — adds inline action buttons (edit note, request/clear
//            refund) so an admin can act without first scrolling
//            back to the table row.
//
// Click a row in CryptoOrdersAdminView (V-534.AG) to open this drawer
// with the full order envelope: account, status, customer note,
// refund metadata, internal note, and timestamps. Pure presentational
// — receives an order object + optional action callbacks. When the
// callbacks are omitted, the action buttons are not rendered (the
// drawer remains useful in read-only contexts like ops dashboards).

import { CryptoOrderStatusBadge } from './CryptoOrderStatusBadge';
import { formatCents } from '../lib/crypto-format';
import type { AdminCryptoOrder } from '../lib/use-admin-crypto-orders-list';

export interface CryptoOrderAdminDetailDrawerProps {
  order: AdminCryptoOrder;
  onClose: () => void;
  /** Fires when admin clicks "Edit note". Optional — read-only when omitted. */
  onEditNote?: (order: AdminCryptoOrder) => void;
  /** Fires when admin clicks "Request refund" (paid orders only). */
  onRequestRefund?: (order: AdminCryptoOrder) => void;
  /** Fires when admin clicks "Clear refund" (orders with refund_requested_at set). */
  onCancelRefund?: (order: AdminCryptoOrder) => void;
}

function formatIso(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  return iso;
}

export function CryptoOrderAdminDetailDrawer(
  props: CryptoOrderAdminDetailDrawerProps,
): JSX.Element {
  const { order, onClose, onEditNote, onRequestRefund, onCancelRefund } = props;
  const refundOutstanding = order.refund_requested_at != null;
  const isPaid = order.status === 'paid';
  const hasAnyAction =
    onEditNote !== undefined || onRequestRefund !== undefined || onCancelRefund !== undefined;
  return (
    <aside
      role="complementary"
      aria-label={`Order detail for ${order.order_id}`}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-surface-divider bg-surface-base p-6 shadow-xl"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Order detail</h3>
          <p className="font-mono text-xs text-ink-secondary">{order.order_id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-inset"
          aria-label="Close order detail"
        >
          Close
        </button>
      </header>

      <div className="flex items-center gap-2">
        <CryptoOrderStatusBadge status={order.status} />
        {refundOutstanding && (
          <span className="inline-flex items-center rounded-full border border-status-warning/40 bg-status-warning/15 px-2 py-0.5 text-[10px] font-medium text-status-warning">
            Refund pending
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-ink-secondary">Account</dt>
        <dd className="font-mono text-xs">{order.account_id ?? '—'}</dd>
        <dt className="text-ink-secondary">Product</dt>
        <dd>{order.product}</dd>
        <dt className="text-ink-secondary">Amount</dt>
        <dd>{formatCents(order.price_cents, order.price_currency)}</dd>
        <dt className="text-ink-secondary">Payment id</dt>
        <dd className="font-mono text-xs">{order.payment_id ?? '—'}</dd>
        <dt className="text-ink-secondary">Created</dt>
        <dd>{order.created_at}</dd>
        <dt className="text-ink-secondary">Updated</dt>
        <dd>{order.updated_at}</dd>
      </dl>

      <section aria-label="Customer note">
        <p className="text-xs uppercase text-ink-secondary">Customer note</p>
        <p className="mt-1 whitespace-pre-wrap text-sm">
          {order.customer_note != null && order.customer_note.length > 0 ? (
            order.customer_note
          ) : (
            <span className="text-ink-secondary">No customer note.</span>
          )}
        </p>
      </section>

      <section aria-label="Internal note">
        <p className="text-xs uppercase text-ink-secondary">Internal note (admin-only)</p>
        <p className="mt-1 whitespace-pre-wrap text-sm">
          {order.internal_note != null && order.internal_note.length > 0 ? (
            order.internal_note
          ) : (
            <span className="text-ink-secondary">No internal note.</span>
          )}
        </p>
      </section>

      <section aria-label="Refund">
        <p className="text-xs uppercase text-ink-secondary">Refund</p>
        {refundOutstanding ? (
          <dl className="mt-1 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-ink-secondary">Requested at</dt>
            <dd>{formatIso(order.refund_requested_at)}</dd>
            <dt className="text-ink-secondary">Reason</dt>
            <dd className="whitespace-pre-wrap">{order.refund_reason ?? '—'}</dd>
          </dl>
        ) : (
          <p className="mt-1 text-sm text-ink-secondary">No refund recorded.</p>
        )}
      </section>

      {hasAnyAction && (
        <section aria-label="Order actions" className="flex flex-wrap gap-2">
          {onEditNote !== undefined && (
            <button
              type="button"
              onClick={() => onEditNote(order)}
              className="rounded border border-surface-divider px-3 py-1 text-sm font-medium hover:bg-surface-inset"
            >
              {order.internal_note != null && order.internal_note.length > 0
                ? 'Edit note'
                : 'Add note'}
            </button>
          )}
          {onRequestRefund !== undefined && isPaid && !refundOutstanding && (
            <button
              type="button"
              onClick={() => onRequestRefund(order)}
              className="rounded border border-surface-divider px-3 py-1 text-sm font-medium hover:bg-surface-inset"
            >
              Request refund
            </button>
          )}
          {onCancelRefund !== undefined && refundOutstanding && (
            <button
              type="button"
              onClick={() => onCancelRefund(order)}
              className="rounded border border-status-warning/40 px-3 py-1 text-sm font-medium text-status-warning hover:bg-status-warning/10"
            >
              Clear refund
            </button>
          )}
        </section>
      )}
    </aside>
  );
}
