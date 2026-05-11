// V-534.AF — presentational summary card for a single crypto order.
//
// Replaces the inline <dl> block previously embedded in
// CryptoOrderDetailView. Pure presentational; no fetching, no actions.
// Callers compose this with cancel buttons / receipt panels around it.

import { CryptoOrderStatusBadge } from './CryptoOrderStatusBadge';
import { formatCents } from '../lib/crypto-format';
import type { CryptoOrderData } from '../lib/use-crypto-order';

export interface CryptoOrderSummaryCardProps {
  order: CryptoOrderData;
  /** Optional content rendered below the summary fields (cancel button, etc.). */
  footer?: React.ReactNode;
}

export function CryptoOrderSummaryCard(props: CryptoOrderSummaryCardProps): JSX.Element {
  const { order, footer } = props;
  return (
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
      {footer !== undefined && <div className="mt-4">{footer}</div>}
    </section>
  );
}
