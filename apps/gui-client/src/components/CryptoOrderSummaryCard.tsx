// V-534.AF — presentational summary card for a single crypto order.
// V-534.BF — surfaces V-666.AV expires_at as a human-readable
//            "pay before X" countdown row when the order is pending.
//
// Replaces the inline <dl> block previously embedded in
// CryptoOrderDetailView. Pure presentational; no fetching, no actions.
// Callers compose this with cancel buttons / receipt panels around it.

import { CryptoOrderStatusBadge } from './CryptoOrderStatusBadge';
import { formatCents, formatProduct, formatTimestamp } from '../lib/crypto-format';
import type { CryptoOrderData } from '../lib/use-crypto-order';

export interface CryptoOrderSummaryCardProps {
  order: CryptoOrderData;
  /** Optional content rendered below the summary fields (cancel button, etc.). */
  footer?: React.ReactNode;
  /** V-534.BF — testing seam so the countdown is deterministic. Defaults to Date.now. */
  nowFn?: () => number;
}

function describeExpiry(expiresAtIso: string, nowMs: number): string {
  const expiresMs = new Date(expiresAtIso).getTime();
  const diff = expiresMs - nowMs;
  if (diff <= 0) return 'pay window elapsed';
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 1) return 'less than a minute remaining';
  if (minutes < 60) return `${minutes.toString()}m remaining`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours.toString()}h ${rem.toString()}m remaining`;
}

export function CryptoOrderSummaryCard(props: CryptoOrderSummaryCardProps): JSX.Element {
  const { order, footer, nowFn } = props;
  const showExpiry =
    order.status === 'pending' &&
    typeof order.expires_at === 'string' &&
    order.expires_at.length > 0;
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
        <dd>{formatProduct(order.product)}</dd>
        <dt className="text-ink-secondary">Amount</dt>
        <dd>{formatCents(order.price_cents, order.price_currency)}</dd>
        {order.payment_id !== null && (
          <>
            <dt className="text-ink-secondary">Payment id</dt>
            <dd className="font-mono text-xs">{order.payment_id}</dd>
          </>
        )}
        <dt className="text-ink-secondary">Created</dt>
        <dd>{formatTimestamp(order.created_at)}</dd>
        <dt className="text-ink-secondary">Updated</dt>
        <dd>{formatTimestamp(order.updated_at)}</dd>
        {showExpiry && (
          <>
            <dt className="text-ink-secondary">Pay by</dt>
            <dd>
              <span>{formatTimestamp(order.expires_at as string)}</span>{' '}
              <span className="text-xs text-ink-secondary">
                ({describeExpiry(order.expires_at as string, (nowFn ?? Date.now)())})
              </span>
            </dd>
          </>
        )}
      </dl>
      {footer !== undefined && <div className="mt-4">{footer}</div>}
    </section>
  );
}
