// V-534.X — Crypto orders history view.
// V-534.Z — adds per-row Cancel action for pending orders.
// V-534.AE — clicking a row opens the V-534.AD CryptoOrderDetailView
//             in a side panel; selection state stays local to this view.
// V-534.BG — pending rows with under 15 minutes remaining on the
//            V-666.AV pay-window get an "Expires soon" pill so the
//            customer can spot them without opening each detail view.
// V-534.BJ — clicking Cancel opens a confirmation modal first
//            (non-refundable disclaimer + explicit confirm) instead
//            of firing the cancel immediately. Footguns the customer
//            into a deliberate choice.
// V-534.BK — modal a11y: pressing Escape closes the modal; the
//            "Keep order" button receives focus on open (the safer
//            default action).
// V-534.BQ — status filter dropdown wired to the V-666.BR
//            server-side filter. Single-value, defaults to "all".
// V-534.BS — auto-refresh every 60s while any visible order is
//            still pending. Stops once everything settles so we
//            don't poll forever on stale tabs.
//
// Renders the caller account's crypto-order history using
// useCryptoOrdersList (V-534.W) + CryptoOrderStatusBadge (V-534.U).
// Shows order_id, product, price, status, and created/updated
// timestamps. Refresh button re-runs the fetch. Pending rows get
// a Cancel button wired to useCancelOrder (V-534.Y).

import { useEffect, useRef, useState } from 'react';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { SkeletonRows } from '../components/Skeleton';
import { formatCents, formatRelative } from '../lib/crypto-format';
import { useCancelOrder } from '../lib/use-cancel-order';
import { useCryptoOrdersList } from '../lib/use-crypto-orders-list';
import { CryptoOrderDetailView } from './CryptoOrderDetailView';

/** V-534.BG — threshold for the "Expires soon" pill on the history list. */
const EXPIRES_SOON_THRESHOLD_MS = 15 * 60 * 1000;

function isExpiringSoon(
  status: string,
  expiresAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (status !== 'pending') return false;
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) return false;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return false;
  const diff = expiresMs - nowMs;
  return diff > 0 && diff <= EXPIRES_SOON_THRESHOLD_MS;
}

export interface CryptoOrdersHistoryViewProps {
  /** V-534.BG — testing seam for the expires-soon clock. */
  nowFn?: () => number;
  /** V-534.BS — auto-refresh interval in ms. Default 60_000. */
  pendingRefreshMs?: number;
}

type StatusFilter = 'all' | 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';

