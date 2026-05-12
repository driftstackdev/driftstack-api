// V-534.AM — admin order-detail drawer.
// V-534.AN — adds inline action button (edit/add internal note) so an
//            admin can act without first scrolling back to the table
//            row.
// V-534.BD — adds an event-timeline section below the envelope,
//            sourced from V-666.AT (GET /events). Fetches on mount /
//            orderId change; errors render an inline message but
//            don't block the rest of the drawer.
//
// Click a row in CryptoOrdersAdminView (V-534.AG) to open this drawer
// with the full order envelope: account, status, customer note,
// internal note, and timestamps. Pure presentational — receives an
// order object + optional action callbacks. When the callbacks are
// omitted, the action buttons are not rendered (the drawer remains
// useful in read-only contexts like ops dashboards).
//
// Crypto payments are non-refundable. The drawer intentionally does
// not surface refund actions; customer cancellation stops future
// billing periods but does not refund the current period.

import { CryptoOrderStatusBadge } from './CryptoOrderStatusBadge';
import { formatCents } from '../lib/crypto-format';
import type { AdminCryptoOrder } from '../lib/use-admin-crypto-orders-list';
import { useAdminOrderEvents } from '../lib/use-admin-order-events';

export interface CryptoOrderAdminDetailDrawerProps {
  order: AdminCryptoOrder;
  onClose: () => void;
  /** Fires when admin clicks "Edit note". Optional — read-only when omitted. */
  onEditNote?: (order: AdminCryptoOrder) => void;
}

export function CryptoOrderAdminDetailDrawer(
  props: CryptoOrderAdminDetailDrawerProps,
): JSX.Element {
  const { order, onClose, onEditNote } = props;
  const hasAnyAction = onEditNote !== undefined;
  const events = useAdminOrderEvents(order.order_id);
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

      <section aria-label="Order events timeline">
        <p className="text-xs uppercase text-ink-secondary">Timeline</p>
        {events.state.kind === 'loading' || events.state.kind === 'idle' ? (
          <p className="mt-1 text-sm text-ink-secondary">Loading timeline…</p>
        ) : events.state.kind === 'error' ? (
          <p className="mt-1 text-sm text-status-error">
            Timeline unavailable: {events.state.message}
          </p>
        ) : events.state.kind === 'ready' ? (
          <ol className="mt-1 flex flex-col gap-1 text-sm">
            {events.state.events.map((e, i) => (
              <li
                key={`${e.at}-${i.toString()}`}
                className="flex items-center justify-between gap-2 rounded border border-surface-divider bg-surface-inset px-2 py-1"
              >
                <span className="flex items-center gap-2">
                  <CryptoOrderStatusBadge status={e.status} size="sm" />
                  <span className="text-xs text-ink-secondary">via {e.source}</span>
                </span>
                <span className="font-mono text-xs text-ink-secondary">{e.at}</span>
              </li>
            ))}
          </ol>
        ) : null}
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
        </section>
      )}
    </aside>
  );
}