export function CryptoOrdersHistoryView(props: CryptoOrdersHistoryViewProps = {}): JSX.Element {
  const { nowFn, pendingRefreshMs = 60_000 } = props;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [createdAfter, setCreatedAfter] = useState<string>('');
  const [createdBefore, setCreatedBefore] = useState<string>('');
  const { state, refetch, loadMore } = useCryptoOrdersList({
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
    ...(createdAfter.length > 0 ? { createdAfter: `${createdAfter}T00:00:00Z` } : {}),
    ...(createdBefore.length > 0 ? { createdBefore: `${createdBefore}T00:00:00Z` } : {}),
  });
  const cancel = useCancelOrder();
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [cancelConfirmFor, setCancelConfirmFor] = useState<string | null>(null);
  const keepBtnRef = useRef<HTMLButtonElement>(null);

  // V-534.BK — escape closes the cancel-confirm modal.
  useEffect(() => {
    if (cancelConfirmFor === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCancelConfirmFor(null);
    };
    window.addEventListener('keydown', onKey);
    keepBtnRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [cancelConfirmFor]);

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

  // V-534.BS — auto-refresh while any visible order is pending.
  // The IPN/sweep loop flips pending → confirming → paid out of
  // band; without polling the user has to manually Refresh to see
  // the new state. We bail as soon as nothing is pending so the
  // tab doesn't keep polling forever.
  //
  // V-534.BT — auto-refresh is paused once the user has paginated
  // past the first page (a refetch resets the cursor + clobbers the
  // appended pages). Track this by comparing the loaded order count
  // to the initial page size and the presence of a next_cursor.
  const hasPending =
    state.kind === 'ready' && state.data.orders.some((o) => o.status === 'pending');
  const paginatedBeyondFirst =
    state.kind === 'ready' && state.data.orders.length > 50 && state.data.nextCursor !== null;
  useEffect(() => {
    if (!hasPending) return;
    if (paginatedBeyondFirst) return;
    const id = setInterval(() => {
      // Skip the pending-order poll while the window is hidden (audit 2026-07-08).
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refetch();
    }, pendingRefreshMs);
    return () => {
      clearInterval(id);
    };
  }, [hasPending, paginatedBeyondFirst, refetch, pendingRefreshMs]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Crypto orders</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-secondary">
            <span>Status</span>
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs"
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="confirming">Confirming</option>
              <option value="paid">Paid</option>
              <option value="failed">Failed</option>
              <option value="partial">Partial</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-ink-secondary">
            <span>From</span>
            <input
              type="date"
              value={createdAfter}
              onChange={(e) => setCreatedAfter(e.target.value)}
              aria-label="Filter by created_at (inclusive lower bound)"
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-ink-secondary">
            <span>To</span>
            <input
              type="date"
              value={createdBefore}
              onChange={(e) => setCreatedBefore(e.target.value)}
              aria-label="Filter by created_at (exclusive upper bound)"
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs"
            />
          </label>
          {(statusFilter !== 'all' || createdAfter.length > 0 || createdBefore.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter('all');
                setCreatedAfter('');
                setCreatedBefore('');
              }}
              className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-xs font-medium hover:bg-surface-base"
            >
              Reset filters
            </button>
          )}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={state.kind === 'loading'}
            className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {state.kind === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {state.kind === 'error' && (
        <ErrorBanner message={state.message} onDismiss={() => void refetch()} />
      )}

      {/* First-load skeleton — the body previously had no `loading` branch, so it rendered
          blank on open (read as "no orders" / broken on a slow link — audit 2026-07-08). */}
      {state.kind === 'loading' && (
        <div className="rounded-md border border-surface-divider bg-surface-inset p-4">
          <SkeletonRows rows={5} label="Loading your crypto orders…" />
        </div>
      )}

      {cancel.state.kind === 'failed' && (
        <ErrorBanner message={cancel.state.message} onDismiss={() => cancel.reset()} />
      )}

      {state.kind === 'ready' && state.data.orders.length === 0 && (
        <div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">
          {statusFilter === 'all' ? (
            <>No crypto orders yet. Open a checkout from the Billing view to create one.</>
          ) : (
            <>
              No orders with status <strong>{statusFilter}</strong>.{' '}
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className="underline hover:text-ink-primary"
              >
                Clear filter
              </button>
            </>
          )}
        </div>
      )}

      {(state.kind === 'ready' || state.kind === 'loading_more') &&
        state.data.orders.length > 0 && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
            <div>
              <p className="mb-1 text-xs text-ink-secondary" aria-live="polite">
                Showing {state.data.orders.length.toString()} order
                {state.data.orders.length === 1 ? '' : 's'}
                {state.data.nextCursor !== null ? ' (more available)' : ''}.
              </p>
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
                    const isSelected = selectedOrderId === o.order_id;
                    return (
                      <tr
                        key={o.order_id}
                        onClick={() => setSelectedOrderId(o.order_id)}
                        aria-selected={isSelected}
                        className={`cursor-pointer border-t border-surface-divider hover:bg-surface-inset ${
                          isSelected ? 'bg-surface-inset' : ''
                        }`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs">{o.order_id}</td>
                        <td className="py-2 pr-4">{o.product}</td>
                        <td className="py-2 pr-4">
                          {formatCents(o.price_cents, o.price_currency)}
                        </td>
                        <td className="py-2 pr-4">
                          <span className="flex flex-wrap items-center gap-1">
                            <CryptoOrderStatusBadge status={o.status} size="sm" />
                            {isExpiringSoon(
                              o.status,
                              o.expires_at ?? null,
                              (nowFn ?? Date.now)(),
                            ) && (
                              <span
                                aria-label="Expires soon"
                                className="rounded-full bg-status-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-warning"
                              >
                                Expires soon
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-ink-secondary">
                          {formatRelative(o.created_at)}
                        </td>
                        <td className="py-2 pr-4">
                          {o.status === 'pending' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCancelConfirmFor(o.order_id);
                              }}
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

              {state.kind === 'ready' && state.data.nextCursor !== null && (
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadMore()}
                    className="rounded border border-surface-divider bg-surface-inset px-3 py-1 text-xs font-medium hover:bg-surface-base"
                  >
                    Load more
                  </button>
                </div>
              )}
              {state.kind === 'loading_more' && (
                <div className="mt-2 flex justify-center text-xs text-ink-secondary">
                  Loading more…
                </div>
              )}
            </div>

            <aside aria-label="Order detail" className="min-w-0">
              {/* key on the order id → React remounts the detail view (and its
                  useCryptoOrder poll refs) when the selected row changes, so a
                  previous order's late response / latched terminal-poll state
                  can't bleed into the newly-selected order. */}
              <CryptoOrderDetailView key={selectedOrderId} orderId={selectedOrderId} />
            </aside>
          </div>
        )}

      {cancelConfirmFor !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm order cancellation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-surface-divider bg-surface-base p-6">
            <h3 className="text-base font-semibold">Cancel this order?</h3>
            <p className="text-sm">
              Order <span className="font-mono text-xs">{cancelConfirmFor}</span> will be marked
              cancelled. You can still mint a new order afterwards. Crypto payments are{' '}
              <strong>non-refundable</strong>; cancelling only stops the pending pay window — if
              you've already sent crypto, contact support to reconcile.
            </p>
            <div className="flex justify-end gap-2">
              <button
                ref={keepBtnRef}
                type="button"
                onClick={() => setCancelConfirmFor(null)}
                className="rounded border border-surface-divider px-3 py-1 text-sm hover:bg-surface-inset"
              >
                Keep order
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = cancelConfirmFor;
                  setCancelConfirmFor(null);
                  void cancel.cancel(id);
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
